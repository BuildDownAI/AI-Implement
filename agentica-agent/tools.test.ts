/**
 * Unit tests for the tool surface.
 *
 * Uses node:test (built-in) so this package needs no extra test-runner
 * dependency. Run via: `npm test` (compiles first, then `node --test`).
 *
 * Each test gets a fresh /tmp scratch dir as WORKSPACE_DIR. We mutate
 * process.env directly — tools.ts is designed to read it per-call so
 * this exercises both the API and the dynamic-workspace contract.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync, rmSync, existsSync, readFileSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import {
  readFile, writeFile, editFile, bash, fileExists, listDir,
} from "./tools.js";

let scratch: string;

beforeEach(() => {
  scratch = join(tmpdir(), `agentica-agent-tools-${randomBytes(8).toString("hex")}`);
  mkdirSync(scratch, { recursive: true });
  process.env.WORKSPACE_DIR = scratch;
});

afterEach(() => {
  if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

// ── readFile ────────────────────────────────────────────────────────────────

test("readFile reads an existing file relative to workspace", () => {
  writeFileSync(join(scratch, "foo.txt"), "hello");
  assert.equal(readFile("foo.txt"), "hello");
});

test("readFile throws on a missing path", () => {
  assert.throws(() => readFile("does-not-exist.txt"));
});

test("readFile honors absolute paths", () => {
  const absPath = join(scratch, "abs.txt");
  writeFileSync(absPath, "abs content");
  assert.equal(readFile(absPath), "abs content");
});

// ── writeFile ───────────────────────────────────────────────────────────────

test("writeFile creates a new file in workspace", () => {
  writeFile("new.txt", "content");
  assert.equal(readFileSync(join(scratch, "new.txt"), "utf8"), "content");
});

test("writeFile overwrites an existing file", () => {
  writeFile("over.txt", "first");
  writeFile("over.txt", "second");
  assert.equal(readFileSync(join(scratch, "over.txt"), "utf8"), "second");
});

test("writeFile creates intermediate parent directories", () => {
  writeFile("a/b/c/deep.txt", "deep");
  assert.equal(readFileSync(join(scratch, "a/b/c/deep.txt"), "utf8"), "deep");
});

// ── editFile ────────────────────────────────────────────────────────────────

test("editFile replaces a unique anchor", () => {
  writeFileSync(join(scratch, "code.js"), "const x = 1;\nconst y = 2;\n");
  editFile("code.js", "const x = 1;", "const x = 42;");
  assert.equal(
    readFileSync(join(scratch, "code.js"), "utf8"),
    "const x = 42;\nconst y = 2;\n",
  );
});

test("editFile throws when oldString is absent", () => {
  writeFileSync(join(scratch, "code.js"), "alpha\n");
  assert.throws(
    () => editFile("code.js", "beta", "gamma"),
    /oldString not found/,
  );
});

test("editFile throws when oldString matches more than once", () => {
  writeFileSync(join(scratch, "code.js"), "x\nx\nx\n");
  assert.throws(
    () => editFile("code.js", "x", "y"),
    /matches 3 times/,
  );
});

// ── bash ────────────────────────────────────────────────────────────────────

test("bash captures stdout from a successful command", () => {
  const result = bash("echo hello");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^hello/);
  assert.equal(result.stderr, "");
});

test("bash captures non-zero exit codes as data, never throws", () => {
  assert.doesNotThrow(() => {
    const result = bash("exit 42");
    assert.equal(result.exitCode, 42);
  });
});

test("bash captures stderr separately from stdout", () => {
  const result = bash("echo to-stderr 1>&2; echo to-stdout");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /to-stdout/);
  assert.match(result.stderr, /to-stderr/);
});

test("bash runs commands relative to the workspace", () => {
  writeFileSync(join(scratch, "marker.txt"), "in workspace");
  const result = bash("cat marker.txt");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /in workspace/);
});

// ── fileExists ──────────────────────────────────────────────────────────────

test("fileExists is true for an existing file", () => {
  writeFileSync(join(scratch, "exists.txt"), "");
  assert.equal(fileExists("exists.txt"), true);
});

test("fileExists is true for an existing directory", () => {
  mkdirSync(join(scratch, "subdir"));
  assert.equal(fileExists("subdir"), true);
});

test("fileExists is false for a missing path", () => {
  assert.equal(fileExists("nothing-here.txt"), false);
});

// ── listDir ─────────────────────────────────────────────────────────────────

test("listDir returns entry names", () => {
  writeFileSync(join(scratch, "a.txt"), "");
  writeFileSync(join(scratch, "b.txt"), "");
  mkdirSync(join(scratch, "c"));
  const names = listDir(".").sort();
  assert.deepEqual(names, ["a.txt", "b.txt", "c"]);
});

// ── Workspace resolution is per-call, not cached at module load ─────────────

test("workspace is resolved per-call (regression: caching at module load)", () => {
  // The smoke-test path mutates process.env after tools.ts is imported.
  // Earlier tools.ts cached the value at module load and silently wrote
  // files to the wrong directory. Guard against that regression here.
  const altDir = join(tmpdir(), `agentica-agent-alt-${randomBytes(8).toString("hex")}`);
  mkdirSync(altDir, { recursive: true });
  try {
    process.env.WORKSPACE_DIR = altDir;
    writeFile("alt.txt", "in alt");
    assert.equal(readFileSync(join(altDir, "alt.txt"), "utf8"), "in alt");
    assert.equal(existsSync(join(scratch, "alt.txt")), false,
      "file leaked into the original scratch dir");
  } finally {
    rmSync(altDir, { recursive: true, force: true });
  }
});
