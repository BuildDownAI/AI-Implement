import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeFetch, type Reply, type FakeFetch } from "../helpers/fake-fetch.js";
import { createModelPrices, MODEL_PRICES_REFRESH_INTERVAL_MS, type ModelPricesCurrent } from "../../restate/model-prices.js";
import {
  VARIANTS, callObject, eventually, journalEntries, journalText,
  queryInvocations, cancelInvocation, setObjectState, startVariants, stopAll, type RestateEnvironment,
} from "./harness.js";

// These cases need no fabricated producer responses. Recorded success/503 cases
// must be added when authentic Control-Plane recordings become available.
describe("ModelPrices configuration and failure scheduling", () => {
  let environments: Map<string, RestateEnvironment>;
  let issuer: string | undefined;
  let endpoint: FakeFetch;
  let reply: Reply;
  let interval: number | undefined;
  let requestOptions: Array<RequestInit | undefined>;
  const SENTINEL = "PRIVATE-NETWORK-ERROR-SENTINEL";
  beforeEach(() => {
    requestOptions = [];
    interval = undefined;
    reply = () => { throw new Error(SENTINEL); };
    endpoint = fakeFetch({ "GET /api/model-prices": call => typeof reply === "function" ? reply(call) : reply });
  });
  beforeAll(async () => {
    environments = await startVariants([createModelPrices({
      issuer: () => issuer,
      get refreshIntervalMs() { return interval; },
      fetch: async (_url, init) => {
        requestOptions.push(init);
        return endpoint.fetch(_url, init);
      },
    })]);
  }, 60_000);
  afterAll(async () => { await stopAll(environments); });

  for (const [variant] of VARIANTS) {
    describe(variant, () => {
      const env = () => environments.get(variant)!;
      const refresh = (key: string, body: unknown) => callObject<number | null>(env().baseUrl(), "ModelPrices", key, "refresh", body);
      const current = (key: string) => callObject<ModelPricesCurrent>(env().baseUrl(), "ModelPrices", key, "current", null);
      const invocations = (key: string) => queryInvocations(env().adminAPIBaseUrl(), `target_service_name = 'ModelPrices' AND target_service_key = '${key}'`);

      for (const configuration of [undefined, "http://auth.example", "https://user:password@auth.example", "https://"]) {
        it(`does no work for configuration ${String(configuration)}`, async () => {
          issuer = configuration;
          const key = randomUUID();
          await refresh(key, { reason: "boot" });
          expect(await current(key)).toEqual({ prices: [], fetchedAt: null, lastError: "not-configured" });
          expect(endpoint.calls.length).toBe(0);
          expect((await invocations(key)).some(row => row.status === "scheduled")).toBe(false);
        });
      }

      for (const [name, response, code] of [
        ["network", () => { throw new Error(SENTINEL); }, "network"],
        ["HTTP", { status: 503, text: SENTINEL }, "http"],
        ["JSON", { text: SENTINEL }, "invalid-body"],
        ["schema", { json: { prices: SENTINEL } }, "invalid-body"],
      ] as const) {
        it(`sanitizes ${name} failures in state and the journal`, async () => {
          issuer = "https://auth.example";
          reply = response;
          const key = randomUUID();
          await setObjectState(env().adminAPIBaseUrl(), "ModelPrices", key, "state", {
            prices: [], fetchedAt: 42, lastError: null, nextAt: 43,
          });
          await refresh(key, { reason: "requested" });
          expect(await current(key)).toEqual({ prices: [], fetchedAt: 42, lastError: code });
          const rows = await invocations(key);
          const journals = await Promise.all(rows.map(async row => journalText(await journalEntries(env().adminAPIBaseUrl(), String(row.id)))));
          expect(journals.join("\n")).not.toContain(SENTINEL);
          const state = await fetch(`${env().adminAPIBaseUrl()}/query`, { // restate-test-allow: inspect the complete cached state
            method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ query: `SELECT * FROM state WHERE service_name = 'ModelPrices' AND service_key = '${key}'` }),
          });
          expect(state.ok).toBe(true);
          expect(JSON.stringify(await state.json())).not.toContain(SENTINEL);
        });
      }

      it("delivers a delayed refresh after a failed read", async () => {
        issuer = "https://auth.example";
        interval = 100;
        const key = randomUUID();
        await refresh(key, { reason: "boot" });
        await eventually(() => endpoint.calls.length, count => count >= 2, {
          label: "durable model price retry delivery", timeoutMs: 10_000,
        });
        // Disable subsequent deliveries before this test's dependency is replaced.
        issuer = undefined;
        const rows = await invocations(key);
        for (const row of rows) {
          if (row.status === "scheduled") await cancelInvocation(env().adminAPIBaseUrl(), String(row.id));
        }
      });

      it("sanitizes network errors, keeps a timer, retries scheduled reads, rejects superseded timers, and deduplicates boot", async () => {
        issuer = "https://auth.example";
        const key = randomUUID();
        expect(MODEL_PRICES_REFRESH_INTERVAL_MS).toBe(6 * 60 * 60_000);
        const firstTimer = await refresh(key, { reason: "boot" });
        expect(firstTimer).toEqual(expect.any(Number));
        expect(await current(key)).toEqual({ prices: [], fetchedAt: null, lastError: "network" });
        const rows = await eventually(() => invocations(key), rows => rows.some(r => r.status === "scheduled"), { label: "six-hour model price timer" });
        expect(endpoint.calls.length).toBe(1);
        expect(requestOptions[0]?.credentials).toBe("omit");
        expect(requestOptions[0]?.redirect).toBe("error");
        expect(requestOptions[0]?.headers).toBeUndefined();
        expect(endpoint.calls[0]?.url.toString()).toBe("https://auth.example/api/model-prices");
        expect(await refresh(key, { reason: "boot" })).toBe(firstTimer);
        expect(endpoint.calls.length).toBe(1);
        const journals = await Promise.all(rows.map(async row => journalText(await journalEntries(env().adminAPIBaseUrl(), String(row.id)))));
        expect(journals.join("\n")).not.toContain(SENTINEL);
        const response = await fetch(`${env().adminAPIBaseUrl()}/query`, { // restate-test-allow: inspect cached state and its timer guard
          method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ query: `SELECT * FROM state WHERE service_name = 'ModelPrices' AND service_key = '${key}'` }),
        });
        expect(response.ok).toBe(true);
        const stateText = JSON.stringify(await response.json());
        expect(stateText).not.toContain(SENTINEL);
        await refresh(key, { reason: "scheduled", scheduledFor: -1 });
        expect(endpoint.calls.length).toBe(1);
        const staleRows = await invocations(key);
        // Inspect every completed invocation: stale and boot no-ops must never send.
        for (const row of staleRows.filter(row => row.status === "completed")) {
          const entries = await journalEntries(env().adminAPIBaseUrl(), String(row.id));
          const text = journalText(entries);
          if (!text.includes("read model prices")) {
            expect(entries.some(entry => entry.entry_type === "Command: OneWayCall")).toBe(false);
          }
        }
        const secondTimer = await refresh(key, { reason: "scheduled", scheduledFor: firstTimer });
        expect(endpoint.calls.length).toBe(2);
        expect(secondTimer).not.toBe(firstTimer);
        await refresh(key, { reason: "scheduled", scheduledFor: firstTimer });
        expect(endpoint.calls.length).toBe(2);
        expect(await current(key)).toEqual({ prices: [], fetchedAt: null, lastError: "network" });
      });
    });
  }
});
