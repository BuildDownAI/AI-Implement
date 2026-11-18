// The test run's own temp directory (AII-1099), listed in globalSetup by both vitest configs.
// vitest's main process creates it before any worker starts and provides its path.
// Each test file then gets a directory of its own inside it, which the scrub points TMPDIR, TMP and TEMP at, so whatever a test or a process it starts writes under os.tmpdir() lands there.
// A directory with anything left in it fails its test file, or the run when the file never ran its own check, and is kept for inspection.
// Reference: docs/unit-tests.md § Isolation from the machine.
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    runTempRoot: string;
  }
}

/** Creates a test file's temp directory inside the run's, named after the file so a kept directory says whose it is. */
export function startFileTempRoot(runTempRoot: string, testFile: string): string {
  return mkdtempSync(join(runTempRoot, `${basename(testFile)}-`));
}

/** Removes a test file's temp directory when it is empty; otherwise throws, naming each entry, and keeps it. */
export function endFileTempRoot(dir: string): void {
  const left = readdirSync(dir);
  if (left.length > 0) {
    throw new Error(`Left in this test file's temp directory, which is kept at ${dir} for inspection: ${left.join(", ")}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

export default function setupRunTempRoot(project: Pick<TestProject, "provide">): () => void {
  // The main process is never scrubbed, so tmpdir() here is the machine's own temp directory on every OS.
  const root = mkdtempSync(join(tmpdir(), "ai-implement-run-"));
  project.provide("runTempRoot", root);
  return () => {
    // vitest runs no afterAll for a file whose tests all skip or that fails to load, so its directory is still here.
    // Empty, it held nothing; anything else is a file that left something behind, named by its directory.
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry);
      if (statSync(dir).isDirectory() && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
    }
    const left = readdirSync(root);
    if (left.length === 0) {
      rmSync(root, { recursive: true, force: true });
      return;
    }
    console.error(`Left in the test run's temp directory, which is kept at ${root} for inspection: ${left.join(", ")}`);
    // vitest only logs a throwing global teardown and still exits 0 (4.1.11), so the exit code is set directly.
    process.exitCode = 1;
  };
}
