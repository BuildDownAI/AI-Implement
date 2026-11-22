import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createPreflightStep, preflightStep } from "../pipeline/steps/preflight.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import { makeContext } from "./helpers/builders.js";
import { testDir } from "./helpers/test-dir.js";

vi.mock("node:child_process", { spy: true });
const spawnMock = cp.spawn as unknown as Mock<(command: string, options: cp.SpawnOptions) => cp.ChildProcess>;
const { spawn: realSpawn } = await vi.importActual<typeof cp>("node:child_process");

describe("preflightStep", () => {
  let dir: string;
  let logs: ReturnType<typeof vi.spyOn>;
  const groups: number[] = [];

  beforeEach(() => {
    dir = testDir("preflight");
    vi.stubEnv("NODE_DISABLE_COMPILE_CACHE", "1");
    vi.stubEnv("NODE_COMPILE_CACHE", path.join(dir, "compile-cache"));
    logs = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    spawnMock.mockReset().mockImplementation((command, options) => {
      const child = realSpawn(command, options);
      if (child.pid) groups.push(child.pid);
      return child;
    });
  });
  afterEach(() => {
    for (const pid of groups.splice(0)) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* Already exited. */ }
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function scripts(values: Record<string, string>) {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: values }));
  }
  let scriptId = 0;
  function node(code: string) {
    const name = `script-${scriptId++}.cjs`;
    fs.writeFileSync(path.join(dir, name), code);
    return `"${process.execPath}" ${name}`;
  }
  function run(step = preflightStep, packageManager = "npm") {
    return step.run(makeContext(), { workspaceDir: dir, packageManager }, new NoopStepReporter());
  }
  function logPair(command: string, status: string) {
    expect(logs.mock.calls).toEqual([
      [`[preflight] start: ${command}`],
      [expect.stringMatching(new RegExp(`^\\[preflight\\] end: ${command} — ${status}; duration \\d+ ms$`))],
    ]);
  }

  it("returns a no-op without scripts", async () => {
    expect(await run()).toEqual({
      passed: true, summary: "no preflight checks configured", testsRun: 0, testOutput: "",
    });
    expect(cp.spawn).not.toHaveBeenCalled();
    expect(logs).not.toHaveBeenCalled();
  });

  it("runs checks sequentially, counts assertions, and logs every command", async () => {
    scripts({ typecheck: node('console.log("typed")'), lint: node('console.log("linted")'), test: node('console.log("pass ✓ ok 1")') });
    const result = await run();
    expect(result.passed).toBe(true);
    expect(result.summary).toBe("typecheck: passed, lint: passed, tests: passed (3 assertions)");
    expect(spawnMock.mock.calls.map(([cmd]) => cmd)).toEqual(["npm run typecheck", "npm run lint", "npm test"]);
    expect(logs.mock.calls).toHaveLength(6);
    for (const [index, command] of ["npm run typecheck", "npm run lint", "npm test"].entries()) {
      expect(logs.mock.calls[index * 2]).toEqual([`[preflight] start: ${command}`]);
      expect(logs.mock.calls[index * 2 + 1]).toEqual([expect.stringMatching(/exit 0; duration \d+ ms$/)]);
    }
  });

  it("preserves failing stdout, stderr, and the exit marker", async () => {
    scripts({ test: node('console.log("FAIL"); console.error("boom"); process.exit(1)') });
    const result = await run();
    expect(result.summary).toBe("tests: failed (exit 1)");
    expect(result.passed).toBe(false);
    expect(result.testOutput).toContain("FAIL");
    expect(result.testOutput).toContain("boom");
    expect(result.testOutput.trimEnd()).toMatch(/\[exit 1\]$/);
    logPair("npm test", "failed \\(exit 1\\)");
  });

  it("skips later checks after typecheck fails", async () => {
    scripts({ typecheck: node("process.exit(2)"), lint: "unused", test: "unused" });
    expect((await run()).summary).toBe("typecheck: failed (exit 2)");
    expect(cp.spawn).toHaveBeenCalledTimes(1);
  });

  it.each(["yarn", "pnpm"])("preserves %s command selection and environment filtering", async (pm) => {
    scripts({ typecheck: "unused", lint: "unused", test: "unused" });
    for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "RUN_TOKEN", "RUN_PROGRESS_TOKEN", "RUN_PUBLICATION_TOKEN"]) vi.stubEnv(key, "sentinel");
    spawnMock.mockImplementation((_cmd, options) => {
      const child = realSpawn(process.execPath, ["-e", ""], { ...options, shell: false });
      if (child.pid) groups.push(child.pid);
      return child;
    });
    expect((await run(preflightStep, pm)).passed).toBe(true);
    expect(spawnMock.mock.calls.map(([cmd]) => cmd)).toEqual(pm === "yarn"
      ? ["yarn typecheck", "yarn lint", "yarn test"]
      : ["pnpm run typecheck", "pnpm run lint", "pnpm test"]);
    const options = spawnMock.mock.calls[0][1];
    expect(options).toMatchObject({ cwd: dir, detached: true, shell: true });
    for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "RUN_TOKEN", "RUN_PROGRESS_TOKEN", "RUN_PUBLICATION_TOKEN"]) expect(options?.env).not.toHaveProperty(key);
    expect(options?.env?.PATH).toBeDefined();
  });

  it("captures more than 1 MiB", async () => {
    scripts({ test: node('process.stdout.write("x".repeat(2 * 1024 * 1024))') });
    const result = await run();
    expect(result.summary).toBe("tests: passed (0 assertions)");
    expect(result.testOutput.length).toBeGreaterThan(2 * 1024 * 1024);
  });

  it("bounds output at 64 MiB and reports ENOBUFS", async () => {
    scripts({ test: node('setInterval(() => process.stdout.write("x".repeat(1024 * 1024)), 1)') });
    const result = await run(createPreflightStep(10_000));
    expect(result.summary).toBe("tests: failed (ENOBUFS: output over 64 MiB)");
    expect(result.testOutput).toMatch(/\[ENOBUFS\]$/);
    expect(result.testOutput.length).toBeLessThan(64 * 1024 * 1024 + 100);
  });

  it.each([false, true])("times out and kills the group (parent exits: %s)", async (parentExits) => {
    fs.writeFileSync(path.join(dir, "worker.cjs"), 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
    fs.writeFileSync(path.join(dir, "hang.cjs"), parentExits
      ? 'require("node:child_process").spawn(process.execPath, ["worker.cjs"], {stdio: "inherit"}); console.log("before timeout"); process.exit(0);'
      : 'console.log("before timeout"); setInterval(() => {}, 1000);');
    scripts({ test: `"${process.execPath}" hang.cjs` });
    const kill = vi.spyOn(process, "kill");
    const started = Date.now();
    const result = await run(createPreflightStep(1500));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(kill).toHaveBeenCalledWith(-groups[groups.length - 1], "SIGKILL");
    expect(result.passed).toBe(false);
    expect(result.summary).toBe("tests: failed (timed out after 0.025 min)");
    expect(result.testOutput).toContain("before timeout");
    logPair("npm test", "failed \\(timed out after 0.025 min\\)");
  });

  it("reports spawn errors once and clears the deadline", async () => {
    scripts({ test: "unused" });
    spawnMock.mockImplementation((_cmd, options) => realSpawn("/nonexistent/preflight-command", [], { ...options, shell: false }));
    const result = await run(createPreflightStep(100));
    expect(result.summary).toBe("tests: failed (ENOENT)");
    expect(result.testOutput).toContain("ENOENT");
    logPair("npm test", "failed \\(ENOENT\\)");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(logs.mock.calls).toHaveLength(2);
  });
});
