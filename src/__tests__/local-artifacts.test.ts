import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateRunId,
  resolveArtifactDir,
  writeRunArtifacts,
  removeRunArtifacts,
} from "../local/artifacts.js";
import type { LocalArtifactInput } from "../local/run-result.js";

const VALID_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_ID = "aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb";

function baseInput(overrides: Partial<LocalArtifactInput> = {}): LocalArtifactInput {
  return {
    runId: VALID_ID,
    identifier: "AII-1",
    title: "Test task",
    outcome: "success",
    exitCode: 0,
    startedAt: new Date("2026-01-01T10:00:00Z"),
    endedAt: new Date("2026-01-01T10:01:00Z"),
    passes: [
      {
        iteration: 1,
        implementTurns: 42,
        implementOutcome: "success",
        costUsd: 1.5,
        reviewApproved: true,
      },
    ],
    ...overrides,
  } as LocalArtifactInput;
}

describe("validateRunId", () => {
  it("accepts a UUID", () => {
    expect(() => validateRunId(VALID_ID)).not.toThrow();
  });

  it("accepts an 8-character alphanumeric ID", () => {
    expect(() => validateRunId("abcdefgh")).not.toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => validateRunId("")).toThrow(/Invalid run ID/);
  });

  it("rejects a string with path traversal", () => {
    expect(() => validateRunId("../evil")).toThrow(/Invalid run ID/);
  });

  it("rejects a string with a forward slash", () => {
    expect(() => validateRunId("foo/bar")).toThrow(/Invalid run ID/);
  });

  it("rejects a string with a backslash", () => {
    expect(() => validateRunId("foo\\bar")).toThrow(/Invalid run ID/);
  });

  it("rejects a string with a dot", () => {
    expect(() => validateRunId("abc.defgh")).toThrow(/Invalid run ID/);
  });

  it("rejects a string shorter than 8 characters", () => {
    expect(() => validateRunId("abc")).toThrow(/Invalid run ID/);
  });

  it("rejects a string starting with a hyphen", () => {
    expect(() => validateRunId("-abcdefgh")).toThrow(/Invalid run ID/);
  });

  it("rejects a string longer than 64 characters", () => {
    expect(() => validateRunId("a" + "-".repeat(64))).toThrow(/Invalid run ID/);
  });
});

describe("resolveArtifactDir", () => {
  it("returns the correct path under the given output root", () => {
    expect(resolveArtifactDir(VALID_ID, "/output/runs")).toBe(`/output/runs/${VALID_ID}`);
  });

  it("uses a custom outputRoot", () => {
    expect(resolveArtifactDir(VALID_ID, "/custom/root")).toBe(`/custom/root/${VALID_ID}`);
  });

  it("rejects an invalid run ID", () => {
    expect(() => resolveArtifactDir("../evil", "/output/runs")).toThrow(/Invalid run ID/);
  });
});

