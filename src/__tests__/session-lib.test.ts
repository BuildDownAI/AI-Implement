import { afterEach, describe, it, expect } from "vitest";

const isWindows = process.platform === "win32";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runBash(script: string) {
  return spawnSync("bash", ["-lc", script], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe.skipIf(isWindows)("session/lib.sh", () => {
  it("passes shellcheck cleanly", () => {
    const result = spawnSync("shellcheck", ["session/lib.sh"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error?.code === "ENOENT") return;
    expect(result.status).toBe(0);
  });

  it("require_env accepts multiple set variables", () => {
    const result = runBash("source session/lib.sh; A=1 B=2; require_env A B");
    expect(result.status).toBe(0);
  });

  it("require_env fails when any requested variable is missing", () => {
    const result = runBash("source session/lib.sh; A=1; require_env A B");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FATAL: Required environment variable B is not set");
  });

  it("require_one_of succeeds when the first variable is set", () => {
    const result = runBash("source session/lib.sh; A=1; require_one_of A B C");
    expect(result.status).toBe(0);
  });

  it("require_one_of succeeds when the last variable is set", () => {
    const result = runBash("source session/lib.sh; C=1; require_one_of A B C");
    expect(result.status).toBe(0);
  });

  it("require_one_of fails through fail when none are set", () => {
    const result = runBash("source session/lib.sh; require_one_of A B C");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FATAL: At least one of A B C must be set");
  });
});

describe.skipIf(isWindows)("verify_workspace_writable", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeEnv(): { binDir: string; workspace: string } {
    const root = mkdtempSync(join(tmpdir(), "lib-ws-test-"));
    cleanupDirs.push(root);
    const binDir = join(root, "bin");
    const workspace = join(root, "workspace");
    mkdirSync(binDir);
    mkdirSync(workspace);
    return { binDir, workspace };
  }

  function writeShim(binDir: string, name: string, body: string): void {
    const p = join(binDir, name);
    writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(p, 0o755);
  }

  function runVerify(binDir: string, workspace: string) {
    return spawnSync(
      "bash",
      ["-c", `export PATH="${binDir}:$PATH"; source session/lib.sh; verify_workspace_writable "${workspace}"`],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
  }

  it("succeeds and leaves no probe file when coder can write the workspace", () => {
    const { binDir, workspace } = makeEnv();
    writeShim(binDir, "id", `case "\${1:-}" in -u) echo 1234 ;; -g) echo 2345 ;; esac`);
    // su shim that forwards the -c command to the current shell (no user switching needed in tests)
    writeShim(
      binDir,
      "su",
      `while [[ $# -gt 0 ]]; do [ "$1" = "-c" ] && { shift; bash -c "$1"; exit $?; }; shift; done`,
    );

    const result = runVerify(binDir, workspace);
    expect(result.status).toBe(0);
    const probes = readdirSync(workspace).filter((f) => f.startsWith(".ai-implement-probe"));
    expect(probes).toHaveLength(0);
  });

  it("fails with path, ownership, and adopted UID/GID when write is denied", () => {
    const { binDir, workspace } = makeEnv();
    writeShim(binDir, "id", `case "\${1:-}" in -u) echo 1234 ;; -g) echo 2345 ;; esac`);
    writeShim(binDir, "stat", "echo 999");
    writeShim(binDir, "su", "exit 1");

    const result = runVerify(binDir, workspace);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(workspace);
    expect(result.stderr).toContain("1234");
    expect(result.stderr).toContain("2345");
    expect(result.stderr).toContain("999");
    expect(result.stderr).toMatch(/read-only/i);
  });
});
