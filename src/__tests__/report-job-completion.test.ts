import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import type * as BreakerModule from "../dispatch-breaker.js";
import type * as ConfigModule from "../config.js";
import type * as IndexModule from "../index.js";
import type * as RegistryModule from "../providers/registry.js";
import type * as DispatchAdmissionModule from "../dispatch-admission.js";
import type { FailureRecord } from "../pipeline/failure-classification.js";

// Integration coverage for BAC-27134 round-one item 7c: reportJobCompletion must not
// let a transient terminal failure count toward the dispatch breaker (a provider outage
// is the provider's problem, not the ticket's), while every other category still counts.
//
// AII-791 coverage (below): a runner callback's own terminal write must not, by itself,
// release the admission reservation it holds — only a verified backend termination may.

let dbPath: string;
let dedup: typeof DedupModule;
let log: typeof LogModule;
let breaker: typeof BreakerModule;
let dispatchAdmission: typeof DispatchAdmissionModule;
let configModule: typeof ConfigModule;
let indexModule: typeof IndexModule;
let registryModule: typeof RegistryModule;

const mockConfig = {
  githubAppId: "test-app-id",
  githubAppPrivateKey: "test-private-key",
  notifyWebhookUrl: null,
  notifyType: "slack",
  adminAccessCode: null,
  oauthRedirectBaseUrl: null,
  pollIntervalMs: 60_000,
  healthPort: 8080,
  flySessionsToken: null,
  flySessionsApp: null,
  flySessionsRegion: null,
  flyOrchestratorApp: null,
  flyDeployToken: null,
  tenantId: null,
  sessionImage: "test-image",
  sessionImageStatus: "unset",
  runnerImageExplicit: false,
  anthropicApiKey: null,
  claudeOAuthToken: null,
  githubWebhookSecret: null,
  reaperDryRun: true,
  reaperAlertThreshold: 5,
  runnerCallbackBaseUrl: null,
  runnerTokenSecret: null,
  localRunnerImage: "test-local-image",
  localRunnerOrchestratorUrl: null,
  kgSidecarUrl: null,
  kgSourceRepo: null,
  selfDeployTarget: null,
} as unknown as IndexModule.AppConfig;

