import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const isWindows = process.platform === "win32";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { ClaudeCliExecutor, readTelemetryFlag, type ActivityReportingConfig } from "../pipeline/executor.js";
import { computeBackoffMs, DEFAULT_RETRY_POLICY, type RetryPolicy } from "../pipeline/retry-backoff.js";
import type { ActivitySink, ActivityIdentity, ActivityToolResult } from "../pipeline/types.js";

interface FakeAttempt {
  stdoutLines?: string[];
  stderr?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

/**
 * A fake `spawn` (the constructor's 4th param) that plays back one scripted
 * attempt per call, falling back to the last spec once exhausted. Emitting on
 * `setImmediate` mirrors the real spawn's async event delivery so the
 * executor's promise-based plumbing is exercised the same way it is in
 * production, without a real subprocess — this is what makes a multi-attempt
 * retry sequence practical to script (a real fake-`claude`-on-PATH binary has
 * no state across separate process invocations).
 */
function makeFakeSpawn(attempts: FakeAttempt[]): { spawnImpl: typeof spawn; callCount: () => number } {
  let calls = 0;
  const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
    const spec = attempts[calls] ?? attempts[attempts.length - 1];
    calls++;
    const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
    const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
    (stdin as unknown as { end: (s: string) => void }).end = () => {};
    Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
    setImmediate(() => {
      for (const line of spec.stdoutLines ?? []) {
        (proc.stdout as unknown as EventEmitter).emit("data", Buffer.from(`${line}\n`));
      }
      if (spec.stderr) (proc.stderr as unknown as EventEmitter).emit("data", Buffer.from(spec.stderr));
      // `spec.exitCode` may deliberately be `null` (a signalled close) — `=== undefined`
      // (not `??`) is what keeps that distinct from "unset, default to a clean exit".
      proc.emit("close", spec.exitCode === undefined ? 0 : spec.exitCode, spec.signal ?? null);
    });
    return proc;
  }) as unknown as typeof spawn;
  return { spawnImpl, callCount: () => calls };
}

// Node's real stdio streams support `.destroy()`; a bare `EventEmitter` fake
// doesn't, and the PROCESS_UNRESPONSIVE path calls it on all three handles
// (see executor.ts). Tests that drive a fake process into that path need this
// instead of a plain `new EventEmitter()`.
function makeDestroyableEmitter(): EventEmitter {
  const emitter = new EventEmitter();
  (emitter as unknown as { destroy: () => void }).destroy = () => {};
  return emitter;
}

function makeFakeSleep(): { sleepImpl: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  const sleepImpl = (ms: number): Promise<void> => {
    calls.push(ms);
    return Promise.resolve();
  };
  return { sleepImpl, calls };
}

let binDir: string;

