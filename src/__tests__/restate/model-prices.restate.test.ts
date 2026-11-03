import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as restate from "@restatedev/restate-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeFetch, type Reply, type Routes, type FakeFetch } from "../helpers/fake-fetch.js";
import { createModelPrices, MODEL_PRICES_REFRESH_INTERVAL_MS, type ModelPricesCurrent } from "../../restate/model-prices.js";
import {
  VARIANTS, callObject, eventually, journalEntries, journalText,
  queryInvocations, cancelInvocation, setObjectState, startVariants, stopAll, type RestateEnvironment,
} from "./harness.js";

const recordings = Object.fromEntries(["several-models", "empty", "unavailable"].map(name => [
  name, JSON.parse(readFileSync(new URL(`../fixtures/contracts/model-prices/${name}.json`, import.meta.url), "utf8")) as {
    response: { status: number; body: { prices?: ModelPricesCurrent["prices"]; error?: string } };
  },
]));
function recordedReply(name: string): Reply {
  const { status, body } = recordings[name]!.response;
  return { status, json: body };
}
describe("ModelPrices configuration and failure scheduling", () => {
  let environments: Map<string, RestateEnvironment>;
  let issuer: string | undefined;
  let endpoint: FakeFetch;
  let reply: Reply;
  let interval: number | undefined;
  let requestOptions: Map<string, RequestInit | undefined>;
  const routes: Routes = {};
  const configurations = new Map<string, { issuer: string | undefined; interval: number | undefined }>();
  const callsFor = (key: string) => endpoint.calls.filter(call => call.url.pathname === `/${key}/api/model-prices`);
  const SENTINEL = "PRIVATE-NETWORK-ERROR-SENTINEL";
  beforeEach(() => {
    requestOptions = new Map();
    interval = undefined;
    reply = () => { throw new Error(SENTINEL); };
    endpoint = fakeFetch(routes);
  });
  beforeAll(async () => {
    // Resolve configuration from the invocation's key, even when an old timer runs
    // after beforeEach has installed the next test's fake endpoint.
    const modelFor = (key: string) => {
      const model = createModelPrices({
        issuer: () => {
          const value = configurations.get(key)?.issuer;
          return value === "https://auth.example" ? `${value}/${key}` : value;
        },
        get refreshIntervalMs() { return configurations.get(key)?.interval; },
        fetch: async (url, init) => {
          requestOptions.set(String(url), init);
          return endpoint.fetch(url, init);
        },
      });
      // The SDK runtime exposes handlers on `object`; its definition type only
      // carries the service name. Keep the cast local to this fixture adapter.
      return (model as typeof model & { object: restate.VirtualObject<typeof model> }).object;
    };
    type RefreshInput = Parameters<ReturnType<typeof modelFor>["refresh"]>[1];
    environments = await startVariants([restate.object({ name: "ModelPrices", handlers: {
      refresh: restate.handlers.object.exclusive(async (ctx: restate.ObjectContext, input: RefreshInput) =>
        modelFor(ctx.key).refresh(ctx, input)),
      current: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext) =>
        modelFor(ctx.key).current(ctx)),
    } })]);
  }, 60_000);
  afterAll(async () => { await stopAll(environments); });

  for (const [variant] of VARIANTS) {
    describe(variant, () => {
      const env = () => environments.get(variant)!;
      const refresh = (key: string, body: unknown) => {
        if (!configurations.has(key)) {
          configurations.set(key, { issuer, interval });
          routes[`GET /${key}/api/model-prices`] = call => typeof reply === "function" ? reply(call) : reply;
        }
        return callObject<number | null>(env().baseUrl(), "ModelPrices", key, "refresh", body);
      };
      const current = (key: string) => callObject<ModelPricesCurrent>(env().baseUrl(), "ModelPrices", key, "current", null);
      const invocations = (key: string) => queryInvocations(env().adminAPIBaseUrl(), `target_service_name = 'ModelPrices' AND target_service_key = '${key}'`);

      for (const configuration of [undefined, "http://auth.example", "https://user:password@auth.example", "https://"]) {
        it(`does no work for configuration ${String(configuration)}`, async () => {
          issuer = configuration;
          const key = randomUUID();
          await refresh(key, { reason: "boot" });
          expect(await current(key)).toEqual({ prices: [], fetchedAt: null, lastError: "not-configured" });
          expect(callsFor(key).length).toBe(0);
          expect((await invocations(key)).some(row => row.status === "scheduled")).toBe(false);
        });
      }

      for (const [name, response, code] of [
        ["network", () => { throw new Error(SENTINEL); }, "network"],
        ["HTTP", recordedReply("unavailable"), "http"],
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

      it("replays producer success, unavailability, recovery, and empty prices", async () => {
        issuer = "https://auth.example";
        const key = randomUUID();
        reply = recordedReply("several-models");
        await refresh(key, { reason: "requested" });
        const successful = await current(key);
        expect(successful).toEqual({
          prices: recordings["several-models"]!.response.body.prices,
          fetchedAt: expect.any(Number), lastError: null,
        });
        reply = recordedReply("unavailable");
        await refresh(key, { reason: "requested" });
        expect(await current(key)).toEqual({ ...successful, lastError: "http" });
        reply = recordedReply("several-models");
        await refresh(key, { reason: "requested" });
        expect(await current(key)).toEqual({ ...successful, fetchedAt: expect.any(Number) });
        reply = recordedReply("empty");
        await refresh(key, { reason: "requested" });
        expect(await current(key)).toEqual({ prices: [], fetchedAt: expect.any(Number), lastError: null });
        expect(callsFor(key)).toHaveLength(4);
      });

      it("delivers a delayed refresh after a failed read", async () => {
        issuer = "https://auth.example";
        interval = 100;
        const key = randomUUID();
        try {
          await refresh(key, { reason: "boot" });
          await eventually(() => callsFor(key).length, count => count >= 2, {
            label: "durable model price retry delivery", timeoutMs: 10_000,
          });
        } finally {
          configurations.get(key)!.issuer = undefined;
          await eventually(async () => {
            const live = (await invocations(key)).filter(row => row.status !== "completed" && row.status !== "cancelled");
            for (const row of live) await cancelInvocation(env().adminAPIBaseUrl(), String(row.id));
            return live;
          }, rows => rows.length === 0, {
            label: `ModelPrices invocations of ${key} did not settle`, timeoutMs: 10_000,
          });
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
        expect(callsFor(key).length).toBe(1);
        const requestUrl = callsFor(key)[0]!.url.toString();
        const options = requestOptions.get(requestUrl);
        expect(options?.credentials).toBe("omit");
        expect(options?.redirect).toBe("error");
        expect(options?.headers).toBeUndefined();
        expect(requestUrl).toBe(`https://auth.example/${key}/api/model-prices`);
        expect(await refresh(key, { reason: "boot" })).toBe(firstTimer);
        expect(callsFor(key).length).toBe(1);
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
        expect(callsFor(key).length).toBe(1);
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
        expect(callsFor(key).length).toBe(2);
        expect(secondTimer).not.toBe(firstTimer);
        await refresh(key, { reason: "scheduled", scheduledFor: firstTimer });
        expect(callsFor(key).length).toBe(2);
        expect(await current(key)).toEqual({ prices: [], fetchedAt: null, lastError: "network" });
      });
    });
  }
});
