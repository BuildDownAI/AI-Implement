import { link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepoMapping } from "../../config.js";
import { FilesystemProvider } from "../../providers/filesystem.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn(actual.link) };
});

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
  vi.mocked(link).mockClear();
});

function mapping(overrides: Partial<RepoMapping> & { directory: string; planningEnabled?: boolean }): RepoMapping {
  return {
    owner: "acme",
    repo: "widgets",
    workflowFile: "claude-implement.yml",
    defaultBranch: "main",
    maxInProgressAiIssues: 3,
    executionMode: "github-actions",
    sessionMode: "autonomous",
    machineCpus: 2,
    machineMemoryMb: 4096,
    planningEnabled: overrides.planningEnabled ?? true,
    planningWorkflowFile: "claude-plan.yml",
    autoApprovePlans: true,
    autoMerge: false,
    extraEnv: {},
    provider: "anthropic",
    ticketingProvider: "filesystem",
    ticketingConfig: { kind: "filesystem", directory: overrides.directory },
    awsRegion: null,
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

async function tempTicketDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ai-implement-fs-provider-"));
  tempDirs.push(dir);
  return dir;
}

async function writeTask(dir: string, filename: string, body: string): Promise<void> {
  await writeFile(join(dir, filename), body, "utf8");
}

function provider(mappings: Record<string, RepoMapping>): FilesystemProvider {
  return new FilesystemProvider(() => mappings);
}

describe("FilesystemProvider", () => {
  it("persists lifecycle state and parsed task limits across provider restarts", async () => {
    const dir = await tempTicketDir();
    await writeTask(dir, "AII-1.md", [
      "---",
      "title: Exercise the review loop",
      "base: testing",
      "profiles:",
      "  - backend",
      "limits:",
      "  maxTurns: 12",
      "  maxIterations: 4",
      "---",
      "",
      "Make a deliberately small change.",
    ].join("\n"));

    const mappings = { AII: mapping({ directory: dir }) };
    const p1 = provider(mappings);
    let snap = await p1.fetchAIImplementSnapshot();
    expect(snap.needsPlanning.map((issue) => issue.identifier)).toEqual(["AII-1"]);
    expect(snap.needsPlanning[0]).toMatchObject({
      id: "filesystem:AII:AII-1",
      baseBranch: "testing",
      profiles: ["backend"],
      maxTurns: 12,
      maxIterations: 4,
    });

    await p1.markPlanningStarted("filesystem:AII:AII-1", "AII");
    snap = await p1.fetchAIImplementSnapshot();
    expect(snap.inProgressCountsByScope).toEqual({ AII: 1 });

    await p1.postComment(
      "filesystem:AII:AII-1",
      "## 🗺 AI Planning: Implementation Map\n\nTouch the local harness.",
    );
    await p1.markPlanComplete("filesystem:AII:AII-1", "AII");

    const p2 = provider(mappings);
    snap = await p2.fetchAIImplementSnapshot();
    expect(snap.needsPlanning).toEqual([]);
    expect(snap.readyForImplementation.map((issue) => issue.identifier)).toEqual(["AII-1"]);
    await expect(p2.fetchPlanningContext("filesystem:AII:AII-1")).resolves.toContain("Touch the local harness.");

    await p2.markPrReady("filesystem:AII:AII-1", "AII", "https://github.com/acme/widgets/pull/1");
    snap = await provider(mappings).fetchAIImplementSnapshot();
    expect(snap.readyForImplementation).toEqual([]);
    const state = JSON.parse(await readFile(join(dir, ".state", "AII", "AII-1.json"), "utf8"));
    expect(state.prUrls).toEqual(["https://github.com/acme/widgets/pull/1"]);
  });

  it("returns admin issue URLs for exact scoped filesystem issue ids", async () => {
    const p = provider({});
    expect(p.issueUrl({
      id: "filesystem:SAN2:SAN2-001",
      identifier: "SAN2-001",
      title: "Make the jellyfish pulse less",
      description: null,
      scopeKey: "SAN2",
      nativeStatus: "ready",
    })).toBe("/admin?filesystemIssue=filesystem%3ASAN2%3ASAN2-001");
  });

  it("reads issue details without creating missing state", async () => {
    const dir = await tempTicketDir();
    await writeTask(dir, "SAN2-1.md", "---\ntitle: Local detail\n---\n\nShow me.");
    const p = provider({ SAN2: mapping({ directory: dir }) });

    const details = await p.readIssueDetails("filesystem:SAN2:SAN2-1");

    expect(details?.issue).toMatchObject({
      id: "filesystem:SAN2:SAN2-1",
      identifier: "SAN2-1",
      title: "Local detail",
      scopeKey: "SAN2",
    });
    expect(details?.markdown).toContain("Show me.");
    expect(details?.state).toBeNull();
    expect(details?.statePath).toBe(".state/SAN2/SAN2-1.json");
    await expect(readFile(join(dir, ".state", "SAN2", "SAN2-1.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns null details for corrupt state and duplicate scoped identifiers", async () => {
    const dir = await tempTicketDir();
    await writeTask(dir, "SAN2-2.md", "---\ntitle: Corrupt state\n---\n\nSkip.");
    await writeTask(dir, "duplicate.md", "---\ntitle: Duplicate\nid: SAN2-3\n---\n\nFirst.");
    await writeTask(dir, "SAN2-3.md", "---\ntitle: Duplicate\n---\n\nSecond.");
    await mkdir(join(dir, ".state", "SAN2"), { recursive: true });
    await writeFile(join(dir, ".state", "SAN2", "SAN2-2.json"), "{broken", "utf8");
    const p = provider({ SAN2: mapping({ directory: dir }) });

    await expect(p.readIssueDetails("filesystem:SAN2:SAN2-2")).resolves.toBeNull();
    await expect(p.readIssueDetails("filesystem:SAN2:SAN2-3")).resolves.toBeNull();
  });

  it("rejects detail reads for invalid scoped issue ids before scanning", async () => {
    const p = provider({});
    await expect(p.readIssueDetails("linear-issue")).rejects.toThrow(/Invalid filesystem issueId/);
    await expect(p.readIssueDetails("filesystem:../SAN2:SAN2-1")).rejects.toThrow(/Invalid filesystem/);
  });

  it("puts new tasks directly in the implementation bucket when planning is disabled", async () => {
    const dir = await tempTicketDir();
    await writeTask(dir, "AII-2.md", "---\ntitle: No planning\n---\n\nImplement directly.");
    const snap = await provider({ AII: mapping({ directory: dir, planningEnabled: false }) }).fetchAIImplementSnapshot();
    expect(snap.needsPlanning).toEqual([]);
    expect(snap.readyForImplementation.map((issue) => issue.identifier)).toEqual(["AII-2"]);
  });

  it("fails closed on malformed documents, corrupt state, and duplicate identifiers in one scope", async () => {
    const dir = await tempTicketDir();
    await writeTask(dir, "AII-3.md", "---\ntitle: Valid\n---\n\nOk.");
    await writeTask(dir, "AII-4.md", "No front matter");
    await writeTask(dir, "AII-5.md", "---\ntitle: First\nid: AII-6\n---\n\nDuplicate.");
    await writeTask(dir, "AII-6.md", "---\ntitle: Second\n---\n\nDuplicate.");
    await mkdir(join(dir, ".state", "AII"), { recursive: true });
    await writeFile(join(dir, ".state", "AII", "AII-3.json"), "{broken", "utf8");

    const snap = await provider({ AII: mapping({ directory: dir }) }).fetchAIImplementSnapshot();
    expect(snap.needsPlanning).toEqual([]);
    expect(snap.readyForImplementation).toEqual([]);
  });

  it("keeps identifiers scoped and refuses ambiguous findByKey results", async () => {
    const dirA = await tempTicketDir();
    const dirB = await tempTicketDir();
    await writeTask(dirA, "AII-7.md", "---\ntitle: One\n---\n\nA.");
    await writeTask(dirB, "AII-7.md", "---\ntitle: Two\n---\n\nB.");
    const p = provider({
      A: mapping({ directory: dirA }),
      B: mapping({ directory: dirB }),
    });

    expect(await p.findByKey("AII-7")).toBeNull();
    await expect(p.markPlanningStarted("filesystem:A:AII-7", "B")).rejects.toThrow(/does not belong/);
  });

  it("serializes concurrent comments without losing updates", async () => {
    const dir = await tempTicketDir();
    await writeTask(dir, "AII-8.md", "---\ntitle: Comment storm\n---\n\nCollect comments.");
    const p = provider({ AII: mapping({ directory: dir }) });

    await Promise.all(Array.from({ length: 20 }, (_, i) => p.postComment("filesystem:AII:AII-8", `comment ${i}`)));

    const state = JSON.parse(await readFile(join(dir, ".state", "AII", "AII-8.json"), "utf8"));
    expect(state.comments).toHaveLength(20);
    expect(new Set(state.comments.map((comment: { body: string }) => comment.body)).size).toBe(20);
  });

  it("preserves terminal state against late failures, resets, and PR callbacks", async () => {
    const dir = await tempTicketDir();
    await writeTask(dir, "AII-9.md", "---\ntitle: Terminal guard\n---\n\nDone.");
    const p = provider({ AII: mapping({ directory: dir }) });

    await p.markMerged("filesystem:AII:AII-9", "AII");
    await expect(p.markImplementationFailed("filesystem:AII:AII-9", "AII", "late")).resolves.toBe(false);
    await expect(p.clearWorkingState("filesystem:AII:AII-9", "AII")).resolves.toBe(false);
    await expect(p.markPrReady("filesystem:AII:AII-9", "AII", "https://github.com/acme/widgets/pull/9")).resolves.toBe(false);

    const state = JSON.parse(await readFile(join(dir, ".state", "AII", "AII-9.json"), "utf8"));
    expect(state.status).toBe("completed");
    expect(state.comments).toEqual([]);
    expect(await p.fetchLifecycleStates(["filesystem:AII:AII-9"])).toEqual(new Map([["filesystem:AII:AII-9", "completed"]]));
  });

  it("ignores symlinked task files", async () => {
    const dir = await tempTicketDir();
    const target = join(await tempTicketDir(), "target.md");
    await writeFile(target, "---\ntitle: Linked\nid: AII-10\n---\n\nIgnore.", "utf8");
    await symlink(target, join(dir, "AII-10.md"));

    const snap = await provider({ AII: mapping({ directory: dir }) }).fetchAIImplementSnapshot();
    expect(snap.needsPlanning).toEqual([]);
  });

  it("accepts an explicit identifier independently of the filename", async () => {
    const dir = await tempTicketDir();
    await writeTask(dir, "version-endpoint.md", "---\ntitle: Version endpoint\nid: LOCAL-1\n---\nImplement.");
    const snapshot = await provider({ LOCAL: mapping({ directory: dir }) }).fetchAIImplementSnapshot();
    expect(snapshot.needsPlanning[0]?.identifier).toBe("LOCAL-1");
  });

  it.each(["root", "scope", "file"])("refuses a symlinked state %s without writing outside the ticket directory", async (kind) => {
    const dir = await tempTicketDir();
    const outside = await tempTicketDir();
    await writeTask(dir, "LOCAL-2.md", "---\ntitle: State safety\n---\nImplement.");
    if (kind === "root") await symlink(outside, join(dir, ".state"));
    if (kind === "scope") {
      await mkdir(join(dir, ".state"));
      await symlink(outside, join(dir, ".state", "LOCAL"));
    }
    if (kind === "file") {
      await mkdir(join(dir, ".state", "LOCAL"), { recursive: true });
      await symlink(join(outside, "missing.json"), join(dir, ".state", "LOCAL", "LOCAL-2.json"));
    }
    const p = provider({ LOCAL: mapping({ directory: dir }) });
    expect((await p.fetchAIImplementSnapshot()).needsPlanning).toEqual([]);
    await expect(p.markPlanningStarted("filesystem:LOCAL:LOCAL-2", "LOCAL")).rejects.toThrow(/Unknown filesystem issue/);
    await expect(readFile(join(outside, "LOCAL-2.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(outside, "missing.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes writes across provider replacements and ignores stale planning callbacks", async () => {
    const dir = await tempTicketDir();
    await writeTask(dir, "LOCAL-3.md", "---\ntitle: Restart safety\n---\nImplement.");
    const mappings = { LOCAL: mapping({ directory: dir }) };
    const first = provider(mappings);
    const second = provider(mappings);
    const id = "filesystem:LOCAL:LOCAL-3";
    await first.markPlanComplete(id, "LOCAL");
    await second.markImplementing(id, "LOCAL");
    await first.markPlanComplete(id, "LOCAL");
    await first.markPlanningFailed(id, "LOCAL", "stale");
    expect((await second.fetchAIImplementSnapshot()).inProgressCountsByScope).toEqual({ LOCAL: 1 });
    await Promise.all([first.postComment(id, "first"), second.postComment(id, "second")]);
    const state = JSON.parse(await readFile(join(dir, ".state", "LOCAL", "LOCAL-3.json"), "utf8"));
    expect(state.comments.map((comment: { body: string }) => comment.body)).toEqual(["first", "second"]);
  });

  it("archives completed tickets after merge while keeping details lifecycle and key lookup available", async () => {
    const dir = await tempTicketDir();
    await writeTask(dir, "LOCAL-4.md", "---\ntitle: Completed archive\n---\nDone.");
    const p = provider({ LOCAL: mapping({ directory: dir }) });
    const id = "filesystem:LOCAL:LOCAL-4";

    await p.markMerged(id, "LOCAL");

    await expect(lstat(join(dir, "LOCAL-4.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(dir, "completed", "LOCAL-4.md"), "utf8")).resolves.toContain("Completed archive");
    await expect(p.fetchAIImplementSnapshot()).resolves.toMatchObject({
      needsPlanning: [],
      readyForImplementation: [],
    });
    await expect(p.fetchLifecycleStates([id])).resolves.toEqual(new Map([[id, "completed"]]));
    await expect(p.findByKey("LOCAL-4")).resolves.toMatchObject({ id });
    await expect(p.readIssueDetails(id)).resolves.toMatchObject({
      location: "completed",
      ticketPath: "completed/LOCAL-4.md",
      statePath: ".state/LOCAL/LOCAL-4.json",
    });
  });

  it("reconciles preexisting completed root files during snapshot polling", async () => {
    const dir = await tempTicketDir();
    const id = "filesystem:LOCAL:LOCAL-5";
    await writeTask(dir, "LOCAL-5.md", "---\ntitle: Preexisting completed\n---\nDone.");
    await mkdir(join(dir, ".state", "LOCAL"), { recursive: true });
    await writeFile(join(dir, ".state", "LOCAL", "LOCAL-5.json"), JSON.stringify({
      version: 1,
      status: "completed",
      comments: [],
      prUrls: [],
      updatedAt: "2026-09-14T00:00:00.000Z",
    }), "utf8");

    const snap = await provider({ LOCAL: mapping({ directory: dir }) }).fetchAIImplementSnapshot();

    expect(snap.needsPlanning).toEqual([]);
    await expect(readFile(join(dir, "completed", "LOCAL-5.md"), "utf8")).resolves.toContain("Preexisting completed");
    await expect(provider({ LOCAL: mapping({ directory: dir }) }).readIssueDetails(id)).resolves.toMatchObject({
      location: "completed",
      ticketPath: "completed/LOCAL-5.md",
    });
  });

  it("explicitly archives failed tickets and retries them without dropping history", async () => {
    const dir = await tempTicketDir();
    const id = "filesystem:LOCAL:LOCAL-6";
    const p = provider({ LOCAL: mapping({ directory: dir }) });
    await writeTask(dir, "retry-me.md", "---\ntitle: Retry me\nid: LOCAL-6\n---\nTry again.");

    await expect(p.markPlanningFailed(id, "LOCAL", "needs a human")).resolves.toBe(true);
    await expect(p.archiveFailed(id, "LOCAL", "planning")).resolves.toBe(true);
    await expect(readFile(join(dir, "failed", "retry-me.md"), "utf8")).resolves.toContain("Try again");
    await expect(p.fetchAIImplementSnapshot()).resolves.toMatchObject({
      needsPlanning: [],
      readyForImplementation: [],
    });

    await expect(p.retryFailed(id, "LOCAL")).resolves.toBe(true);
    await expect(readFile(join(dir, "retry-me.md"), "utf8")).resolves.toContain("Try again");
    await expect(lstat(join(dir, "failed", "retry-me.md"))).rejects.toMatchObject({ code: "ENOENT" });
    const state = JSON.parse(await readFile(join(dir, ".state", "LOCAL", "LOCAL-6.json"), "utf8"));
    expect(state.status).toBe("ready");
    expect(state.failurePhase).toBeUndefined();
    expect(state.comments.map((comment: { body: string }) => comment.body)).toEqual(["⚠️ Planning failed: needs a human"]);
    expect((await p.fetchAIImplementSnapshot()).needsPlanning.map((issue) => issue.id)).toEqual([id]);
  });

  it("archives exhausted active tickets after watchdog reset by stamping failed state before moving", async () => {
    const dir = await tempTicketDir();
    const planningId = "filesystem:LOCAL:LOCAL-17";
    const implementationId = "filesystem:LOCAL:LOCAL-18";
    const terminalId = "filesystem:LOCAL:LOCAL-19";
    const p = provider({ LOCAL: mapping({ directory: dir }) });
    await writeTask(dir, "LOCAL-17.md", "---\ntitle: Parked planning\n---\nArchive after reset.");
    await writeTask(dir, "LOCAL-18.md", "---\ntitle: Parked implementation\n---\nArchive after reset.");
    await writeTask(dir, "LOCAL-19.md", "---\ntitle: Has PR\n---\nDo not archive.");

    await p.markPlanningStarted(planningId, "LOCAL");
    await expect(p.clearWorkingState(planningId, "LOCAL")).resolves.toBe(true);
    await p.markImplementing(implementationId, "LOCAL");
    await expect(p.clearWorkingState(implementationId, "LOCAL")).resolves.toBe(true);
    await p.markPrReady(terminalId, "LOCAL", "https://github.com/acme/widgets/pull/19");

    await expect(p.archiveFailed(planningId, "LOCAL", "planning")).resolves.toBe(true);
    await expect(p.archiveFailed(implementationId, "LOCAL", "implementation")).resolves.toBe(true);
    await expect(p.archiveFailed(terminalId, "LOCAL", "implementation")).resolves.toBe(false);

    await expect(p.readIssueDetails(planningId)).resolves.toMatchObject({
      location: "failed",
      ticketPath: "failed/LOCAL-17.md",
      state: { status: "failed", failurePhase: "planning" },
    });
    await expect(p.readIssueDetails(implementationId)).resolves.toMatchObject({
      location: "failed",
      ticketPath: "failed/LOCAL-18.md",
      state: { status: "failed", failurePhase: "implementation" },
    });
    await expect(readFile(join(dir, "LOCAL-19.md"), "utf8")).resolves.toContain("Has PR");
  });

  it("recovers retry when a previous restore moved the file but failed before state reset", async () => {
    const dir = await tempTicketDir();
    const id = "filesystem:LOCAL:LOCAL-20";
    const p = provider({ LOCAL: mapping({ directory: dir }) });
    await writeTask(dir, "LOCAL-20.md", "---\ntitle: Root failed retry\n---\nRetry recovery.");
    await p.markPlanningFailed(id, "LOCAL", "write failed after move");

    expect((await p.fetchAIImplementSnapshot()).needsPlanning).toEqual([]);
    await expect(p.retryFailed(id, "LOCAL")).resolves.toBe(true);
    expect((await p.fetchAIImplementSnapshot()).needsPlanning.map((issue) => issue.id)).toEqual([id]);
    const state = JSON.parse(await readFile(join(dir, ".state", "LOCAL", "LOCAL-20.json"), "utf8"));
    expect(state.status).toBe("ready");
    expect(state.failurePhase).toBeUndefined();
  });

  it("archives exhausted dispatch failures before a runner created state", async () => {
    const dir = await tempTicketDir();
    const id = "filesystem:LOCAL:LOCAL-22";
    const p = provider({ LOCAL: mapping({ directory: dir }) });
    await writeTask(dir, "LOCAL-22.md", "---\ntitle: Never started\n---\nRunner unavailable.");
    await expect(p.archiveFailed(id, "LOCAL", "implementation")).resolves.toBe(true);
    expect(await p.readIssueDetails(id)).toMatchObject({ location: "failed", state: { status: "failed", failurePhase: "implementation" } });
    expect((await p.fetchAIImplementSnapshot()).needsPlanning).toEqual([]);
  });

  it("retries implementation failures to plan-approved and refuses known PR histories", async () => {
    const dir = await tempTicketDir();
    const id = "filesystem:LOCAL:LOCAL-7";
    const p = provider({ LOCAL: mapping({ directory: dir }) });
    await writeTask(dir, "LOCAL-7.md", "---\ntitle: Retry implementation\n---\nTry implementation again.");

    await p.markImplementing(id, "LOCAL");
    await expect(p.markImplementationFailed(id, "LOCAL", "tests failed")).resolves.toBe(true);
    await expect(p.archiveFailed(id, "LOCAL", "implementation")).resolves.toBe(true);
    await expect(p.markPrReady(id, "LOCAL", "https://github.com/acme/widgets/pull/7")).resolves.toBe(false);
    await expect(p.retryFailed(id, "LOCAL")).resolves.toBe(true);
    expect((await p.fetchAIImplementSnapshot()).readyForImplementation.map((issue) => issue.id)).toEqual([id]);

    await p.markPrReady(id, "LOCAL", "https://github.com/acme/widgets/pull/7");
    await expect(p.markImplementationFailed(id, "LOCAL", "late")).resolves.toBe(false);
    await expect(p.archiveFailed(id, "LOCAL", "implementation")).resolves.toBe(false);
  });

  it("does not dispatch archived failed tickets or manual root moves without retry reset", async () => {
    const dir = await tempTicketDir();
    const id = "filesystem:LOCAL:LOCAL-8";
    const p = provider({ LOCAL: mapping({ directory: dir }) });
    await writeTask(dir, "LOCAL-8.md", "---\ntitle: Manual restore\n---\nKeep failed.");

    await p.markPlanningFailed(id, "LOCAL", "manual");
    await p.archiveFailed(id, "LOCAL", "planning");
    await rename(join(dir, "failed", "LOCAL-8.md"), join(dir, "LOCAL-8.md"));

    const snap = await p.fetchAIImplementSnapshot();
    expect(snap.needsPlanning).toEqual([]);
    expect(snap.readyForImplementation).toEqual([]);
    await expect(p.readIssueDetails(id)).resolves.toMatchObject({
      location: "active",
      ticketPath: "LOCAL-8.md",
      state: { status: "failed", failurePhase: "planning" },
    });
  });

  it("ignores stale callbacks for archived failures but accepts comments and late merges", async () => {
    const dir = await tempTicketDir();
    const id = "filesystem:LOCAL:LOCAL-16";
    const p = provider({ LOCAL: mapping({ directory: dir }) });
    await writeTask(dir, "LOCAL-16.md", "---\ntitle: Late callbacks\n---\nCallbacks.");

    await p.markPlanningFailed(id, "LOCAL", "manual");
    await p.archiveFailed(id, "LOCAL", "planning");
    await p.markPlanningStarted(id, "LOCAL");
    await p.markPlanComplete(id, "LOCAL");
    await p.markImplementing(id, "LOCAL");
    await expect(p.clearWorkingState(id, "LOCAL")).resolves.toBe(false);
    await p.postComment(id, "late comment");
    await expect(p.readIssueDetails(id)).resolves.toMatchObject({
      location: "failed",
      state: { status: "failed" },
    });

    await p.markMerged(id, "LOCAL");
    await expect(p.readIssueDetails(id)).resolves.toMatchObject({
      location: "completed",
      ticketPath: "completed/LOCAL-16.md",
      state: { status: "completed" },
    });
    const state = JSON.parse(await readFile(join(dir, ".state", "LOCAL", "LOCAL-16.json"), "utf8"));
    expect(state.comments.map((comment: { body: string }) => comment.body)).toEqual([
      "⚠️ Planning failed: manual",
      "late comment",
    ]);
  });

  it("refuses duplicate ids across active completed and failed locations", async () => {
    const dir = await tempTicketDir();
    await mkdir(join(dir, "completed"));
    await mkdir(join(dir, "failed"));
    await writeTask(dir, "LOCAL-9.md", "---\ntitle: Active\n---\nA.");
    await writeTask(dir, "completed-copy.md", "---\ntitle: Done\nid: LOCAL-9\n---\nB.");
    await rename(join(dir, "completed-copy.md"), join(dir, "completed", "completed-copy.md"));
    await writeTask(dir, "failed-copy.md", "---\ntitle: Failed\nid: LOCAL-10\n---\nC.");
    await writeTask(dir, "active-copy.md", "---\ntitle: Also failed\nid: LOCAL-10\n---\nD.");
    await rename(join(dir, "failed-copy.md"), join(dir, "failed", "failed-copy.md"));
    const p = provider({ LOCAL: mapping({ directory: dir }) });

    expect(await p.findByKey("LOCAL-9")).toBeNull();
    expect(await p.findByKey("LOCAL-10")).toBeNull();
    await expect(p.readIssueDetails("filesystem:LOCAL:LOCAL-9")).resolves.toBeNull();
    expect((await p.fetchAIImplementSnapshot()).needsPlanning).toEqual([]);
  });

  it("refuses archive and restore collisions without overwriting files", async () => {
    const dir = await tempTicketDir();
    const id = "filesystem:LOCAL:LOCAL-11";
    const p = provider({ LOCAL: mapping({ directory: dir }) });
    await writeTask(dir, "LOCAL-11.md", "---\ntitle: Collide\n---\nOriginal.");
    await mkdir(join(dir, "failed"));
    await writeTask(join(dir, "failed"), "LOCAL-11.md", "---\ntitle: Existing\nid: LOCAL-99\n---\nExisting.");

    await p.markPlanningFailed(id, "LOCAL", "manual");
    await expect(p.archiveFailed(id, "LOCAL", "planning")).resolves.toBe(false);
    await expect(readFile(join(dir, "LOCAL-11.md"), "utf8")).resolves.toContain("Original");

    await writeTask(dir, "restore-collision.md", "---\ntitle: Active collision\nid: LOCAL-98\n---\nActive.");
    await mkdir(join(dir, ".state", "LOCAL"), { recursive: true });
    await writeFile(join(dir, ".state", "LOCAL", "LOCAL-12.json"), JSON.stringify({
      version: 1,
      status: "failed",
      comments: [],
      prUrls: [],
      failurePhase: "planning",
      updatedAt: "2026-09-14T00:00:00.000Z",
    }), "utf8");
    await writeTask(join(dir, "failed"), "restore-collision.md", "---\ntitle: Restore collision\nid: LOCAL-12\n---\nFailed.");
    await expect(p.retryFailed("filesystem:LOCAL:LOCAL-12", "LOCAL")).resolves.toBe(false);
    await expect(readFile(join(dir, "restore-collision.md"), "utf8")).resolves.toContain("Active");
  });

  it.each(["archive", "restore"])("refuses a destination created concurrently during %s", async (operation) => {
    const dir = await tempTicketDir();
    const id = "filesystem:LOCAL:LOCAL-21";
    const p = provider({ LOCAL: mapping({ directory: dir }) });
    await writeTask(dir, "LOCAL-21.md", "---\ntitle: Original\n---\nOriginal contents.");
    await p.markPlanningFailed(id, "LOCAL", "manual");
    if (operation === "restore") await p.archiveFailed(id, "LOCAL", "planning");
    const source = join(dir, ...(operation === "archive" ? [] : ["failed"]), "LOCAL-21.md");
    const target = join(dir, ...(operation === "archive" ? ["failed"] : []), "LOCAL-21.md");
    const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(link).mockImplementationOnce(async (from, to) => {
      await writeFile(to, "Concurrent ticket: must survive.", { flag: "wx" });
      return realFs.link(from, to);
    });
    const result = operation === "archive"
      ? await p.archiveFailed(id, "LOCAL", "planning")
      : await p.retryFailed(id, "LOCAL");
    expect(result).toBe(false);
    expect(await readFile(source, "utf8")).toContain("Original contents");
    expect(await readFile(target, "utf8")).toBe("Concurrent ticket: must survive.");
  });

  it("skips symlink archive directories and shared-root archival", async () => {
    const dir = await tempTicketDir();
    const outside = await tempTicketDir();
    await symlink(outside, join(dir, "failed"));
    const id = "filesystem:LOCAL:LOCAL-13";
    const p = provider({ LOCAL: mapping({ directory: dir }) });
    await writeTask(dir, "LOCAL-13.md", "---\ntitle: Symlink archive\n---\nDo not move out.");

    await p.markPlanningFailed(id, "LOCAL", "manual");
    await expect(p.archiveFailed(id, "LOCAL", "planning")).resolves.toBe(false);
    await expect(readFile(join(dir, "LOCAL-13.md"), "utf8")).resolves.toContain("Symlink archive");
    await expect(readFile(join(outside, "LOCAL-13.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const sharedId = "filesystem:ONE:ONE-1";
    await writeTask(dir, "ONE-1.md", "---\ntitle: Shared\n---\nShared root.");
    const shared = provider({
      ONE: mapping({ directory: dir }),
      TWO: mapping({ directory: dir }),
    });
    await shared.markMerged(sharedId, "ONE");
    await expect(readFile(join(dir, "ONE-1.md"), "utf8")).resolves.toContain("Shared root");
    await expect(shared.readIssueDetails(sharedId)).resolves.toMatchObject({
      location: "active",
      state: { status: "completed" },
    });
  });

  it("keeps active clearWorkingState retry behavior unchanged", async () => {
    const dir = await tempTicketDir();
    const p = provider({ LOCAL: mapping({ directory: dir }) });
    const planningId = "filesystem:LOCAL:LOCAL-14";
    const implementationId = "filesystem:LOCAL:LOCAL-15";
    await writeTask(dir, "LOCAL-14.md", "---\ntitle: Planning retry\n---\nPlan again.");
    await writeTask(dir, "LOCAL-15.md", "---\ntitle: Implementation retry\n---\nImplement again.");

    await p.markPlanningFailed(planningId, "LOCAL", "temporary");
    await expect(p.clearWorkingState(planningId, "LOCAL")).resolves.toBe(true);
    await p.markImplementing(implementationId, "LOCAL");
    await p.markImplementationFailed(implementationId, "LOCAL", "temporary");
    await expect(p.clearWorkingState(implementationId, "LOCAL")).resolves.toBe(true);

    const snap = await p.fetchAIImplementSnapshot();
    expect(snap.needsPlanning.map((issue) => issue.id)).toEqual([planningId]);
    expect(snap.readyForImplementation.map((issue) => issue.id)).toEqual([implementationId]);
  });
});
