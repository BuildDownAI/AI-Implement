import { afterEach, describe, it, expect } from "vitest";

const isWindows = process.platform === "win32";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
    if (result.error && "code" in result.error && result.error.code === "ENOENT") return;
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

describe.skipIf(isWindows)("session/lib.sh configured-run helpers (AII-951)", () => {
  const run = (script: string, env: Record<string, string> = {}) =>
    spawnSync("bash", ["-c", `source session/lib.sh\n${script}`], {
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "", ...env },
    });

  it("run_scoped passes the environment through unchanged for legacy runs", () => {
    const r = run('run_scoped "" bash -c \'echo "$OPENAI_API_KEY"\'', { OPENAI_API_KEY: "legacy-value" });
    expect(r.stdout.trim()).toBe("legacy-value");
  });

  it("run_scoped hands configured children only minimal context plus named extras", () => {
    const r = run('CONFIGURED=1; run_scoped "GH_TOKEN" env', {
      HOME: "/h", GH_TOKEN: "gh", GITHUB_TOKEN: "ghp", OPENAI_API_KEY: "o", CODEX_HOME: "/c",
      AI_IMPLEMENT_RUN_CONFIG: "enc", AI_IMPLEMENT_MODEL_AUTH_BEARER: "b", FWD: "f", AI_IMPLEMENT_FORWARDED_SECRETS: "FWD",
    });
    expect(r.status, r.stderr).toBe(0);
    const names = r.stdout.trim().split("\n").map((l) => l.split("=")[0]).filter((n) => !["_", "PWD", "SHLVL", "OLDPWD", "SHELL", "TERM"].includes(n));
    expect(names.sort()).toEqual(["GH_TOKEN", "HOME", "PATH"]);
  });

  it("run_scoped preserves the child's exit status", () => {
    expect(run('CONFIGURED=1; run_scoped "" false').status).not.toBe(0);
    expect(run('run_scoped "" false').status).not.toBe(0);
  });

  it("on_err includes the command for legacy and omits it for configured runs", () => {
    expect(run('on_err 1 9 "git clone https://x:SECRET@h"').stdout).toContain("git clone");
    const r = run('CONFIGURED=1; on_err 1 9 "git clone https://x:SECRET@h"');
    expect(r.stdout).toContain("line 9 failed (exit 1)");
    expect(r.stdout).not.toContain("SECRET");
  });

  describe("scoped git credential helper", () => {
    const fill = (env: Record<string, string>) =>
      run('git -c credential.helper= -c "credential.helper=$SCOPED_GIT_HELPER" credential fill <<< $\'protocol=https\\nhost=github.com\\n\\n\'', { HOME: "/tmp", GIT_TERMINAL_PROMPT: "0", ...env });

    it("answers from the operation-scoped GIT_PASSWORD only", () => {
      const withToken = fill({ GIT_PASSWORD: "SYNTHETIC-token" });
      expect(withToken.status, withToken.stderr).toBe(0);
      expect(withToken.stdout).toContain("username=x-access-token");
      expect(withToken.stdout).toContain("password=SYNTHETIC-token");
      const without = fill({});
      expect(without.status).not.toBe(0);
      expect(without.stdout).not.toContain("password=");
    });

    it("git_authed puts the token only in the git child's environment, never in argv", () => {
      const dir = mkdtempSync(join(tmpdir(), "git-authed-"));
      const log = join(dir, "log");
      writeFileSync(join(dir, "git"), `#!/bin/sh\n{ echo "argv: $*"; env; } > '${log}'\n`);
      chmodSync(join(dir, "git"), 0o755);
      try {
        const r = run('CONFIGURED=1; git_authed clone https://github.com/o/r.git /w', {
          PATH: `${dir}:${process.env.PATH}`, HOME: "/h", GITHUB_TOKEN: "SYNTHETIC-token", OPENAI_API_KEY: "SENTINEL-openai",
        });
        expect(r.status, r.stderr).toBe(0);
        const seen = readFileSync(log, "utf-8");
        expect(seen).toContain("argv: clone https://github.com/o/r.git /w");
        expect(seen.split("\n")[0]).not.toContain("SYNTHETIC-token");
        expect(seen).toContain("GIT_PASSWORD=SYNTHETIC-token");
        expect(seen).not.toContain("GITHUB_TOKEN");
        expect(seen).not.toContain("SENTINEL-openai");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("remap_team_secrets reservation", () => {
    const MODEL_NAMES = [
      "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
      "CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AI_IMPLEMENT_MODEL_AUTH_BEARER", "AI_IMPLEMENT_RUN_CONFIG",
    ];
    const secrets = (): Record<string, string> => ({
      AI_IMPLEMENT_TEAM_SECRET_PREFIX: "SAN_",
      SAN_DB_URL: "safe-value",
      ...Object.fromEntries(MODEL_NAMES.map((n) => [`SAN_${n}`, `SENTINEL-${n}`])),
    });
    const probe = (configured: boolean) =>
      run(
        `${configured ? "CONFIGURED=1\n" : ""}remap_team_secrets\n` +
          `echo "FORWARDED=$AI_IMPLEMENT_FORWARDED_SECRETS"\n` +
          MODEL_NAMES.map((n) => `echo "${n}=\${${n}:-UNSET}"`).join("\n"),
        secrets(),
      );

    it("configured runs reject every model, session and provider-routing alias but forward a normal secret", () => {
      const r = probe(true);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("FORWARDED=DB_URL\n");
      for (const n of MODEL_NAMES) expect(r.stdout).toContain(`${n}=UNSET`);
      expect(r.stdout).not.toContain("SENTINEL-");
    });

    it("legacy runs keep the narrower reserved list: non-reserved model-looking names still forward", () => {
      const r = probe(false);
      expect(r.stdout).toContain("OPENAI_API_KEY=SENTINEL-OPENAI_API_KEY");
      expect(r.stdout).toContain("CLAUDE_CONFIG_DIR=SENTINEL-CLAUDE_CONFIG_DIR");
      // AI_IMPLEMENT_* stays reserved in every mode.
      expect(r.stdout).toContain("AI_IMPLEMENT_MODEL_AUTH_BEARER=UNSET");
      expect(r.stdout).toContain("AI_IMPLEMENT_RUN_CONFIG=UNSET");
    });

    it("configured runs reserve NODE_OPTIONS/NODE_PATH aliases; legacy runs keep forwarding them", () => {
      const env = {
        AI_IMPLEMENT_TEAM_SECRET_PREFIX: "SAN_",
        SAN_NODE_OPTIONS: "--require=/sentinel/preload.cjs",
        SAN_NODE_PATH: "/sentinel/modules",
        SAN_DB_URL: "safe-value",
      };
      const script = (c: boolean) =>
        `${c ? "CONFIGURED=1\n" : ""}remap_team_secrets\necho "F=$AI_IMPLEMENT_FORWARDED_SECRETS"\necho "NO=\${NODE_OPTIONS:-UNSET}"\necho "NP=\${NODE_PATH:-UNSET}"\necho "DB=$DB_URL"`;
      const configured = run(script(true), env);
      expect(configured.stdout).toContain("F=DB_URL\n");
      expect(configured.stdout).toContain("NO=UNSET");
      expect(configured.stdout).toContain("NP=UNSET");
      expect(configured.stdout).toContain("DB=safe-value");
      const legacy = run(script(false), env);
      expect(legacy.stdout).toContain("NO=--require=/sentinel/preload.cjs");
      expect(legacy.stdout).toContain("NP=/sentinel/modules");
    });
  });

  describe("node decoders never start with ambient preload controls", () => {
    const withFixture = (fn: (fx: { dist: string; preload: string; marker: string }) => void) => {
      const dir = mkdtempSync(join(tmpdir(), "session-node-"));
      try {
        const dist = join(dir, "dist");
        mkdirSync(dist);
        const marker = join(dir, "marker");
        const preload = join(dir, "preload.cjs");
        writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(Boolean(process.env.AI_IMPLEMENT_RUN_CONFIG)));\n`);
        // Stand-in trusted decoder: this suite probes launch hygiene, not decoding.
        writeFileSync(join(dist, "run-config.js"),
          'export function decodeTrustedRunConfig(e){ if (e === "BAD") throw new Error("bad"); return { agentConfig: {}, credentials: { modelAuthGrant: {} } }; }\n');
        fn({ dist, preload, marker });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const run = (script: string, env: Record<string, string>) =>
      spawnSync("bash", ["-c", `source session/lib.sh\n${script}`], { encoding: "utf-8", env: { PATH: process.env.PATH ?? "", ...env } });

    it("control: the preload does execute when node is launched bare", () => {
      withFixture(({ preload, marker }) => {
        spawnSync("node", ["-e", ""], { env: { PATH: process.env.PATH ?? "", NODE_OPTIONS: `--require=${preload}`, AI_IMPLEMENT_RUN_CONFIG: "X" } });
        expect(existsSync(marker)).toBe(true);
      });
    });

    it.each([["valid configured", "OK", "configured"], ["malformed", "BAD", "invalid"]])(
      "classify_run_config (%s) runs no NODE_OPTIONS preload and ignores NODE_PATH",
      (_n, envelope, expected) => {
        withFixture(({ dist, preload, marker }) => {
          const r = run("classify_run_config", {
            AI_IMPLEMENT_DIST_DIR: dist, AI_IMPLEMENT_RUN_CONFIG: envelope,
            NODE_OPTIONS: `--require=${preload}`, NODE_PATH: "/sentinel/modules",
          });
          expect(r.stdout.trim()).toBe(expected);
          expect(existsSync(marker)).toBe(false);
        });
      },
    );

    it("resolve_envelope_field runs no NODE_OPTIONS preload", () => {
      withFixture(({ preload, marker }) => {
        const envelope = Buffer.from(JSON.stringify({ v: 1, runnerPhase: "planning" })).toString("base64");
        const r = run("resolve_envelope_field RUNNER_PHASE runnerPhase\necho \"P=$RUNNER_PHASE\"", {
          AI_IMPLEMENT_RUN_CONFIG: envelope, NODE_OPTIONS: `--require=${preload}`,
        });
        expect(r.stdout).toContain("P=planning");
        expect(existsSync(marker)).toBe(false);
      });
    });
  });
});

describe.skipIf(isWindows)("local configured bootstrap classification", () => {
  const classify = (envelope: string | undefined, pointer: string | undefined, grant = false) => {
    const dir = mkdtempSync(join(tmpdir(), "local-classify-"));
    try {
      mkdirSync(join(dir, "local"));
      writeFileSync(join(dir, "run-config.js"), `export function decodeTrustedRunConfig(e) { if(e === "bad") throw Error(); return {agentConfig:e === "snapshot" ? {} : undefined, credentials:${grant ? '{modelAuthGrant:{}}' : '{}'}}; }`);
      writeFileSync(join(dir, "local/session.js"), 'export function validateLocalSessionBootstrap(p) { if (p !== "/private/valid") throw Error("private error"); }');
      return spawnSync("bash", ["-c", "source session/lib.sh; classify_run_config"], {
        encoding: "utf-8",
        env: { PATH: process.env.PATH ?? "", AI_IMPLEMENT_DIST_DIR: dir,
          ...(envelope ? { AI_IMPLEMENT_RUN_CONFIG: envelope } : {}),
          ...(pointer ? { AI_IMPLEMENT_LOCAL_AUTH_BOOTSTRAP_FILE: pointer } : {}) },
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it("accepts snapshot plus validated local bootstrap without a hosted grant", () => {
    expect(classify("snapshot", "/private/valid").stdout).toBe("configured");
  });
  it.each([[undefined, "/private/valid"], ["legacy", "/private/valid"], ["snapshot", "/private/invalid"], ["bad", "/private/valid"], ["snapshot", undefined]])(
    "fails closed for incomplete or invalid local intent (%s, %s)", (envelope, pointer) => {
      const result = classify(envelope, pointer);
      expect(result.stdout.trim()).toBe("invalid");
      expect(result.stderr).not.toContain("private error");
    },
  );
  it("rejects mixing local bootstrap with a hosted grant", () => {
    expect(classify("snapshot", "/private/valid", true).stdout).toBe("invalid");
  });
  it("preserves the envelope-free legacy path", () => {
    expect(classify(undefined, undefined).stdout.trim()).toBe("legacy");
  });
});