describe("writeRunArtifacts", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("creates the artifact directory and writes summary.json", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    const dir = await writeRunArtifacts(baseInput({ outputRoot: root }));
    expect(existsSync(dir)).toBe(true);
    const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf-8")) as Record<string, unknown>;
    expect(summary.runId).toBe(VALID_ID);
    expect(summary.identifier).toBe("AII-1");
    expect(summary.outcome).toBe("success");
    expect(summary.durationMs).toBe(60000);
    expect(summary.artifactDir).toBe(dir);
  });

  it("returns the absolute artifact directory path", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    const dir = await writeRunArtifacts(baseInput({ outputRoot: root }));
    expect(dir).toBe(join(root, VALID_ID));
  });

  it("returns an absolute path even when outputRoot is relative", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    const relative = `./aii-rel-${Date.now()}`;
    let dir: string | undefined;
    try {
      dir = await writeRunArtifacts(baseInput({ outputRoot: relative }));
      expect(dir.startsWith("/")).toBe(true);
    } finally {
      if (dir != null) rmSync(dir, { recursive: true, force: true });
      rmSync(relative, { recursive: true, force: true });
    }
  });

  it("writes run.log when logs is provided", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    const dir = await writeRunArtifacts(baseInput({ outputRoot: root, logs: "step 1\nstep 2\n" }));
    expect(readFileSync(join(dir, "run.log"), "utf-8")).toBe("step 1\nstep 2\n");
  });

  it("writes plan.md when plan is provided", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    const dir = await writeRunArtifacts(baseInput({ outputRoot: root, plan: "## Plan\n..." }));
    expect(readFileSync(join(dir, "plan.md"), "utf-8")).toBe("## Plan\n...");
  });

  it("writes changes.diff when patch is provided", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    const patch = "diff --git a/src/foo.ts b/src/foo.ts\n+new line\n";
    const dir = await writeRunArtifacts(baseInput({ outputRoot: root, patch }));
    expect(readFileSync(join(dir, "changes.diff"), "utf-8")).toBe(patch);
  });

  it("writes changed-files.txt with all changed paths including untracked files", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    const changedFiles = ["src/existing.ts", "src/new-untracked-file.ts"];
    const dir = await writeRunArtifacts(baseInput({ outputRoot: root, changedFiles }));
    const content = readFileSync(join(dir, "changed-files.txt"), "utf-8");
    expect(content).toContain("src/existing.ts");
    expect(content).toContain("src/new-untracked-file.ts");
  });

  it("writes test-summary.txt when testSummary is provided", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    const dir = await writeRunArtifacts(baseInput({ outputRoot: root, testSummary: "PASS 5/5" }));
    expect(readFileSync(join(dir, "test-summary.txt"), "utf-8")).toBe("PASS 5/5");
  });

  it("writes review.md when reviewResult is provided", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    const dir = await writeRunArtifacts(
      baseInput({ outputRoot: root, reviewResult: "## Review\nApproved." }),
    );
    expect(readFileSync(join(dir, "review.md"), "utf-8")).toBe("## Review\nApproved.");
  });

  it("writes run-summary.md when runSummary is provided", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    const dir = await writeRunArtifacts(
      baseInput({ outputRoot: root, runSummary: "## Summary\nDone." }),
    );
    expect(readFileSync(join(dir, "run-summary.md"), "utf-8")).toBe("## Summary\nDone.");
  });

  it("writes tokens.json when tokenSummary is provided", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    const tokenSummary = {
      costUsd: 1.5,
      tokensIn: 1000,
      tokensOut: 500,
      cacheReadTokens: 200,
      cacheCreationTokens: 50,
    };
    const dir = await writeRunArtifacts(baseInput({ outputRoot: root, tokenSummary }));
    const parsed = JSON.parse(readFileSync(join(dir, "tokens.json"), "utf-8")) as Record<string, unknown>;
    expect(parsed.costUsd).toBe(1.5);
    expect(parsed.tokensIn).toBe(1000);
  });

  it("writes autopsy.md for unapproved runs", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    const dir = await writeRunArtifacts(
      baseInput({ outputRoot: root, outcome: "unapproved", autopsy: "## Autopsy\nFailed." }),
    );
    expect(readFileSync(join(dir, "autopsy.md"), "utf-8")).toBe("## Autopsy\nFailed.");
  });

  it("includes failureCode and repairAction in summary.json for failed runs", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    const dir = await writeRunArtifacts(
      baseInput({
        outputRoot: root,
        outcome: "failed",
        failureCode: "REVIEW_UNAPPROVED",
        repairAction: "Check review feedback and re-dispatch.",
      }),
    );
    const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf-8")) as Record<string, unknown>;
    expect(summary.failureCode).toBe("REVIEW_UNAPPROVED");
    expect(summary.repairAction).toBe("Check review feedback and re-dispatch.");
  });

  it("does not write optional files when not provided", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    const dir = await writeRunArtifacts(baseInput({ outputRoot: root }));
    expect(existsSync(join(dir, "run.log"))).toBe(false);
    expect(existsSync(join(dir, "plan.md"))).toBe(false);
    expect(existsSync(join(dir, "changes.diff"))).toBe(false);
    expect(existsSync(join(dir, "autopsy.md"))).toBe(false);
    expect(existsSync(join(dir, "tokens.json"))).toBe(false);
  });

  it("summary.json does not contain logs, plan, or patch content", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    const dir = await writeRunArtifacts(
      baseInput({
        outputRoot: root,
        logs: "SECRET_TOKEN_VALUE_HERE",
        plan: "CONFIDENTIAL_PLAN_BODY",
        patch: "SECRET_DIFF_CONTENT",
      }),
    );
    const raw = readFileSync(join(dir, "summary.json"), "utf-8");
    expect(raw).not.toContain("SECRET_TOKEN_VALUE_HERE");
    expect(raw).not.toContain("CONFIDENTIAL_PLAN_BODY");
    expect(raw).not.toContain("SECRET_DIFF_CONTENT");
  });

  it("rejects an invalid run ID", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    await expect(
      writeRunArtifacts(baseInput({ outputRoot: root, runId: "../evil" })),
    ).rejects.toThrow(/Invalid run ID/);
  });

  it("rejects a run ID with a forward slash", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    await expect(
      writeRunArtifacts(baseInput({ outputRoot: root, runId: "foo/bar/baz" })),
    ).rejects.toThrow(/Invalid run ID/);
  });

  it("rejects when the artifact directory is a symlink", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    const outside = mkdtempSync(join(tmpdir(), "aii-outside-"));
    try {
      await symlink(outside, join(root, VALID_ID));
      await expect(writeRunArtifacts(baseInput({ outputRoot: root }))).rejects.toThrow(/Symlink/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects when summary.json is a symlink and leaves the outside target unchanged", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    const outsideFile = join(tmpdir(), `aii-outside-${Date.now()}.txt`);
    writeFileSync(outsideFile, "original content");
    try {
      const dir = join(root, VALID_ID);
      mkdirSync(dir);
      await symlink(outsideFile, join(dir, "summary.json"));
      await expect(writeRunArtifacts(baseInput({ outputRoot: root }))).rejects.toThrow(/Symlink/);
      expect(readFileSync(outsideFile, "utf-8")).toBe("original content");
    } finally {
      rmSync(outsideFile, { force: true });
    }
  });

  it("rejects when an optional artifact target is a symlink and leaves the outside target unchanged", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    const outsideFile = join(tmpdir(), `aii-outside-${Date.now()}.txt`);
    writeFileSync(outsideFile, "original content");
    try {
      const dir = join(root, VALID_ID);
      mkdirSync(dir);
      await symlink(outsideFile, join(dir, "run.log"));
      await expect(
        writeRunArtifacts(baseInput({ outputRoot: root, logs: "injected log" })),
      ).rejects.toThrow(/Symlink/);
      expect(readFileSync(outsideFile, "utf-8")).toBe("original content");
    } finally {
      rmSync(outsideFile, { force: true });
    }
  });
});

describe("removeRunArtifacts", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("removes the artifact directory for the given run ID", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    const dir = await writeRunArtifacts(baseInput({ outputRoot: root }));
    expect(existsSync(dir)).toBe(true);
    await removeRunArtifacts(VALID_ID, root);
    expect(existsSync(dir)).toBe(false);
  });

  it("does not remove other run directories", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    await writeRunArtifacts(baseInput({ outputRoot: root }));
    await writeRunArtifacts(baseInput({ outputRoot: root, runId: OTHER_ID }));
    await removeRunArtifacts(VALID_ID, root);
    expect(existsSync(join(root, OTHER_ID))).toBe(true);
    expect(existsSync(join(root, VALID_ID))).toBe(false);
  });

  it("is idempotent when the run directory does not exist", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    await expect(removeRunArtifacts(VALID_ID, root)).resolves.not.toThrow();
  });

  it("rejects an invalid run ID", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    await expect(removeRunArtifacts("../evil", root)).rejects.toThrow(/Invalid run ID/);
  });

  it("rejects a run ID with path traversal sequences", async () => {
    root = mkdtempSync(join(tmpdir(), "aii-art-"));
    await expect(removeRunArtifacts("abc/../def", root)).rejects.toThrow(/Invalid run ID/);
  });
});
