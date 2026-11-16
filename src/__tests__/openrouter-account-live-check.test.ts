import { readdirSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { fakeFetch, hangUntilAborted, stubAbortTimeout } from "./helpers/fake-fetch.js";
import { testTempRoot } from "./helpers/test-dir.js";
import type { AccountCheckDeps } from "../../scripts/openrouter-account-live-check.js";

async function runOpenRouterAccountLiveCheck(options: Parameters<typeof import("../../scripts/openrouter-account-live-check.js").runOpenRouterAccountLiveCheck>[0]) {
  vi.resetModules();
  return (await import("../../scripts/openrouter-account-live-check.js")).runOpenRouterAccountLiveCheck(options);
}

const key = "synthetic-account-SENTINEL-key";
const prefix = "openrouter-account-live-check: ";

it.each([
  [200, "pass"], [299, "pass"], [401, "fail (provider: key refused, status 401)"],
  [403, "fail (provider: key refused, status 403)"], [503, "fail (provider: status 503)"],
  [302, "fail (provider: status 302)"], [0, "fail (provider: no answer)"], [-1, "fail (provider: no answer)"],
] as const)("uses real routes and resolver, safely reports provider %s", async (status, result) => {
  const root = testTempRoot();
  const saved = [process.env.DEDUP_DB_PATH, process.env.RUNNER_TOKEN_SECRET];
  const timeout = stubAbortTimeout(20_000);
  const fake = fakeFetch({ "GET /api/v1/key": status === -1 ? hangUntilAborted
    : status === 0 ? () => { throw new Error(`Authorization: Bearer ${key}`); } : { status, text: key } });
  const fetchImpl = vi.fn(fake.fetch);
  const log = vi.fn();
  expect(await runOpenRouterAccountLiveCheck({ env: { OPENROUTER_TEST_API_KEY: key }, fetchImpl, log })).toBe(0);
  expect(log.mock.calls).toEqual([[prefix + result]]);
  expect(JSON.stringify(log.mock.calls)).not.toContain(key);
  expect(readdirSync(root)).toEqual([]);
  expect([process.env.DEDUP_DB_PATH, process.env.RUNNER_TOKEN_SECRET]).toEqual(saved);
  expect(timeout).toHaveBeenCalledWith(20_000);
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0].url.href).toBe("https://openrouter.ai/api/v1/key");
  expect(fake.calls[0].body).toBe("");
  expect([...fake.calls[0].headers]).toEqual([["authorization", `Bearer ${key}`]]);
  expect(fetchImpl.mock.calls[0][1]?.redirect).toBe("manual");
});

it.each([undefined, ""])("skips absent/empty key %s without steps", async value => {
  const root = testTempRoot();
  const fake = fakeFetch({});
  const request = vi.fn();
  const log = vi.fn();
  await runOpenRouterAccountLiveCheck({ env: { OPENROUTER_TEST_API_KEY: value }, fetchImpl: fake.fetch, log, accountDeps: { request } });
  expect(log.mock.calls).toEqual([[prefix + "skipped (no key)"]]);
  expect(request).not.toHaveBeenCalled();
  expect(fake.calls).toEqual([]);
  expect(readdirSync(root)).toEqual([]);
});

it("deduplicates a run but allows a different run", async () => {
  const root = testTempRoot();
  const fake = fakeFetch({ "GET /api/v1/key": { status: 200 } });
  const log = vi.fn();
  const env = { OPENROUTER_TEST_API_KEY: key, OPENROUTER_ACCOUNT_CHECK_RUN_ID: "run-one" };
  await runOpenRouterAccountLiveCheck({ env, fetchImpl: fake.fetch, log });
  const request = vi.fn();
  await runOpenRouterAccountLiveCheck({ env, fetchImpl: fake.fetch, log, accountDeps: { request } });
  expect(request).not.toHaveBeenCalled();
  await runOpenRouterAccountLiveCheck({ env: { ...env, OPENROUTER_ACCOUNT_CHECK_RUN_ID: "run-two" }, fetchImpl: fake.fetch, log });
  expect(log.mock.calls).toEqual([[prefix + "pass"], [prefix + "skipped (ran before in this run)"], [prefix + "pass"]]);
  expect(fake.calls).toHaveLength(2);
  expect(readdirSync(root)).toHaveLength(2);
});

const failures: { name: string; deps: AccountCheckDeps; calls?: number }[] = [
  { name: "create: status 400", deps: { request: vi.fn(async () => ({ status: 400, text: "" })) }, calls: 1 },
  { name: "store: status 500", deps: { request: vi.fn(async method => ({ status: method === "POST" ? 201 : 500, text: "" })) }, calls: 2 },
  { name: "binding: missing", deps: { binding: () => undefined } },
  { name: "binding: mismatch", deps: { binding: () => ({ destination: "wrong", bound_at: 1 }) } },
  { name: "list: credential not set", deps: { request: vi.fn(async method => ({ status: method === "POST" ? 201 : 200, text: '{"accounts":[]}' })), binding: () => ({ destination: "openrouter/openrouter-api-key", bound_at: 1 }) }, calls: 3 },
  { name: "list: key in answer", deps: { request: vi.fn(async method => ({ status: method === "POST" ? 201 : 200, text: key })), binding: () => ({ destination: "openrouter/openrouter-api-key", bound_at: 1 }) }, calls: 3 },
  { name: "resolve: secret_unavailable", deps: { resolveCredential: () => ({ ok: false, code: "secret_unavailable", category: "authentication_required" }) } },
];
it.each(failures)("stops at $name and removes its database", async ({ name, deps, calls }) => {
  const root = testTempRoot();
  const fake = fakeFetch({});
  const log = vi.fn();
  await runOpenRouterAccountLiveCheck({ env: { OPENROUTER_TEST_API_KEY: key }, fetchImpl: fake.fetch, log, accountDeps: deps });
  expect(log.mock.calls).toEqual([[prefix + `fail (${name})`]]);
  expect(JSON.stringify(log.mock.calls)).not.toContain(key);
  expect(fake.calls).toEqual([]);
  expect(readdirSync(root)).toEqual([]);
  if (calls) expect(deps.request).toHaveBeenCalledTimes(calls);
});
