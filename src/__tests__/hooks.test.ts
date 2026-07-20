import { describe, it, expect, beforeEach, afterEach } from "vitest";

const isWindows = process.platform === "win32";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHookScript } from "../pipeline/steps/hooks.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "hook-")); });
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // On Windows, bash-created files may be locked briefly after the process exits
  }
  // Clean up env the hook scripts export, so a failing assertion mid-test can't
  // leak a var into other tests sharing this Vitest worker's process.env.
  for (const k of ["FOO_TEST_VAR", "SIMPLE_TEST_VAR", "MULTI_TEST_VAR"]) {
    delete process.env[k];
  }
});

describe.skipIf(isWindows)("runHookScript", () => {
  it("runs the script and merges GITHUB_ENV exports into process.env", () => {
    writeFileSync(join(dir, "setup.sh"), 'echo "FOO_TEST_VAR=bar123" >> "$GITHUB_ENV"\n');
    const result = runHookScript("setup", "setup.sh", dir);
    expect(result.exitCode).toBe(0);
    expect(process.env.FOO_TEST_VAR).toBe("bar123");
  });

  it("returns a non-zero exit code when the script fails", () => {
    writeFileSync(join(dir, "bad.sh"), "exit 3\n");
    const result = runHookScript("setup", "bad.sh", dir);
    expect(result.exitCode).toBe(3);
  });

  it("throws a clear error when the script path does not exist", () => {
    expect(() => runHookScript("setup", "missing.sh", dir)).toThrow(/missing\.sh/);
  });

  it("ignores GHA heredoc multiline values (only KEY=value is supported)", () => {
    // A heredoc opener (KEY<<EOF) must NOT be parsed as an env var; the simple
    // line on the same file is still merged.
    writeFileSync(
      join(dir, "multi.sh"),
      'printf "MULTI_TEST_VAR<<EOF\\nl1\\nl2\\nEOF\\nSIMPLE_TEST_VAR=ok\\n" >> "$GITHUB_ENV"\n',
    );
    const result = runHookScript("setup", "multi.sh", dir);
    expect(result.exitCode).toBe(0);
    expect(process.env.MULTI_TEST_VAR).toBeUndefined();
    expect(process.env.SIMPLE_TEST_VAR).toBe("ok");
  });
});
