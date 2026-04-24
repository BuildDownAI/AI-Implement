import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { safeDestroyMachine, sweepOrphanedMachines, getLastSweepAt } from "../reaper.js";
import type { ReaperConfig, ReaperHelpers } from "../reaper.js";

vi.mock("../fly-machines.js", () => ({
  listMachines: vi.fn(),
  destroyMachine: vi.fn(),
}));

vi.mock("../log.js", () => ({
  getJobByMachineId: vi.fn(),
  updateJobStatus: vi.fn(),
  invalidateNonce: vi.fn(),
}));

vi.mock("../linear.js", () => ({
  fetchIssueStates: vi.fn(() => Promise.resolve(new Map())),
}));

vi.mock("../dedup.js", () => ({
  recordReaperAction: vi.fn(),
}));

vi.mock("../notify.js", () => ({
  notifyReaperBurst: vi.fn(() => Promise.resolve()),
}));

import { listMachines, destroyMachine } from "../fly-machines.js";
import { getJobByMachineId, updateJobStatus, invalidateNonce } from "../log.js";
import { recordReaperAction } from "../dedup.js";
import { notifyReaperBurst } from "../notify.js";

const TOKEN = "fly-test-token";
const APP = "test-sessions-app";

function makeConfig(reaperDryRun: boolean, overrides?: Partial<ReaperConfig>): ReaperConfig {
  return {
    flySessionsToken: TOKEN,
    flySessionsApp: APP,
    flyOrchestratorApp: "my-orchestrator",
    linearApiKey: "lin_test",
    reaperDryRun,
    ...overrides,
  };
}

function makeHelpers(): ReaperHelpers {
  return {
    resetLinearIssue: vi.fn(() => Promise.resolve()),
    postSessionLogsToLinear: vi.fn(() => Promise.resolve()),
    findPrForIssue: vi.fn(() => Promise.resolve(null)),
  };
}

