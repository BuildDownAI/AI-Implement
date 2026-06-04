import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCliExecutor } from "../pipeline/executor.js";

// Real-subprocess test: a fake `claude` on PATH records the argv it was invoked
// with and whatever arrived on stdin. This exercises the actual spawn + stdio
// plumbing — the only thing that meaningfully proves the E2BIG fix.
describe("ClaudeCliExecutor", () => {
  let dir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-exec-"));
    const script = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${dir}/argv.txt"
cat > "${dir}/stdin.txt"
echo "ok"
`;
    const fakeClaude = join(dir, "claude");
    writeFileSync(fakeClaude, script);
    chmodSync(fakeClaude, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it("delivers the prompt over stdin, never as a command-line argument", async () => {
    // A prompt larger than Linux MAX_ARG_STRLEN (128 KiB) trips spawn E2BIG when
    // passed as a single argv element. Delivering it on stdin sidesteps that.
    const bigPrompt = "X".repeat(200_000);

    const result = await new ClaudeCliExecutor(dir).invoke({
      prompt: bigPrompt,
      model: "claude-sonnet-4-6",
    });

    expect(result.exitCode).toBe(0);

    const argv = readFileSync(join(dir, "argv.txt"), "utf-8");
    const stdin = readFileSync(join(dir, "stdin.txt"), "utf-8");

    // The prompt must arrive via stdin...
    expect(stdin).toContain(bigPrompt);
    // ...and must NOT appear in argv (that is what causes E2BIG).
    expect(argv).not.toContain(bigPrompt);
  });

  it("still passes model and flags as arguments", async () => {
    await new ClaudeCliExecutor(dir).invoke({
      prompt: "hello",
      model: "claude-sonnet-4-6",
      maxTurns: 7,
    });

    const argv = readFileSync(join(dir, "argv.txt"), "utf-8");
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).toContain("--model");
    expect(argv).toContain("claude-sonnet-4-6");
    expect(argv).toContain("--max-turns");
    expect(argv).toContain("7");
  });
});
