import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const isWindows = process.platform === "win32";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { ClaudeCliExecutor } from "../pipeline/executor.js";

let binDir: string;

function installFakeClaude(stdoutLines: string[], code = 0): void {
  const script = `#!/usr/bin/env bash
cat <<'JSONL'
${stdoutLines.join("\n")}
JSONL
exit ${code}
`;
  const path = join(binDir, "claude");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

// A fake `claude` that writes a message to stderr (e.g. an auth/model error)
// and exits non-zero, with no JSONL on stdout.
function installFakeClaudeStderr(message: string, code = 1): void {
  const script = `#!/usr/bin/env bash
printf '%s\\n' '${message.replace(/'/g, `'\\''`)}' >&2
exit ${code}
`;
  const path = join(binDir, "claude");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

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

function installFakeClaudeNoTrailingNewline(stdoutLines: string[], code = 0): void {
  // Emit every line but the last via a quoted heredoc, then the final line with
  // `printf '%s'` so there is NO trailing newline — exercises the close-handler
  // flush. Quoted heredoc + single-quoted printf arg means `$`/backtick in JSON
  // values are never interpreted by the shell.
  const lines = [...stdoutLines];
  const last = (lines.pop() ?? "").replace(/'/g, `'\\''`);
  const head = lines.length ? `cat <<'JSONL'\n${lines.join("\n")}\nJSONL\n` : "";
  const script = `#!/usr/bin/env bash
${head}printf '%s' '${last}'
exit ${code}
`;
  const path = join(binDir, "claude");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

// Builds a fake ChildProcess whose stdout emits the given content string, then
// closes with exitCode. Content is pushed asynchronously so all event listeners
// are registered before data arrives, matching real child process ordering.
function makeTestProcess(stdoutContent: string, exitCode: number): ChildProcessWithoutNullStreams {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const ee = new EventEmitter();
  const proc = Object.assign(ee, { stdout, stderr, stdin }) as unknown as ChildProcessWithoutNullStreams;
  setImmediate(() => {
    stdout.push(stdoutContent);
    stdout.push(null);
    stderr.push(null);
    setImmediate(() => ee.emit("close", exitCode));
  });
  return proc;
}

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
    installFakeClaude(SUCCESS_LINES, 0);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await new ClaudeCliExecutor("/tmp", "summary").invoke({ prompt: "p", model: "m" });

    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith("[claude] result="))).toBe(true);
    expect(lines.some((l) => l.startsWith("[claude] tool "))).toBe(false);
  });

  it("prints per-event lines at stream level", async () => {
    installFakeClaude(SUCCESS_LINES, 0);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await new ClaudeCliExecutor("/tmp", "stream").invoke({ prompt: "p", model: "m" });

    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("tool Bash pnpm check"))).toBe(true);
    expect(lines.some((l) => l.startsWith("[claude] result="))).toBe(true);
  });

  it("propagates a non-zero exit code and degrades telemetry to unknown", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    installFakeClaude(["not even json"], 1);
    const result = await new ClaudeCliExecutor("/tmp", "summary").invoke({ prompt: "p", model: "m" });
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
    installFakeClaudeStderr("Authentication failed: invalid API key", 1);
    const result = await new ClaudeCliExecutor("/tmp", "summary").invoke({ prompt: "p", model: "m" });

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
});
