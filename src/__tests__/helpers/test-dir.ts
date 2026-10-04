// Temporary directories for tests (AII-925). A test that needs a scratch directory calls
// testDir() here rather than mkdtempSync: the directory and everything in it are removed
// when the test finishes, whether it passed or failed. See docs/unit-tests.md § Harnesses.
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
