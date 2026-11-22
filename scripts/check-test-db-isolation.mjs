import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

// Exercise the suite that previously wrote fixtures into an inherited app DB.
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "test-db-isolation-"));
const filename = join(directory, "application.sqlite");
try {
  const db = new Database(filename);
  db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('keep me')");
  db.close();
  const result = spawnSync(process.execPath, [
    join(root, "node_modules/vitest/vitest.mjs"), "run",
    "src/__tests__/github-dispatch.test.ts",
  ], {
    cwd: root,
    env: { ...process.env, DEDUP_DB_PATH: filename },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const checked = new Database(filename, { readonly: true });
  try {
    assert.deepEqual(
      checked.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
      [{ name: "sentinel" }],
      "Tests must not add tables or fixture jobs to the inherited application database",
    );
    assert.deepEqual(checked.prepare("SELECT value FROM sentinel").all(), [{ value: "keep me" }]);
  } finally {
    checked.close();
  }
  console.log("PASS: dispatch tests left the inherited application database untouched");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
