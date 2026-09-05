import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { safeDestroyMachine, sweepOrphanedMachines, getLastSweepAt } from "../reaper.js";
import type { ReaperConfig, ReaperHelpers } from "../reaper.js";
import { FakeProvider } from "./providers/fake.js";
import type { ProviderRegistry } from "../providers/registry.js";

function makeFakeRegistry(provider: FakeProvider): ProviderRegistry {
  return {
    forMapping: async () => provider,
    forAllMappings: async () => [provider],
    invalidate: () => {},
  } as unknown as ProviderRegistry;
}

vi.mock("../fly-machines.js", () => ({
  listMachines: vi.fn(),
  destroyMachine: vi.fn(),
}));

vi.mock("../log.js", () => ({
  getJobByMachineId: vi.fn(),
  updateJobStatus: vi.fn(),
  invalidateNonce: vi.fn(),
  getInFlightKgRefreshJobs: vi.fn(() => []),
}));

vi.mock("../dedup.js", () => ({
  recordReaperAction: vi.fn(),
}));

vi.mock("../notify.js", () => ({
  notifyReaperBurst: vi.fn(() => Promise.resolve()),
}));

import { listMachines, destroyMachine } from "../fly-machines.js";
import { getJobByMachineId, updateJobStatus, invalidateNonce, getInFlightKgRefreshJobs } from "../log.js";
import { recordReaperAction } from "../dedup.js";
import { notifyReaperBurst } from "../notify.js";

const TOKEN = "fly-test-token";
const APP = "test-sessions-app";

function makeConfig(reaperDryRun: boolean, overrides?: Partial<ReaperConfig>): ReaperConfig {
  return {
    flySessionsToken: TOKEN,
    flySessionsApp: APP,
    flyOrchestratorApp: "my-orchestrator",
    registry: makeFakeRegistry(new FakeProvider()),
    getMappings: () => ({}),
    reaperDryRun,
    ...overrides,
  };
}

