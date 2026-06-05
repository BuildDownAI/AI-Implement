import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCliExecutor } from "../pipeline/executor.js";

let binDir: string;
let originalPath: string | undefined;

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

const SUCCESS_LINES = [
  JSON.stringify({ type: "system", subtype: "init", model: "claude-x", cwd: "/workspace" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm check" } }] } }),
  JSON.stringify({ type: "result", subtype: "success", result: "Done implementing.", num_turns: 4, duration_ms: 5000, usage: { input_tokens: 100, output_tokens: 20 } }),
];

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(binDir, { recursive: true, force: true });
  vi.restoreAllMocks();
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

describe("ClaudeCliExecutor", () => {
  it("returns the result event's text as stdout (compat) plus telemetry", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    installFakeClaude(SUCCESS_LINES, 0);
    const exec = new ClaudeCliExecutor("/tmp", "summary");
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
    installFakeClaudeNoTrailingNewline(SUCCESS_LINES, 0);
    const result = await new ClaudeCliExecutor("/tmp", "summary").invoke({ prompt: "p", model: "m" });
    expect(result.stdout).toBe("Done implementing.");
    expect(result.telemetry?.outcome).toBe("success");
    expect(result.telemetry?.numTurns).toBe(4);
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
});
