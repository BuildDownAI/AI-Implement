import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RepoMapping } from "../config.js";
import type * as DedupModule from "../dedup.js";
import type * as BreakerModule from "../dispatch-breaker.js";
import type * as LifecycleModule from "../filesystem-ticket-lifecycle.js";
import type * as LogModule from "../log.js";
import type { FilesystemProvider } from "../providers/filesystem.js";

let dbPath: string;
let ticketDir: string;
let mappings: Record<string, RepoMapping>;
let dedup: typeof DedupModule;
let breaker: typeof BreakerModule;
let lifecycle: typeof LifecycleModule;
let log: typeof LogModule;
let provider: FilesystemProvider;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `filesystem-ticket-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  ticketDir = fs.mkdtempSync(path.join(os.tmpdir(), "filesystem-ticket-lifecycle-"));
  mappings = { FS: makeMapping() };
  vi.stubEnv("DEDUP_DB_PATH", dbPath);
  vi.doMock("../config.js", () => ({ getMappings: () => mappings }));
  vi.doMock("../runner-mode.js", () => ({ getRunnerMode: () => ({ mode: "local", source: "env" }) }));

  dedup = await import("../dedup.js");
  log = await import("../log.js");
  breaker = await import("../dispatch-breaker.js");
  const providerModule = await import("../providers/filesystem.js");
  lifecycle = await import("../filesystem-ticket-lifecycle.js");
  dedup.getDb();
  log.initLogTable();
  breaker.initDispatchBreakerTable();
  provider = new providerModule.FilesystemProvider(() => mappings);
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  try { fs.rmSync(ticketDir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function makeMapping(overrides: Partial<RepoMapping> = {}): RepoMapping {
  return {
    owner: "BuildDownAI",
    repo: "AI-Implement",
    workflowFile: "claude-implement.yml",
    defaultBranch: "main",
    maxInProgressAiIssues: 3,
    executionMode: "github-actions",
    sessionMode: "autonomous",
    machineCpus: 2,
    machineMemoryMb: 4096,
    planningEnabled: true,
    planningWorkflowFile: "claude-plan.yml",
    autoApprovePlans: true,
    autoMerge: false,
    extraEnv: {},
    provider: "anthropic",
    awsRegion: null,
    ticketingProvider: "filesystem",
    ticketingConfig: { kind: "filesystem", directory: ticketDir },
    paused: false,
    maxTurns: null,
    maxIterations: null,
    maxJobMinutes: null,
    branchPrefix: null,
    skillsRepo: null,
    referenceRepos: null,
    sensitiveAddPatterns: null,
    sensitiveAllowPatterns: null,
    dependencyTokenScope: null,
    memoryProviderId: null,
    reviewers: null,
    ...overrides,
  };
}

function issueId(identifier: string): string {
  return `filesystem:FS:${identifier}`;
}

function writeTicket(
  identifier: string,
  options: {
    location?: "active" | "failed";
    status?: "ready" | "plan-approved" | "implementing" | "failed";
    phase?: "planning" | "implementation";
    prUrls?: string[];
  } = {},
): void {
  const location = options.location ?? "active";
  const dir = location === "active" ? ticketDir : path.join(ticketDir, location);
  fs.mkdirSync(path.join(ticketDir, ".state", "FS"), { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${identifier}.md`), [
    "---",
    `title: ${identifier} lifecycle`,
    `id: ${identifier}`,
    "---",
    "",
    "Validate filesystem lifecycle behavior.",
  ].join("\n"));
  fs.writeFileSync(path.join(ticketDir, ".state", "FS", `${identifier}.json`), JSON.stringify({
    version: 1,
    status: options.status ?? "failed",
    comments: [],
    prUrls: options.prUrls ?? [],
    ...(options.phase ? { failurePhase: options.phase } : {}),
    updatedAt: "2026-09-14T20:00:00.000Z",
  }));
}

function rowExists(table: string, issue: string): boolean {
  return Boolean(dedup.getDb().prepare(`SELECT 1 FROM ${table} WHERE issue_id = ?`).get(issue));
}

function registryForFilesystemProvider() {
  return {
    forMapping: vi.fn(async () => provider),
  };
}

