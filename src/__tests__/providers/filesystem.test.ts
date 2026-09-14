import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { RepoMapping } from "../../config.js";
import { FilesystemProvider } from "../../providers/filesystem.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
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
});