function makeMachine(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `session-${id}`,
    state: "started",
    region: "iad",
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date().toISOString(),
    config: {
      image: "ghcr.io/test/runner:latest",
      env: {},
      guest: { cpu_kind: "shared", cpus: 1, memory_mb: 1024 },
      auto_destroy: false,
      restart: { policy: "no" },
      metadata: { orchestrator_app: "my-orchestrator" },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- safeDestroyMachine ----------

describe("safeDestroyMachine", () => {
  it("calls destroyMachine in live mode", async () => {
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);
    const config = makeConfig(false);

    await safeDestroyMachine(config, "machine-abc", "orphan");

    expect(destroyMachine).toHaveBeenCalledOnce();
    expect(destroyMachine).toHaveBeenCalledWith(TOKEN, APP, "machine-abc");
  });

  it("does not call destroyMachine in dry-run mode", async () => {
    const config = makeConfig(true);

    await safeDestroyMachine(config, "machine-abc", "orphan");

    expect(destroyMachine).not.toHaveBeenCalled();
  });

  it("logs structured [reaper] line in dry-run mode without ctx", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const config = makeConfig(true);

    await safeDestroyMachine(config, "machine-xyz", "stale-terminal-job");

    expect(consoleSpy).toHaveBeenCalledWith(
      "[reaper] rule=stale-terminal-job machine=machine-xyz tenant=- issue=- age_s=- dry_run=true",
    );
  });

  it("logs structured [reaper] line with context fields", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const config = makeConfig(false);
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);

    await safeDestroyMachine(config, "m-ctx", "max-age-exceeded", {
      tenantId: "my-team",
      issueIdentifier: "ENG-42",
      ageSeconds: 14400,
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      "[reaper] rule=max-age-exceeded machine=m-ctx tenant=my-team issue=ENG-42 age_s=14400 dry_run=false",
    );
  });

  it("swallows 404 errors in live mode", async () => {
    vi.mocked(destroyMachine).mockRejectedValueOnce(new Error("404 not found"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const config = makeConfig(false);

    await expect(safeDestroyMachine(config, "gone-machine", "orphan")).resolves.toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("returns early when token is missing", async () => {
    const config: ReaperConfig = { ...makeConfig(false), flySessionsToken: null };

    await safeDestroyMachine(config, "machine-abc", "orphan");

    expect(destroyMachine).not.toHaveBeenCalled();
  });
});

// ---------- sweepOrphanedMachines — orphan rule ----------

describe("sweepOrphanedMachines — orphan rule", () => {
  it("destroys orphaned machine in live mode", async () => {
    const machine = makeMachine("m-orphan");
    vi.mocked(listMachines).mockResolvedValueOnce([machine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);

    await sweepOrphanedMachines(makeConfig(false), makeHelpers());

    expect(destroyMachine).toHaveBeenCalledOnce();
    expect(destroyMachine).toHaveBeenCalledWith(TOKEN, APP, "m-orphan");
  });

  it("does not destroy orphaned machine in dry-run mode", async () => {
    const machine = makeMachine("m-orphan");
    vi.mocked(listMachines).mockResolvedValueOnce([machine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);

    await sweepOrphanedMachines(makeConfig(true), makeHelpers());

    expect(destroyMachine).not.toHaveBeenCalled();
  });

  it("records reaper action for orphaned machine", async () => {
    const machine = makeMachine("m-orphan");
    vi.mocked(listMachines).mockResolvedValueOnce([machine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);

    await sweepOrphanedMachines(makeConfig(false), makeHelpers());

    expect(recordReaperAction).toHaveBeenCalledOnce();
    expect(recordReaperAction).toHaveBeenCalledWith(
      expect.objectContaining({ ruleMatched: "orphan", machineId: "m-orphan", dryRun: false }),
    );
  });

  it("logs structured [reaper] line for orphaned machine in dry-run mode", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const machine = makeMachine("m-orphan");
    vi.mocked(listMachines).mockResolvedValueOnce([machine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);

    await sweepOrphanedMachines(makeConfig(true), makeHelpers());

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[reaper\] rule=orphan machine=m-orphan tenant=- issue=- age_s=\d+ dry_run=true/),
    );
  });
});

// ---------- sweepOrphanedMachines — stale terminal job ----------

describe("sweepOrphanedMachines — stale terminal job rule", () => {
  const terminalJob = {
    id: 1,
    issueId: "issue-1",
    issueIdentifier: "ENG-1",
    issueTitle: "Test",
    teamKey: "ENG",
    repo: "org/repo",
    dispatchedAt: Date.now() - 3600_000,
    dispatchNumber: 1,
    issueState: null,
    runId: null,
    status: "completed" as const,
    conclusion: "success",
    prUrl: null,
    completedAt: Date.now() - 1800_000,
    notifiedAt: null,
    machineNonce: null,
    executionMode: "fly-machines",
    machineId: "m-terminal",
    runnerMode: "autonomous",
  };

  it("destroys stale terminal-job machine in live mode", async () => {
    const machine = makeMachine("m-terminal");
    vi.mocked(listMachines).mockResolvedValueOnce([machine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(terminalJob);
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);

    await sweepOrphanedMachines(makeConfig(false), makeHelpers());

    expect(destroyMachine).toHaveBeenCalledOnce();
    expect(destroyMachine).toHaveBeenCalledWith(TOKEN, APP, "m-terminal");
  });

  it("does not destroy stale terminal-job machine in dry-run mode", async () => {
    const machine = makeMachine("m-terminal");
    vi.mocked(listMachines).mockResolvedValueOnce([machine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(terminalJob);

    await sweepOrphanedMachines(makeConfig(true), makeHelpers());

    expect(destroyMachine).not.toHaveBeenCalled();
  });

  it("records reaper action with job context for stale terminal-job machine", async () => {
    const machine = makeMachine("m-terminal");
    vi.mocked(listMachines).mockResolvedValueOnce([machine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(terminalJob);
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);

    await sweepOrphanedMachines(makeConfig(false), makeHelpers());

    expect(recordReaperAction).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleMatched: "stale-terminal-job",
        machineId: "m-terminal",
        tenantId: "ENG",
        issueIdentifier: "ENG-1",
        dryRun: false,
      }),
    );
  });

  it("logs structured [reaper] line for stale terminal-job machine in dry-run mode", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const machine = makeMachine("m-terminal");
    vi.mocked(listMachines).mockResolvedValueOnce([machine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(terminalJob);

    await sweepOrphanedMachines(makeConfig(true), makeHelpers());

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[reaper\] rule=stale-terminal-job machine=m-terminal tenant=ENG issue=ENG-1/),
    );
  });
});

// ---------- sweepOrphanedMachines — side effects guarded in dry-run ----------

describe("sweepOrphanedMachines — side effects skipped in dry-run", () => {
  const inflight = {
    id: 2,
    issueId: "issue-2",
    issueIdentifier: "ENG-2",
    issueTitle: "Another",
    teamKey: "ENG",
    repo: "org/repo",
    dispatchedAt: Date.now() - 6 * 3600_000,
    dispatchNumber: 2,
    issueState: null,
    runId: null,
    status: "running" as const,
    conclusion: null,
    prUrl: null,
    completedAt: null,
    notifiedAt: null,
    machineNonce: "nonce-abc",
    executionMode: "fly-machines",
    machineId: "m-aged",
    runnerMode: "autonomous",
  };

  it("skips updateJobStatus and invalidateNonce in dry-run for max-age rule", async () => {
    const oldMachine = makeMachine("m-aged", {
      created_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
    });
    vi.mocked(listMachines).mockResolvedValueOnce([oldMachine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(inflight);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(true), helpers);

    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(invalidateNonce).not.toHaveBeenCalled();
    expect(helpers.resetLinearIssue).not.toHaveBeenCalled();
  });

  it("calls updateJobStatus and invalidateNonce in live mode for max-age rule", async () => {
    const oldMachine = makeMachine("m-aged", {
      created_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
    });
    vi.mocked(listMachines).mockResolvedValueOnce([oldMachine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(inflight);
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    expect(updateJobStatus).toHaveBeenCalledWith(inflight.id, "timed_out", "machine_max_age_sweep");
    expect(invalidateNonce).toHaveBeenCalledWith(inflight.id);
    expect(helpers.resetLinearIssue).toHaveBeenCalledWith(inflight);
  });
});

// ---------- sweepOrphanedMachines — skips destroyed machines ----------

describe("sweepOrphanedMachines — skips destroyed machines", () => {
  it("skips machines with state=destroyed", async () => {
    const machine = makeMachine("m-dead", { state: "destroyed" });
    vi.mocked(listMachines).mockResolvedValueOnce([machine] as never);

    await sweepOrphanedMachines(makeConfig(false), makeHelpers());

    expect(destroyMachine).not.toHaveBeenCalled();
    expect(getJobByMachineId).not.toHaveBeenCalled();
  });
});

// ---------- sweepOrphanedMachines — cross-orchestrator safety ----------

describe("sweepOrphanedMachines — cross-orchestrator safety", () => {
  it("skips machines tagged with a different orchestrator", async () => {
    const machine = makeMachine("m-other");
    (machine.config.metadata as Record<string, string>).orchestrator_app = "other-orchestrator";
    vi.mocked(listMachines).mockResolvedValueOnce([machine] as never);

    await sweepOrphanedMachines(makeConfig(false), makeHelpers());

    expect(destroyMachine).not.toHaveBeenCalled();
  });
});

// ---------- sweepOrphanedMachines — lastSweepAt ----------

describe("sweepOrphanedMachines — lastSweepAt", () => {
  it("sets lastSweepAt after a sweep with no machines", async () => {
    vi.mocked(listMachines).mockResolvedValueOnce([] as never);

    await sweepOrphanedMachines(makeConfig(false), makeHelpers());

    expect(getLastSweepAt()).toBeGreaterThan(0);
  });

  it("sets lastSweepAt after a sweep that destroys machines", async () => {
    const machine = makeMachine("m-orphan");
    vi.mocked(listMachines).mockResolvedValueOnce([machine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);

    const before = Date.now();
    await sweepOrphanedMachines(makeConfig(false), makeHelpers());

    expect(getLastSweepAt()).toBeGreaterThanOrEqual(before);
  });
});

// ---------- sweepOrphanedMachines — threshold alert ----------

describe("sweepOrphanedMachines — threshold alert", () => {
  it("fires notifyReaperBurst when destroyed count exceeds threshold", async () => {
    const machines = Array.from({ length: 3 }, (_, i) => makeMachine(`m-burst-${i}`));
    vi.mocked(listMachines).mockResolvedValueOnce(machines as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);
    vi.mocked(destroyMachine).mockResolvedValue(undefined);

    const config = makeConfig(false, {
      reaperAlertThreshold: 2,
      notifyWebhookUrl: "https://hooks.example.com/burst",
      notifyType: "slack",
    });
    await sweepOrphanedMachines(config, makeHelpers());

    expect(notifyReaperBurst).toHaveBeenCalledOnce();
    expect(notifyReaperBurst).toHaveBeenCalledWith("slack", "https://hooks.example.com/burst", {
      count: 3,
      threshold: 2,
    });
  });

  it("does not fire notifyReaperBurst when destroyed count is at or below threshold", async () => {
    const machines = [makeMachine("m-solo")];
    vi.mocked(listMachines).mockResolvedValueOnce(machines as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);
    vi.mocked(destroyMachine).mockResolvedValue(undefined);

    const config = makeConfig(false, {
      reaperAlertThreshold: 2,
      notifyWebhookUrl: "https://hooks.example.com/burst",
    });
    await sweepOrphanedMachines(config, makeHelpers());

    expect(notifyReaperBurst).not.toHaveBeenCalled();
  });

  it("does not fire notifyReaperBurst in dry-run mode even when threshold exceeded", async () => {
    const machines = Array.from({ length: 5 }, (_, i) => makeMachine(`m-dry-${i}`));
    vi.mocked(listMachines).mockResolvedValueOnce(machines as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);

    const config = makeConfig(true, {
      reaperAlertThreshold: 1,
      notifyWebhookUrl: "https://hooks.example.com/burst",
    });
    await sweepOrphanedMachines(config, makeHelpers());

    expect(notifyReaperBurst).not.toHaveBeenCalled();
  });

  it("does not fire notifyReaperBurst when webhook URL is not set", async () => {
    const machines = Array.from({ length: 5 }, (_, i) => makeMachine(`m-nowh-${i}`));
    vi.mocked(listMachines).mockResolvedValueOnce(machines as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);
    vi.mocked(destroyMachine).mockResolvedValue(undefined);

    const config = makeConfig(false, { reaperAlertThreshold: 1, notifyWebhookUrl: null });
    await sweepOrphanedMachines(config, makeHelpers());

    expect(notifyReaperBurst).not.toHaveBeenCalled();
  });
});
