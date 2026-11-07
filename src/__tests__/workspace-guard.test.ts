import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreWorkspace, snapshotWorkspace } from "../pipeline/workspace-guard.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdtempSync: vi.fn(actual.mkdtempSync) };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
const read = (f: string) => readFileSync(join(dir, f), "utf-8");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ws-guard-"));
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, ".gitignore"), "bin/\n");
  for (const f of ["a.txt", "c.txt", "d.txt"]) writeFileSync(join(dir, f), `${f}-head\n`);
  git("add", "-A");
  git("commit", "-qm", "init");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("workspace guard", () => {
  it("keeps the agent's changes and undoes the hook's, leaving ignored files", () => {
    // Agent: edits tracked A, adds new B.
    writeFileSync(join(dir, "a.txt"), "A-agent\n");
    writeFileSync(join(dir, "b.txt"), "B-agent\n");
    const indexBefore = readFileSync(join(dir, ".git", "index"));

    const snap = snapshotWorkspace(dir);
    expect(snap).not.toBeNull();
    // Hook: edits tracked C, deletes tracked D, creates untracked E (and a new dir), creates ignored F.
    writeFileSync(join(dir, "c.txt"), "C-hook\n");
    rmSync(join(dir, "d.txt"));
    writeFileSync(join(dir, "e.txt"), "E-hook\n");
    mkdirSync(join(dir, "gen"));
    writeFileSync(join(dir, "gen", "x.txt"), "x\n");
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "f.dll"), "F\n");

    restoreWorkspace(snap);

    expect(read("a.txt")).toBe("A-agent\n");
    expect(read("b.txt")).toBe("B-agent\n");
    expect(read("c.txt")).toBe("c.txt-head\n");
    expect(read("d.txt")).toBe("d.txt-head\n");
    expect(existsSync(join(dir, "e.txt"))).toBe(false);
    expect(existsSync(join(dir, "gen"))).toBe(false);
    expect(read("bin/f.dll")).toBe("F\n");
    // The real index was never touched.
    expect(readFileSync(join(dir, ".git", "index")).equals(indexBefore)).toBe(true);
  });

  it("preserves .gitignore files inside ignored build output", () => {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", ".gitignore"), "local-cache\n");
    const snap = snapshotWorkspace(dir);
    writeFileSync(join(dir, "c.txt"), "hook edit\n");
    expect(restoreWorkspace(snap)).toBe(true);
    expect(read("bin/.gitignore")).toBe("local-cache\n");
    expect(read("c.txt")).toBe("c.txt-head\n");
  });

  it("restores nested ignore rules before removing hook-created files", () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", ".gitignore"), "cache/\n");
    const snap = snapshotWorkspace(dir);
    writeFileSync(join(dir, "src", ".gitignore"), "cache/\ngenerated.ts\n");
    writeFileSync(join(dir, "src", "generated.ts"), "hook code\n");
    expect(restoreWorkspace(snap)).toBe(true);
    expect(read("src/.gitignore")).toBe("cache/\n");
    expect(existsSync(join(dir, "src", "generated.ts"))).toBe(false);
  });

  it("restores a file the hook modified that the agent had also modified", () => {
    writeFileSync(join(dir, "a.txt"), "A-agent\n");
    const snap = snapshotWorkspace(dir);
    writeFileSync(join(dir, "a.txt"), "A-hook\n");
    restoreWorkspace(snap);
    expect(read("a.txt")).toBe("A-agent\n");
  });

  it("returns true on a clean restore and when nothing changed", () => {
    const snap = snapshotWorkspace(dir);
    expect(restoreWorkspace(snap)).toBe(true);
    writeFileSync(join(dir, "c.txt"), "C-hook\n");
    expect(restoreWorkspace(snap)).toBe(true);
    expect(read("c.txt")).toBe("c.txt-head\n");
  });

  it("returns false when the workspace is no longer a repository", () => {
    const snap = snapshotWorkspace(dir);
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    expect(restoreWorkspace(snap)).toBe(false);
  });

  it("returns false for a null snapshot", () => {
    expect(restoreWorkspace(null)).toBe(false);
  });

  it("is a no-op outside a git repository", () => {
    const plain = mkdtempSync(join(tmpdir(), "ws-plain-"));
    try {
      const snap = snapshotWorkspace(plain);
      expect(snap).toBeNull();
      expect(() => restoreWorkspace(snap)).not.toThrow();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("snapshotWorkspace returns null instead of throwing when the temp dir cannot be created", () => {
    vi.mocked(mkdtempSync).mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });
    expect(snapshotWorkspace(dir)).toBeNull();
  });

  it("restoreWorkspace returns false instead of throwing when the temp dir cannot be created", () => {
    const snap = snapshotWorkspace(dir);
    expect(snap).not.toBeNull();
    vi.mocked(mkdtempSync).mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });
    expect(restoreWorkspace(snap)).toBe(false);
  });

  it("restores pre-hook ignore semantics when a hook edits .gitignore to hide a file it creates", () => {
    const snap = snapshotWorkspace(dir);
    // Hook: appends a pattern to .gitignore and creates a file that pattern now matches.
    writeFileSync(join(dir, ".gitignore"), "bin/\ngenerated.ts\n");
    writeFileSync(join(dir, "generated.ts"), "export const x = 1;\n");

    expect(restoreWorkspace(snap)).toBe(true);

    expect(existsSync(join(dir, "generated.ts"))).toBe(false);
    expect(read(".gitignore")).toBe("bin/\n");
    // The push step's `git add -A` must not pick the file back up.
    git("add", "-A");
    const staged = execFileSync("git", ["status", "--porcelain"], { cwd: dir }).toString();
    expect(staged).not.toContain("generated.ts");
  });

  it("leaves pre-existing ignored build output alone when a hook removes its ignore rule", () => {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "output.dll"), "binary\n");
    const snap = snapshotWorkspace(dir);
    // Hook: removes the bin/ ignore rule, un-ignoring build output it did not create.
    writeFileSync(join(dir, ".gitignore"), "");

    expect(restoreWorkspace(snap)).toBe(true);

    expect(read("bin/output.dll")).toBe("binary\n");
    expect(read(".gitignore")).toBe("bin/\n");
  });

  it.each(["read-tree", "checkout-index"])("returns false when %s fails during the revert", (failing) => {
    const snap = snapshotWorkspace(dir);
    writeFileSync(join(dir, "c.txt"), "C-hook\n");
    const real = vi.mocked(spawnSync).getMockImplementation()!;
    vi.mocked(spawnSync).mockImplementation(((cmd: string, args: string[], opts: never) =>
      args?.[0] === failing
        ? { status: 1, error: undefined, stdout: Buffer.alloc(0), stderr: Buffer.from("boom"), pid: 0, output: [], signal: null }
        : (real as Function)(cmd, args, opts)) as never);
    try {
      expect(restoreWorkspace(snap)).toBe(false);
      // The revert did not run, so the hook's change survives.
      expect(readFileSync(join(dir, "c.txt"), "utf8")).toBe("C-hook\n");
    } finally {
      vi.mocked(spawnSync).mockImplementation(real);
    }
  });
});