describe("filesystem ticket lifecycle", () => {
  it("retries an eligible failed ticket and clears dispatch guards before restoring it", async () => {
    const id = issueId("FS-101");
    writeTicket("FS-101", { location: "failed", status: "failed", phase: "implementation" });
    dedup.markDispatched(id, "FS-101", "Retry me");
    breaker.recordDispatchFailure(id, "implementation", "failure");
    breaker.recordDispatchFailure(id, "implementation", "failure");
    breaker.recordDispatchFailure(id, "implementation", "failure");
    dedup.getDb().prepare("INSERT INTO stuck_attempts (issue_id, attempts, last_attempt_at) VALUES (?, 4, ?)").run(id, Date.now());
    dedup.getDb().prepare("INSERT INTO runner_tokens (dispatch_id, audience, issue_id, phase, expires_at, mapping_team_key) VALUES (?, 'result', ?, 'implementation', ?, 'FS')").run("dispatch-1", id, Date.now() + 60_000);
    const staleJob = log.appendLog({ issueId: id, issueIdentifier: "FS-101", teamKey: "FS", phase: "implementation" });
    log.updateJobStatus(staleJob, "failed", "failure");

    await expect(lifecycle.retryFilesystemTicket(provider, id, "FS")).resolves.toEqual({ retried: true });

    expect(fs.existsSync(path.join(ticketDir, "FS-101.md"))).toBe(true);
    expect(fs.existsSync(path.join(ticketDir, "failed", "FS-101.md"))).toBe(false);
    expect(dedup.isAlreadyDispatched(id)).toBe(false);
    expect(breaker.isParked(id, "implementation")).toBe(false);
    expect(log.getStuckAttempts(id)).toBe(0);
    expect(rowExists("runner_tokens", id)).toBe(false);
    expect(dedup.getDb().prepare("SELECT notified_at FROM dispatch_log WHERE id = ?").get(staleJob)).toMatchObject({ notified_at: expect.any(Number) });
    await expect(provider.readIssueDetails(id)).resolves.toMatchObject({
      location: "active",
      state: { status: "plan-approved", prUrls: [] },
    });
  });

  it("refuses retry for failed tickets with pull requests and leaves guards intact", async () => {
    const id = issueId("FS-102");
    writeTicket("FS-102", {
      location: "failed",
      status: "failed",
      phase: "implementation",
      prUrls: ["https://github.com/BuildDownAI/AI-Implement/pull/102"],
    });
    dedup.markDispatched(id, "FS-102", "Has a PR");

    await expect(lifecycle.retryFilesystemTicket(provider, id, "FS")).resolves.toEqual({
      retried: false,
      error: "This ticket already has a pull request. Continue from that PR instead of creating another run.",
    });

    expect(fs.existsSync(path.join(ticketDir, "failed", "FS-102.md"))).toBe(true);
    expect(dedup.isAlreadyDispatched(id)).toBe(true);
  });

  it("archives a terminal filesystem ticket when watchdog attempts are exhausted after state reset", async () => {
    const id = issueId("FS-201");
    writeTicket("FS-201", { status: "plan-approved" });
    dedup.markDispatched(id, "FS-201", "Exhausted");
    dedup.getDb().prepare("INSERT INTO stuck_attempts (issue_id, attempts, last_attempt_at) VALUES (?, 4, ?)").run(id, Date.now());
    log.updateJobStatus(log.appendLog({ issueId: id, issueIdentifier: "FS-201", teamKey: "FS", phase: "implementation" }), "failed", "failure");

    await lifecycle.reconcileFilesystemFailures(registryForFilesystemProvider() as never);

    expect(fs.existsSync(path.join(ticketDir, "failed", "FS-201.md"))).toBe(true);
    expect(fs.existsSync(path.join(ticketDir, "FS-201.md"))).toBe(false);
    await expect(provider.readIssueDetails(id)).resolves.toMatchObject({
      location: "failed",
      state: { status: "failed", failurePhase: "implementation", prUrls: [] },
    });
  });

  it("archives a planning callback failure immediately because planning has no watchdog retry", async () => {
    const id = issueId("FS-202");
    writeTicket("FS-202", { status: "failed", phase: "planning" });
    log.updateJobStatus(log.appendLog({ issueId: id, issueIdentifier: "FS-202", teamKey: "FS", phase: "planning" }), "failed", "failure");

    await lifecycle.reconcileFilesystemFailures(registryForFilesystemProvider() as never);

    expect(fs.existsSync(path.join(ticketDir, "failed", "FS-202.md"))).toBe(true);
    expect(fs.existsSync(path.join(ticketDir, "FS-202.md"))).toBe(false);
    await expect(provider.readIssueDetails(id)).resolves.toMatchObject({
      location: "failed",
      state: { status: "failed", failurePhase: "planning", prUrls: [] },
    });
  });

  it("archives direct failed implementation state as a terminal manual failure", async () => {
    const id = issueId("FS-203");
    writeTicket("FS-203", { status: "failed", phase: "implementation" });
    log.updateJobStatus(log.appendLog({ issueId: id, issueIdentifier: "FS-203", teamKey: "FS", phase: "implementation" }), "failed", "failure");

    await lifecycle.reconcileFilesystemFailures(registryForFilesystemProvider() as never);

    expect(fs.existsSync(path.join(ticketDir, "failed", "FS-203.md"))).toBe(true);
    expect(fs.existsSync(path.join(ticketDir, "FS-203.md"))).toBe(false);
  });

  it("uses provider archiveFailed to stamp failed state for exhausted tickets reset to ready", async () => {
    const id = issueId("FS-204");
    writeTicket("FS-204", { status: "ready" });
    dedup.markDispatched(id, "FS-204", "Reset exhausted");
    dedup.getDb().prepare("INSERT INTO stuck_attempts (issue_id, attempts, last_attempt_at) VALUES (?, 4, ?)").run(id, Date.now());
    log.updateJobStatus(log.appendLog({ issueId: id, issueIdentifier: "FS-204", teamKey: "FS", phase: "planning" }), "timed_out", "failure");

    await lifecycle.reconcileFilesystemFailures(registryForFilesystemProvider() as never);

    expect(fs.existsSync(path.join(ticketDir, "failed", "FS-204.md"))).toBe(true);
    await expect(provider.readIssueDetails(id)).resolves.toMatchObject({
      location: "failed",
      state: { status: "failed", failurePhase: "planning", prUrls: [] },
    });
  });

  it("does not archive automatic requeues, PR-backed tickets, or in-flight jobs", async () => {
    const requeued = issueId("FS-301");
    const withPr = issueId("FS-302");
    const inFlight = issueId("FS-303");
    writeTicket("FS-301", { status: "failed", phase: "implementation" });
    writeTicket("FS-302", {
      status: "failed",
      phase: "implementation",
      prUrls: ["https://github.com/BuildDownAI/AI-Implement/pull/302"],
    });
    writeTicket("FS-303", { status: "failed", phase: "implementation" });
    dedup.markDispatched(requeued, "FS-301", "Requeue");
    dedup.markDispatched(withPr, "FS-302", "PR");
    dedup.markDispatched(inFlight, "FS-303", "Inflight");
    dedup.getDb().prepare("INSERT INTO stuck_attempts (issue_id, attempts, last_attempt_at) VALUES (?, 4, ?)").run(requeued, Date.now());
    dedup.getDb().prepare("INSERT INTO stuck_attempts (issue_id, attempts, last_attempt_at) VALUES (?, 4, ?)").run(withPr, Date.now());
    dedup.getDb().prepare("INSERT INTO stuck_attempts (issue_id, attempts, last_attempt_at) VALUES (?, 4, ?)").run(inFlight, Date.now());
    log.updateJobStatus(log.appendLog({ issueId: requeued, issueIdentifier: "FS-301", teamKey: "FS", phase: "implementation" }), "timed_out", "stuck_requeued");
    log.updateJobStatus(log.appendLog({ issueId: withPr, issueIdentifier: "FS-302", teamKey: "FS", phase: "implementation" }), "failed", "failure");
    log.appendLog({ issueId: inFlight, issueIdentifier: "FS-303", teamKey: "FS", phase: "implementation", status: "running" });

    await lifecycle.reconcileFilesystemFailures(registryForFilesystemProvider() as never);

    for (const identifier of ["FS-301", "FS-302", "FS-303"]) {
      expect(fs.existsSync(path.join(ticketDir, `${identifier}.md`))).toBe(true);
      expect(fs.existsSync(path.join(ticketDir, "failed", `${identifier}.md`))).toBe(false);
    }
  });
});
