import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { safeDestroyMachine, sweepOrphanedMachines, getLastSweepAt, reconcileRestateMachine, reconcileRestateLocalContainers, canReapFinishedRestateJob } from "../reaper.js";
import type { ReaperConfig, ReaperHelpers } from "../reaper.js";
import { makeJob, makeMapping, makeProvider, makeRegistry } from "./helpers/builders.js";

vi.mock("../fly-machines.js", () => ({
  listMachines: vi.fn(),
  destroyMachine: vi.fn(),
}));

vi.mock("../local-docker.js", async (importOriginal) => ({
  listAiImplementContainers: vi.fn(), removeLocalContainer: vi.fn(),
  selectSweepableContainers: (await importOriginal<typeof import("../local-docker.js")>()).selectSweepableContainers,
}));

vi.mock("../log.js", () => ({
  getJobByMachineId: vi.fn(),
  updateJobStatus: vi.fn(),
  invalidateNonce: vi.fn(),
}));

vi.mock("../dedup.js", () => ({
  recordReaperAction: vi.fn(),
}));

vi.mock("../notify.js", () => ({
  notifyReaperBurst: vi.fn(() => Promise.resolve()),
}));

// Default: no admission row for any dispatchId, so every existing test (none of which
// cares about the Restate-owner fence) keeps exercising the pre-AII-791 code paths.
// Restate-owner tests below override this per-case with mockReturnValueOnce.
vi.mock("../dispatch-admission.js", () => ({
  read: vi.fn(() => null),
}));

import { listMachines, destroyMachine } from "../fly-machines.js";
import { getJobByMachineId, updateJobStatus, invalidateNonce } from "../log.js";
import { recordReaperAction } from "../dedup.js";
import { notifyReaperBurst } from "../notify.js";
import { read as readAdmission } from "../dispatch-admission.js";

const TOKEN = "fly-test-token";
const APP = "test-sessions-app";