function makeFailure(category: FailureRecord["category"]): FailureRecord {
  return {
    category,
    code: category === "transient" ? "PROVIDER_OVERLOADED" : "UNCLASSIFIED_CRASH",
    stage: "feedback-loop/implement-1",
    attempt: 1,
    retryable: category === "transient",
    message: `${category} failure`,
    evidence: { truncated: false },
  };
}

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `report-job-completion-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  delete process.env.DISPATCH_BREAKER_THRESHOLD;
  dedup = await import("../dedup.js");
  log = await import("../log.js");
  breaker = await import("../dispatch-breaker.js");
  configModule = await import("../config.js");
  registryModule = await import("../providers/registry.js");
  indexModule = await import("../index.js");
  dispatchAdmission = await import("../dispatch-admission.js");
  log.initLogTable();
  breaker.initDispatchBreakerTable();
  configModule.initMappingsTable();
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  delete process.env.DISPATCH_BREAKER_THRESHOLD;
});

function makeRegistry(): RegistryModule.ProviderRegistry {
  return new registryModule.ProviderRegistry({} as never, () => configModule.getMappings());
}

async function runReportOnce(): Promise<void> {
  const registry = makeRegistry();
  await indexModule.reportJobCompletion(mockConfig, registry);
}

describe("reportJobCompletion breaker integration (BAC-27134)", () => {
  it("does not call recordDispatchFailure for a terminal job whose failure.category is transient", async () => {
    const jobId = log.appendLog({ issueId: "issue-transient", issueIdentifier: "BAC-1", phase: "implementation" });
    log.updateJobStatus(jobId, "failed", "provider_unavailable");
    log.updateJobFailure(jobId, makeFailure("transient"));

    await runReportOnce();

    const state = breaker.isParked("issue-transient", "implementation");
    expect(state).toBe(false);
    // No breaker row at all: recordDispatchFailure was never invoked for this issue.
    const row = dedup
      .getDb()
      .prepare("SELECT consecutive_failures FROM dispatch_breaker WHERE issue_id = ? AND phase = ?")
      .get("issue-transient", "implementation") as { consecutive_failures: number } | undefined;
    expect(row).toBeUndefined();
  });

  it("calls recordDispatchFailure for a terminal job whose failure.category is crash", async () => {
    const jobId = log.appendLog({ issueId: "issue-crash", issueIdentifier: "BAC-2", phase: "implementation" });
    log.updateJobStatus(jobId, "failed", "crash");
    log.updateJobFailure(jobId, makeFailure("crash"));

    await runReportOnce();

    const row = dedup
      .getDb()
      .prepare("SELECT consecutive_failures FROM dispatch_breaker WHERE issue_id = ? AND phase = ?")
      .get("issue-crash", "implementation") as { consecutive_failures: number } | undefined;
    expect(row).toBeDefined();
    expect(row?.consecutive_failures).toBe(1);
  });
});

// AII-791: a runner callback reports its own business outcome (success/failure) from
// inside the still-running backend — that self-report is not proof the GHA run / Fly
// machine / local container has actually exited. log.ts's updateJobStatus only releases
// the admission reservation when the caller explicitly reports verified termination.
describe("admission reservation survives a callback-style terminal write (AII-791)", () => {
  it("leaves a Restate-owned terminal outcome to Restate rather than applying Legacy breaker actions", async () => {
    const admitted = dispatchAdmission.acquire({
      dispatchId: "restate-completion-1",
      mappingKey: "ENG",
      scope: { kind: "issue", issueScope: "ENG", issueId: "issue-restate-completion" },
      kind: "implementation",
      backend: "github-actions",
      lifecycleOwner: { kind: "restate", attemptId: "attempt-1" },
      cap: 2,
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const jobId = log.appendLog({
      issueId: "issue-restate-completion",
      issueIdentifier: "AII-REST",
      phase: "implementation",
      dispatchId: "restate-completion-1",
      admissionGeneration: admitted.record.generation,
    });
    log.updateJobStatus(jobId, "failed", "runner_failure");

    await runReportOnce();

    expect(log.getJobById(jobId)?.notifiedAt).toBeNull();
    const breakerRow = dedup.getDb().prepare("SELECT 1 FROM dispatch_breaker WHERE issue_id = ?").get("issue-restate-completion");
    expect(breakerRow).toBeUndefined();
    expect(dispatchAdmission.read("restate-completion-1")?.releasedAt).toBeNull();
  });
  it("stays occupied on a callback terminal write while the backend is still running", async () => {
    const dispatchId = "dispatch-callback-1";
    const admitted = dispatchAdmission.acquire({
      dispatchId,
      mappingKey: "ENG",
      scope: { kind: "issue", issueScope: "ENG", issueId: "issue-callback" },
      kind: "implementation",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 5,
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;

    const jobId = log.appendLog({
      issueId: "issue-callback",
      issueIdentifier: "BAC-3",
      phase: "implementation",
      dispatchId,
      admissionGeneration: admitted.record.generation,
    });

    // Mirrors the runner callback's own write: its business outcome is not evidence
    // that the GHA run itself has completed.
    log.updateJobStatus(jobId, "completed", "success");

    const record = dispatchAdmission.read(dispatchId);
    expect(record?.releasedAt).toBeNull();
    expect(dispatchAdmission.count("ENG")).toBe(1);
  });

  it("releases once a caller vouches for verified termination (contrast case)", async () => {
    const dispatchId = "dispatch-callback-2";
    const admitted = dispatchAdmission.acquire({
      dispatchId,
      mappingKey: "ENG",
      scope: { kind: "issue", issueScope: "ENG", issueId: "issue-callback-2" },
      kind: "implementation",
      backend: "github-actions",
      lifecycleOwner: { kind: "legacy" },
      cap: 5,
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;

    const jobId = log.appendLog({
      issueId: "issue-callback-2",
      issueIdentifier: "BAC-4",
      phase: "implementation",
      dispatchId,
      admissionGeneration: admitted.record.generation,
    });

    // The GHA monitor observed this exact run's completed status.
    log.updateJobStatus(jobId, "completed", "success", undefined, { backendTerminated: true });

    const record = dispatchAdmission.read(dispatchId);
    expect(record?.releasedAt).not.toBeNull();
    expect(dispatchAdmission.count("ENG")).toBe(0);
  });
});
