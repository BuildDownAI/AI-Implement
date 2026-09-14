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

describe.skipIf(isWindows)("resolve_envelope_field / select_runner_entry", () => {
  function encodeEnvelope(fields: Record<string, unknown> = {}): string {
    const payload = {
      v: 1,
      issue: { id: "1", identifier: "AII-1", title: "t", description: "d" },
      ...fields,
    };
    return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
  }

  // Deterministically malformed: valid base64, but the decoded text isn't JSON.
  const MALFORMED_ENVELOPE = Buffer.from("not json at all", "utf-8").toString("base64");

  // log() writes its "[session] ..." lines to stdout, so a script that both
  // logs and echoes a result must be read by its last line.
  function lastLine(stdout: string): string {
    return stdout.trim().split("\n").at(-1) ?? "";
  }

  // Every case below unsets AI_IMPLEMENT_RUN_CONFIG, RUNNER_PHASE, and
  // RUNNER_CALLBACK_URL before establishing its own fixture, so a value
  // inherited from the invoking shell (e.g. an implementation container's
  // own already-exported envelope) can never make an assertion pass by
  // accident. Any fixture the case means resolve_envelope_field to decode
  // is `export`ed, since the node child spawned by resolve_envelope_field
  // only inherits exported variables — an unexported assignment is invisible
  // to it even though it is visible to later commands in the same shell.
  const RESET = "unset AI_IMPLEMENT_RUN_CONFIG RUNNER_PHASE RUNNER_CALLBACK_URL";

  it("env wins over the envelope (dev-harness guard: RUNNER_PHASE=full survives runnerPhase:implementation)", () => {
    const envelope = encodeEnvelope({ runnerPhase: "implementation" });
    const result = runBash(
      `${RESET}; source session/lib.sh; RUNNER_PHASE=full; export AI_IMPLEMENT_RUN_CONFIG='${envelope}'; resolve_envelope_field RUNNER_PHASE runnerPhase; select_runner_entry "$RUNNER_PHASE"`,
    );
    expect(result.status).toBe(0);
    expect(lastLine(result.stdout)).toBe("run-local-full-loop.js");
    expect(result.stdout).not.toContain("envelope.runnerPhase");
  });

  it("envelope fills empty RUNNER_PHASE (integration case: kg-refresh)", () => {
    const envelope = encodeEnvelope({ runnerPhase: "kg-refresh" });
    const result = runBash(
      `${RESET}; source session/lib.sh; export AI_IMPLEMENT_RUN_CONFIG='${envelope}'; resolve_envelope_field RUNNER_PHASE runnerPhase; select_runner_entry "$RUNNER_PHASE"`,
    );
    expect(result.status).toBe(0);
    expect(lastLine(result.stdout)).toBe("pipeline/kg-refresh-run.js");
    expect(result.stdout).toContain("envelope.runnerPhase=kg-refresh");
  });

  it("defaults to implementation when the envelope has no runnerPhase", () => {
    const envelope = encodeEnvelope({});
    const result = runBash(
      `${RESET}; source session/lib.sh; export AI_IMPLEMENT_RUN_CONFIG='${envelope}'; resolve_envelope_field RUNNER_PHASE runnerPhase; RUNNER_PHASE="\${RUNNER_PHASE:-implementation}"; echo "$RUNNER_PHASE"`,
    );
    expect(result.status).toBe(0);
    expect(lastLine(result.stdout)).toBe("implementation");
    expect(result.stdout).not.toContain("envelope.runnerPhase");
    expect(result.stdout).not.toMatch(/WARNING/);
  });

  it("defaults to implementation and logs a warning when the envelope is malformed", () => {
    const result = runBash(
      `${RESET}; source session/lib.sh; export AI_IMPLEMENT_RUN_CONFIG='${MALFORMED_ENVELOPE}'; resolve_envelope_field RUNNER_PHASE runnerPhase; RUNNER_PHASE="\${RUNNER_PHASE:-implementation}"; echo "$RUNNER_PHASE"`,
    );
    expect(result.status).toBe(0);
    expect(lastLine(result.stdout)).toBe("implementation");
    expect(result.stdout).toMatch(/WARNING/);
  });

  it("defaults to implementation when there is no envelope at all", () => {
    const result = runBash(
      `${RESET}; source session/lib.sh; resolve_envelope_field RUNNER_PHASE runnerPhase; RUNNER_PHASE="\${RUNNER_PHASE:-implementation}"; echo "$RUNNER_PHASE"`,
    );
    expect(result.status).toBe(0);
    expect(lastLine(result.stdout)).toBe("implementation");
    expect(result.stdout).not.toMatch(/WARNING/);
  });

  it("fills RUNNER_CALLBACK_URL from the envelope when env is empty", () => {
    const envelope = encodeEnvelope({ runnerCallbackUrl: "https://example.test/callback" });
    const result = runBash(
      `${RESET}; source session/lib.sh; export AI_IMPLEMENT_RUN_CONFIG='${envelope}'; resolve_envelope_field RUNNER_CALLBACK_URL runnerCallbackUrl; echo "$RUNNER_CALLBACK_URL"`,
    );
    expect(result.status).toBe(0);
    expect(lastLine(result.stdout)).toBe("https://example.test/callback");
  });

  it("leaves RUNNER_CALLBACK_URL unchanged when env is already set", () => {
    const envelope = encodeEnvelope({ runnerCallbackUrl: "https://example.test/from-envelope" });
    const result = runBash(
      `${RESET}; source session/lib.sh; RUNNER_CALLBACK_URL='https://example.test/from-env'; export AI_IMPLEMENT_RUN_CONFIG='${envelope}'; resolve_envelope_field RUNNER_CALLBACK_URL runnerCallbackUrl; echo "$RUNNER_CALLBACK_URL"`,
    );
    expect(result.status).toBe(0);
    expect(lastLine(result.stdout)).toBe("https://example.test/from-env");
    expect(result.stdout).not.toContain("envelope.runnerCallbackUrl");
  });

  it("select_runner_entry reproduces all five arms", () => {
    const cases: Array<[string, string]> = [
      ["planning", "run-planning.js"],
      ["local-planning", "run-local-planning.js"],
      ["full", "run-local-full-loop.js"],
      ["kg-refresh", "pipeline/kg-refresh-run.js"],
      ["implementation", "run-autonomous.js"],
    ];
    for (const [phase, entry] of cases) {
      const result = runBash(`source session/lib.sh; select_runner_entry "${phase}"`);
      expect(result.stdout.trim()).toBe(entry);
    }
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
