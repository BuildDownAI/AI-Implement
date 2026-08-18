import { afterEach, describe, it, expect } from "vitest";

const isWindows = process.platform === "win32";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

  // Workspace is passed as argv $1 so shell-significant characters in the path
  // are never interpolated into the bash -c command text.
  function runVerify(binDir: string, workspace: string) {
    return spawnSync(
      "bash",
      ["-c", `export PATH="${binDir}:$PATH"; source session/lib.sh; verify_workspace_writable "$1"`, "--", workspace],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
  }

  function writeSuShim(binDir: string): void {
    writeShim(
      binDir,
      "su",
      [
        "cmd=''",
        "pos_args=()",
        "while (( $# )); do",
        '  case "$1" in',
        '    -c) cmd="$2"; shift 2 ;;',
        "    -s) shift 2 ;;",
        '    --) shift; pos_args=("$@"); break ;;',
        "    *) shift ;;",
        "  esac",
        "done",
        'exec bash -c "$cmd" "${pos_args[@]}"',
      ].join("\n"),
    );
  }

  it("succeeds and leaves no probe file when coder can write the workspace", () => {
    const { binDir, workspace } = makeEnv();
    writeShim(binDir, "id", `case "\${1:-}" in -u) echo 1234 ;; -g) echo 2345 ;; esac`);
    // su shim: extract the -c script and positional args after --, run as current user.
    // Real su strips -- before calling bash, so bash sees: bash -c '<script>' _ /workspace
    // ($0=_, $1=/workspace).  We replicate that by collecting args after -- and calling
    // bash without --.
    writeSuShim(binDir);

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

  it("does not execute $(...) syntax embedded in the workspace path during cleanup", () => {
    // The sentinel target path can't appear literally in the directory name (filenames
    // cannot contain /), so we reference it via $PROBE_SENTINEL and pass the real
    // path as an env var.  If the trap were to eval the probe path, it would run
    // `touch $PROBE_SENTINEL` and create the sentinel file.
    const sentinelRoot = mkdtempSync(join(tmpdir(), "sentinel-test-"));
    cleanupDirs.push(sentinelRoot);
    const sentinel = join(sentinelRoot, "PWNED");

    const wsRoot = mkdtempSync(join(tmpdir(), "hostile-ws-"));
    cleanupDirs.push(wsRoot);
    // $, (, ), and space are valid filename characters on Linux.
    const hostileWs = join(wsRoot, "ws-$(touch $PROBE_SENTINEL)");
    mkdirSync(hostileWs);

    const { binDir } = makeEnv();
    writeShim(binDir, "id", `case "\${1:-}" in -u) echo 1234 ;; -g) echo 2345 ;; esac`);
    writeSuShim(binDir);

    const result = spawnSync(
      "bash",
      ["-c", `export PATH="${binDir}:$PATH"; source session/lib.sh; verify_workspace_writable "$1"`, "--", hostileWs],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PROBE_SENTINEL: sentinel } },
    );
    expect(result.status).toBe(0);
    // Probe must be cleaned up
    const probes = readdirSync(hostileWs).filter((f) => f.startsWith(".ai-implement-probe"));
    expect(probes).toHaveLength(0);
    // Command embedded in the path must not have executed
    expect(existsSync(sentinel)).toBe(false);
  });

  it("does not execute backtick syntax embedded in the workspace path during cleanup", () => {
    const sentinelRoot = mkdtempSync(join(tmpdir(), "sentinel-test-"));
    cleanupDirs.push(sentinelRoot);
    const sentinel = join(sentinelRoot, "PWNED");

    const wsRoot = mkdtempSync(join(tmpdir(), "hostile-ws-"));
    cleanupDirs.push(wsRoot);
    // Backtick is a valid filename character on Linux.
    const hostileWs = join(wsRoot, "ws-`touch $PROBE_SENTINEL`");
    mkdirSync(hostileWs);

    const { binDir } = makeEnv();
    writeShim(binDir, "id", `case "\${1:-}" in -u) echo 1234 ;; -g) echo 2345 ;; esac`);
    writeSuShim(binDir);

    const result = spawnSync(
      "bash",
      ["-c", `export PATH="${binDir}:$PATH"; source session/lib.sh; verify_workspace_writable "$1"`, "--", hostileWs],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PROBE_SENTINEL: sentinel } },
    );
    expect(result.status).toBe(0);
    // Probe must be cleaned up
    const probes = readdirSync(hostileWs).filter((f) => f.startsWith(".ai-implement-probe"));
    expect(probes).toHaveLength(0);
    // Command embedded in the path must not have executed
    expect(existsSync(sentinel)).toBe(false);
  });
});
