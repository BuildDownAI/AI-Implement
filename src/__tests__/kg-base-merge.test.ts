import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { kgBaseMergeStep, KgBaseMergeError, KG_BASE_INGEST_PATHS } from "../pipeline/steps/kg-base-merge.js";
import { loadPipelineDefinition } from "../pipeline/pipeline-loader.js";
import type { PipelineContext, StepReporter } from "../pipeline/types.js";

const reporter: StepReporter = { report: async () => undefined };
const ctx = {} as PipelineContext;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "protocol.file.allow=always", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();
}

function put(dir: string, path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function commitAll(dir: string, msg: string): string {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}

describe("kgBaseMergeStep", () => {
  let root: string;
  let base: string; // <root>/org/base.git (a normal repo whose dir is named base.git)
  let kg: string;
  const REPO = "org/base";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kgbm-"));
    base = join(root, "org", "base.git");
    mkdirSync(base, { recursive: true });
    git(base, "init", "-q", "-b", "main");
    git(base, "config", "uploadpack.allowAnySHA1InWant", "true");
    put(base, "kg_ingest/cli.py", "a\nb\nc\n");
    put(base, "kg_ingest/tracker.py", "t1\nt2\nt3\n");
    put(base, "sources.yml", "base: 1\n");
    put(base, "README.md", "r1\nr2\nr3\n");
    put(base, "snapshot/parts/x.nt", "base-snap\n");
    put(base, ".github/ci.yml", "ci\n");
    commitAll(base, "init");
    kg = join(root, "kg");
    git(root, "clone", "-q", base, kg);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Commit `edit` on the base repo's current branch and return the new sha. */
  function baseCommit(edit: () => void, msg = "base change"): string {
    edit();
    return commitAll(base, msg);
  }

  const run = (baseSha: string, headSha: string, dryRun = true) =>
    kgBaseMergeStep.run(
      ctx,
      { workspaceDir: kg, dryRun, remoteBase: root, kgBaseMerge: { repo: REPO, prNumber: 69, baseSha, headSha } },
      reporter,
    );

  async function failure(p: Promise<unknown>): Promise<KgBaseMergeError> {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(KgBaseMergeError);
      return e as KgBaseMergeError;
    }
    throw new Error("expected a KgBaseMergeError");
  }

  it("is skipped by the pipeline when kgBaseMerge is absent, and the step is a no-op", async () => {
    const def = loadPipelineDefinition("pipelines/kg-refresh.yml").steps.find((s) => s.id === "kg-base-merge");
    const skip = (def as unknown as { skip: (c: unknown) => string | false }).skip;
    expect(typeof skip({ data: {}, getOutputs: () => ({}) })).toBe("string");
    expect(skip({ data: { kgBaseMerge: { repo: REPO } }, getOutputs: () => ({}) })).toBe(false);
    const before = git(kg, "rev-parse", "HEAD");
    expect(await kgBaseMergeStep.run(ctx, { workspaceDir: kg, dryRun: true }, reporter)).toEqual({});
    expect(git(kg, "rev-parse", "HEAD")).toBe(before);
  });

  it("refuses a live run before any fetch", async () => {
    const e = await failure(
      kgBaseMergeStep.run(
        ctx,
        { workspaceDir: kg, dryRun: false, remoteBase: "/nonexistent", kgBaseMerge: { repo: REPO, prNumber: 1, baseSha: "a".repeat(40), headSha: "b".repeat(40) } },
        reporter,
      ),
    );
    expect(e.code).toBe("KG_BASE_MERGE_REFUSED");
  });

  it("merges a clean PR, commits locally, and leaves sources.yml and snapshot/ as the KG repo's", async () => {
    put(kg, "sources.yml", "kg: own\n");
    commitAll(kg, "kg sources");
    const baseSha = git(base, "rev-parse", "HEAD");
    const head = baseCommit(() => put(base, "kg_ingest/x.py", "new\n"));
    const before = git(kg, "rev-parse", "HEAD");
    const out = await run(baseSha, head);
    expect(out).toEqual({ baseMerge: { headSha: head, result: "merged" } });
    expect(git(kg, "rev-parse", "HEAD")).not.toBe(before);
    expect(git(kg, "rev-list", "--parents", "-n1", "HEAD").split(" ")).toHaveLength(3);
    expect(git(kg, "log", "-1", "--format=%an")).toBe("ai-implement-kg-dry-run");
    expect(git(kg, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(kg, "kg_ingest/x.py"), "utf8")).toBe("new\n");
    expect(git(kg, "diff", before, "HEAD", "--", "sources.yml", "snapshot")).toBe("");
  });

  it("reports behind when the KG repo conflicts with the base target commit", async () => {
    put(kg, "kg_ingest/cli.py", "kg\nb\nc\n");
    commitAll(kg, "kg edit");
    const baseSha = baseCommit(() => put(base, "kg_ingest/cli.py", "base\nb\nc\n"));
    const head = baseCommit(() => put(base, "kg_ingest/x.py", "x\n"));
    const before = git(kg, "rev-parse", "HEAD");
    const e = await failure(run(baseSha, head));
    expect(e.code).toBe("KG_BASE_BEHIND");
    expect(e.result).toBe("behind");
    expect(e.conflictPaths).toEqual(["kg_ingest/cli.py"]);
    expect(git(kg, "rev-parse", "HEAD")).toBe(before);
    expect(existsSync(join(kg, ".git/MERGE_HEAD"))).toBe(false);
    expect(git(kg, "status", "--porcelain")).toBe("");
  });

  it("reports conflict when the baseline is clean but the PR head conflicts", async () => {
    put(kg, "kg_ingest/tracker.py", "kg\nt2\nt3\n");
    commitAll(kg, "kg edit");
    const baseSha = git(base, "rev-parse", "HEAD");
    const head = baseCommit(() => put(base, "kg_ingest/tracker.py", "pr\nt2\nt3\n"));
    const before = git(kg, "rev-parse", "HEAD");
    const e = await failure(run(baseSha, head));
    expect(e.code).toBe("KG_BASE_CONFLICT");
    expect(e.result).toBe("conflict");
    expect(e.conflictPaths).toEqual(["kg_ingest/tracker.py"]);
    expect(git(kg, "rev-parse", "HEAD")).toBe(before);
    expect(existsSync(join(kg, ".git/MERGE_HEAD"))).toBe(false);
  });

  it("keeps the KG repo's README.md and sources.yml when only they conflict", async () => {
    put(kg, "README.md", "kg\nr2\nr3\n");
    put(kg, "sources.yml", "kg: own\n");
    commitAll(kg, "kg edits");
    const baseSha = git(base, "rev-parse", "HEAD");
    const head = baseCommit(() => {
      put(base, "README.md", "pr\nr2\nr3\n");
      put(base, "sources.yml", "pr: 1\n");
      put(base, "kg_ingest/x.py", "x\n");
    });
    const out = await run(baseSha, head);
    expect(out.baseMerge?.result).toBe("merged");
    expect(readFileSync(join(kg, "README.md"), "utf8")).toBe("kg\nr2\nr3\n");
    expect(readFileSync(join(kg, "sources.yml"), "utf8")).toBe("kg: own\n");
  });

  it("keeps the KG copy for unconflicted sources.yml/snapshot changes and drops added snapshot files", async () => {
    const baseSha = git(base, "rev-parse", "HEAD");
    const head = baseCommit(() => {
      put(base, "sources.yml", "base: 2\n");
      put(base, "snapshot/parts/new.nt", "added\n");
      put(base, "snapshot/parts/x.nt", "changed\n");
      put(base, "kg_ingest/x.py", "x\n");
    });
    await run(baseSha, head);
    expect(readFileSync(join(kg, "sources.yml"), "utf8")).toBe("base: 1\n");
    expect(readFileSync(join(kg, "snapshot/parts/x.nt"), "utf8")).toBe("base-snap\n");
    expect(existsSync(join(kg, "snapshot/parts/new.nt"))).toBe(false);
    expect(git(kg, "status", "--porcelain")).toBe("");
  });

  it("survives a delete/modify conflict on a non-ingest file", async () => {
    git(kg, "rm", "-q", ".github/ci.yml");
    commitAll(kg, "kg drops ci");
    const baseSha = git(base, "rev-parse", "HEAD");
    const head = baseCommit(() => {
      put(base, ".github/ci.yml", "ci2\n");
      put(base, "kg_ingest/x.py", "x\n");
    });
    const out = await run(baseSha, head);
    expect(out.baseMerge?.result).toBe("merged");
    expect(existsSync(join(kg, ".github/ci.yml"))).toBe(false);
  });

  it("fails the fetch for an unreachable sha", async () => {
    const baseSha = git(base, "rev-parse", "HEAD");
    const e = await failure(run(baseSha, "c".repeat(40)));
    expect(e.code).toBe("KG_BASE_FETCH_FAILED");
  });

  it("does not carry a baseline-only change into the final tree", async () => {
    const baseSha = baseCommit(() => put(base, "kg_ingest/only-baseline.py", "b\n"));
    git(base, "checkout", "-q", "-b", "pr", "HEAD~1");
    const head = baseCommit(() => put(base, "kg_ingest/x.py", "x\n"), "pr change");
    await run(baseSha, head);
    expect(existsSync(join(kg, "kg_ingest/only-baseline.py"))).toBe(false);
    expect(existsSync(join(kg, "kg_ingest/x.py"))).toBe(true);
  });

  it("treats an already-contained head as merged with no new commit", async () => {
    const head = baseCommit(() => put(base, "kg_ingest/x.py", "x\n"));
    git(kg, "pull", "-q", "origin", "main");
    const before = git(kg, "rev-parse", "HEAD");
    const out = await run(head, head);
    expect(out.baseMerge).toEqual({ headSha: head, result: "merged" });
    expect(git(kg, "rev-parse", "HEAD")).toBe(before);
  });

  it("caps reported conflicts at 50", async () => {
    for (let i = 0; i < 60; i++) put(base, `kg_ingest/f${String(i).padStart(2, "0")}.py`, "1\n2\n3\n");
    commitAll(base, "many");
    git(kg, "pull", "-q", "origin", "main");
    for (let i = 0; i < 60; i++) put(kg, `kg_ingest/f${String(i).padStart(2, "0")}.py`, "kg\n2\n3\n");
    commitAll(kg, "kg many");
    const baseSha = baseCommit(() => {
      for (let i = 0; i < 60; i++) put(base, `kg_ingest/f${String(i).padStart(2, "0")}.py`, "base\n2\n3\n");
    });
    const e = await failure(run(baseSha, baseSha));
    expect(e.code).toBe("KG_BASE_BEHIND");
    expect(e.conflictPaths).toHaveLength(50);
  });

  it("works on a runner with no git identity (merge --no-commit still needs one)", async () => {
    const keys = ["HOME", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const home = mkdtempSync(join(tmpdir(), "kgbm-home-"));
    try {
      put(kg, "kg_ingest/cli.py", "kg\nb\nc\n");
      commitAll(kg, "kg edit");
      const cleanBase = git(base, "rev-parse", "HEAD");
      const clean = baseCommit(() => put(base, "kg_ingest/x.py", "new\n"));
      const conflictBase = baseCommit(() => put(base, "kg_ingest/cli.py", "base\nb\nc\n"));
      process.env.HOME = home;
      process.env.GIT_CONFIG_NOSYSTEM = "1";
      process.env.GIT_AUTHOR_NAME = "";
      process.env.GIT_COMMITTER_NAME = "";
      expect(await run(cleanBase, clean)).toEqual({ baseMerge: { headSha: clean, result: "merged" } });
      const e = await failure(run(conflictBase, conflictBase));
      expect(e.code).toBe("KG_BASE_BEHIND");
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("exports the ingest path list", () => {
    expect(KG_BASE_INGEST_PATHS).toContain("kg_ingest/");
  });
});
