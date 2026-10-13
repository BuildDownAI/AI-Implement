// Temporary directories for tests (AII-925). A test that needs a scratch directory calls
// testDir() here rather than mkdtempSync: the directory and everything in it are removed
// when the test finishes, whether it passed or failed. testTempRoot() also points the OS
// temp directory at one (AII-1073). See docs/unit-tests.md § Harnesses.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

/** Creates an empty directory under the OS temp directory, removed when the current test
 *  finishes. Call it from a test or a `beforeEach`; vitest throws from a `beforeAll` or a
 *  `describe` body, before anything is created. */
export function testDir(prefix = "test"): string {
  let dir: string | undefined;
  // Registered before the directory exists, so a call where registration throws leaves nothing behind.
  onTestFinished(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  dir = mkdtempSync(join(tmpdir(), `ai-implement-${prefix}-`));
  return dir;
}

/** The variables os.tmpdir() reads, on POSIX and Windows between them. */
const TEMP_DIR_VARS = ["TMPDIR", "TEMP", "TMP"] as const;

/** A testDir that the OS temp directory points at until the current test finishes, for code that
 *  writes under os.tmpdir() itself. The directory is created in the real temp directory before the
 *  redirect, and the variables are restored before it is removed. Call it from a test or a `beforeEach`. */
export function testTempRoot(prefix = "temp-root"): string {
  const dir = testDir(prefix);
  const saved = TEMP_DIR_VARS.map((name) => [name, process.env[name]] as const);
  onTestFinished(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  for (const name of TEMP_DIR_VARS) process.env[name] = dir;
  return dir;
}