// A fake `claude` that records the argv it was invoked with and whatever arrived
// on stdin, then emits a single valid result line so the stream executor settles
// cleanly. This exercises the actual spawn + stdio plumbing — the only thing that
// meaningfully proves the E2BIG fix (prompt delivered on stdin, not as argv).
function installArgvRecordingClaude(): void {
  const resultLine = JSON.stringify({
    type: "result",
    subtype: "success",
    result: "ok",
    num_turns: 1,
    duration_ms: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const script = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${binDir}/argv.txt"
cat > "${binDir}/stdin.txt"
printf '%s\\n' '${resultLine}'
exit 0
`;
  const path = join(binDir, "claude");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

function installEnvironmentRecordingClaude(): void {
  const resultLine = JSON.stringify({
    type: "result",
    subtype: "success",
    result: "ok",
    num_turns: 1,
    duration_ms: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const script = `#!/usr/bin/env bash
printf '%s\n' "\${GITHUB_TOKEN-unset}" > "${binDir}/github-token.txt"
printf '%s\n' "\${GH_TOKEN-unset}" > "${binDir}/gh-token.txt"
printf '%s\n' "\${GH_ENTERPRISE_TOKEN-unset}" > "${binDir}/gh-enterprise-token.txt"
printf '%s\n' "\${GITHUB_ENTERPRISE_TOKEN-unset}" > "${binDir}/github-enterprise-token.txt"
printf '%s\n' "\${GIT_PASSWORD-unset}" > "${binDir}/git-password.txt"
printf '%s\n' "\${RUN_PROGRESS_TOKEN-unset}" > "${binDir}/run-progress-token.txt"
printf '%s\n' "\${RUN_PUBLICATION_TOKEN-unset}" > "${binDir}/run-publication-token.txt"
printf '%s\n' "\${RUN_TOKEN-unset}" > "${binDir}/run-token.txt"
printf '%s\n' "\${SAFE_EXECUTOR_VAR-unset}" > "${binDir}/safe-executor-var.txt"
git remote get-url origin > "${binDir}/origin-url.txt" 2>/dev/null || true
printf '%s\n' '${resultLine}'
exit 0
`;
  const path = join(binDir, "claude");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

function installForwardedSecretRecordingClaude(): void {
  const resultLine = JSON.stringify({
    type: "result",
    subtype: "success",
    result: "ok",
    num_turns: 1,
    duration_ms: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const script = `#!/usr/bin/env bash
printf '%s\n' "\${QA_BASE_URL-unset}" > "${binDir}/qa-base-url.txt"
printf '%s\n' "\${QA_TOKEN-unset}" > "${binDir}/qa-token.txt"
printf '%s\n' "\${AI_IMPLEMENT_FORWARDED_SECRETS-unset}" > "${binDir}/ai-implement-forwarded-secrets.txt"
env > "${binDir}/env-dump.txt"
printf '%s\n' '${resultLine}'
exit 0
`;
  const path = join(binDir, "claude");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

function installModelCredentialRecordingClaude(): void {
  const resultLine = JSON.stringify({
    type: "result",
    subtype: "success",
    result: "ok",
    num_turns: 1,
    duration_ms: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const script = `#!/usr/bin/env bash
printf '%s\n' "\${ANTHROPIC_API_KEY-unset}" > "${binDir}/anthropic-api-key.txt"
printf '%s\n' "\${CLAUDE_CODE_OAUTH_TOKEN-unset}" > "${binDir}/claude-oauth-token.txt"
printf '%s\n' '${resultLine}'
exit 0
`;
  const path = join(binDir, "claude");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

const SUCCESS_LINES = [
  JSON.stringify({ type: "system", subtype: "init", model: "claude-x", cwd: "/workspace" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm check" } }] } }),
  JSON.stringify({ type: "result", subtype: "success", result: "Done implementing.", num_turns: 4, duration_ms: 5000, usage: { input_tokens: 100, output_tokens: 20 } }),
];

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(binDir, { recursive: true, force: true });
});

// Builds a fake ChildProcess whose stdout emits the given content string, then
// closes with exitCode. Content is pushed asynchronously so all event listeners
// are registered before data arrives, matching real child process ordering.
function makeTestProcess(stdoutContent: string, exitCode: number, stderrContent = ""): ChildProcessWithoutNullStreams {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const ee = new EventEmitter();
  const proc = Object.assign(ee, { stdout, stderr, stdin }) as unknown as ChildProcessWithoutNullStreams;
  setImmediate(() => {
    stdout.push(stdoutContent);
    stdout.push(null);
    if (stderrContent) stderr.push(stderrContent);
    stderr.push(null);
    setImmediate(() => ee.emit("close", exitCode));
  });
  return proc;
}

describe("readTelemetryFlag", () => {
  it("rejects an array, matching its sibling readers (readBoolFlag/readSignalFlag)", () => {
    expect(readTelemetryFlag({ telemetry: [1, 2, 3] })).toBeUndefined();
  });

  it("accepts a plain RunTelemetry-shaped object", () => {
    const telemetry = { outcome: "success", numTurns: 1, durationMs: 1, costUsd: 0, tokensIn: 1, tokensOut: 1 };
    expect(readTelemetryFlag({ telemetry })).toEqual(telemetry);
  });

  it("rejects a non-object err", () => {
    expect(readTelemetryFlag(null)).toBeUndefined();
    expect(readTelemetryFlag("not an object")).toBeUndefined();
  });
});

describe.skipIf(isWindows)("ClaudeCliExecutor", () => {
  it("returns the result event's text as stdout (compat) plus telemetry", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fakeProc = makeTestProcess(SUCCESS_LINES.join("\n") + "\n", 0);
    const fakeSpawn = () => fakeProc;
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, fakeSpawn as unknown as typeof spawn);
    const result = await exec.invoke({ prompt: "do it", model: "claude-x" });

    expect(result.stdout).toBe("Done implementing.");
    expect(result.exitCode).toBe(0);
    expect(result.telemetry?.outcome).toBe("success");
    expect(result.telemetry?.numTurns).toBe(4);
    expect(result.tokensUsed).toBe(120);
  });

  it("does NOT print per-event lines at summary level, but prints the summary", async () => {
    const fakeProc = makeTestProcess(SUCCESS_LINES.join("\n") + "\n", 0);
    const fakeSpawn = () => fakeProc;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await new ClaudeCliExecutor("/tmp", "summary", false, fakeSpawn as unknown as typeof spawn).invoke({ prompt: "p", model: "m" });

    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith("[claude] result="))).toBe(true);
    expect(lines.some((l) => l.startsWith("[claude] tool "))).toBe(false);
  });

  it("prints per-event lines at stream level", async () => {
    const fakeProc = makeTestProcess(SUCCESS_LINES.join("\n") + "\n", 0);
    const fakeSpawn = () => fakeProc;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await new ClaudeCliExecutor("/tmp", "stream", false, fakeSpawn as unknown as typeof spawn).invoke({ prompt: "p", model: "m" });

    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("tool Bash pnpm check"))).toBe(true);
    expect(lines.some((l) => l.startsWith("[claude] result="))).toBe(true);
  });

  it("propagates a non-zero exit code and degrades telemetry to unknown", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fakeProc = makeTestProcess("not even json\n", 1);
    const fakeSpawn = () => fakeProc;
    const result = await new ClaudeCliExecutor("/tmp", "summary", false, fakeSpawn as unknown as typeof spawn).invoke({ prompt: "p", model: "m" });
    expect(result.exitCode).toBe(1);
    expect(result.telemetry?.outcome).toBe("unknown");
    expect(result.stdout).toBe("");
  });

  it("parses a final line that has no trailing newline", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fakeProc = makeTestProcess(SUCCESS_LINES.join("\n"), 0);
    const fakeSpawn = () => fakeProc;
    const result = await new ClaudeCliExecutor(
      "/tmp",
      "summary",
      false,
      fakeSpawn as unknown as typeof spawn,
    ).invoke({ prompt: "p", model: "m" });
    expect(result.stdout).toBe("Done implementing.");
    expect(result.telemetry?.outcome).toBe("success");
    expect(result.telemetry?.numTurns).toBe(4);
  });

  it("surfaces non-empty CLI stderr via console.error and returns it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fakeProc = makeTestProcess("", 1, "Authentication failed: invalid API key\n");
    const fakeSpawn = () => fakeProc;
    const result = await new ClaudeCliExecutor("/tmp", "summary", false, fakeSpawn as unknown as typeof spawn).invoke({ prompt: "p", model: "m" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Authentication failed");
    const errLines = err.mock.calls.map((c) => c.join(" "));
    expect(errLines.some((l) => l.includes("[claude] stderr:") && l.includes("Authentication failed"))).toBe(true);
  });

  it("delivers the prompt over stdin, never as a command-line argument", async () => {
    // A prompt larger than Linux MAX_ARG_STRLEN (128 KiB) trips spawn E2BIG when
    // passed as a single argv element. Delivering it on stdin sidesteps that.
    vi.spyOn(console, "log").mockImplementation(() => {});
    installArgvRecordingClaude();
    const bigPrompt = "X".repeat(200_000);

    const result = await new ClaudeCliExecutor(binDir, "summary").invoke({
      prompt: bigPrompt,
      model: "claude-sonnet-4-6",
    });

    expect(result.exitCode).toBe(0);

    const argv = readFileSync(join(binDir, "argv.txt"), "utf-8");
    const stdin = readFileSync(join(binDir, "stdin.txt"), "utf-8");

    // The prompt must arrive via stdin...
    expect(stdin).toContain(bigPrompt);
    // ...and must NOT appear in argv (that is what causes E2BIG).
    expect(argv).not.toContain(bigPrompt);
  });

  it("still passes model and flags as arguments", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    installArgvRecordingClaude();
    await new ClaudeCliExecutor(binDir, "summary").invoke({
      prompt: "hello",
      model: "claude-sonnet-4-6",
      maxTurns: 7,
    });

    const argv = readFileSync(join(binDir, "argv.txt"), "utf-8");
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).toContain("--model");
    expect(argv).toContain("claude-sonnet-4-6");
    expect(argv).toContain("--max-turns");
    expect(argv).toContain("7");
  });

  it("withholds GitHub write credentials from initial implementation sessions", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    installEnvironmentRecordingClaude();
    vi.stubEnv("GITHUB_TOKEN", "github-write-token");
    vi.stubEnv("GH_TOKEN", "gh-write-token");
    vi.stubEnv("GH_ENTERPRISE_TOKEN", "gh-enterprise-write-token");
    vi.stubEnv("GITHUB_ENTERPRISE_TOKEN", "github-enterprise-write-token");
    vi.stubEnv("GIT_PASSWORD", "git-write-password");
    vi.stubEnv("RUN_PROGRESS_TOKEN", "run-progress-token");
    vi.stubEnv("RUN_PUBLICATION_TOKEN", "run-publication-token");
    vi.stubEnv("RUN_TOKEN", "run-token");
    vi.stubEnv("SAFE_EXECUTOR_VAR", "safe");
    const tokenizedOrigin = "https://x-access-token:github-write-token@github.com/acme/app.git";
    execFileSync("git", ["init", "-q"], { cwd: binDir });
    execFileSync("git", ["remote", "add", "origin", tokenizedOrigin], { cwd: binDir });

    await new ClaudeCliExecutor(binDir, "summary", false).invoke({ prompt: "p", model: "m" });

    expect(readFileSync(join(binDir, "github-token.txt"), "utf-8").trim()).toBe("unset");
    expect(readFileSync(join(binDir, "gh-token.txt"), "utf-8").trim()).toBe("unset");
    expect(readFileSync(join(binDir, "gh-enterprise-token.txt"), "utf-8").trim()).toBe("unset");
    expect(readFileSync(join(binDir, "github-enterprise-token.txt"), "utf-8").trim()).toBe("unset");
    expect(readFileSync(join(binDir, "git-password.txt"), "utf-8").trim()).toBe("unset");
    expect(readFileSync(join(binDir, "run-progress-token.txt"), "utf-8").trim()).toBe("unset");
    expect(readFileSync(join(binDir, "run-publication-token.txt"), "utf-8").trim()).toBe("unset");
    expect(readFileSync(join(binDir, "run-token.txt"), "utf-8").trim()).toBe("unset");
    expect(readFileSync(join(binDir, "safe-executor-var.txt"), "utf-8").trim()).toBe("safe");
    expect(readFileSync(join(binDir, "origin-url.txt"), "utf-8").trim()).toBe("https://github.com/acme/app.git");
    expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: binDir, encoding: "utf-8" }).trim()).toBe(tokenizedOrigin);
    expect(process.env.RUN_PROGRESS_TOKEN).toBe("run-progress-token");
    expect(process.env.RUN_PUBLICATION_TOKEN).toBe("run-publication-token");
    expect(process.env.RUN_TOKEN).toBe("run-token");
  });

  it("preserves GitHub credentials for gap-fill sessions that own their existing PR branch but withholds runner tokens", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    installEnvironmentRecordingClaude();
    vi.stubEnv("GITHUB_TOKEN", "github-write-token");
    vi.stubEnv("GH_TOKEN", "gh-write-token");
    vi.stubEnv("RUN_PROGRESS_TOKEN", "run-progress-token");
    vi.stubEnv("RUN_PUBLICATION_TOKEN", "run-publication-token");
    vi.stubEnv("RUN_TOKEN", "run-token");
    vi.stubEnv("SAFE_EXECUTOR_VAR", "safe");
    const tokenizedOrigin = "https://x-access-token:github-write-token@github.com/acme/app.git";
    execFileSync("git", ["init", "-q"], { cwd: binDir });
    execFileSync("git", ["remote", "add", "origin", tokenizedOrigin], { cwd: binDir });

    await new ClaudeCliExecutor(binDir, "summary", true).invoke({ prompt: "p", model: "m" });

    expect(readFileSync(join(binDir, "github-token.txt"), "utf-8").trim()).toBe("github-write-token");
    expect(readFileSync(join(binDir, "gh-token.txt"), "utf-8").trim()).toBe("gh-write-token");
    expect(readFileSync(join(binDir, "run-progress-token.txt"), "utf-8").trim()).toBe("unset");
    expect(readFileSync(join(binDir, "run-publication-token.txt"), "utf-8").trim()).toBe("unset");
    expect(readFileSync(join(binDir, "run-token.txt"), "utf-8").trim()).toBe("unset");
    expect(readFileSync(join(binDir, "safe-executor-var.txt"), "utf-8").trim()).toBe("safe");
    expect(readFileSync(join(binDir, "origin-url.txt"), "utf-8").trim()).toBe(tokenizedOrigin);
    expect(process.env.RUN_PROGRESS_TOKEN).toBe("run-progress-token");
    expect(process.env.RUN_PUBLICATION_TOKEN).toBe("run-publication-token");
    expect(process.env.RUN_TOKEN).toBe("run-token");
  });

  it("leaves SSH origins unchanged while withholding environment credentials", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    installEnvironmentRecordingClaude();
    vi.stubEnv("GITHUB_TOKEN", "github-write-token");
    const sshOrigin = "ssh://git@github.com/acme/app.git";
    execFileSync("git", ["init", "-q"], { cwd: binDir });
    execFileSync("git", ["remote", "add", "origin", sshOrigin], { cwd: binDir });

    await new ClaudeCliExecutor(binDir, "summary", false).invoke({ prompt: "p", model: "m" });

    expect(readFileSync(join(binDir, "github-token.txt"), "utf-8").trim()).toBe("unset");
    expect(readFileSync(join(binDir, "origin-url.txt"), "utf-8").trim()).toBe(sshOrigin);
    expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: binDir, encoding: "utf-8" }).trim()).toBe(sshOrigin);
  });

  it("OAuth-wins: when both model credentials are set, only OAuth token reaches Claude", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    installModelCredentialRecordingClaude();
    vi.stubEnv("ANTHROPIC_API_KEY", "sentinel-api-key");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sentinel-oauth-token");

    await new ClaudeCliExecutor("/tmp", "summary").invoke({ prompt: "p", model: "m" });

    expect(readFileSync(join(binDir, "claude-oauth-token.txt"), "utf-8").trim()).toBe("sentinel-oauth-token");
    expect(readFileSync(join(binDir, "anthropic-api-key.txt"), "utf-8").trim()).toBe("unset");
  });

  it("API key only: API key reaches Claude when OAuth token is absent", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    installModelCredentialRecordingClaude();
    vi.stubEnv("ANTHROPIC_API_KEY", "sentinel-api-key");
    const savedOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    try {
      await new ClaudeCliExecutor("/tmp", "summary").invoke({ prompt: "p", model: "m" });
      expect(readFileSync(join(binDir, "anthropic-api-key.txt"), "utf-8").trim()).toBe("sentinel-api-key");
      expect(readFileSync(join(binDir, "claude-oauth-token.txt"), "utf-8").trim()).toBe("unset");
    } finally {
      if (savedOAuth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOAuth;
    }
  });

  it("OAuth only: OAuth token reaches Claude when API key is absent", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    installModelCredentialRecordingClaude();
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sentinel-oauth-token");
    const savedApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      await new ClaudeCliExecutor("/tmp", "summary").invoke({ prompt: "p", model: "m" });
      expect(readFileSync(join(binDir, "claude-oauth-token.txt"), "utf-8").trim()).toBe("sentinel-oauth-token");
      expect(readFileSync(join(binDir, "anthropic-api-key.txt"), "utf-8").trim()).toBe("unset");
    } finally {
      if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
    }
  });

  it("strips forwarded secrets from model env by key and by value", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    installForwardedSecretRecordingClaude();
    vi.stubEnv("AI_IMPLEMENT_FORWARDED_SECRETS", "QA_BASE_URL,QA_TOKEN");
    vi.stubEnv("QA_BASE_URL", "https://qa.example.com");
    vi.stubEnv("QA_TOKEN", "sentinel-qa-token-abc");

    await new ClaudeCliExecutor("/tmp", "summary").invoke({ prompt: "p", model: "m" });

    expect(readFileSync(join(binDir, "qa-base-url.txt"), "utf-8").trim()).toBe("unset");
    expect(readFileSync(join(binDir, "qa-token.txt"), "utf-8").trim()).toBe("unset");
    expect(readFileSync(join(binDir, "ai-implement-forwarded-secrets.txt"), "utf-8").trim()).toBe("unset");
    const envDump = readFileSync(join(binDir, "env-dump.txt"), "utf-8");
    expect(envDump).not.toContain("sentinel-qa-token-abc");
  });

  it("logs forwarded secret names (not values) at runner start when list is non-empty", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    installForwardedSecretRecordingClaude();
    vi.stubEnv("AI_IMPLEMENT_FORWARDED_SECRETS", "QA_BASE_URL,QA_TOKEN");
    vi.stubEnv("QA_BASE_URL", "https://qa.example.com");
    vi.stubEnv("QA_TOKEN", "sentinel-qa-token-xyz");

    await new ClaudeCliExecutor("/tmp", "summary").invoke({ prompt: "p", model: "m" });

    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("QA_BASE_URL") && l.includes("QA_TOKEN"))).toBe(true);
    expect(lines.every((l) => !l.includes("sentinel-qa-token-xyz"))).toBe(true);
    expect(lines.every((l) => !l.includes("https://qa.example.com"))).toBe(true);
  });

  it("does not log forwarded secrets line when AI_IMPLEMENT_FORWARDED_SECRETS is unset", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    installForwardedSecretRecordingClaude();
    const saved = process.env.AI_IMPLEMENT_FORWARDED_SECRETS;
    delete process.env.AI_IMPLEMENT_FORWARDED_SECRETS;

    try {
      await new ClaudeCliExecutor("/tmp", "summary").invoke({ prompt: "p", model: "m" });
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines.every((l) => !l.includes("forwarded secrets"))).toBe(true);
    } finally {
      if (saved !== undefined) process.env.AI_IMPLEMENT_FORWARDED_SECRETS = saved;
    }
  });

  it("ignores forwarded secret names absent from the environment", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("AI_IMPLEMENT_FORWARDED_SECRETS", "DOES_NOT_EXIST_KEY");
    delete process.env.DOES_NOT_EXIST_KEY;

    const fakeProc = makeTestProcess(SUCCESS_LINES.join("\n") + "\n", 0);
    const fakeSpawn = () => fakeProc;
    await expect(
      new ClaudeCliExecutor("/tmp", "summary", false, fakeSpawn as unknown as typeof spawn).invoke({ prompt: "p", model: "m" }),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it("tolerates whitespace and empty entries in AI_IMPLEMENT_FORWARDED_SECRETS", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("AI_IMPLEMENT_FORWARDED_SECRETS", " QA_BASE_URL , ,QA_TOKEN ");
    vi.stubEnv("QA_BASE_URL", "https://qa.example.com");
    vi.stubEnv("QA_TOKEN", "sentinel-qa-token-ws");

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const fakeProc = makeTestProcess(SUCCESS_LINES.join("\n") + "\n", 0);
    const fakeSpawn = (_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      capturedEnv = opts?.env;
      return fakeProc;
    };

    await new ClaudeCliExecutor("/tmp", "summary", false, fakeSpawn as unknown as typeof spawn).invoke({ prompt: "p", model: "m" });

    expect(capturedEnv?.QA_BASE_URL).toBeUndefined();
    expect(capturedEnv?.QA_TOKEN).toBeUndefined();
    expect(capturedEnv?.AI_IMPLEMENT_FORWARDED_SECRETS).toBeUndefined();
    expect(Object.values(capturedEnv ?? {}).some((v) => v?.includes("sentinel-qa-token-ws"))).toBe(false);
  });

  it("kills the child on a stdin EPIPE, waits for close, and rejects with a classified transient spawn failure (BAC-27114 supersedes the EPIPE-ignore guard)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const ee = new EventEmitter();
    const proc = Object.assign(ee, { stdout, stderr, stdin }) as unknown as ChildProcessWithoutNullStreams;

    stdin.end = ((..._args: unknown[]) => {
      setImmediate(() => stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
      return stdin;
    }) as unknown as typeof stdin.end;

    setImmediate(() => {
      stdout.push(null);
      stderr.push(null);
      setImmediate(() => ee.emit("close", 1));
    });

    const fakeSpawn = () => proc;
    const err = await new ClaudeCliExecutor("/tmp", "summary", false, fakeSpawn as unknown as typeof spawn)
      .invoke({ prompt: "p", model: "m" })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "EPIPE" });
    const failure = (err as Error & { failure?: { category?: string; code?: string } }).failure;
    expect(failure?.category).toBe("transient");
    expect(failure?.code).toBe("PROCESS_SPAWN_FAILED");
  });

  it("rejects on non-EPIPE stdin write error once the killed child closes, classified as a non-transient spawn failure", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const ee = new EventEmitter();
    const proc = Object.assign(ee, { stdout, stderr, stdin }) as unknown as ChildProcessWithoutNullStreams;

    stdin.end = ((..._args: unknown[]) => {
      setImmediate(() => stdin.emit("error", Object.assign(new Error("bad file descriptor"), { code: "EBADF" })));
      return stdin;
    }) as unknown as typeof stdin.end;

    // Every stdin failure now kills the child and waits for `close` before
    // rejecting (see the stdin-EPIPE handler), so the fake must still close.
    setImmediate(() => {
      stdout.push(null);
      stderr.push(null);
      setImmediate(() => ee.emit("close", 1));
    });

    const fakeSpawn = () => proc;
    const err = await new ClaudeCliExecutor("/tmp", "summary", false, fakeSpawn as unknown as typeof spawn)
      .invoke({ prompt: "p", model: "m" })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "EBADF" });
    expect((err as Error & { failure?: { category?: string } }).failure?.category).toBe("crash");
  });

  it("still strips MODEL_CHILD_CREDENTIAL_KEYS when forwarded secrets are also set", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    installEnvironmentRecordingClaude();
    vi.stubEnv("AI_IMPLEMENT_FORWARDED_SECRETS", "QA_TOKEN");
    vi.stubEnv("QA_TOKEN", "sentinel-qa-forwarded");
    vi.stubEnv("RUN_PROGRESS_TOKEN", "run-progress-token");
    vi.stubEnv("RUN_PUBLICATION_TOKEN", "run-publication-token");
    vi.stubEnv("RUN_TOKEN", "run-token");

    await new ClaudeCliExecutor("/tmp", "summary").invoke({ prompt: "p", model: "m" });

    expect(readFileSync(join(binDir, "run-progress-token.txt"), "utf-8").trim()).toBe("unset");
    expect(readFileSync(join(binDir, "run-publication-token.txt"), "utf-8").trim()).toBe("unset");
    expect(readFileSync(join(binDir, "run-token.txt"), "utf-8").trim()).toBe("unset");
  });
});

describe.skipIf(isWindows)("ClaudeCliExecutor request-level retry (BAC-27114)", () => {
  const OVERLOAD_STDERR =
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
  const AUTH_STDERR =
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';

  const SUCCESS_RESULT_LINE = JSON.stringify({
    type: "result",
    subtype: "success",
    result: "ok",
    num_turns: 1,
    duration_ms: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  const TOOL_USE_LINE = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "echo hi" } }] },
  });

  const READ_TOOL_USE_LINE = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/tmp/x" } }] },
  });

  const BASH_CURL_TOOL_USE_LINE = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "curl -s https://example.com" } }] },
  });

  // Zero jitter makes the backoff assertion deterministic.
  const basePolicy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, requestRetries: 2, backoffJitter: 0 };

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("retries a transient failure that occurred before any tool use, then succeeds", async () => {
    const { spawnImpl, callCount } = makeFakeSpawn([
      { stderr: OVERLOAD_STDERR, exitCode: 1 },
      { stdoutLines: [SUCCESS_RESULT_LINE], exitCode: 0 },
    ]);
    const { sleepImpl, calls: sleepCalls } = makeFakeSleep();
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const result = await exec.invoke({ prompt: "p", model: "m", stage: "implement", expectsStructuredOutput: false, retry: { policy: basePolicy, toolUseIsSafe: false } });

    expect(result.exitCode).toBe(0);
    expect(result.attempts).toBe(2);
    expect(callCount()).toBe(2);
    expect(sleepCalls).toEqual([computeBackoffMs(1, basePolicy)]);
  });

  it("does not retry once the first attempt already saw a tool_use block, even though the failure is transient", async () => {
    const { spawnImpl, callCount } = makeFakeSpawn([
      { stdoutLines: [TOOL_USE_LINE], stderr: OVERLOAD_STDERR, exitCode: 1 },
    ]);
    const { sleepImpl } = makeFakeSleep();
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const result = await exec.invoke({ prompt: "p", model: "m", stage: "implement", expectsStructuredOutput: false, retry: { policy: basePolicy, toolUseIsSafe: false } });

    expect(callCount()).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.failure?.category).toBe("transient");
    expect(result.failure?.code).toBe("PROVIDER_OVERLOADED");
  });

  it("does not retry a non-transient (auth) failure", async () => {
    const { spawnImpl, callCount } = makeFakeSpawn([{ stderr: AUTH_STDERR, exitCode: 1 }]);
    const { sleepImpl } = makeFakeSleep();
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const result = await exec.invoke({ prompt: "p", model: "m", stage: "implement", expectsStructuredOutput: false, retry: { policy: basePolicy, toolUseIsSafe: false } });

    expect(callCount()).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.failure?.category).toBe("auth");
  });

  it("makes exactly one call when requestRetries is 0, regardless of category", async () => {
    const { spawnImpl, callCount } = makeFakeSpawn([{ stderr: OVERLOAD_STDERR, exitCode: 1 }]);
    const { sleepImpl } = makeFakeSleep();
    const policy: RetryPolicy = { ...basePolicy, requestRetries: 0 };
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const result = await exec.invoke({ prompt: "p", model: "m", stage: "implement", expectsStructuredOutput: false, retry: { policy, toolUseIsSafe: false } });

    expect(callCount()).toBe(1);
    expect(result.attempts).toBe(1);
  });

  it("stops after policy.requestRetries + 1 attempts under persistent overload", async () => {
    const { spawnImpl, callCount } = makeFakeSpawn([{ stderr: OVERLOAD_STDERR, exitCode: 1 }]);
    const { sleepImpl } = makeFakeSleep();
    const policy: RetryPolicy = { ...basePolicy, requestRetries: 2 };
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const result = await exec.invoke({ prompt: "p", model: "m", stage: "implement", expectsStructuredOutput: false, retry: { policy, toolUseIsSafe: false } });

    expect(callCount()).toBe(3);
    expect(result.attempts).toBe(3);
    expect(result.failure?.attempt).toBe(3);
    expect(result.failure?.category).toBe("transient");
  });

  it("does not retry a signalled close (SIGTERM) and records the signal", async () => {
    const { spawnImpl, callCount } = makeFakeSpawn([{ exitCode: null, signal: "SIGTERM" }]);
    const { sleepImpl } = makeFakeSleep();
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const result = await exec.invoke({ prompt: "p", model: "m", stage: "implement", expectsStructuredOutput: false, retry: { policy: basePolicy, toolUseIsSafe: false } });

    expect(callCount()).toBe(1);
    expect(result.signal).toBe("SIGTERM");
    expect(result.failure?.category).toBe("cancelled");
  });

  it("never retries when retry is omitted, but still classifies the failure (BAC-27114 follow-up: dev harness gets a failure record too)", async () => {
    const { spawnImpl, callCount } = makeFakeSpawn([{ stderr: OVERLOAD_STDERR, exitCode: 1 }]);
    const { sleepImpl } = makeFakeSleep();
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const result = await exec.invoke({ prompt: "p", model: "m" });

    expect(callCount()).toBe(1);
    expect(result.exitCode).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.failure?.category).toBe("transient");
    expect(result.failure?.code).toBe("PROVIDER_OVERLOADED");
    expect(result.failure?.stage).toBe("unknown");
  });

  it("does not attach a failure record to a successful invocation when retry is omitted", async () => {
    const { spawnImpl } = makeFakeSpawn([{ stdoutLines: [SUCCESS_RESULT_LINE], exitCode: 0 }]);
    const { sleepImpl } = makeFakeSleep();
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const result = await exec.invoke({ prompt: "p", model: "m" });

    expect(result.exitCode).toBe(0);
    expect(result.failure).toBeUndefined();
  });

  it("counts one CLI process exit as one executor attempt, even when the CLI's own stderr mentions its internal retries", async () => {
    // The Claude CLI may retry internally before ever exiting, leaving "retrying"/
    // "attempt N of M" language in stderr. The executor never parses for this
    // (see the note on `signatureMatchText`) — every process exit is exactly one
    // executor attempt, so this must still resolve after exactly two attempts,
    // not be double-counted into more.
    const { spawnImpl, callCount } = makeFakeSpawn([
      { stderr: `Retrying request... (attempt 2 of 3)\n${OVERLOAD_STDERR}`, exitCode: 1 },
      { stdoutLines: [SUCCESS_RESULT_LINE], exitCode: 0 },
    ]);
    const { sleepImpl } = makeFakeSleep();
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const result = await exec.invoke({ prompt: "p", model: "m", stage: "implement", expectsStructuredOutput: false, retry: { policy: basePolicy, toolUseIsSafe: false } });

    expect(callCount()).toBe(2);
    expect(result.attempts).toBe(2);
    expect(result.exitCode).toBe(0);
  });

  it("retries a transient failure even after tool use when toolUseIsSafe is true (review's read-only sessions)", async () => {
    const { spawnImpl, callCount } = makeFakeSpawn([
      { stdoutLines: [READ_TOOL_USE_LINE], stderr: OVERLOAD_STDERR, exitCode: 1 },
      { stdoutLines: [SUCCESS_RESULT_LINE], exitCode: 0 },
    ]);
    const { sleepImpl } = makeFakeSleep();
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const result = await exec.invoke({
      prompt: "p",
      model: "m",
      stage: "review", expectsStructuredOutput: true, retry: { policy: basePolicy, toolUseIsSafe: true },
    });

    expect(callCount()).toBe(2);
    expect(result.attempts).toBe(2);
    expect(result.exitCode).toBe(0);
  });

  it("does not retry a transient failure after a Bash tool_use even when toolUseIsSafe is true — Bash(curl *) can still write files or POST", async () => {
    const { spawnImpl, callCount } = makeFakeSpawn([
      { stdoutLines: [BASH_CURL_TOOL_USE_LINE], stderr: OVERLOAD_STDERR, exitCode: 1 },
    ]);
    const { sleepImpl } = makeFakeSleep();
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const result = await exec.invoke({
      prompt: "p",
      model: "m",
      stage: "review", expectsStructuredOutput: true, retry: { policy: basePolicy, toolUseIsSafe: true },
    });

    expect(callCount()).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.failure?.category).toBe("transient");
    expect(result.failure?.code).toBe("PROVIDER_OVERLOADED");
  });

  it("classifies (but does not retry) a structural exit-0 review failure — missing structured output is not transient", async () => {
    const NO_STRUCTURED_OUTPUT_RESULT_LINE = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "ok",
      num_turns: 1,
      duration_ms: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const { spawnImpl, callCount } = makeFakeSpawn([
      { stdoutLines: [NO_STRUCTURED_OUTPUT_RESULT_LINE], exitCode: 0 },
    ]);
    const { sleepImpl } = makeFakeSleep();
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const result = await exec.invoke({
      prompt: "p",
      model: "m",
      jsonSchema: { type: "object" },
      stage: "review", expectsStructuredOutput: true, retry: { policy: basePolicy, toolUseIsSafe: true },
    });

    expect(callCount()).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(result.failure?.category).toBe("invalid_output");
    expect(result.failure?.code).toBe("LLM_NO_STRUCTURED_OUTPUT");
  });

  it("sums tokensIn/tokensOut/costUsd/numTurns/cacheReadTokens/cacheCreationTokens across attempts, reports the total wall clock as durationMs, and re-derives tokensUsed from the aggregate", async () => {
    const FAILED_RESULT_LINE = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      num_turns: 3,
      duration_ms: 2000,
      total_cost_usd: 0.05,
      usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 20 },
    });
    const SUCCESS_WITH_CACHE_LINE = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "ok",
      num_turns: 1,
      duration_ms: 1,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
    });
    const { spawnImpl } = makeFakeSpawn([
      { stdoutLines: [FAILED_RESULT_LINE], stderr: OVERLOAD_STDERR, exitCode: 1 },
      { stdoutLines: [SUCCESS_WITH_CACHE_LINE], exitCode: 0 },
    ]);
    const { sleepImpl } = makeFakeSleep();
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const result = await exec.invoke({ prompt: "p", model: "m", stage: "implement", expectsStructuredOutput: false, retry: { policy: basePolicy, toolUseIsSafe: false } });

    expect(result.attempts).toBe(2);
    // tokensIn per attempt already includes cache creation/read (extractTelemetry
    // reports the full input sum): attempt 1 = 50+20+200=270, attempt 2 = 1+2+5=8.
    expect(result.telemetry?.tokensIn).toBe(278);
    expect(result.telemetry?.tokensOut).toBe(11);
    expect(result.telemetry?.costUsd).toBe(0.05);
    expect(result.telemetry?.numTurns).toBe(4);
    expect(result.telemetry?.cacheReadTokens).toBe(205);
    expect(result.telemetry?.cacheCreationTokens).toBe(22);
    expect(result.tokensUsed).toBe(289);
    expect(typeof result.telemetry?.durationMs).toBe("number");
  });

  it("stops retrying once the total backoff sleep would exceed policy.backoffMaxMs * 2, even with attempts remaining", async () => {
    const { spawnImpl, callCount } = makeFakeSpawn([{ stderr: OVERLOAD_STDERR, exitCode: 1 }]);
    const { sleepImpl, calls: sleepCalls } = makeFakeSleep();
    const policy: RetryPolicy = {
      ...basePolicy,
      requestRetries: 10,
      backoffInitialMs: 100_000,
      backoffMaxMs: 100_000,
    };
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const result = await exec.invoke({
      prompt: "p",
      model: "m",
      stage: "implement", expectsStructuredOutput: false, retry: { policy, toolUseIsSafe: false },
    });

    // Budget is 200_000ms. Attempt 1 sleeps 100_000 (total 100_000), attempt 2 sleeps
    // 100_000 (total 200_000, still within budget). A third sleep of 100_000 would push
    // the total to 300_000 > 200_000, so the loop must give up there instead of using
    // all 10 configured requestRetries.
    expect(sleepCalls).toEqual([100_000, 100_000]);
    expect(callCount()).toBe(3);
    expect(result.attempts).toBe(3);
    expect(result.failure?.category).toBe("transient");
  });

  it("retries a spawn-level failure (proc.on('error'), e.g. EAGAIN) before any tool use", async () => {
    let calls = 0;
    const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
      calls++;
      if (calls === 1) {
        const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
        const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
        (stdin as unknown as { end: (s: string) => void }).end = () => {};
        Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
        setImmediate(() => {
          const err = Object.assign(new Error("spawn claude EAGAIN"), { code: "EAGAIN" });
          proc.emit("error", err);
        });
        return proc;
      }
      const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
      (stdin as unknown as { end: (s: string) => void }).end = () => {};
      Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
      setImmediate(() => {
        (proc.stdout as unknown as EventEmitter).emit("data", Buffer.from(`${SUCCESS_RESULT_LINE}\n`));
        proc.emit("close", 0, null);
      });
      return proc;
    }) as unknown as typeof spawn;
    const { sleepImpl, calls: sleepCalls } = makeFakeSleep();
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const result = await exec.invoke({
      prompt: "p",
      model: "m",
      stage: "implement", expectsStructuredOutput: false, retry: { policy: basePolicy, toolUseIsSafe: false },
    });

    expect(calls).toBe(2);
    expect(result.exitCode).toBe(0);
    expect(result.attempts).toBe(2);
    expect(sleepCalls).toEqual([computeBackoffMs(1, basePolicy)]);
  });

  it("does not retry a spawn-level ENOENT (binary missing) — it is a config problem, not transient", async () => {
    let calls = 0;
    const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
      calls++;
      const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
      (stdin as unknown as { end: (s: string) => void }).end = () => {};
      Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
      setImmediate(() => {
        const err = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
        proc.emit("error", err);
      });
      return proc;
    }) as unknown as typeof spawn;
    const { sleepImpl } = makeFakeSleep();
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const err = await exec
      .invoke({
        prompt: "p",
        model: "m",
        stage: "implement", expectsStructuredOutput: false, retry: { policy: basePolicy, toolUseIsSafe: false },
      })
      .catch((e: unknown) => e);

    expect(calls).toBe(1);
    expect(err).toBeInstanceOf(Error);
    const failure = (err as Error & { failure?: { category?: string; code?: string } }).failure;
    expect(failure?.category).toBe("config");
    expect(failure?.code).toBe("PROCESS_SPAWN_FAILED");
  });

  it("kills the child on a stdin EPIPE and does not retry when the failed attempt already saw a tool_use (implement) — never spawns a second claude into the same workspace", async () => {
    let calls = 0;
    const killCalls: Array<NodeJS.Signals | number | undefined> = [];
    const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
      calls++;
      const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
      // The prompt write itself fails with EPIPE — but only after a tool_use event
      // has already arrived on stdout, simulating a session that used a tool
      // before the pipe broke.
      (stdin as unknown as { end: (s: string) => void }).end = () => {
        setImmediate(() => {
          (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        });
      };
      Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
      (proc as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = ((signal?: NodeJS.Signals | number) => {
        killCalls.push(signal);
        // The process was already exiting on its own (unaffected by our kill) — a
        // plain exit code, no signal — so the signal-precedence rule doesn't apply
        // and the tool_use gate is what has to block the retry.
        setImmediate(() => proc.emit("close", 1, null));
        return true;
      }) as ChildProcessWithoutNullStreams["kill"];
      setImmediate(() => {
        (proc.stdout as unknown as EventEmitter).emit("data", Buffer.from(`${TOOL_USE_LINE}\n`));
      });
      return proc;
    }) as unknown as typeof spawn;
    const { sleepImpl } = makeFakeSleep();
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const err = await exec
      .invoke({
        prompt: "p",
        model: "m",
        stage: "implement", expectsStructuredOutput: false, retry: { policy: basePolicy, toolUseIsSafe: false },
      })
      .catch((e: unknown) => e);

    expect(calls).toBe(1); // never spawned a second claude
    expect(killCalls.length).toBeGreaterThan(0);
    expect(err).toBeInstanceOf(Error);
    const failure = (err as Error & { failure?: { category?: string; code?: string } }).failure;
    // classifySpawnError would treat EPIPE as transient, but the tool_use gate
    // must still block the retry since the prior session may have already
    // mutated the workspace.
    expect(failure?.category).toBe("transient");
  });

  it("does not report its own kill() as an external cancellation: a close signal produced by the stdin-EPIPE kill is ignored, the attempt is classified from the EPIPE itself, and retried", async () => {
    // Round-four review follow-up (BAC-27114): proc.kill() defaults to SIGTERM, so
    // the `close` event this handler's own kill triggers reports `signal: "SIGTERM"`.
    // That must not be read back as an external cancellation — it must classify from
    // the original stdin EPIPE error instead, keeping the EPIPE retry reachable.
    let calls = 0;
    const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
      calls++;
      const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
      if (calls === 1) {
        (stdin as unknown as { end: (s: string) => void }).end = () => {
          setImmediate(() => {
            (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
          });
        };
        Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
        (proc as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = (() => {
          // The process is actually terminated by this handler's own kill() — the
          // close event reports the resulting signal.
          setImmediate(() => proc.emit("close", null, "SIGTERM"));
          return true;
        }) as ChildProcessWithoutNullStreams["kill"];
        return proc;
      }
      (stdin as unknown as { end: (s: string) => void }).end = () => {};
      Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
      setImmediate(() => {
        (proc.stdout as unknown as EventEmitter).emit("data", Buffer.from(`${SUCCESS_RESULT_LINE}\n`));
        proc.emit("close", 0, null);
      });
      return proc;
    }) as unknown as typeof spawn;
    const { sleepImpl, calls: sleepCalls } = makeFakeSleep();
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const result = await exec.invoke({
      prompt: "p",
      model: "m",
      stage: "implement",
      expectsStructuredOutput: false,
      retry: { policy: basePolicy, toolUseIsSafe: false },
    });

    expect(calls).toBe(2);
    expect(result.exitCode).toBe(0);
    expect(result.attempts).toBe(2);
    expect(sleepCalls).toEqual([computeBackoffMs(1, basePolicy)]);
  });

  it("classifies a close signal that does not match our own kill signal as an external cancellation, even on the stdin-EPIPE path", async () => {
    // Companion to the test above: this time the `close` signal is "SIGKILL", but our
    // own kill() (called once, no escalation yet) only ever sent "SIGTERM" — a mismatch
    // that must be read as a genuinely external signal (e.g. a job-timeout SIGKILL
    // landing in the same window) rather than our own kill, and classified `cancelled`
    // rather than retried as the transient EPIPE.
    let calls = 0;
    const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
      calls++;
      const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
      (stdin as unknown as { end: (s: string) => void }).end = () => {
        setImmediate(() => {
          (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        });
      };
      Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
      (proc as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = (() => {
        // We sent (implicitly) SIGTERM here, but the process reports it was actually
        // killed by an external SIGKILL that landed in the same window.
        setImmediate(() => proc.emit("close", null, "SIGKILL"));
        return true;
      }) as ChildProcessWithoutNullStreams["kill"];
      return proc;
    }) as unknown as typeof spawn;
    const { sleepImpl } = makeFakeSleep();
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const err = await exec
      .invoke({
        prompt: "p",
        model: "m",
        stage: "implement",
        expectsStructuredOutput: false,
        retry: { policy: basePolicy, toolUseIsSafe: false },
      })
      .catch((e: unknown) => e);

    expect(calls).toBe(1); // cancelled is never retried
    expect(err).toBeInstanceOf(Error);
    const failure = (err as Error & { failure?: { category?: string; code?: string; signal?: string } }).failure;
    expect(failure?.category).toBe("cancelled");
    expect(failure?.code).toBe("PROCESS_SIGNALLED");
    expect(failure?.signal).toBe("SIGKILL");
  });

  it("exhausts retries as a transient spawn failure (never 'cancelled') when the stdin-EPIPE self-kill keeps reporting a close signal", async () => {
    let calls = 0;
    const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
      calls++;
      const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
      (stdin as unknown as { end: (s: string) => void }).end = () => {
        setImmediate(() => {
          (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        });
      };
      Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
      (proc as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = (() => {
        setImmediate(() => proc.emit("close", null, "SIGTERM"));
        return true;
      }) as ChildProcessWithoutNullStreams["kill"];
      return proc;
    }) as unknown as typeof spawn;
    const { sleepImpl } = makeFakeSleep();
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const err = await exec
      .invoke({
        prompt: "p",
        model: "m",
        stage: "implement",
        expectsStructuredOutput: false,
        retry: { policy: basePolicy, toolUseIsSafe: false },
      })
      .catch((e: unknown) => e);

    expect(calls).toBe(3); // 1 + basePolicy.requestRetries(2)
    expect(err).toBeInstanceOf(Error);
    const failure = (err as Error & { failure?: { category?: string; code?: string; attempt?: number } }).failure;
    expect(failure?.category).toBe("transient");
    expect(failure?.code).toBe("PROCESS_SPAWN_FAILED");
    expect(failure?.attempt).toBe(3);
  });

  it("still recognizes a close signal as our own kill after escalating to SIGKILL, even when it reports the earlier SIGTERM (round-eight review follow-up: selfKillSignal must accumulate, not overwrite)", async () => {
    // Before this fix, selfKillSignal was a single overwritten variable: once the
    // 5s escalation timer fired, it held only "SIGKILL". A `close` reporting the
    // original "SIGTERM" (e.g. the child finally dying from the first signal, its
    // exit merely observed late) would then mismatch and be misclassified as an
    // external cancellation instead of retried as the transient EPIPE it actually is.
    // Only fake setTimeout/clearTimeout — the escalation timer this test needs to
    // advance — leaving setImmediate real so the second attempt's fake spawn
    // (below) still resolves without needing to also drive that clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let calls = 0;
      const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
        calls++;
        const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
        const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
        if (calls === 1) {
          (stdin as unknown as { end: (s: string) => void }).end = () => {
            queueMicrotask(() => {
              (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
            });
          };
          Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
          (proc as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = ((signal?: NodeJS.Signals | number) => {
            if (signal === "SIGKILL") {
              // The escalation kill is what the fake child finally "reacts" to, but the
              // close event it emits still reports the original SIGTERM — as if the
              // first signal was what actually killed it and this was only observed late.
              queueMicrotask(() => proc.emit("close", null, "SIGTERM"));
            }
            return true;
          }) as ChildProcessWithoutNullStreams["kill"];
          return proc;
        }
        (stdin as unknown as { end: (s: string) => void }).end = () => {};
        Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
        setImmediate(() => {
          (proc.stdout as unknown as EventEmitter).emit("data", Buffer.from(`${SUCCESS_RESULT_LINE}\n`));
          proc.emit("close", 0, null);
        });
        return proc;
      }) as unknown as typeof spawn;
      const { sleepImpl, calls: sleepCalls } = makeFakeSleep();
      const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

      const pending = exec.invoke({
        prompt: "p",
        model: "m",
        stage: "implement",
        expectsStructuredOutput: false,
        retry: { policy: basePolicy, toolUseIsSafe: false },
      });

      // Stdin EPIPE fires, calling proc.kill() (implicit SIGTERM) — no close yet.
      await vi.advanceTimersByTimeAsync(0);
      // 5s later: escalate to SIGKILL, which the mock resolves by emitting close(null, "SIGTERM").
      await vi.advanceTimersByTimeAsync(5000);

      const result = await pending;
      expect(calls).toBe(2); // retried, not classified as cancelled
      expect(result.exitCode).toBe(0);
      expect(result.attempts).toBe(2);
      expect(sleepCalls).toEqual([computeBackoffMs(1, basePolicy)]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies a spawn-level ENOENT even when retry is omitted, so a bare invoke() (e.g. the dev harness) still gets a failure record", async () => {
    const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
      const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
      (stdin as unknown as { end: (s: string) => void }).end = () => {};
      Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
      setImmediate(() => {
        const err = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
        proc.emit("error", err);
      });
      return proc;
    }) as unknown as typeof spawn;
    const { sleepImpl } = makeFakeSleep();
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const err = await exec.invoke({ prompt: "p", model: "m" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const failure = (err as Error & { failure?: { category?: string; code?: string; stage?: string } }).failure;
    expect(failure?.category).toBe("config");
    expect(failure?.code).toBe("PROCESS_SPAWN_FAILED");
    expect(failure?.stage).toBe("unknown");
  });

  it("leaves no pending SIGKILL timer when the stdin error handler fires after the attempt already settled via proc.on('error')", async () => {
    vi.useFakeTimers();
    try {
      const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
        const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
        const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
        let endCalled = false;
        (stdin as unknown as { end: (s: string) => void }).end = () => {
          endCalled = true;
        };
        Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
        // `queueMicrotask` (unlike `setImmediate`) is excluded from vitest's fake-timer
        // install, so this still fires without needing to advance the fake clock —
        // the fake clock here exists solely to observe the (would-be) SIGKILL timer.
        queueMicrotask(() => {
          // proc.on("error") settles the attempt first (ENOENT: the binary never started)...
          const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
          proc.emit("error", enoent);
          // ...and only afterward does stdin also report the pipe as broken, as Node can
          // do for the same underlying failure. This must be a no-op: no second kill, no
          // SIGKILL timer left armed.
          expect(endCalled).toBe(true);
          (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        });
        return proc;
      }) as unknown as typeof spawn;
      const { sleepImpl } = makeFakeSleep();
      const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

      const err = await exec.invoke({ prompt: "p", model: "m" }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error & { failure?: { code?: string } }).failure?.code).toBe("PROCESS_SPAWN_FAILED");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles as a non-retryable crash when close never arrives within 5s of the SIGKILL escalation (round-four review follow-up)", async () => {
    vi.useFakeTimers();
    try {
      const killCalls: Array<NodeJS.Signals | number | undefined> = [];
      const destroyCalls: string[] = [];
      const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
        const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
        const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
        (stdin as unknown as { end: (s: string) => void }).end = () => {
          queueMicrotask(() => {
            (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
          });
        };
        (stdin as unknown as { destroy: () => void }).destroy = () => destroyCalls.push("stdin");
        const stdout = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdout"];
        (stdout as unknown as { destroy: () => void }).destroy = () => destroyCalls.push("stdout");
        const stderr = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stderr"];
        (stderr as unknown as { destroy: () => void }).destroy = () => destroyCalls.push("stderr");
        Object.assign(proc, { stdin, stdout, stderr });
        // A fake process that never emits `close`, however many times it is killed —
        // exercises the bounded wait after the SIGKILL escalation.
        (proc as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = ((signal?: NodeJS.Signals | number) => {
          killCalls.push(signal);
          return true;
        }) as ChildProcessWithoutNullStreams["kill"];
        return proc;
      }) as unknown as typeof spawn;
      const { sleepImpl } = makeFakeSleep();
      const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

      const pending = exec
        .invoke({
          prompt: "p",
          model: "m",
          stage: "implement",
          expectsStructuredOutput: false,
          retry: { policy: basePolicy, toolUseIsSafe: false },
        })
        .catch((e: unknown) => e);

      // Let the queued stdin EPIPE fire, which calls proc.kill() (the SIGTERM escalation source).
      await vi.advanceTimersByTimeAsync(0);
      // 5s later: the SIGTERM->SIGKILL escalation fires.
      await vi.advanceTimersByTimeAsync(5000);
      // A further 5s with still no `close`: the bounded wait gives up.
      await vi.advanceTimersByTimeAsync(5000);

      const err = await pending;
      // No `pid` on this fake process, so killProcessGroup falls back to signalling
      // the process directly rather than the (nonexistent) group — with an explicit
      // signal now, not the old bare proc.kill().
      expect(killCalls).toEqual(["SIGTERM", "SIGKILL"]);
      expect(err).toBeInstanceOf(Error);
      const failure = (err as Error & { failure?: { category?: string; code?: string; retryable?: boolean } }).failure;
      expect(failure?.category).toBe("crash");
      expect(failure?.code).toBe("PROCESS_UNRESPONSIVE");
      expect(failure?.retryable).toBe(false);
      // The stdio handles must be destroyed (not merely unlistened-to) so a container
      // whose only remaining work was this invocation can still exit.
      expect(destroyCalls.sort()).toEqual(["stderr", "stdin", "stdout"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the write credential suspended when the child is unresponsive after SIGKILL — a possibly-live agent must never regain push access (round-seven review follow-up)", async () => {
    vi.useFakeTimers();
    try {
      const tokenizedOrigin = "https://x-access-token:github-write-token@github.com/acme/app.git";
      execFileSync("git", ["init", "-q"], { cwd: binDir });
      execFileSync("git", ["remote", "add", "origin", tokenizedOrigin], { cwd: binDir });

      const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
        const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
        const stdin = makeDestroyableEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
        (stdin as unknown as { end: (s: string) => void }).end = () => {
          queueMicrotask(() => {
            (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
          });
        };
        Object.assign(proc, { stdin, stdout: makeDestroyableEmitter(), stderr: makeDestroyableEmitter() });
        // Never emits `close`, however many times it is killed.
        (proc as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = (() => true) as ChildProcessWithoutNullStreams["kill"];
        return proc;
      }) as unknown as typeof spawn;
      const { sleepImpl } = makeFakeSleep();
      const exec = new ClaudeCliExecutor(binDir, "summary", false, spawnImpl, sleepImpl);

      const pending = exec.invoke({ prompt: "p", model: "m" }).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);

      const err = await pending;
      expect((err as Error & { failure?: { code?: string } }).failure?.code).toBe("PROCESS_UNRESPONSIVE");
      // The credential must still be stripped from origin — restoring it here would hand
      // a possibly-live agent process the ability to push.
      expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: binDir, encoding: "utf-8" }).trim()).toBe(
        "https://github.com/acme/app.git",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("guards proc.on('error') with the unresponsive flag: a late error after the unresponsive settle must not restore the withheld credential (BAC-27114 round-nine review follow-up)", async () => {
    vi.useFakeTimers();
    try {
      const tokenizedOrigin = "https://x-access-token:github-write-token@github.com/acme/app.git";
      execFileSync("git", ["init", "-q"], { cwd: binDir });
      execFileSync("git", ["remote", "add", "origin", tokenizedOrigin], { cwd: binDir });

      let procRef!: ChildProcessWithoutNullStreams;
      const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
        const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
        procRef = proc;
        const stdin = makeDestroyableEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
        (stdin as unknown as { end: (s: string) => void }).end = () => {
          queueMicrotask(() => {
            (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
          });
        };
        Object.assign(proc, { stdin, stdout: makeDestroyableEmitter(), stderr: makeDestroyableEmitter() });
        // Never emits `close`, however many times it is killed.
        (proc as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = (() => true) as ChildProcessWithoutNullStreams["kill"];
        return proc;
      }) as unknown as typeof spawn;
      const { sleepImpl } = makeFakeSleep();
      const exec = new ClaudeCliExecutor(binDir, "summary", false, spawnImpl, sleepImpl);

      const pending = exec.invoke({ prompt: "p", model: "m" }).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);

      const err = await pending;
      expect((err as Error & { failure?: { code?: string } }).failure?.code).toBe("PROCESS_UNRESPONSIVE");

      // A late `error` lands on the same process after it already settled as
      // unresponsive (e.g. a delayed kill-signal failure). It must not restore the
      // credential the unresponsive path deliberately withheld — the child may still
      // be alive.
      procRef.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));

      expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: binDir, encoding: "utf-8" }).trim()).toBe(
        "https://github.com/acme/app.git",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the write credential when proc.on('error') settles the attempt (contrast with the unresponsive path above)", async () => {
    const tokenizedOrigin = "https://x-access-token:github-write-token@github.com/acme/app.git";
    execFileSync("git", ["init", "-q"], { cwd: binDir });
    execFileSync("git", ["remote", "add", "origin", tokenizedOrigin], { cwd: binDir });

    const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
      const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
      (stdin as unknown as { end: (s: string) => void }).end = () => {};
      Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
      setImmediate(() => {
        proc.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
      });
      return proc;
    }) as unknown as typeof spawn;
    const { sleepImpl } = makeFakeSleep();
    const exec = new ClaudeCliExecutor(binDir, "summary", false, spawnImpl, sleepImpl);

    await exec.invoke({ prompt: "p", model: "m" }).catch((e: unknown) => e);

    expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: binDir, encoding: "utf-8" }).trim()).toBe(tokenizedOrigin);
  });

  it("restores the write credential when the stdin-EPIPE close handler settles the attempt (contrast with the unresponsive path above)", async () => {
    const tokenizedOrigin = "https://x-access-token:github-write-token@github.com/acme/app.git";
    execFileSync("git", ["init", "-q"], { cwd: binDir });
    execFileSync("git", ["remote", "add", "origin", tokenizedOrigin], { cwd: binDir });

    const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
      const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
      (stdin as unknown as { end: (s: string) => void }).end = () => {
        setImmediate(() => {
          (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        });
      };
      Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
      (proc as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = (() => {
        setImmediate(() => proc.emit("close", 1, null));
        return true;
      }) as ChildProcessWithoutNullStreams["kill"];
      return proc;
    }) as unknown as typeof spawn;
    const { sleepImpl } = makeFakeSleep();
    const exec = new ClaudeCliExecutor(binDir, "summary", false, spawnImpl, sleepImpl);

    await exec.invoke({ prompt: "p", model: "m" }).catch((e: unknown) => e);

    expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: binDir, encoding: "utf-8" }).trim()).toBe(tokenizedOrigin);
  });

  it("stamps llmOutcome: null in evidence on a PROCESS_UNRESPONSIVE record, matching every other failure record's evidence keys", async () => {
    vi.useFakeTimers();
    try {
      const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
        const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
        const stdin = makeDestroyableEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
        (stdin as unknown as { end: (s: string) => void }).end = () => {
          queueMicrotask(() => {
            (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
          });
        };
        Object.assign(proc, { stdin, stdout: makeDestroyableEmitter(), stderr: makeDestroyableEmitter() });
        (proc as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = (() => true) as ChildProcessWithoutNullStreams["kill"];
        return proc;
      }) as unknown as typeof spawn;
      const { sleepImpl } = makeFakeSleep();
      const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

      const pending = exec.invoke({ prompt: "p", model: "m" }).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);

      const err = await pending;
      const failure = (err as Error & { failure?: { evidence?: { llmOutcome?: unknown } } }).failure;
      expect(failure?.evidence?.llmOutcome).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("folds an EPIPE attempt's telemetry into the cross-attempt aggregate rather than dropping the tokens it burned (round-seven review follow-up)", async () => {
    const EPIPE_RESULT_LINE = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      num_turns: 3,
      duration_ms: 2000,
      total_cost_usd: 0.05,
      usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 20 },
    });
    const SUCCESS_WITH_CACHE_LINE = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "ok",
      num_turns: 1,
      duration_ms: 1,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
    });
    let calls = 0;
    const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
      calls++;
      const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
      if (calls === 1) {
        // The result event arrives on stdout — and is captured into `events` — before
        // the prompt write fails with EPIPE, simulating the child finishing its own
        // output right as it tears down the stdin pipe out from under us.
        (stdin as unknown as { end: (s: string) => void }).end = () => {
          setImmediate(() => {
            (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
          });
        };
        Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
        (proc as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = (() => {
          setImmediate(() => proc.emit("close", 1, null));
          return true;
        }) as ChildProcessWithoutNullStreams["kill"];
        setImmediate(() => {
          (proc.stdout as unknown as EventEmitter).emit("data", Buffer.from(`${EPIPE_RESULT_LINE}\n`));
        });
        return proc;
      }
      (stdin as unknown as { end: (s: string) => void }).end = () => {};
      Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
      setImmediate(() => {
        (proc.stdout as unknown as EventEmitter).emit("data", Buffer.from(`${SUCCESS_WITH_CACHE_LINE}\n`));
        proc.emit("close", 0, null);
      });
      return proc;
    }) as unknown as typeof spawn;
    const { sleepImpl } = makeFakeSleep();
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const result = await exec.invoke({
      prompt: "p",
      model: "m",
      stage: "implement",
      expectsStructuredOutput: false,
      retry: { policy: basePolicy, toolUseIsSafe: false },
    });

    expect(calls).toBe(2);
    expect(result.exitCode).toBe(0);
    expect(result.attempts).toBe(2);
    // Same aggregate the stderr-driven retry test above computes: attempt 1's EPIPE
    // telemetry (270 in / 10 out / cache 200+20 / cost 0.05 / 3 turns) plus attempt
    // 2's success (8 in / 1 out / cache 5+2).
    expect(result.telemetry?.tokensIn).toBe(278);
    expect(result.telemetry?.tokensOut).toBe(11);
    expect(result.telemetry?.costUsd).toBe(0.05);
    expect(result.telemetry?.numTurns).toBe(4);
    expect(result.telemetry?.cacheReadTokens).toBe(205);
    expect(result.telemetry?.cacheCreationTokens).toBe(22);
    expect(result.tokensUsed).toBe(289);
  });

  it("flushes a trailing partial line before extracting telemetry on the stdin-EPIPE path, matching the normal close path (BAC-27114 round-nine review follow-up)", async () => {
    // Same shape as the round-seven EPIPE-aggregation test above, except attempt 1's
    // result line arrives with no trailing newline — it sits in the internal buffer as
    // a partial line when the EPIPE tears down stdin. Without flushing that buffer
    // before extractTelemetry, this event never reaches `events` and its usage is
    // silently dropped from the cross-attempt aggregate.
    const EPIPE_RESULT_LINE = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      num_turns: 3,
      duration_ms: 2000,
      total_cost_usd: 0.05,
      usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 20 },
    });
    const SUCCESS_WITH_CACHE_LINE = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "ok",
      num_turns: 1,
      duration_ms: 1,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
    });
    let calls = 0;
    const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
      calls++;
      const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
      if (calls === 1) {
        (stdin as unknown as { end: (s: string) => void }).end = () => {
          setImmediate(() => {
            (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
          });
        };
        Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
        (proc as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = (() => {
          setImmediate(() => proc.emit("close", 1, null));
          return true;
        }) as ChildProcessWithoutNullStreams["kill"];
        setImmediate(() => {
          // No trailing "\n" — deliberately left as a partial line.
          (proc.stdout as unknown as EventEmitter).emit("data", Buffer.from(EPIPE_RESULT_LINE));
        });
        return proc;
      }
      (stdin as unknown as { end: (s: string) => void }).end = () => {};
      Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
      setImmediate(() => {
        (proc.stdout as unknown as EventEmitter).emit("data", Buffer.from(`${SUCCESS_WITH_CACHE_LINE}\n`));
        proc.emit("close", 0, null);
      });
      return proc;
    }) as unknown as typeof spawn;
    const { sleepImpl } = makeFakeSleep();
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const result = await exec.invoke({
      prompt: "p",
      model: "m",
      stage: "implement",
      expectsStructuredOutput: false,
      retry: { policy: basePolicy, toolUseIsSafe: false },
    });

    expect(calls).toBe(2);
    expect(result.attempts).toBe(2);
    // Matches the round-seven test's aggregate exactly — proving attempt 1's
    // no-trailing-newline result line was flushed and counted the same as a
    // newline-terminated one.
    expect(result.telemetry?.tokensIn).toBe(278);
    expect(result.telemetry?.tokensOut).toBe(11);
    expect(result.telemetry?.costUsd).toBe(0.05);
    expect(result.telemetry?.numTurns).toBe(4);
    expect(result.telemetry?.cacheReadTokens).toBe(205);
    expect(result.telemetry?.cacheCreationTokens).toBe(22);
  });

  it("classifies LLM_NO_STRUCTURED_OUTPUT on a bare invoke() with no retry — pins the expectsStructuredOutput hoist (round-seven review follow-up)", async () => {
    const NO_STRUCTURED_OUTPUT_RESULT_LINE = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "ok",
      num_turns: 1,
      duration_ms: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const { spawnImpl } = makeFakeSpawn([{ stdoutLines: [NO_STRUCTURED_OUTPUT_RESULT_LINE], exitCode: 0 }]);
    const { sleepImpl } = makeFakeSleep();
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const result = await exec.invoke({ prompt: "p", model: "m", stage: "review", expectsStructuredOutput: true });

    expect(result.exitCode).toBe(0);
    expect(result.failure?.category).toBe("invalid_output");
    expect(result.failure?.code).toBe("LLM_NO_STRUCTURED_OUTPUT");
  });

  it("leaves the origin protected and arms no SIGKILL-escalation timer when kill() emits `error` synchronously; a later `error` after settle is a no-op (BAC-27136)", async () => {
    vi.useFakeTimers();
    try {
      const tokenizedOrigin = "https://x-access-token:github-write-token@github.com/acme/app.git";
      execFileSync("git", ["init", "-q"], { cwd: binDir });
      execFileSync("git", ["remote", "add", "origin", tokenizedOrigin], { cwd: binDir });

      let procRef!: ChildProcessWithoutNullStreams;
      const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
        const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
        procRef = proc;
        const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
        (stdin as unknown as { end: (s: string) => void }).end = () => {
          queueMicrotask(() => {
            (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
          });
        };
        Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
        // No `pid` set, so killProcessGroup falls straight to proc.kill(). That
        // kill() itself fails for a reason other than ESRCH — Node's real
        // ChildProcess.kill() emits `error` synchronously in exactly that case
        // (see killProcessGroup) — while the child may still be alive.
        (proc as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = (() => {
          proc.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));
          return false;
        }) as ChildProcessWithoutNullStreams["kill"];
        return proc;
      }) as unknown as typeof spawn;
      const { sleepImpl } = makeFakeSleep();
      const exec = new ClaudeCliExecutor(binDir, "summary", false, spawnImpl, sleepImpl);

      const pending = exec.invoke({ prompt: "p", model: "m" }).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(0);

      const err = await pending;
      expect(err).toBeInstanceOf(Error);
      // The origin must stay stripped of its write credential — kill() failed
      // synchronously while the child may still be alive.
      expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: binDir, encoding: "utf-8" }).trim()).toBe(
        "https://github.com/acme/app.git",
      );
      // No SIGKILL-escalation timer left armed: it was cleared by this same
      // synchronous `error` before its own arming setTimeout callback could fire.
      expect(vi.getTimerCount()).toBe(0);

      // A later `error` on the same process must be a no-op: no exception, and
      // the (still-protected) origin is left exactly as it is.
      procRef.emit("error", Object.assign(new Error("kill EPERM again"), { code: "EPERM" }));
      expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: binDir, encoding: "utf-8" }).trim()).toBe(
        "https://github.com/acme/app.git",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills the process group via a negative pid for both the SIGTERM and the SIGKILL escalation", async () => {
    vi.useFakeTimers();
    try {
      const processKillCalls: Array<[number, NodeJS.Signals | number | undefined]> = [];
      const processKillSpy = vi
        .spyOn(process, "kill")
        .mockImplementation(((pid: number, signal?: string | number) => {
          processKillCalls.push([pid, signal as NodeJS.Signals]);
          return true;
        }) as typeof process.kill);
      try {
        let spawnOpts: { detached?: boolean } | undefined;
        const spawnImpl = ((_cmd: string, _args: readonly string[], opts: unknown) => {
          spawnOpts = opts as { detached?: boolean };
          const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
          Object.assign(proc, { pid: 4242 });
          const stdin = makeDestroyableEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
          (stdin as unknown as { end: (s: string) => void }).end = () => {
            queueMicrotask(() => {
              (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
            });
          };
          Object.assign(proc, { stdin, stdout: makeDestroyableEmitter(), stderr: makeDestroyableEmitter() });
          // Never emits `close`, however many times it is killed — exercises both
          // the SIGTERM and the SIGKILL escalation reaching process.kill(-pid, ...).
          return proc;
        }) as unknown as typeof spawn;
        const { sleepImpl } = makeFakeSleep();
        const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

        const pending = exec.invoke({ prompt: "p", model: "m" }).catch((e: unknown) => e);

        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(5000);
        await vi.advanceTimersByTimeAsync(5000);

        await pending;
        expect(processKillCalls).toEqual([
          [-4242, "SIGTERM"],
          [-4242, "SIGKILL"],
        ]);
        // `process.kill(-pid, …)` above only addresses the CLI's whole process
        // group because the CLI was spawned as that group's own leader — pin the
        // invariant the negative-pid assertion above depends on.
        expect(spawnOpts?.detached).toBe(true);
      } finally {
        processKillSpy.mockRestore();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to proc.kill() on ANY process.kill(-pid, ...) failure, not only ESRCH — signalling the CLI alone beats signalling nothing (BAC-27136)", async () => {
    const processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    });
    try {
      const procKillCalls: Array<NodeJS.Signals | number | undefined> = [];
      const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
        const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
        Object.assign(proc, { pid: 4444 });
        const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
        (stdin as unknown as { end: (s: string) => void }).end = () => {
          setImmediate(() => {
            (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
          });
        };
        Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
        (proc as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = ((signal?: NodeJS.Signals | number) => {
          procKillCalls.push(signal);
          setImmediate(() => proc.emit("close", 1, null));
          return true;
        }) as ChildProcessWithoutNullStreams["kill"];
        return proc;
      }) as unknown as typeof spawn;
      const { sleepImpl } = makeFakeSleep();
      const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

      await exec.invoke({ prompt: "p", model: "m" }).catch((e: unknown) => e);

      expect(procKillCalls).toEqual(["SIGTERM"]);
    } finally {
      processKillSpy.mockRestore();
    }
  });

  it("attaches the accumulated telemetry to the thrown error when every attempt EPIPEs, summing tokensIn/tokensOut across attempts", async () => {
    const resultLine = (tokensIn: number, tokensOut: number) =>
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        num_turns: 1,
        duration_ms: 1,
        usage: { input_tokens: tokensIn, output_tokens: tokensOut },
      });
    let calls = 0;
    const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
      calls++;
      const attemptNumber = calls;
      const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
      (stdin as unknown as { end: (s: string) => void }).end = () => {
        setImmediate(() => {
          (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        });
      };
      Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
      (proc as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = (() => {
        setImmediate(() => proc.emit("close", 1, null));
        return true;
      }) as ChildProcessWithoutNullStreams["kill"];
      setImmediate(() => {
        (proc.stdout as unknown as EventEmitter).emit(
          "data",
          Buffer.from(`${resultLine(attemptNumber * 10, attemptNumber)}\n`),
        );
      });
      return proc;
    }) as unknown as typeof spawn;
    const { sleepImpl } = makeFakeSleep();
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

    const err = await exec
      .invoke({
        prompt: "p",
        model: "m",
        stage: "implement",
        expectsStructuredOutput: false,
        retry: { policy: basePolicy, toolUseIsSafe: false },
      })
      .catch((e: unknown) => e);

    expect(calls).toBe(3); // 1 + basePolicy.requestRetries(2)
    expect(err).toBeInstanceOf(Error);
    const telemetry = (err as Error & { telemetry?: { tokensIn?: number | null; tokensOut?: number | null } }).telemetry;
    // Attempt tokensIn/tokensOut are 10/1, 20/2, 30/3 — sums to 60/6.
    expect(telemetry?.tokensIn).toBe(60);
    expect(telemetry?.tokensOut).toBe(6);
  });

  it("still settles as PROCESS_UNRESPONSIVE when the process's streams have no destroy() (e.g. a custom/ spawn wrapper) — the guarded teardown must not leave invoke() unsettled (BAC-27136)", async () => {
    vi.useFakeTimers();
    try {
      const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
        const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
        const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
        (stdin as unknown as { end: (s: string) => void }).end = () => {
          queueMicrotask(() => {
            (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
          });
        };
        // Deliberately plain EventEmitters with no destroy() at all, unlike the
        // makeDestroyableEmitter() fakes used elsewhere in this file — this is
        // what a custom/ spawn wrapper's streams might look like.
        Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
        (proc as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = (() => true) as ChildProcessWithoutNullStreams["kill"];
        return proc;
      }) as unknown as typeof spawn;
      const { sleepImpl } = makeFakeSleep();
      const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

      const pending = exec.invoke({ prompt: "p", model: "m" }).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);

      const err = await pending;
      expect((err as Error & { failure?: { code?: string } }).failure?.code).toBe("PROCESS_UNRESPONSIVE");
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries telemetry accumulated from an earlier EPIPE'd attempt onto a PROCESS_UNRESPONSIVE error (BAC-27136)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const EPIPE_RESULT_LINE = JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        num_turns: 1,
        duration_ms: 1,
        usage: { input_tokens: 50, output_tokens: 10 },
      });
      let calls = 0;
      const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
        calls++;
        const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
        if (calls === 1) {
          // First attempt: reports some usage, then EPIPEs and dies cleanly (its
          // kill() succeeds and close arrives) — an ordinary retryable transient
          // failure. queueMicrotask (not setImmediate) so this whole round trip
          // resolves within the fake-timer advances below without needing a real
          // macrotask tick — see the working precedent tests for this pattern.
          const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
          (stdin as unknown as { end: (s: string) => void }).end = () => {
            queueMicrotask(() => {
              (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
            });
          };
          Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
          (proc as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = (() => {
            queueMicrotask(() => proc.emit("close", 1, null));
            return true;
          }) as ChildProcessWithoutNullStreams["kill"];
          queueMicrotask(() => {
            (proc.stdout as unknown as EventEmitter).emit("data", Buffer.from(`${EPIPE_RESULT_LINE}\n`));
          });
          return proc;
        }
        // Second attempt: EPIPEs too, but the child never reports `close` even
        // after the SIGKILL escalation — settles as PROCESS_UNRESPONSIVE.
        const stdin = makeDestroyableEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
        (stdin as unknown as { end: (s: string) => void }).end = () => {
          queueMicrotask(() => {
            (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
          });
        };
        Object.assign(proc, { stdin, stdout: makeDestroyableEmitter(), stderr: makeDestroyableEmitter() });
        (proc as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = (() => true) as ChildProcessWithoutNullStreams["kill"];
        return proc;
      }) as unknown as typeof spawn;
      const { sleepImpl } = makeFakeSleep();
      const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

      const pending = exec
        .invoke({
          prompt: "p",
          model: "m",
          stage: "implement",
          expectsStructuredOutput: false,
          retry: { policy: basePolicy, toolUseIsSafe: false },
        })
        .catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);

      const err = await pending;
      expect(calls).toBe(2);
      expect((err as Error & { failure?: { code?: string } }).failure?.code).toBe("PROCESS_UNRESPONSIVE");
      const telemetry = (err as Error & { telemetry?: { tokensIn?: number; tokensOut?: number } }).telemetry;
      expect(telemetry?.tokensIn).toBe(50);
      expect(telemetry?.tokensOut).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still settles as PROCESS_UNRESPONSIVE when a stream's destroy() itself throws (contrast with the missing-destroy() case above) (BAC-27137)", async () => {
    vi.useFakeTimers();
    try {
      const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
        const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
        const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
        (stdin as unknown as { end: (s: string) => void }).end = () => {
          queueMicrotask(() => {
            (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
          });
        };
        // Unlike makeDestroyableEmitter()'s no-op, this destroy() throws — the guarded
        // teardown in executor.ts must still reach `reject` regardless.
        (stdin as unknown as { destroy: () => void }).destroy = () => {
          throw new Error("destroy failed");
        };
        const stdout = new EventEmitter();
        (stdout as unknown as { destroy: () => void }).destroy = () => {
          throw new Error("destroy failed");
        };
        const stderr = new EventEmitter();
        (stderr as unknown as { destroy: () => void }).destroy = () => {
          throw new Error("destroy failed");
        };
        Object.assign(proc, { stdin, stdout, stderr });
        (proc as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = (() => true) as ChildProcessWithoutNullStreams["kill"];
        return proc;
      }) as unknown as typeof spawn;
      const { sleepImpl } = makeFakeSleep();
      const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

      const pending = exec.invoke({ prompt: "p", model: "m" }).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);

      const err = await pending;
      expect((err as Error & { failure?: { code?: string } }).failure?.code).toBe("PROCESS_UNRESPONSIVE");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stamps the dying attempt's own telemetry (not just earlier attempts' sums) on a PROCESS_UNRESPONSIVE error", async () => {
    vi.useFakeTimers();
    try {
      const RESULT_LINE = JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        num_turns: 1,
        duration_ms: 1,
        usage: { input_tokens: 42, output_tokens: 7 },
      });
      const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
        const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
        const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
        (stdin as unknown as { end: (s: string) => void }).end = () => {
          queueMicrotask(() => {
            (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
          });
        };
        Object.assign(proc, { stdin, stdout: makeDestroyableEmitter(), stderr: makeDestroyableEmitter() });
        (proc as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = (() => true) as ChildProcessWithoutNullStreams["kill"];
        // Reports usage before it ever EPIPEs — this is the ONLY attempt (no retry), so
        // any telemetry on the final error must come from this attempt's own events, not
        // a cross-attempt sum.
        queueMicrotask(() => {
          (proc.stdout as unknown as EventEmitter).emit("data", Buffer.from(`${RESULT_LINE}\n`));
        });
        return proc;
      }) as unknown as typeof spawn;
      const { sleepImpl } = makeFakeSleep();
      const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl);

      const pending = exec.invoke({ prompt: "p", model: "m" }).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);

      const err = await pending;
      expect((err as Error & { failure?: { code?: string } }).failure?.code).toBe("PROCESS_UNRESPONSIVE");
      const telemetry = (err as Error & { telemetry?: { tokensIn?: number; tokensOut?: number } }).telemetry;
      expect(telemetry?.tokensIn).toBe(42);
      expect(telemetry?.tokensOut).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it("escalates to SIGKILL before giving up when kill() fails synchronously and the child may still be alive — the credential withhold must not also be an abandonment (BAC-27136)", async () => {
    vi.useFakeTimers();
    try {
      const tokenizedOrigin = "https://x-access-token:github-write-token@github.com/acme/app.git";
      execFileSync("git", ["init", "-q"], { cwd: binDir });
      execFileSync("git", ["remote", "add", "origin", tokenizedOrigin], { cwd: binDir });

      const RESULT_LINE = JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        num_turns: 1,
        duration_ms: 1,
        usage: { input_tokens: 11, output_tokens: 3 },
      });
      const killCalls: Array<NodeJS.Signals | number | undefined> = [];
      const destroyCalls: string[] = [];
      const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
        const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
        const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
        (stdin as unknown as { end: (s: string) => void }).end = () => {
          queueMicrotask(() => {
            (stdin as unknown as EventEmitter).emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
          });
        };
        (stdin as unknown as { destroy: () => void }).destroy = () => destroyCalls.push("stdin");
        const stdout = new EventEmitter();
        (stdout as unknown as { destroy: () => void }).destroy = () => destroyCalls.push("stdout");
        const stderr = new EventEmitter();
        (stderr as unknown as { destroy: () => void }).destroy = () => destroyCalls.push("stderr");
        Object.assign(proc, { stdin, stdout, stderr });
        (proc as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = ((signal?: NodeJS.Signals | number) => {
          killCalls.push(signal);
          if (killCalls.length === 1) {
            // The SIGTERM escalation's kill() fails synchronously — Node's real
            // ChildProcess.kill() can emit `error` on `proc` in exactly this case.
            proc.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));
          }
          return false;
        }) as ChildProcessWithoutNullStreams["kill"];
        // Reports usage before the EPIPE — this dying attempt's own telemetry must be
        // stamped onto the rejected error, mirroring the unresponsive-timeout path.
        queueMicrotask(() => {
          stdout.emit("data", Buffer.from(`${RESULT_LINE}\n`));
        });
        return proc;
      }) as unknown as typeof spawn;
      const { sleepImpl } = makeFakeSleep();
      const exec = new ClaudeCliExecutor(binDir, "summary", false, spawnImpl, sleepImpl);

      const pending = exec.invoke({ prompt: "p", model: "m" }).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(0);

      const err = await pending;
      expect(err).toBeInstanceOf(Error);
      // The failed SIGTERM must be followed by a SIGKILL escalation before this
      // attempt gives up on the (possibly still-alive) child.
      expect(killCalls).toEqual(["SIGTERM", "SIGKILL"]);
      expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: binDir, encoding: "utf-8" }).trim()).toBe(
        "https://github.com/acme/app.git",
      );
      // Mirrors the unresponsive-timeout path's guarded teardown: the stdio handles are
      // destroyed (not merely unlistened-to), and this attempt's own telemetry is stamped
      // onto the rejected error rather than silently dropped.
      expect(destroyCalls.sort()).toEqual(["stderr", "stdin", "stdout"]);
      const telemetry = (err as Error & { telemetry?: { tokensIn?: number; tokensOut?: number } }).telemetry;
      expect(telemetry?.tokensIn).toBe(11);
      expect(telemetry?.tokensOut).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.skipIf(isWindows)("ClaudeCliExecutor runner-activity reporting (AII-798)", () => {
  interface RecordedCall {
    method: "toolStart" | "toolResult" | "cycleSummary" | "final";
    identity: ActivityIdentity;
    payload: unknown;
  }

  function makeRecordingSink(): { sink: ActivitySink; calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    const sink: ActivitySink = {
      toolStart: (identity, input) => calls.push({ method: "toolStart", identity, payload: input }),
      toolResult: (identity, result) => calls.push({ method: "toolResult", identity, payload: result }),
      cycleSummary: (identity, summary) => calls.push({ method: "cycleSummary", identity, payload: summary }),
      final: (identity, lastSequence) => calls.push({ method: "final", identity, payload: { lastSequence } }),
    };
    return { sink, calls };
  }

  const TOOL_ACTIVITY_LINES = [
    JSON.stringify({ type: "system", subtype: "init", model: "claude-x", cwd: "/workspace" }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "About to look at the test output." },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pnpm test" } },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "42 passed", is_error: false }] },
    }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/tmp/x" } }] },
    }),
    JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "file body" }], is_error: false }],
      },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Done.",
      num_turns: 2,
      duration_ms: 10,
      usage: { input_tokens: 5, output_tokens: 5 },
    }),
  ];

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it.each(["summary", "stream"] as const)(
    "reports ordered, correctly-identified tool start/result events, then a final marker, in %s log mode",
    async (logLevel) => {
      const proc = makeTestProcess(TOOL_ACTIVITY_LINES.join("\n") + "\n", 0);
      const spawnImpl = () => proc;
      const { sink, calls } = makeRecordingSink();
      const activityReporting: ActivityReportingConfig = { attemptId: "attempt-1", sink };
      const exec = new ClaudeCliExecutor("/tmp", logLevel, false, spawnImpl as unknown as typeof spawn, undefined, activityReporting);

      const result = await exec.invoke({ prompt: "p", model: "m", stage: "implement" });

      expect(result.exitCode).toBe(0);
      expect(calls.map((c) => c.method)).toEqual(["toolStart", "toolResult", "toolStart", "toolResult", "final"]);
      // Strictly increasing sequence, all under the same (attemptId, producerId) identity.
      expect(calls.map((c) => c.identity.sequence)).toEqual([0, 1, 2, 3, 3]);
      for (const call of calls) {
        expect(call.identity.attemptId).toBe("attempt-1");
        expect(call.identity.producerId).toBe("implement-1-1");
      }
      expect(calls[0].payload).toMatchObject({ cycle: 1, action: "Bash", detail: { command: "pnpm test" } });
      expect(calls[1].payload).toMatchObject({ cycle: 1, action: "Bash" });
      expect((calls[1].payload as ActivityToolResult).output).toEqual({ text: "42 passed", truncated: false });
      expect(calls[2].payload).toMatchObject({ cycle: 1, action: "Read", detail: { file_path: "/tmp/x" } });
      expect(calls[3].payload).toMatchObject({ cycle: 1, action: "Read" });
      expect((calls[3].payload as ActivityToolResult).output).toEqual({ text: "file body", truncated: false });
      expect(calls[4].payload).toEqual({ lastSequence: 3 });
    },
  );

  it("leaves the returned LLMResult byte-identical whether or not a sink is supplied (absent sink = unchanged legacy behavior)", async () => {
    const procA = makeTestProcess(TOOL_ACTIVITY_LINES.join("\n") + "\n", 0);
    const resultWithoutSink = await new ClaudeCliExecutor("/tmp", "summary", false, (() => procA) as unknown as typeof spawn).invoke({
      prompt: "p",
      model: "m",
    });

    const procB = makeTestProcess(TOOL_ACTIVITY_LINES.join("\n") + "\n", 0);
    const { sink } = makeRecordingSink();
    const activityReporting: ActivityReportingConfig = { attemptId: "attempt-1", sink };
    const resultWithSink = await new ClaudeCliExecutor(
      "/tmp",
      "summary",
      false,
      (() => procB) as unknown as typeof spawn,
      undefined,
      activityReporting,
    ).invoke({ prompt: "p", model: "m" });

    expect(resultWithSink).toEqual(resultWithoutSink);
  });

  it("never lets a throwing sink block or fail model work", async () => {
    const proc = makeTestProcess(TOOL_ACTIVITY_LINES.join("\n") + "\n", 0);
    const spawnImpl = () => proc;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sink: ActivitySink = {
      toolStart: () => {
        throw new Error("sink boom");
      },
      toolResult: () => {
        throw new Error("sink boom");
      },
      cycleSummary: () => {},
      final: () => {
        throw new Error("sink boom");
      },
    };
    const activityReporting: ActivityReportingConfig = { attemptId: "attempt-1", sink };
    const result = await new ClaudeCliExecutor(
      "/tmp",
      "summary",
      false,
      spawnImpl as unknown as typeof spawn,
      undefined,
      activityReporting,
    ).invoke({ prompt: "p", model: "m" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Done.");
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("[activity]"))).toBe(true);
  });

  const RETRY_OVERLOAD_STDERR =
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

  it("resets sequence and producerId on a retried spawnOnce attempt rather than continuing the prior attempt's sequence", async () => {
    const { spawnImpl } = makeFakeSpawn([
      { stderr: RETRY_OVERLOAD_STDERR, exitCode: 1 },
      { stdoutLines: TOOL_ACTIVITY_LINES, exitCode: 0 },
    ]);
    const { sleepImpl } = makeFakeSleep();
    const { sink, calls } = makeRecordingSink();
    const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, requestRetries: 2, backoffJitter: 0 };
    const activityReporting: ActivityReportingConfig = { attemptId: "attempt-1", sink };
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, sleepImpl, activityReporting);

    const result = await exec.invoke({
      prompt: "p",
      model: "m",
      stage: "implement",
      retry: { policy, toolUseIsSafe: false },
    });

    expect(result.attempts).toBe(2);
    const finals = calls.filter((c) => c.method === "final");
    expect(finals).toHaveLength(2);
    // Attempt 1 failed before any tool use, so it only ever reaches sequence 0 (its own
    // final marker) under its own producerId — this must never bleed into attempt 2's count.
    expect(finals[0].identity).toMatchObject({ producerId: "implement-1-1", sequence: 0 });
    expect(finals[1].identity).toMatchObject({ producerId: "implement-1-2", sequence: 3 });
    const attempt2ToolStarts = calls.filter((c) => c.method === "toolStart" && c.identity.producerId === "implement-1-2");
    expect(attempt2ToolStarts.map((c) => c.identity.sequence)).toEqual([0, 2]);
  });

  it("gives two sequential invoke() calls sharing the same stage on one executor+sink distinct, non-colliding producerIds (regression: a shared executor across feedback-loop iterations must not finalize and then silently drop the second call's activity)", async () => {
    // Mirrors real feedback-loop.ts usage: implement.ts/review.ts pass a constant
    // `stage` (e.g. "implement") on every iteration against the one ClaudeCliExecutor
    // instance shared for the whole pipeline run. Before the invocation-counter fix,
    // both calls derived producerId from `stage` + spawnOnce's per-call attempt counter
    // (which always restarts at 1), so the second call's producerId collided with the
    // first's already-finalized ActivityReporter and its tool events were dropped.
    const procA = makeTestProcess(TOOL_ACTIVITY_LINES.join("\n") + "\n", 0);
    const procB = makeTestProcess(TOOL_ACTIVITY_LINES.join("\n") + "\n", 0);
    const procs = [procA, procB];
    const spawnImpl = (() => procs.shift()) as unknown as typeof spawn;
    const { sink, calls } = makeRecordingSink();
    const activityReporting: ActivityReportingConfig = { attemptId: "attempt-1", sink };
    const exec = new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, undefined, activityReporting);

    const first = await exec.invoke({ prompt: "p", model: "m", stage: "implement", cycle: 1 });
    const second = await exec.invoke({ prompt: "p", model: "m", stage: "implement", cycle: 2 });

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);

    const producerIds = [...new Set(calls.map((c) => c.identity.producerId))];
    expect(producerIds).toHaveLength(2);
    expect(producerIds).toEqual(["implement-1-1", "implement-2-1"]);

    const firstCallEvents = calls.filter((c) => c.identity.producerId === "implement-1-1");
    const secondCallEvents = calls.filter((c) => c.identity.producerId === "implement-2-1");
    // Each call reaches its own toolStart/toolResult/toolStart/toolResult/final sequence —
    // the second call's activity must actually be delivered, not silently no-op'd by an
    // already-finalized reporter.
    expect(firstCallEvents.map((c) => c.method)).toEqual(["toolStart", "toolResult", "toolStart", "toolResult", "final"]);
    expect(secondCallEvents.map((c) => c.method)).toEqual(["toolStart", "toolResult", "toolStart", "toolResult", "final"]);
    expect(secondCallEvents.map((c) => c.identity.sequence)).toEqual([0, 1, 2, 3, 3]);

    // Regression: each call's `cycle` param (feedback-loop.ts's iteration counter, once
    // threaded through) must land on that call's own toolStart/toolResult payloads rather
    // than being hardcoded — the second invoke() call's events must carry cycle 2, not 1,
    // even though both calls share the same executor, sink, and `stage`.
    const toolPayloadCycles = (events: typeof calls) =>
      events.filter((c) => c.method === "toolStart" || c.method === "toolResult").map((c) => (c.payload as { cycle: number }).cycle);
    expect(toolPayloadCycles(firstCallEvents)).toEqual([1, 1, 1, 1]);
    expect(toolPayloadCycles(secondCallEvents)).toEqual([2, 2, 2, 2]);
  });

  it("attempts the final marker on a stdin-EPIPE failure path, not only on success", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const ee = new EventEmitter();
    const proc = Object.assign(ee, { stdout, stderr, stdin }) as unknown as ChildProcessWithoutNullStreams;

    stdin.end = ((..._args: unknown[]) => {
      setImmediate(() => stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
      return stdin;
    }) as unknown as typeof stdin.end;

    setImmediate(() => {
      stdout.push(null);
      stderr.push(null);
      setImmediate(() => ee.emit("close", 1));
    });

    const fakeSpawn = () => proc;
    const { sink, calls } = makeRecordingSink();
    const activityReporting: ActivityReportingConfig = { attemptId: "attempt-1", sink };
    await new ClaudeCliExecutor("/tmp", "summary", false, fakeSpawn as unknown as typeof spawn, undefined, activityReporting)
      .invoke({ prompt: "p", model: "m" })
      .catch(() => {});

    expect(calls.filter((c) => c.method === "final")).toHaveLength(1);
  });

  it("attempts the final marker on a proc.on('error') spawn failure, not only on success", async () => {
    const spawnImpl = ((_cmd: string, _args: readonly string[], _opts: unknown) => {
      const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
      const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
      (stdin as unknown as { end: (s: string) => void }).end = () => {};
      Object.assign(proc, { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
      setImmediate(() => {
        proc.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
      });
      return proc;
    }) as unknown as typeof spawn;
    const { sink, calls } = makeRecordingSink();
    const activityReporting: ActivityReportingConfig = { attemptId: "attempt-1", sink };
    await new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl, undefined, activityReporting)
      .invoke({ prompt: "p", model: "m" })
      .catch(() => {});

    expect(calls.filter((c) => c.method === "final")).toHaveLength(1);
  });

  const TEXT_ONLY_LINES = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Thinking about this privately." }] } }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: "done",
      num_turns: 1,
      duration_ms: 1,
      usage: { input_tokens: 500, output_tokens: 500 },
    }),
  ];

  it("never derives activity from assistant text or usage/token fields, and yields no synthesized events when the executor reports zero tool_use blocks", async () => {
    const proc = makeTestProcess(TEXT_ONLY_LINES.join("\n") + "\n", 0);
    const spawnImpl = () => proc;
    const { sink, calls } = makeRecordingSink();
    const activityReporting: ActivityReportingConfig = { attemptId: "attempt-1", sink };
    await new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl as unknown as typeof spawn, undefined, activityReporting).invoke({
      prompt: "p",
      model: "m",
    });

    expect(calls.filter((c) => c.method === "toolStart" || c.method === "toolResult")).toHaveLength(0);
    const finals = calls.filter((c) => c.method === "final");
    expect(finals).toHaveLength(1);
    expect(finals[0].identity.sequence).toBe(0);
  });

  const HUGE_TOOL_OUTPUT = "x".repeat(20 * 1024);
  const BOUNDS_LINES = [
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "cat big.txt" } }] },
    }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: HUGE_TOOL_OUTPUT, is_error: false }] },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: "done",
      num_turns: 1,
      duration_ms: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  ];

  it("truncates a tool_result output over the 16 KiB per-event cap and flags it explicitly, rather than dropping it or shipping it unbounded", async () => {
    const proc = makeTestProcess(BOUNDS_LINES.join("\n") + "\n", 0);
    const spawnImpl = () => proc;
    const { sink, calls } = makeRecordingSink();
    const activityReporting: ActivityReportingConfig = { attemptId: "attempt-1", sink };
    await new ClaudeCliExecutor("/tmp", "summary", false, spawnImpl as unknown as typeof spawn, undefined, activityReporting).invoke({
      prompt: "p",
      model: "m",
    });

    const toolResultCall = calls.find((c) => c.method === "toolResult");
    expect(toolResultCall).toBeDefined();
    const output = (toolResultCall!.payload as ActivityToolResult).output;
    expect(output.truncated).toBe(true);
    expect(Buffer.byteLength(output.text, "utf8")).toBeLessThanOrEqual(16 * 1024);
  });
});
