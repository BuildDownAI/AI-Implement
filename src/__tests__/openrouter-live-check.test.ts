import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { fakeFetch, hangUntilAborted, stubAbortTimeout } from "./helpers/fake-fetch.js";
import { testDir } from "./helpers/test-dir.js";

// @ts-ignore no declaration file for the repository-local ESM script
const { runOpenRouterLiveCheck } = await import("../../scripts/openrouter-live-check.mjs");
const key = "synthetic-openrouter-test-secret";
const prefix = "openrouter-live-check: ";

const cases = [
  { name: "absent key", key: undefined, status: 200, result: "skipped (no key)" },
  { name: "empty key", key: "", status: 200, result: "skipped (no key)" },
  { name: "success", key, status: 200, result: "pass" },
  { name: "other 2xx", key, status: 299, result: "pass" },
  { name: "unauthorized", key, status: 401, result: "fail (key refused, status 401)" },
  { name: "forbidden", key, status: 403, result: "fail (key refused, status 403)" },
  { name: "server error", key, status: 503, result: "fail (status 503)" },
  { name: "redirect", key, status: 302, result: "fail (status 302)" },
  { name: "network error", key, status: 0, result: "fail (no answer)" },
  { name: "timeout", key, status: -1, result: "fail (no answer)" },
];

describe("OpenRouter live check", () => {
  it.each(cases)("reports $name safely with exit 0", async (scenario) => {
    const timeout = stubAbortTimeout(20_000);
    const fake = fakeFetch(scenario.key ? {
      "GET /api/v1/key": scenario.status === -1 ? hangUntilAborted
        : scenario.status === 0 ? () => { throw new Error(`Authorization: Bearer ${key}`); }
          : { status: scenario.status, text: key, headers: { "x-sensitive": key } },
    } : {});
    const log = vi.fn();
    // Explicitly use an empty key for absence so no ambient environment can supply one.
    expect(await runOpenRouterLiveCheck({ key: scenario.key ?? "", fetchImpl: fake.fetch, log })).toBe(0);
    expect(log.mock.calls).toEqual([[prefix + scenario.result]]);
    const output = JSON.stringify(log.mock.calls);
    expect(output).not.toContain(key);
    expect(output).not.toContain("Authorization");
    expect(output).not.toContain("Bearer");
    expect(fake.calls).toHaveLength(scenario.key ? 1 : 0);
    expect(timeout).toHaveBeenCalledTimes(scenario.key ? 1 : 0);
    if (scenario.key) {
      const call = fake.calls[0];
      expect(call.url.href).toBe("https://openrouter.ai/api/v1/key");
      expect(call.method).toBe("GET");
      expect([...call.headers]).toEqual([["authorization", `Bearer ${key}`]]);
      expect(call.body).toBe("");
    }
  });

  it.each(cases)("shell hook exits 0 for $name without a real request", (scenario) => {
    const preload = join(testDir("openrouter-preload"), "fetch.mjs");
    writeFileSync(preload, `
      import assert from 'node:assert/strict';
      const scenario = ${JSON.stringify(scenario)};
      AbortSignal.timeout = (ms) => {
        assert.equal(ms, 20000);
        const controller = new AbortController();
        queueMicrotask(() => controller.abort(new Error('synthetic timeout')));
        return controller.signal;
      };
      globalThis.fetch = async (url, init) => {
        assert.ok(scenario.key, 'skip must not fetch');
        assert.equal(url, 'https://openrouter.ai/api/v1/key');
        assert.equal(init.method, 'GET');
        assert.equal(init.redirect, 'manual');
        assert.deepEqual(init.headers, { Authorization: 'Bearer ' + scenario.key });
        assert.equal(init.body, undefined);
        if (scenario.status === 0) throw new Error('Authorization: Bearer ' + scenario.key);
        if (scenario.status === -1) return new Promise((_, reject) => {
          if (init.signal.aborted) reject(init.signal.reason);
          else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
        return new Response(scenario.key, { status: scenario.status });
      };
    `);
    const bin = testDir("openrouter-bin");
    writeFileSync(join(bin, "npx"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, "npx"), 0o755);
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
    delete env.OPENROUTER_TEST_API_KEY;
    if (scenario.key !== undefined) env.OPENROUTER_TEST_API_KEY = scenario.key;
    const stdoutPath = join(testDir("openrouter-output"), "stdout");
    const stderrPath = stdoutPath + ".stderr";
    const stdoutFd = openSync(stdoutPath, "w");
    const stderrFd = openSync(stderrPath, "w");
    let child;
    try {
      child = spawnSync("sh", [resolve("scripts/ci/ai-verify.sh")], {
        env, stdio: ["ignore", stdoutFd, stderrFd],
      });
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
    const stdout = readFileSync(stdoutPath, "utf8");
    const stderr = readFileSync(stderrPath, "utf8");
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(stdout).toBe(prefix + scenario.result + "\nopenrouter-account-live-check: skipped (tsx not found)\n");
    expect(stderr).toBe("");
    expect(stdout + stderr).not.toContain(key);
  });

  it("configures the repository verify hook", () => {
    const workflow = readFileSync(resolve("WORKFLOW.md"), "utf8");
    const frontMatter = workflow.match(/^---\n([\s\S]*?)\n---/);
    expect(frontMatter).not.toBeNull();
    expect(parse(frontMatter![1]).verify).toBe("scripts/ci/ai-verify.sh");
  });
});

it("runs the account check after the key check and exits zero when tsx throws", () => {
  const dir = testDir("openrouter-throwing-tsx");
  const npx = join(dir, "npx");
  const calls = join(dir, "calls");
  writeFileSync(npx, `#!/bin/sh
if [ "$3" = "--version" ]; then exit 0; fi
printf '%s\\n' "$*" > "$CHECK_CALLS"
echo 'account invoked'
"$CHECK_NODE" -e 'throw new Error("synthetic sensitive exception")'
`);
  chmodSync(npx, 0o755);
  writeFileSync(join(dir, "node"), "#!/bin/sh\necho 'openrouter-live-check: skipped (no key)'\n");
  chmodSync(join(dir, "node"), 0o755);
  const child = spawnSync("sh", [resolve("scripts/ci/ai-verify.sh")], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, OPENROUTER_TEST_API_KEY: "", CHECK_CALLS: calls, CHECK_NODE: process.execPath, NODE_OPTIONS: "" }, encoding: "utf8",
  });
  expect(child.status).toBe(0);
  expect(child.stdout).toBe("openrouter-live-check: skipped (no key)\naccount invoked\n");
  expect(child.stderr).toBe("");
  expect(readFileSync(calls, "utf8")).toContain("--no-install tsx");
  expect(readFileSync(calls, "utf8")).toContain("openrouter-account-live-check.ts");
});