function makeHelpers(): ReaperHelpers {
  return {
    resetTicket: vi.fn(() => Promise.resolve()),
    postSessionLogs: vi.fn(() => Promise.resolve()),
    findPrForIssue: vi.fn(() => Promise.resolve(null)),
    failKgRefreshMachine: vi.fn(),
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
    expect(helpers.resetTicket).not.toHaveBeenCalled();
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
    expect(helpers.resetTicket).toHaveBeenCalledWith(inflight);
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

// ---------- sweepOrphanedMachines — kg-refresh machine-absent rule ----------

const kgRefreshJob = {
  id: 10,
  issueId: "kg-refresh",
  issueIdentifier: null,
  issueTitle: null,
  teamKey: null,
  repo: null,
  dispatchedAt: Date.now() - 60_000,
  dispatchId: "disp-kg",
  dispatchNumber: 1,
  issueState: null,
  runId: null,
  status: "running" as const,
  conclusion: null,
  prUrl: null,
  completedAt: null,
  notifiedAt: null,
  machineNonce: "nonce-kg",
  executionMode: "fly-machines",
  machineId: "m-kg",
  runnerMode: null,
  sessionImage: null,
  phase: "kg-refresh",
  contract: null,
  groupingParent: false,
};

describe("sweepOrphanedMachines — kg-refresh machine-absent rule", () => {
  it("calls failKgRefreshMachine when machine absent", async () => {
    // No machines in the registry — m-kg is absent
    vi.mocked(listMachines).mockResolvedValueOnce([] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([kgRefreshJob]);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    expect(helpers.failKgRefreshMachine).toHaveBeenCalledOnce();
    expect(helpers.failKgRefreshMachine).toHaveBeenCalledWith(kgRefreshJob);
  });

  it("records reaper action with ruleMatched=kg-refresh-machine-absent", async () => {
    vi.mocked(listMachines).mockResolvedValueOnce([] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([kgRefreshJob]);

    await sweepOrphanedMachines(makeConfig(false), makeHelpers());

    expect(recordReaperAction).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleMatched: "kg-refresh-machine-absent",
        machineId: "m-kg",
        tenantId: null,
        issueIdentifier: null,
        dryRun: false,
      }),
    );
  });

  it("logs structured [reaper] line for absent kg-refresh machine", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(listMachines).mockResolvedValueOnce([] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([kgRefreshJob]);

    await sweepOrphanedMachines(makeConfig(false), makeHelpers());

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[reaper\] rule=kg-refresh-machine-absent machine=m-kg job=10/),
    );
  });

  it("does not call failKgRefreshMachine when machine is present", async () => {
    // Machine m-kg is alive in the registry
    const machine = makeMachine("m-kg");
    vi.mocked(listMachines).mockResolvedValueOnce([machine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([kgRefreshJob]);
    vi.mocked(destroyMachine).mockResolvedValue(undefined);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    expect(helpers.failKgRefreshMachine).not.toHaveBeenCalled();
  });

  it("dry-run: records action but does not call failKgRefreshMachine", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(listMachines).mockResolvedValueOnce([] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([kgRefreshJob]);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(true), helpers);

    expect(helpers.failKgRefreshMachine).not.toHaveBeenCalled();
    expect(recordReaperAction).toHaveBeenCalledWith(
      expect.objectContaining({ ruleMatched: "kg-refresh-machine-absent", dryRun: true }),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/dry_run=true/),
    );
  });

  it("skips job with no machineId (local Docker)", async () => {
    const localJob = { ...kgRefreshJob, machineId: null };
    vi.mocked(listMachines).mockResolvedValueOnce([] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([localJob]);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    expect(helpers.failKgRefreshMachine).not.toHaveBeenCalled();
    expect(recordReaperAction).not.toHaveBeenCalled();
  });

  it("no error when failKgRefreshMachine is absent from helpers", async () => {
    vi.mocked(listMachines).mockResolvedValueOnce([] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([kgRefreshJob]);
    const helpers: ReaperHelpers = {
      resetTicket: vi.fn(() => Promise.resolve()),
      postSessionLogs: vi.fn(() => Promise.resolve()),
      findPrForIssue: vi.fn(() => Promise.resolve(null)),
      // failKgRefreshMachine intentionally absent
    };

    await expect(sweepOrphanedMachines(makeConfig(false), helpers)).resolves.toBeUndefined();
  });

  it("handles multiple running kg-refresh jobs — absent fires, present skips", async () => {
    const machine2 = makeMachine("m-kg2");
    vi.mocked(listMachines).mockResolvedValueOnce([machine2] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);
    const job2 = { ...kgRefreshJob, id: 11, machineId: "m-kg2" };
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([kgRefreshJob, job2]);
    vi.mocked(destroyMachine).mockResolvedValue(undefined);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    // Only m-kg is absent; m-kg2 is alive
    expect(helpers.failKgRefreshMachine).toHaveBeenCalledOnce();
    expect(helpers.failKgRefreshMachine).toHaveBeenCalledWith(kgRefreshJob);
  });

  it("issue-keyed jobs are unaffected by kg-refresh sweep (regression pin)", async () => {
    // An issue-keyed machine plus a kg-refresh machine; kg-refresh machine is absent.
    const issueMachine = makeMachine("m-issue");
    const issueJob = {
      id: 20,
      issueId: "issue-123",
      issueIdentifier: "ENG-100",
      issueTitle: "Fix thing",
      teamKey: "ENG",
      repo: "org/repo",
      dispatchedAt: Date.now() - 60_000,
      dispatchId: null,
      dispatchNumber: 1,
      issueState: null,
      runId: null,
      status: "running" as const,
      conclusion: null,
      prUrl: null,
      completedAt: null,
      notifiedAt: null,
      machineNonce: "nonce-issue",
      executionMode: "fly-machines",
      machineId: "m-issue",
      runnerMode: "autonomous",
      sessionImage: null,
      phase: "implementation",
      contract: null,
      groupingParent: false,
    };
    vi.mocked(listMachines).mockResolvedValueOnce([issueMachine] as never);
    vi.mocked(getJobByMachineId).mockImplementation((id) =>
      id === "m-issue" ? issueJob : null,
    );
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([kgRefreshJob]);
    vi.mocked(destroyMachine).mockResolvedValue(undefined);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    // Issue-keyed machine is alive — no destruction
    expect(destroyMachine).not.toHaveBeenCalled();
    // kg-refresh machine absent — failKgRefreshMachine called
    expect(helpers.failKgRefreshMachine).toHaveBeenCalledOnce();
    expect(helpers.failKgRefreshMachine).toHaveBeenCalledWith(kgRefreshJob);
  });
});

// ---------- sweepOrphanedMachines — kg-refresh max-age rule ----------

const kgRefreshInflight = {
  ...kgRefreshJob,
  status: "running" as const,
  machineId: "m-kg",
};

describe("sweepOrphanedMachines — kg-refresh max-age rule", () => {
  it("destroys an aged-out kg-refresh machine", async () => {
    const oldMachine = makeMachine("m-kg", {
      created_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
    });
    vi.mocked(listMachines).mockResolvedValueOnce([oldMachine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(kgRefreshInflight);
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([]);

    await sweepOrphanedMachines(makeConfig(false), makeHelpers());

    expect(destroyMachine).toHaveBeenCalledWith(TOKEN, APP, "m-kg");
  });

  it("calls failKgRefreshMachine (not resetTicket) for an aged-out kg-refresh machine", async () => {
    const oldMachine = makeMachine("m-kg", {
      created_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
    });
    vi.mocked(listMachines).mockResolvedValueOnce([oldMachine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(kgRefreshInflight);
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([]);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    expect(helpers.failKgRefreshMachine).toHaveBeenCalledOnce();
    expect(helpers.failKgRefreshMachine).toHaveBeenCalledWith(kgRefreshInflight);
    expect(helpers.resetTicket).not.toHaveBeenCalled();
  });

  it("does not call postSessionLogs for a kg-refresh max-age eviction", async () => {
    const oldMachine = makeMachine("m-kg", {
      created_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
    });
    vi.mocked(listMachines).mockResolvedValueOnce([oldMachine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(kgRefreshInflight);
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([]);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    expect(helpers.postSessionLogs).not.toHaveBeenCalled();
  });

  it("closes the job row and invalidates the nonce for an aged-out kg-refresh machine", async () => {
    const oldMachine = makeMachine("m-kg", {
      created_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
    });
    vi.mocked(listMachines).mockResolvedValueOnce([oldMachine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(kgRefreshInflight);
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([]);

    await sweepOrphanedMachines(makeConfig(false), makeHelpers());

    expect(updateJobStatus).toHaveBeenCalledWith(kgRefreshInflight.id, "timed_out", "machine_max_age_sweep");
    expect(invalidateNonce).toHaveBeenCalledWith(kgRefreshInflight.id);
  });

  it("issue-keyed max-age still calls resetTicket and NOT failKgRefreshMachine (regression pin)", async () => {
    const issueJob = {
      id: 20,
      issueId: "issue-100",
      issueIdentifier: "ENG-100",
      issueTitle: "Fix thing",
      teamKey: "ENG",
      repo: "org/repo",
      dispatchedAt: Date.now() - 5 * 3600_000,
      dispatchId: null,
      dispatchNumber: 1,
      issueState: null,
      runId: null,
      status: "running" as const,
      conclusion: null,
      prUrl: null,
      completedAt: null,
      notifiedAt: null,
      machineNonce: "nonce-issue",
      executionMode: "fly-machines",
      machineId: "m-issue",
      runnerMode: "autonomous",
      sessionImage: null,
      phase: "implementation",
      contract: null,
      groupingParent: false,
    };
    const oldMachine = makeMachine("m-issue", {
      created_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
    });
    vi.mocked(listMachines).mockResolvedValueOnce([oldMachine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(issueJob);
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([]);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    expect(helpers.resetTicket).toHaveBeenCalledWith(issueJob);
    expect(helpers.failKgRefreshMachine).not.toHaveBeenCalled();
  });
});

// ---------- sweepOrphanedMachines — kg-refresh stopped/failed machine triggers close ----------

describe("sweepOrphanedMachines — kg-refresh stopped/failed machine triggers close", () => {
  it("stopped machine present in registry still triggers sweep close", async () => {
    const machine = makeMachine("m-kg", { state: "stopped" });
    vi.mocked(listMachines).mockResolvedValueOnce([machine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([kgRefreshJob]);
    vi.mocked(destroyMachine).mockResolvedValue(undefined);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    expect(helpers.failKgRefreshMachine).toHaveBeenCalledOnce();
    expect(helpers.failKgRefreshMachine).toHaveBeenCalledWith(kgRefreshJob);
    expect(recordReaperAction).toHaveBeenCalledWith(
      expect.objectContaining({ ruleMatched: "kg-refresh-machine-absent", dryRun: false }),
    );
  });

  it("failed machine present in registry still triggers sweep close", async () => {
    const machine = makeMachine("m-kg", { state: "failed" });
    vi.mocked(listMachines).mockResolvedValueOnce([machine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([kgRefreshJob]);
    vi.mocked(destroyMachine).mockResolvedValue(undefined);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    expect(helpers.failKgRefreshMachine).toHaveBeenCalledOnce();
    expect(helpers.failKgRefreshMachine).toHaveBeenCalledWith(kgRefreshJob);
    expect(recordReaperAction).toHaveBeenCalledWith(
      expect.objectContaining({ ruleMatched: "kg-refresh-machine-absent", dryRun: false }),
    );
  });

  it("started machine mid-ingest is never reaped (regression pin)", async () => {
    const machine = makeMachine("m-kg"); // default state: "started"
    vi.mocked(listMachines).mockResolvedValueOnce([machine] as never);
    vi.mocked(getJobByMachineId).mockImplementation((id) => (id === "m-kg" ? kgRefreshJob : null));
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([kgRefreshJob]);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    expect(helpers.failKgRefreshMachine).not.toHaveBeenCalled();
    expect(destroyMachine).not.toHaveBeenCalled();
  });
});

// ---------- sweepOrphanedMachines — kg-refresh bootstrap deadline ----------

describe("sweepOrphanedMachines — kg-refresh bootstrap deadline", () => {
  it("dispatched row with null machineId past deadline closes with bootstrap_timeout", async () => {
    const dispatchedJob = { ...kgRefreshJob, status: "dispatched" as const, machineId: null, dispatchedAt: Date.now() - 10 * 60_000 };
    vi.mocked(listMachines).mockResolvedValueOnce([] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([dispatchedJob]);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    expect(helpers.failKgRefreshMachine).toHaveBeenCalledOnce();
    expect(helpers.failKgRefreshMachine).toHaveBeenCalledWith(dispatchedJob, { failureCode: "bootstrap_timeout" });
    expect(recordReaperAction).toHaveBeenCalledWith(
      expect.objectContaining({ ruleMatched: "kg-refresh-bootstrap-timeout", dryRun: false }),
    );
  });

  it("dispatched row with null machineId within deadline is skipped", async () => {
    const dispatchedJob = { ...kgRefreshJob, status: "dispatched" as const, machineId: null, dispatchedAt: Date.now() - 60_000 };
    vi.mocked(listMachines).mockResolvedValueOnce([] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([dispatchedJob]);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    expect(helpers.failKgRefreshMachine).not.toHaveBeenCalled();
    expect(recordReaperAction).not.toHaveBeenCalled();
  });

  it("dispatched row with machineId past deadline closes via bootstrap (not double-fired)", async () => {
    const dispatchedJob = { ...kgRefreshJob, status: "dispatched" as const, machineId: "m-kg", dispatchedAt: Date.now() - 10 * 60_000 };
    vi.mocked(listMachines).mockResolvedValueOnce([] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([dispatchedJob]);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    expect(helpers.failKgRefreshMachine).toHaveBeenCalledOnce();
    expect(helpers.failKgRefreshMachine).toHaveBeenCalledWith(dispatchedJob, { failureCode: "bootstrap_timeout" });
  });

  it("dry-run: bootstrap timeout records action but does not call failKgRefreshMachine", async () => {
    const dispatchedJob = { ...kgRefreshJob, status: "dispatched" as const, machineId: null, dispatchedAt: Date.now() - 10 * 60_000 };
    vi.mocked(listMachines).mockResolvedValueOnce([] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([dispatchedJob]);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(true), helpers);

    expect(recordReaperAction).toHaveBeenCalledWith(
      expect.objectContaining({ ruleMatched: "kg-refresh-bootstrap-timeout", dryRun: true }),
    );
    expect(helpers.failKgRefreshMachine).not.toHaveBeenCalled();
  });

  it("running row past 5 min triggers machine-absent path, not bootstrap", async () => {
    const runningJob = { ...kgRefreshJob, status: "running" as const, machineId: "m-kg", dispatchedAt: Date.now() - 10 * 60_000 };
    vi.mocked(listMachines).mockResolvedValueOnce([] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(undefined);
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([runningJob]);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    expect(helpers.failKgRefreshMachine).toHaveBeenCalledOnce();
    expect(helpers.failKgRefreshMachine).toHaveBeenCalledWith(runningJob);
    expect(recordReaperAction).toHaveBeenCalledWith(
      expect.objectContaining({ ruleMatched: "kg-refresh-machine-absent" }),
    );
    expect(recordReaperAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ ruleMatched: "kg-refresh-bootstrap-timeout" }),
    );
  });
});

// ---------- sweepOrphanedMachines — kg-refresh issue-terminal exclusion (regression pin) ----------

describe("sweepOrphanedMachines — kg-refresh issue-terminal exclusion", () => {
  it("does not query the ticketing provider for an in-flight kg-refresh machine", async () => {
    // Machine is alive and young (below max-age), so the issue-terminal rule is
    // the only one that would invoke the provider. Verify it is never called.
    const machine = makeMachine("m-kg");
    vi.mocked(listMachines).mockResolvedValueOnce([machine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(kgRefreshJob);
    vi.mocked(getInFlightKgRefreshJobs).mockReturnValue([]);
    const fakeProv = new FakeProvider();
    const fetchSpy = vi.spyOn(fakeProv, "fetchLifecycleStates");
    const registry = makeFakeRegistry(fakeProv);
    // Configure a mapping so the provider lookup path is reachable for any
    // issue-keyed job — the guard must fire before that path for kg-refresh.
    const config = makeConfig(false, {
      registry,
      getMappings: () => ({ ENG: { ticketingProvider: "fake", teamKey: "ENG" } as never }),
    });

    await sweepOrphanedMachines(config, makeHelpers());

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
