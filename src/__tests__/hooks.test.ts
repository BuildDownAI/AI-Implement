import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const isWindows = process.platform === "win32";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hookOutputTail, runHookScript } from "../pipeline/steps/hooks.js";
import { testDir } from "./helpers/test-dir.js";

let dir: string;
beforeEach(() => { dir = testDir("hooks"); });
afterEach(() => {
  // Clean up env the hook scripts export, so a failing assertion mid-test can't
  // leak a var into other tests sharing this Vitest worker's process.env.
  vi.unstubAllEnvs();
  for (const k of ["FOO_TEST_VAR", "SIMPLE_TEST_VAR", "MULTI_TEST_VAR", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "AI_IMPLEMENT_FORWARDED_SECRETS", "QA_BASE_URL", "QA_TOKEN"]) {
    delete process.env[k];
  }
});

describe.skipIf(isWindows)("runHookScript", () => {
  it("runs the script and merges GITHUB_ENV exports into process.env", async () => {
    writeFileSync(join(dir, "setup.sh"), 'echo "FOO_TEST_VAR=bar123" >> "$GITHUB_ENV"\n');
    const result = await runHookScript("setup", "setup.sh", dir);
    expect(result.exitCode).toBe(0);
    expect(process.env.FOO_TEST_VAR).toBe("bar123");
  });

  it("returns a non-zero exit code when the script fails", async () => {
    writeFileSync(join(dir, "bad.sh"), "exit 3\n");
    const result = await runHookScript("setup", "bad.sh", dir);
    expect(result.exitCode).toBe(3);
  });

  it("pauses the child's stream when the sink is full and resumes on drain", async () => {
    writeFileSync(join(dir, "chatty.sh"), 'echo first\nsleep 0.2\necho second\n');
    let calls = 0;
    let fullReturned = false;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      calls++;
      // Only the write carrying the child's first chunk reports a full sink.
      if (!fullReturned && String(chunk).includes("first")) {
        fullReturned = true;
        setTimeout(() => process.stdout.emit("drain"), 20);
        return false;
      }
      return true;
    }) as never);
      try {
      const result = await runHookScript("verify", "chatty.sh", dir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("first");
      expect(result.output).toContain("second");
      expect(fullReturned).toBe(true);
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      write.mockRestore();
    }
  });

  it("captures stdout and stderr in the result", async () => {
    writeFileSync(join(dir, "out.sh"), 'echo to-out\necho to-err >&2\nexit 4\n');
    const result = await runHookScript("verify", "out.sh", dir);
    expect(result.exitCode).toBe(4);
    expect(result.output).toContain("to-out");
    expect(result.output).toContain("to-err");
  });

  it("hookOutputTail keeps only the last 200 lines and redacts a _TOKEN-suffixed secret", async () => {
    vi.stubEnv("QA_TOKEN", "supersecretvalue123");
    const output = [...Array.from({ length: 300 }, (_, i) => `l${i}`), "tok=supersecretvalue123"].join("\n");
    const tail = hookOutputTail(output);
    expect(tail.split("\n")).toHaveLength(200);
    expect(tail).not.toContain("l0\n");
    expect(tail).not.toContain("supersecretvalue123");
  });

  it("hookOutputTail redacts a forwarded secret by value, whatever its name", () => {
    vi.stubEnv("AI_IMPLEMENT_FORWARDED_SECRETS", "DB_PASS");
    vi.stubEnv("DB_PASS", "hunter2");
    vi.stubEnv("NPM_TOKEN", "npm-secret-xyz");
    const tail = hookOutputTail("connect password=hunter2 npm=npm-secret-xyz ok");
    expect(tail).not.toContain("hunter2");
    expect(tail).not.toContain("npm-secret-xyz");
    expect(tail).toContain("connect password=*** npm=*** ok");
  });

  it("streams output past 64 MiB without throwing and keeps a bounded tail", async () => {
    writeFileSync(join(dir, "big.sh"), 'head -c 70000000 /dev/zero | tr "\\0" "a"\necho; echo THE-END\nexit 5\n');
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const result = await runHookScript("verify", "big.sh", dir);
      expect(result.exitCode).toBe(5);
      expect(result.output.length).toBeLessThanOrEqual(256 * 1024);
      expect(result.output).toContain("THE-END");
      expect(write).toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  }, 60_000);

  it("throws a clear error when the script path does not exist", async () => {
    await expect(runHookScript("setup", "missing.sh", dir)).rejects.toThrow(/missing\.sh/);
  });

  it("does not pass model credentials to hook scripts", async () => {
    const captureFile = join(dir, "hook-env.txt");
    writeFileSync(join(dir, "setup.sh"), `env > "${captureFile}"\n`);
    process.env.ANTHROPIC_API_KEY = "sentinel-api-key-hook";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sentinel-oauth-hook";

    const result = await runHookScript("setup", "setup.sh", dir);
    expect(result.exitCode).toBe(0);

    const captured = readFileSync(captureFile, "utf-8");
    expect(captured).not.toContain("sentinel-api-key-hook");
    expect(captured).not.toContain("sentinel-oauth-hook");
    // GITHUB_ENV must be present so the hook can export variables
    expect(captured).toContain("GITHUB_ENV=");
  });

  it("does not pass run tokens to hook scripts", async () => {
    const captureFile = join(dir, "hook-env.txt");
    writeFileSync(join(dir, "setup.sh"), `env > "${captureFile}"\n`);
    process.env.RUN_TOKEN = "sentinel-run-token-hook";
    process.env.RUN_PROGRESS_TOKEN = "sentinel-progress-token-hook";
    process.env.RUN_PUBLICATION_TOKEN = "sentinel-publication-token-hook";
    try {
      const result = await runHookScript("setup", "setup.sh", dir);
      expect(result.exitCode).toBe(0);
      const captured = readFileSync(captureFile, "utf-8");
      expect(captured).not.toContain("sentinel-run-token-hook");
      expect(captured).not.toContain("sentinel-progress-token-hook");
      expect(captured).not.toContain("sentinel-publication-token-hook");
    } finally {
      delete process.env.RUN_TOKEN;
      delete process.env.RUN_PROGRESS_TOKEN;
      delete process.env.RUN_PUBLICATION_TOKEN;
    }
  });

  it("forwarded secrets are present in hook spawn env", async () => {
    const captureFile = join(dir, "hook-env.txt");
    writeFileSync(join(dir, "setup.sh"), `env > "${captureFile}"\n`);
    process.env.AI_IMPLEMENT_FORWARDED_SECRETS = "QA_BASE_URL,QA_TOKEN";
    process.env.QA_BASE_URL = "https://qa.example.com";
    process.env.QA_TOKEN = "sentinel-qa-token-hook";

    const result = await runHookScript("setup", "setup.sh", dir);
    expect(result.exitCode).toBe(0);

    const captured = readFileSync(captureFile, "utf-8");
    expect(captured).toContain("sentinel-qa-token-hook");
    expect(captured).toContain("https://qa.example.com");
    expect(captured).toContain("AI_IMPLEMENT_FORWARDED_SECRETS=");
  });

  it("ignores GHA heredoc multiline values (only KEY=value is supported)", async () => {
    // A heredoc opener (KEY<<EOF) must NOT be parsed as an env var; the simple
    // line on the same file is still merged.
    writeFileSync(
      join(dir, "multi.sh"),
      'printf "MULTI_TEST_VAR<<EOF\\nl1\\nl2\\nEOF\\nSIMPLE_TEST_VAR=ok\\n" >> "$GITHUB_ENV"\n',
    );
    const result = await runHookScript("setup", "multi.sh", dir);
    expect(result.exitCode).toBe(0);
    expect(process.env.MULTI_TEST_VAR).toBeUndefined();
    expect(process.env.SIMPLE_TEST_VAR).toBe("ok");
  });
});