function makeConfig(reaperDryRun: boolean, overrides?: Partial<ReaperConfig>): ReaperConfig {
  return {
    flySessionsToken: TOKEN,
    flySessionsApp: APP,
    flyOrchestratorApp: "my-orchestrator",
    registry: makeRegistry(),
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

  it("swallows 404 errors in live mode and reports the machine confirmed gone", async () => {
    vi.mocked(destroyMachine).mockRejectedValueOnce(new Error("404 not found"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const config = makeConfig(false);

    await expect(safeDestroyMachine(config, "gone-machine", "orphan")).resolves.toBe(true);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("returns early (not confirmed) when token is missing", async () => {
    const config: ReaperConfig = { ...makeConfig(false), flySessionsToken: null };

    await expect(safeDestroyMachine(config, "machine-abc", "orphan")).resolves.toBe(false);

    expect(destroyMachine).not.toHaveBeenCalled();
  });

  it("resolves true on a successful live destroy", async () => {
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);
    const config = makeConfig(false);

    await expect(safeDestroyMachine(config, "machine-abc", "orphan")).resolves.toBe(true);
  });

  it("resolves false when destroy fails with a non-404 error", async () => {
    vi.mocked(destroyMachine).mockRejectedValueOnce(new Error("500 internal error"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const config = makeConfig(false);

    await expect(safeDestroyMachine(config, "machine-abc", "orphan")).resolves.toBe(false);
  });
});

// ---------- sweepOrphanedMachines — orphan rule ----------

describe("sweepOrphanedMachines — orphan rule", () => {
  it("destroys orphaned machine in live mode", async () => {
    const machine = makeMachine("m-orphan");
    vi.mocked(listMachines).mockResolvedValueOnce([machine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(null);
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);

    await sweepOrphanedMachines(makeConfig(false), makeHelpers());

    expect(destroyMachine).toHaveBeenCalledOnce();
    expect(destroyMachine).toHaveBeenCalledWith(TOKEN, APP, "m-orphan");
  });

  it("does not destroy orphaned machine in dry-run mode", async () => {
    const machine = makeMachine("m-orphan");
    vi.mocked(listMachines).mockResolvedValueOnce([machine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(null);

    await sweepOrphanedMachines(makeConfig(true), makeHelpers());

    expect(destroyMachine).not.toHaveBeenCalled();
  });

  it("records reaper action for orphaned machine", async () => {
    const machine = makeMachine("m-orphan");
    vi.mocked(listMachines).mockResolvedValueOnce([machine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(null);
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
    vi.mocked(getJobByMachineId).mockReturnValue(null);

    await sweepOrphanedMachines(makeConfig(true), makeHelpers());

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[reaper\] rule=orphan machine=m-orphan tenant=- issue=- age_s=\d+ dry_run=true/),
    );
  });
});

// ---------- sweepOrphanedMachines — stale terminal job ----------

describe("sweepOrphanedMachines — stale terminal job rule", () => {
  const terminalJob = makeJob({
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
  });

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
  const inflight = makeJob({
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
  });

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

    expect(updateJobStatus).toHaveBeenCalledWith(inflight.id, "timed_out", "machine_max_age_sweep", undefined, { backendTerminated: true });
    expect(invalidateNonce).toHaveBeenCalledWith(inflight.id);
    expect(helpers.resetTicket).toHaveBeenCalledWith(inflight);
  });

  // AII-783 gap-fill (review finding on PR #681): a destroy call that fails (and isn't a
  // 404-already-gone) must not read as verified termination — log.ts's updateJobStatus
  // only releases the admission reservation when skipAdmissionRelease is unset/false, so
  // this uncertain case must be written with it set.
  it("marks skipAdmissionRelease when the machine destroy fails with a non-404 error (max-age rule)", async () => {
    const oldMachine = makeMachine("m-aged", {
      created_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
    });
    vi.mocked(listMachines).mockResolvedValueOnce([oldMachine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(inflight);
    vi.mocked(destroyMachine).mockRejectedValueOnce(new Error("500 internal error"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    expect(updateJobStatus).toHaveBeenCalledWith(
      inflight.id,
      "timed_out",
      "machine_max_age_sweep",
      undefined,
      { skipAdmissionRelease: true },
    );
    // The job is still finalized (ticket reset, nonce invalidated) — only the admission
    // release is withheld, not the rest of the sweep's cleanup.
    expect(invalidateNonce).toHaveBeenCalledWith(inflight.id);
    expect(helpers.resetTicket).toHaveBeenCalledWith(inflight);
  });

  it("does not mark skipAdmissionRelease when the machine destroy 404s (already gone)", async () => {
    const oldMachine = makeMachine("m-aged", {
      created_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
    });
    vi.mocked(listMachines).mockResolvedValueOnce([oldMachine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(inflight);
    vi.mocked(destroyMachine).mockRejectedValueOnce(new Error("404 not found"));
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    expect(updateJobStatus).toHaveBeenCalledWith(inflight.id, "timed_out", "machine_max_age_sweep", undefined, { backendTerminated: true });
  });
});

// ---------- sweepOrphanedMachines — Restate-owned reservation fence (AII-791) ----------

describe("sweepOrphanedMachines — Restate-owned reservation fence (AII-791)", () => {
  function restateOwnedRecord(attemptId = "attempt-1") {
    return { lifecycleOwner: { kind: "restate", attemptId } } as never;
  }

  const inflightJob = makeJob({
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
    sessionImage: null,
    phase: "implementation",
    contract: null,
    groupingParent: false,
    approved: false,
    failure: null,
    failureCommentedAt: null,
  });

  it("does not destroy or finalize a Restate-owned max-age-exceeded machine", async () => {
    const restateJob = { ...inflightJob, id: 30, dispatchId: "disp-restate-1" };
    const oldMachine = makeMachine("m-restate-aged", {
      created_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
    });
    vi.mocked(listMachines).mockResolvedValueOnce([oldMachine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(restateJob);
    vi.mocked(readAdmission).mockReturnValueOnce(restateOwnedRecord());
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    expect(destroyMachine).not.toHaveBeenCalled();
    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(invalidateNonce).not.toHaveBeenCalled();
    expect(helpers.resetTicket).not.toHaveBeenCalled();
    expect(recordReaperAction).not.toHaveBeenCalled();
  });

  it("does not destroy or finalize a young, in-flight Restate-owned machine even though it resolves an admission row", async () => {
    const restateJob = { ...inflightJob, id: 31, dispatchId: "disp-restate-2" };
    const machine = makeMachine("m-restate-terminal");
    vi.mocked(listMachines).mockResolvedValueOnce([machine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(restateJob);
    vi.mocked(readAdmission).mockReturnValueOnce(restateOwnedRecord());

    await sweepOrphanedMachines(makeConfig(false), makeHelpers());

    expect(destroyMachine).not.toHaveBeenCalled();
    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(invalidateNonce).not.toHaveBeenCalled();
  });

  it("does not destroy a Restate-owned stale-terminal-job machine", async () => {
    const restateTerminalJob = makeJob({
      id: 32,
      issueId: "issue-restate",
      issueIdentifier: "ENG-9",
      issueTitle: "Restate-owned",
      teamKey: "ENG",
      repo: "org/repo",
      dispatchedAt: Date.now() - 3600_000,
      dispatchId: "disp-restate-3",
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
      machineId: "m-restate-stale",
      runnerMode: "autonomous",
      sessionImage: null,
      phase: "implementation",
      contract: null,
      groupingParent: false,
      approved: false,
      failure: null,
      failureCommentedAt: null,
    });
    const machine = makeMachine("m-restate-stale");
    vi.mocked(listMachines).mockResolvedValueOnce([machine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(restateTerminalJob);
    vi.mocked(readAdmission).mockReturnValueOnce(restateOwnedRecord());

    await sweepOrphanedMachines(makeConfig(false), makeHelpers());

    expect(destroyMachine).not.toHaveBeenCalled();
    expect(recordReaperAction).not.toHaveBeenCalled();
  });

  it("still destroys a Legacy-owned max-age-exceeded machine (regression: owner check does not over-fence)", async () => {
    const legacyJob = { ...inflightJob, id: 33, dispatchId: "disp-legacy-1" };
    const oldMachine = makeMachine("m-legacy-aged", {
      created_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
    });
    vi.mocked(listMachines).mockResolvedValueOnce([oldMachine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(legacyJob);
    vi.mocked(readAdmission).mockReturnValueOnce({ lifecycleOwner: { kind: "legacy" } } as never);
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    expect(destroyMachine).toHaveBeenCalledWith(TOKEN, APP, "m-legacy-aged");
    expect(updateJobStatus).toHaveBeenCalledWith(legacyJob.id, "timed_out", "machine_max_age_sweep", undefined, { backendTerminated: true });
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
    vi.mocked(getJobByMachineId).mockReturnValue(null);
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
    vi.mocked(getJobByMachineId).mockReturnValue(null);
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
    vi.mocked(getJobByMachineId).mockReturnValue(null);
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
    vi.mocked(getJobByMachineId).mockReturnValue(null);

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
    vi.mocked(getJobByMachineId).mockReturnValue(null);
    vi.mocked(destroyMachine).mockResolvedValue(undefined);

    const config = makeConfig(false, { reaperAlertThreshold: 1, notifyWebhookUrl: null });
    await sweepOrphanedMachines(config, makeHelpers());

    expect(notifyReaperBurst).not.toHaveBeenCalled();
  });
});

// ---------- sweepOrphanedMachines — kg-refresh job fixture ----------

const kgRefreshJob = makeJob({
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

    await sweepOrphanedMachines(makeConfig(false), makeHelpers());

    expect(destroyMachine).toHaveBeenCalledWith(TOKEN, APP, "m-kg");
  });

  it("does not call resetTicket for an aged-out kg-refresh machine", async () => {
    const oldMachine = makeMachine("m-kg", {
      created_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
    });
    vi.mocked(listMachines).mockResolvedValueOnce([oldMachine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(kgRefreshInflight);
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    expect(helpers.resetTicket).not.toHaveBeenCalled();
  });

  it("does not call postSessionLogs for a kg-refresh max-age eviction", async () => {
    const oldMachine = makeMachine("m-kg", {
      created_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
    });
    vi.mocked(listMachines).mockResolvedValueOnce([oldMachine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(kgRefreshInflight);
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);
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

    await sweepOrphanedMachines(makeConfig(false), makeHelpers());

    expect(updateJobStatus).toHaveBeenCalledWith(kgRefreshInflight.id, "timed_out", "machine_max_age_sweep", undefined, { backendTerminated: true });
    expect(invalidateNonce).toHaveBeenCalledWith(kgRefreshInflight.id);
  });

  it("does not call resetTicket for an aged-out gap-analysis machine", async () => {
    const gapJob = { ...kgRefreshInflight, id: 30, issueId: "issue-200", issueIdentifier: "ENG-200", teamKey: "ENG", repo: "org/repo", phase: "gap-analysis" };
    const oldMachine = makeMachine("m-kg", {
      created_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
    });
    vi.mocked(listMachines).mockResolvedValueOnce([oldMachine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(gapJob);
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    expect(updateJobStatus).toHaveBeenCalledWith(30, "timed_out", "machine_max_age_sweep", undefined, { backendTerminated: true });
    expect(helpers.resetTicket).not.toHaveBeenCalled();
  });

  it("does not call resetTicket for an in-flight gap-analysis machine on a cancelled ticket", async () => {
    const gapJob = { ...kgRefreshInflight, id: 31, issueId: "issue-201", issueIdentifier: "ENG-201", teamKey: "ENG", repo: "org/repo", phase: "gap-analysis" };
    const machine = makeMachine("m-gap", { created_at: new Date(Date.now() - 60_000).toISOString() });
    vi.mocked(listMachines).mockResolvedValueOnce([machine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(gapJob);
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);
    const helpers = makeHelpers();
    const fakeProv = makeProvider();
    vi.mocked(fakeProv.fetchLifecycleStates).mockResolvedValue(new Map([["issue-201", "cancelled"]]) as never);
    const config = makeConfig(false, {
      registry: makeRegistry({ provider: fakeProv }),
      getMappings: () => ({ ENG: makeMapping() }),
    });

    await sweepOrphanedMachines(config, helpers);

    expect(updateJobStatus).toHaveBeenCalledWith(31, "timed_out", "issue_completed_sweep", undefined, { backendTerminated: true });
    expect(helpers.resetTicket).not.toHaveBeenCalled();
  });

  it("issue-keyed max-age still calls resetTicket (regression pin)", async () => {
    const issueJob = makeJob({
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
    });
    const oldMachine = makeMachine("m-issue", {
      created_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
    });
    vi.mocked(listMachines).mockResolvedValueOnce([oldMachine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(issueJob);
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);
    const helpers = makeHelpers();

    await sweepOrphanedMachines(makeConfig(false), helpers);

    expect(helpers.resetTicket).toHaveBeenCalledWith(issueJob);
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
    const provider = makeProvider();
    // Configure a mapping so the provider lookup path is reachable for any
    // issue-keyed job — the guard must fire before that path for kg-refresh.
    const config = makeConfig(false, {
      registry: makeRegistry({ provider }),
      getMappings: () => ({ ENG: makeMapping() }),
    });

    await sweepOrphanedMachines(config, makeHelpers());

    expect(provider.fetchLifecycleStates).not.toHaveBeenCalled();
  });
});

// ---------- sweepOrphanedMachines — durable-runner machines ----------

describe("sweepOrphanedMachines — durable-runner machines", () => {
  const terminalJob = makeJob({ id: 7, status: "completed", teamKey: "ENG", issueIdentifier: "ENG-7" });

  function durableMachine(id: string, extra: Record<string, string> = {}, purpose = "durable-runner") {
    return makeMachine(id, {
      config: {
        ...makeMachine(id).config,
        metadata: { orchestrator_app: "my-orchestrator", purpose, ...extra },
      },
    });
  }
  const nowSec = () => Math.floor(Date.now() / 1000);

  it("skips a durable-runner machine with no durable_until, recording nothing", async () => {
    vi.mocked(listMachines).mockResolvedValueOnce([durableMachine("m-d")] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(terminalJob);
    await sweepOrphanedMachines(makeConfig(false), makeHelpers());
    expect(destroyMachine).not.toHaveBeenCalled();
    expect(recordReaperAction).not.toHaveBeenCalled();
  });

  it("skips a durable-runner machine with no job row (not an orphan)", async () => {
    vi.mocked(listMachines).mockResolvedValueOnce([durableMachine("m-d")] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(null);
    await sweepOrphanedMachines(makeConfig(false), makeHelpers());
    expect(destroyMachine).not.toHaveBeenCalled();
    expect(recordReaperAction).not.toHaveBeenCalled();
  });

  it("skips a durable-runner machine whose durable_until is in the future", async () => {
    const m = durableMachine("m-d", { durable_until: String(nowSec() + 3600) });
    vi.mocked(listMachines).mockResolvedValueOnce([m] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(terminalJob);
    await sweepOrphanedMachines(makeConfig(false), makeHelpers());
    expect(destroyMachine).not.toHaveBeenCalled();
    expect(recordReaperAction).not.toHaveBeenCalled();
  });

  it("destroys a durable-runner machine past durable_until with rule durable-expired", async () => {
    const m = durableMachine("m-d", { durable_until: String(nowSec() - 3600) });
    vi.mocked(listMachines).mockResolvedValueOnce([m] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(terminalJob);
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);
    await sweepOrphanedMachines(makeConfig(false), makeHelpers());
    expect(destroyMachine).toHaveBeenCalledWith(TOKEN, APP, "m-d");
    expect(recordReaperAction).toHaveBeenCalledTimes(1);
    expect(recordReaperAction).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleMatched: "durable-expired",
        machineId: "m-d",
        tenantId: null,
        issueIdentifier: null,
        ageSeconds: expect.any(Number),
        dryRun: false,
      }),
    );
  });

  it.each(["soon", "", "NaN"])("treats durable_until %j as expired with one warning", async (bad) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(listMachines).mockResolvedValueOnce([durableMachine("m-d", { durable_until: bad })] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(terminalJob);
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);
    await sweepOrphanedMachines(makeConfig(false), makeHelpers());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(destroyMachine).toHaveBeenCalledWith(TOKEN, APP, "m-d");
    expect(recordReaperAction).toHaveBeenCalledWith(expect.objectContaining({ ruleMatched: "durable-expired" }));
  });

  it("still destroys a session machine with a terminal job via stale-terminal-job", async () => {
    vi.mocked(listMachines).mockResolvedValueOnce([durableMachine("m-s", {}, "session")] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(terminalJob);
    vi.mocked(destroyMachine).mockResolvedValueOnce(undefined);
    await sweepOrphanedMachines(makeConfig(false), makeHelpers());
    expect(destroyMachine).toHaveBeenCalledWith(TOKEN, APP, "m-s");
    expect(recordReaperAction).toHaveBeenCalledWith(expect.objectContaining({ ruleMatched: "stale-terminal-job" }));
  });

  it("dry run logs would-destroy for durable-expired and makes no Fly call", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const m = durableMachine("m-d", { durable_until: String(nowSec() - 3600) });
    vi.mocked(listMachines).mockResolvedValueOnce([m] as never);
    await sweepOrphanedMachines(makeConfig(true), makeHelpers());
    expect(destroyMachine).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/\[reaper\] rule=durable-expired machine=m-d tenant=- issue=- age_s=\d+ dry_run=true/),
    );
    expect(recordReaperAction).toHaveBeenCalledWith(
      expect.objectContaining({ ruleMatched: "durable-expired", dryRun: true }),
    );
  });
});


describe("finished Restate resource cleanup", () => {
  const job = makeJob({ dispatchId: "owned", admissionGeneration: 7,
    status: "completed", executionMode: "fly-machines", machineId: "leftover" });
  function admission(releasedAt: number | null, generation = 7) {
    return { lifecycleOwner: { kind: "restate", attemptId: "owned" },
      releasedAt, generation, backend: "fly-machines" } as NonNullable<ReturnType<typeof readAdmission>>;
  }
  it.each([
    { count: 3, threshold: 2, alert: true },
    { count: 2, threshold: 2, alert: false },
    { count: 10, threshold: undefined, alert: false },
    { count: 11, threshold: undefined, alert: true },
  ])("counts Restate-only attempts: $count at threshold $threshold", async ({ count, threshold, alert }) => {
    vi.mocked(listMachines).mockResolvedValue(Array.from({ length: count }, (_, i) => makeMachine(`owned-${i}`)) as never);
    vi.mocked(getJobByMachineId).mockReturnValue(job);
    vi.mocked(readAdmission).mockReturnValue(admission(123));
    await sweepOrphanedMachines(makeConfig(false, {
      reaperAlertThreshold: threshold, notifyWebhookUrl: "https://hooks.example.com/burst",
    }), makeHelpers());
    expect(destroyMachine).toHaveBeenCalledTimes(count);
    expect(recordReaperAction).toHaveBeenCalledTimes(count);
    expect(notifyReaperBurst).toHaveBeenCalledTimes(alert ? 1 : 0);
    if (alert) expect(notifyReaperBurst).toHaveBeenCalledWith("slack", "https://hooks.example.com/burst", {
      count, threshold: threshold ?? 10,
    });
  });

  it.each([false, true])("counts mixed attempts once, including failed destroys, dryRun=%s", async (dryRun) => {
    const machines = [makeMachine("owned"), makeMachine("legacy"), makeMachine("orphan")];
    vi.mocked(listMachines).mockResolvedValue(machines as never);
    vi.mocked(getJobByMachineId).mockImplementation((id) => id === "orphan" ? null :
      id === "owned" ? job : makeJob({ status: "completed", dispatchId: null }));
    vi.mocked(readAdmission).mockReturnValue(admission(123));
    vi.mocked(destroyMachine).mockRejectedValue(new Error("503 unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const helpers = makeHelpers();
    await sweepOrphanedMachines(makeConfig(dryRun, {
      reaperAlertThreshold: 2, notifyWebhookUrl: "https://hooks.example.com/burst",
    }), helpers);
    expect(recordReaperAction).toHaveBeenCalledTimes(3);
    for (const machine of machines) {
      expect(recordReaperAction).toHaveBeenCalledWith(expect.objectContaining({ machineId: machine.id, dryRun }));
      if (!dryRun) expect(destroyMachine).toHaveBeenCalledWith(TOKEN, APP, machine.id);
    }
    expect(destroyMachine).toHaveBeenCalledTimes(dryRun ? 0 : 3);
    expect(notifyReaperBurst).toHaveBeenCalledTimes(dryRun ? 0 : 1);
    if (!dryRun) expect(notifyReaperBurst).toHaveBeenCalledWith("slack", "https://hooks.example.com/burst", { count: 3, threshold: 2 });
    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(invalidateNonce).not.toHaveBeenCalled();
    expect(helpers.resetTicket).not.toHaveBeenCalled();
  });

  it("requires a webhook for Restate burst notifications", async () => {
    vi.mocked(listMachines).mockResolvedValue([makeMachine("owned")] as never);
    vi.mocked(getJobByMachineId).mockReturnValue(job);
    vi.mocked(readAdmission).mockReturnValue(admission(123));
    await sweepOrphanedMachines(makeConfig(false, { reaperAlertThreshold: 0 }), makeHelpers());
    expect(destroyMachine).toHaveBeenCalledOnce();
    expect(notifyReaperBurst).not.toHaveBeenCalled();
  });

  it.each(["held", "nonterminal", "wrong-generation", "wrong-backend", "outer-backend", "foreign", "untagged", "destroyed", "durable", "kept-KG"])(
    "excludes %s resources from burst accounting", async (scenario) => {
      const machine = makeMachine("leftover");
      let record = admission(scenario === "held" ? null : 123, scenario === "wrong-generation" ? 8 : 7);
      // Direct admission/job mismatch, distinct from the outer Fly sweep backend fence.
      if (scenario === "wrong-backend") record = { ...record, backend: "local-docker" };
      const candidate = { ...job, status: scenario === "nonterminal" ? "running" as const : job.status };
      if (scenario === "outer-backend") {
        candidate.executionMode = "local-docker";
        record = { ...record, backend: "local-docker" };
      }
      if (scenario === "foreign") machine.config.metadata.orchestrator_app = "other";
      if (scenario === "untagged") machine.config.metadata = {} as typeof machine.config.metadata;
      if (scenario === "destroyed") machine.state = "destroyed";
      if (scenario === "durable" || scenario === "kept-KG") {
        machine.config.metadata = { ...machine.config.metadata, purpose: "durable-runner" } as typeof machine.config.metadata;
        if (scenario === "kept-KG") candidate.phase = "kg-refresh";
      }
      vi.mocked(listMachines).mockResolvedValue([machine] as never);
      vi.mocked(getJobByMachineId).mockReturnValue(candidate);
      vi.mocked(readAdmission).mockReturnValue(record);
      await sweepOrphanedMachines(makeConfig(false, {
        reaperAlertThreshold: 0, notifyWebhookUrl: "https://hooks.example.com/burst",
      }), makeHelpers());
      expect(recordReaperAction).not.toHaveBeenCalled();
      expect(destroyMachine).not.toHaveBeenCalled();
      expect(notifyReaperBurst).not.toHaveBeenCalled();
    },
  );

  it.each(["completed", "failed", "review_failed", "timed_out", "dispatch-failed"] as const)("removes released %s sessions without finalizing", async (status) => {
    vi.mocked(listMachines).mockResolvedValue([makeMachine("leftover", { state: "stopped" })] as never);
    vi.mocked(getJobByMachineId).mockReturnValue({ ...job, status });
    vi.mocked(readAdmission).mockReturnValue(admission(123));
    const helpers = makeHelpers();
    const log = vi.spyOn(console, "log");
    await sweepOrphanedMachines(makeConfig(false), helpers);
    expect(destroyMachine).toHaveBeenCalledWith(TOKEN, APP, "leftover");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[reaper] rule=stale-terminal-job machine=leftover"));
    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(invalidateNonce).not.toHaveBeenCalled();
    expect(helpers.resetTicket).not.toHaveBeenCalled();
  });
  it.each([[null, 7, "completed"], [123, 8, "completed"], [123, 7, "running"]] as const)("fences admission %s generation %s status %s", async (released, generation, status) => {
    vi.mocked(listMachines).mockResolvedValue([makeMachine("leftover")] as never);
    vi.mocked(getJobByMachineId).mockReturnValue({ ...job, status });
    vi.mocked(readAdmission).mockReturnValue(admission(released, generation));
    await sweepOrphanedMachines(makeConfig(false), makeHelpers());
    expect(destroyMachine).not.toHaveBeenCalled();
  });
  it("keeps a KG profile machine even when its last admission is released", async () => {
    const machine = makeMachine("leftover");
    machine.config.metadata = { ...machine.config.metadata, purpose: "durable-runner" } as typeof machine.config.metadata;
    vi.mocked(listMachines).mockResolvedValue([machine] as never);
    vi.mocked(getJobByMachineId).mockReturnValue({ ...job, phase: "kg-refresh" });
    vi.mocked(readAdmission).mockReturnValue(admission(123));
    await sweepOrphanedMachines(makeConfig(false), makeHelpers());
    expect(destroyMachine).not.toHaveBeenCalled();
  });
  it.each([null, 123])("boot reconciliation only removes released admissions (%s)", async (released) => {
    vi.mocked(readAdmission).mockReturnValue(admission(released));
    expect(await reconcileRestateMachine(makeConfig(false), job, "leftover", 60, "startup-stale-terminal")).toBe(true);
    expect(destroyMachine).toHaveBeenCalledTimes(released === null ? 0 : 1);
    expect(invalidateNonce).not.toHaveBeenCalled();
    expect(updateJobStatus).not.toHaveBeenCalled();
  });
  it.each(["No such container: leftover", "daemon unavailable"])("handles local removal error: %s", async (message) => {
    const { listAiImplementContainers, removeLocalContainer } = await import("../local-docker.js");
    vi.mocked(listAiImplementContainers).mockResolvedValue([{ id: "leftover", name: "runner", status: "Exited (0) 5 minutes ago" }]);
    vi.mocked(getJobByMachineId).mockReturnValue({ ...job, executionMode: "local-docker" });
    vi.mocked(readAdmission).mockReturnValue({ ...admission(123), backend: "local-docker" });
    vi.mocked(removeLocalContainer).mockRejectedValue(new Error(message));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await reconcileRestateLocalContainers(makeConfig(false));
    expect(errors).toHaveBeenCalledTimes(message.startsWith("No such") ? 0 : 1);
  });
  it.each([false, true])("reconciles local containers with dry run=%s", async (dryRun) => {
    const { listAiImplementContainers, removeLocalContainer } = await import("../local-docker.js");
    vi.mocked(listAiImplementContainers).mockResolvedValue([{ id: "leftover", name: "runner", status: "Exited (0) 5 minutes ago" }]);
    vi.mocked(getJobByMachineId).mockReturnValue({ ...job, executionMode: "local-docker" });
    vi.mocked(readAdmission).mockReturnValue({ ...admission(123), backend: "local-docker" });
    expect(await reconcileRestateLocalContainers(makeConfig(dryRun))).toEqual(["leftover"]);
    expect(removeLocalContainer).toHaveBeenCalledTimes(dryRun ? 0 : 1);
    expect(updateJobStatus).not.toHaveBeenCalled();
  });
  it("protects terminal held local containers from the Legacy sweep", async () => {
    const { listAiImplementContainers, removeLocalContainer } = await import("../local-docker.js");
    vi.mocked(listAiImplementContainers).mockResolvedValue([{ id: "leftover", name: "runner", status: "Exited (0) 5 minutes ago" }]);
    vi.mocked(getJobByMachineId).mockReturnValue({ ...job, executionMode: "local-docker" });
    vi.mocked(readAdmission).mockReturnValue({ ...admission(null), backend: "local-docker" });
    expect(await reconcileRestateLocalContainers(makeConfig(false), [])).toEqual(["leftover"]);
    expect(removeLocalContainer).not.toHaveBeenCalled();
  });
});

// Execute the production boot function with its dependencies supplied explicitly,
// without starting the orchestrator's HTTP server or poll loop.
async function runBoot(config: ReaperConfig, local = false) {
  const { readFileSync } = await import("node:fs");
  const ts = await import("typescript");
  const source = readFileSync("src/index.ts", "utf8");
  const start = source.indexOf("async function startupReconciliation(");
  const end = source.indexOf("// ---------- Reconciliation", start);
  const { isDurableRunnerMachine } = await import("../reaper.js");
  const dependencies = { getRunnerMode: () => ({ mode: local ? "local" : "default" }),
    reconcileRestateLocalContainers, reaperConfig: () => config, listMachines,
    isDurableRunnerMachine, recordReaperAction, getJobByMachineId, safeDestroyMachine,
    reconcileRestateMachine, invalidateNonce };
  const compiled = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const boot = new Function(...Object.keys(dependencies), `${compiled}; return startupReconciliation;`)(...Object.values(dependencies));
  await boot(config, config.registry);
}

async function runPeriodicLocal(config: ReaperConfig) {
  const { readFileSync } = await import("node:fs");
  const ts = await import("typescript");
  const source = readFileSync("src/index.ts", "utf8");
  const start = source.indexOf('  if (getRunnerMode().mode === "local") {', source.indexOf("// Local mode: reap exited containers"));
  const end = source.indexOf("// Reconciliation for admission reservations", start);
  const dependencies = { config, registry: config.registry, getRunnerMode: () => ({ mode: "local" }),
    getInFlightJobs: () => [], reconcileRestateLocalContainers, reaperConfig: () => config,
    sweepOrphanedMachines, makeReaperHelpers: makeHelpers };
  const compiled = ts.transpileModule(`async function reconcile() { ${source.slice(start, end)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  await new Function(...Object.keys(dependencies), `${compiled}; return reconcile();`)(...Object.values(dependencies));
}

describe("finished Restate cleanup integration regressions", () => {
  it("preserves Legacy Docker cleanup during Fly reaper dry run", async () => {
    const { listAiImplementContainers, removeLocalContainer } = await import("../local-docker.js");
    vi.mocked(listAiImplementContainers).mockResolvedValue([{ id: "legacy", name: "runner", status: "Exited" }]);
    vi.mocked(getJobByMachineId).mockReturnValue(makeJob({ status: "completed" }));
    await reconcileRestateLocalContainers(makeConfig(true), []);
    expect(removeLocalContainer).toHaveBeenCalledWith("legacy");
  });

  it.each(["Up 10 hours", "Created", "Paused", "Restarting (1) 5 minutes ago"])("preserves Legacy containers with status %s", async (status) => {
    const { listAiImplementContainers, removeLocalContainer } = await import("../local-docker.js");
    vi.mocked(listAiImplementContainers).mockResolvedValue([{ id: "legacy", name: "runner", status }]);
    vi.mocked(getJobByMachineId).mockReturnValue(makeJob({ status: "completed" }));
    vi.mocked(listMachines).mockResolvedValue([]);
    await runPeriodicLocal(makeConfig(false));
    expect(removeLocalContainer).not.toHaveBeenCalled();
  });

  it.each(["fly-machines", "local-docker"] as const)("requires explicit admission evidence for %s", (backend) => {
    vi.mocked(readAdmission).mockReturnValue(null);
    expect(canReapFinishedRestateJob(makeJob({ dispatchId: "missing", status: "completed", executionMode: backend }))).toBe(false);
  });

  it.each(["boot", "periodic"] as const)("%s wiring retains local cleanup and Fly ownership ordering", async (entry) => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/index.ts", "utf8");
    if (entry === "periodic") {
      // Pin the monitor call site as well as exercising its shared reconciliation below.
      expect(source).toContain("await reconcileRestateLocalContainers(reaperConfig(config, registry), inFlightMachineIds)");
      expect(source).toContain("await sweepOrphanedMachines(reaperConfig(config, registry), makeReaperHelpers(config, registry))");
    } else {
      vi.mocked(listMachines).mockResolvedValue([]);
      const { listAiImplementContainers, removeLocalContainer } = await import("../local-docker.js");
      vi.mocked(listAiImplementContainers).mockResolvedValue([{ id: "local", name: "runner", status: "Exited" }]);
      vi.mocked(getJobByMachineId).mockReturnValue(makeJob({ dispatchId: "owned", admissionGeneration: 7, status: "completed", executionMode: "local-docker" }));
      vi.mocked(readAdmission).mockReturnValue({ lifecycleOwner: { kind: "restate", attemptId: "owned" }, generation: 7, backend: "local-docker", releasedAt: 123 } as NonNullable<ReturnType<typeof readAdmission>>);
      await runBoot(makeConfig(false), true);
      expect(removeLocalContainer).toHaveBeenCalledWith("local");
    }
  });

  for (const backend of ["fly-machines", "local-docker"] as const) {
    for (const entry of ["boot", "periodic"] as const) {
      it.each(["released", "held", "running", "backend-mismatch", "github-actions", "running-container-released", "running-container-held"] as const)(`${entry} ${backend}: %s preserves workflow state`, async (scenario) => {
        const { listAiImplementContainers, removeLocalContainer } = await import("../local-docker.js");
        const job = makeJob({ dispatchId: "owned", admissionGeneration: 7, machineId: "leftover",
          executionMode: scenario === "github-actions" ? "github-actions" : scenario === "backend-mismatch" ? (backend === "fly-machines" ? "local-docker" : "fly-machines") : backend,
          status: scenario === "running" ? "running" : "completed", dispatchedAt: Date.now() - 10 * 60 * 60 * 1000 });
        const admission = { lifecycleOwner: { kind: "restate", attemptId: "owned" }, generation: 7,
          backend: job.executionMode, releasedAt: (scenario === "held" || scenario === "running-container-held") ? null : 123 } as NonNullable<ReturnType<typeof readAdmission>>;
        const before = structuredClone(admission);
        vi.mocked(readAdmission).mockReturnValue(admission);
        vi.mocked(getJobByMachineId).mockReturnValue(job);
        vi.mocked(listMachines).mockResolvedValue(backend === "fly-machines" ? [makeMachine("leftover", {
          state: "stopped", created_at: new Date(job.dispatchedAt).toISOString(),
        })] as never : []);
        vi.mocked(listAiImplementContainers).mockResolvedValue([{ id: "leftover", name: "runner", status: scenario.startsWith("running-container-") ? "Up 10 hours" : "Exited" }]);
        const helpers = makeHelpers();
        const config = makeConfig(false, { getMappings: () => ({ [job.teamKey!]: makeMapping() }),
          registry: makeRegistry({ provider: makeProvider({ fetchLifecycleStates: vi.fn(async () => new Map([[job.issueId!, "completed" as const]])) }) }) });
        const log = vi.spyOn(console, "log");
        if (entry === "boot") await runBoot(config, backend === "local-docker");
        else if (backend === "fly-machines") await sweepOrphanedMachines(config, helpers);
        else await runPeriodicLocal(config);
        const removal = backend === "fly-machines" ? destroyMachine : removeLocalContainer;
        expect(removal).toHaveBeenCalledTimes((scenario === "released" || scenario === "running-container-released") ? 1 : 0);
        if (scenario === "released" || scenario === "running-container-released") {
          expect(recordReaperAction).toHaveBeenCalledWith(expect.objectContaining({ machineId: "leftover", dryRun: false }));
          expect(log).toHaveBeenCalledWith(expect.stringMatching(/\[reaper\] rule=.* machine=leftover/));
        }
        expect(updateJobStatus).not.toHaveBeenCalled();
        expect(invalidateNonce).not.toHaveBeenCalled();
        expect(helpers.resetTicket).not.toHaveBeenCalled();
        expect(admission).toEqual(before);
      });
    }
  }
});
