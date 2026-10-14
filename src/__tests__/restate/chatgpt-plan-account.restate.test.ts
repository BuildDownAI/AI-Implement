// Restate scenarios for the `ChatGptPlanAccount` object (AII-1200): one test per row of the issue's state table,
// the concurrent-refresh guarantee, and the "no token in the journal or state" check.
//
// Run with `npm run test:restate` (binary runtime, no Docker); excluded from `npm test`.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RestateEnvironment } from "./harness.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { serializeChatGptPlanRecord, parseChatGptPlanRecord, type ChatGptPlanRecordV1 } from "../../chatgpt-plan-token.js";
import type { ModelSessionStore, SessionReadResult, SessionWriteResult } from "../../model-session-store.js";
import { closeDb } from "../../dedup.js";
import { createModelSessionStore } from "../../model-session-store.js";
import { createModelSessionKeyProvider } from "../../model-session-keys.js";
import { createChatGptPlanAccount, type ChatGptPlanRefreshResult } from "../../restate/chatgpt-plan-account.js";
import { VARIANTS, callObject, eventually, journalEntries, journalText, queryInvocations, startVariants, stopAll } from "./harness.js";

const SENTINEL_ACCESS = "SENTINEL-ACCESS-TOKEN-xyz";
const SENTINEL_REFRESH = "SENTINEL-REFRESH-TOKEN-xyz";
const NEW_ACCESS = "SENTINEL-NEW-ACCESS-TOKEN-xyz";
const NEW_REFRESH = "SENTINEL-NEW-REFRESH-TOKEN-xyz";
const HOUR = 60 * 60_000;

function record(overrides: Partial<ChatGptPlanRecordV1> = {}): ChatGptPlanRecordV1 {
  const now = Date.now();
  return {
    version: 1,
    email: "ada@example.com",
    issuer: "https://auth.openai.com",
    subject: "sub-1",
    clientId: "app_client",
    extAgentHostId: "host-1",
    idToken: "id-token",
    accessToken: SENTINEL_ACCESS,
    refreshToken: SENTINEL_REFRESH,
    tokenType: "Bearer",
    scopes: ["chatgpt.tokens.use.direct"],
    accessTokenExpiresAt: now + 5 * 60_000, // inside the 10 minute window: refresh due
    earliestRefreshAt: null,
    savedAt: now,
    ...overrides,
  };
}

/** In-memory stand-in for the store's plan-record methods, with the same compare-and-set rule. */
function fakeStore() {
  const rows: Array<{ sequence: number; data: string }> = [];
  const hooks: { beforeWrite?: () => void } = {};
  const store = {
    readPlanRecord(): SessionReadResult {
      const last = rows[rows.length - 1];
      if (!last) return { ok: false, category: "recovery_required", reason: "no_state" };
      return { ok: true, profileId: "p", ownerGeneration: 1, stateSequence: last.sequence, sessionData: last.data };
    },
    writePlanRecord(input: { expectedSequence: number | null; sessionData: string }): SessionWriteResult {
      hooks.beforeWrite?.();
      const last = rows[rows.length - 1];
      if ((last?.sequence ?? null) !== input.expectedSequence) return { ok: false, category: "stale_owner", reason: "stale_sequence" };
      const sequence = input.expectedSequence === null ? 0 : input.expectedSequence + 1;
      rows.push({ sequence, data: input.sessionData });
      return { ok: true, profileId: "p", ownerGeneration: 1, stateSequence: sequence, idempotent: false };
    },
  } as unknown as ModelSessionStore;
  return { store, rows, hooks, put: (r: ChatGptPlanRecordV1) => rows.push({ sequence: rows.length, data: serializeChatGptPlanRecord(r) }) };
}

type FetchPlan = { status: number; body: unknown } | "throw";
function fakeFetch(plan: FetchPlan, expiresInSec = 3600) {
  const calls: string[] = [];
  const impl = (async (_url: unknown, init?: RequestInit) => {
    calls.push(String((init?.body as URLSearchParams | undefined)?.get("refresh_token")));
    if (plan === "throw") throw new Error("network down");
    const body = plan.status === 200
      ? { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: expiresInSec, scope: "chatgpt.tokens.use.direct" }
      : plan.body;
    return new Response(JSON.stringify(body), { status: plan.status });
  }) as typeof fetch;
  return { calls, impl };
}

function latest(rows: Array<{ data: string }>): ChatGptPlanRecordV1 {
  const parsed = parseChatGptPlanRecord(JSON.parse(rows[rows.length - 1]!.data));
  if (!parsed.ok) throw new Error("stored record invalid");
  return parsed.value;
}

describe("ChatGptPlanAccount object", () => {
  let environments: Map<string, RestateEnvironment>;
  const fake = fakeStore();
  let current = { store: fake, fetch: fakeFetch({ status: 200, body: {} }) };

  beforeAll(async () => {
    // One object definition; each test swaps the store and fetch it closes over.
    const proxyStore = {
      readPlanRecord: (...a: unknown[]) => (current.store.store.readPlanRecord as (...x: unknown[]) => SessionReadResult)(...a),
      writePlanRecord: (...a: unknown[]) => (current.store.store.writePlanRecord as (...x: unknown[]) => SessionWriteResult)(...a),
    } as unknown as ModelSessionStore;
    const object = createChatGptPlanAccount({
      store: proxyStore,
      fetch: ((...a: Parameters<typeof fetch>) => current.fetch.impl(...a)) as typeof fetch,
      now: Date.now,
    });
    environments = await startVariants([object]);
  }, 60_000);

  afterAll(async () => {
    await stopAll(environments);
  });

  function setup(plan: FetchPlan, stored: ChatGptPlanRecordV1 | null, expiresInSec = 3600) {
    const store = fakeStore();
    if (stored) store.put(stored);
    const f = fakeFetch(plan, expiresInSec);
    current = { store, fetch: f };
    return { store, f };
  }

  const refreshCall = (env: RestateEnvironment, key: string) =>
    callObject<ChatGptPlanRefreshResult>(env.baseUrl(), "ChatGptPlanAccount", key, "refresh", { reason: "requested" });
  const invocations = (env: RestateEnvironment, key: string) =>
    queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'ChatGptPlanAccount' AND target_service_key = '${key}'`);

  for (const [label] of VARIANTS) {
    const env = () => {
      const e = environments.get(label);
      if (!e) throw new Error(`environment "${label}" did not start`);
      return e;
    };

    describe(label, () => {
      it("missing: no write, nothing scheduled", async () => {
        const { f, store } = setup({ status: 200, body: {} }, null);
        const key = randomUUID();
        const res = await refreshCall(env(), key);
        expect(res).toEqual({ outcome: "missing", nextAt: null });
        expect(f.calls).toHaveLength(0);
        expect(store.rows).toHaveLength(0);
        expect(await invocations(env(), key)).toHaveLength(1);
      });

      it("fresh: no fetch, no write, next refresh scheduled", async () => {
        const rec = record({ accessTokenExpiresAt: Date.now() + 2 * HOUR });
        const { f, store } = setup({ status: 200, body: {} }, rec);
        const key = randomUUID();
        const res = await refreshCall(env(), key);
        expect(res.outcome).toBe("fresh");
        expect(res.nextAt).toBe(rec.accessTokenExpiresAt - 10 * 60_000);
        expect(f.calls).toHaveLength(0);
        expect(store.rows).toHaveLength(1);
        await eventually(() => invocations(env(), key), (rows) => rows.length === 2 && rows.some((r) => r.status === "scheduled"), { label: "scheduled refresh" });
      });

      it("refreshed: new sequence stored, nextAt from the new record", async () => {
        const { f, store } = setup({ status: 200, body: {} }, record());
        const key = randomUUID();
        const res = await refreshCall(env(), key);
        expect(res.outcome).toBe("refreshed");
        expect(f.calls).toEqual([SENTINEL_REFRESH]);
        expect(store.rows.map((r) => r.sequence)).toEqual([0, 1]);
        const saved = latest(store.rows);
        expect(saved.refreshToken).toBe(NEW_REFRESH);
        expect(res.nextAt).toBe(saved.accessTokenExpiresAt - 10 * 60_000);
        await eventually(() => invocations(env(), key), (rows) => rows.some((r) => r.status === "scheduled"), { label: "scheduled refresh" });
      });

      it("CAS lost: no extra row, fresh, the other write's nextAt", async () => {
        const winner = record({ accessToken: "winner-access", refreshToken: "winner-refresh", accessTokenExpiresAt: Date.now() + 3 * HOUR });
        const { store } = setup({ status: 200, body: {} }, record());
        let injected = false;
        store.hooks.beforeWrite = () => {
          if (!injected) { injected = true; store.put(winner); }
        };
        const key = randomUUID();
        const res = await refreshCall(env(), key);
        expect(res).toEqual({ outcome: "fresh", nextAt: winner.accessTokenExpiresAt - 10 * 60_000 });
        expect(store.rows).toHaveLength(2);
        expect(latest(store.rows).refreshToken).toBe("winner-refresh");
      });

      it("transient: no write, retry in 2 minutes", async () => {
        const { store } = setup({ status: 503, body: {} }, record());
        const key = randomUUID();
        const before = Date.now();
        const res = await refreshCall(env(), key);
        expect(res.outcome).toBe("transient");
        expect(res.nextAt!).toBeGreaterThanOrEqual(before + 2 * 60_000);
        expect(res.nextAt!).toBeLessThanOrEqual(Date.now() + 2 * 60_000);
        expect(store.rows).toHaveLength(1);
        await eventually(() => invocations(env(), key), (rows) => rows.some((r) => r.status === "scheduled"), { label: "retry scheduled" });
      });

      it("a thrown fetch is transient", async () => {
        setup("throw", record());
        const res = await refreshCall(env(), randomUUID());
        expect(res.outcome).toBe("transient");
      });

      it("reauth_required: nothing written or scheduled", async () => {
        const { store } = setup({ status: 400, body: { error: "invalid_grant" } }, record());
        const key = randomUUID();
        const res = await refreshCall(env(), key);
        expect(res).toEqual({ outcome: "reauth_required", nextAt: null });
        expect(store.rows).toHaveLength(1);
        expect(await invocations(env(), key)).toHaveLength(1);
      });

      it("invalid_client: nothing written or scheduled", async () => {
        const { store } = setup({ status: 401, body: { error: "invalid_client" } }, record());
        const key = randomUUID();
        const res = await refreshCall(env(), key);
        expect(res).toEqual({ outcome: "invalid_client", nextAt: null });
        expect(store.rows).toHaveLength(1);
        expect(await invocations(env(), key)).toHaveLength(1);
      });

      it("floors nextAt at 60 seconds from now", async () => {
        // The new token expires in 30 s, so expiry - 10 min is already past.
        setup({ status: 200, body: {} }, record(), 30);
        const before = Date.now();
        const res = await refreshCall(env(), randomUUID());
        expect(res.outcome).toBe("refreshed");
        expect(res.nextAt!).toBeGreaterThanOrEqual(before + 60_000);
        expect(res.nextAt!).toBeLessThan(Date.now() + 61_000);
      });

      it("two concurrent refresh calls make one OpenAI call", async () => {
        const { f, store } = setup({ status: 200, body: {} }, record());
        const key = randomUUID();
        const [a, b] = await Promise.all([refreshCall(env(), key), refreshCall(env(), key)]);
        expect([a.outcome, b.outcome].sort()).toEqual(["fresh", "refreshed"]);
        expect(f.calls).toHaveLength(1);
        expect(store.rows).toHaveLength(2);
      });

      it("keeps every token out of the journal and the object state", async () => {
        setup({ status: 200, body: {} }, record());
        const key = randomUUID();
        await refreshCall(env(), key);
        const rows = await invocations(env(), key);
        const text = (await Promise.all(rows.map(async (r) => journalText(await journalEntries(env().adminAPIBaseUrl(), String(r.id)))))).join("\n");
        expect(text).toContain("refresh"); // the journal was read
        for (const s of [SENTINEL_ACCESS, SENTINEL_REFRESH, NEW_ACCESS, NEW_REFRESH]) expect(text).not.toContain(s);
        const response = await fetch(`${env().adminAPIBaseUrl()}/query`, { // restate-test-allow: the one state-table read
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ query: `SELECT * FROM state WHERE service_name = 'ChatGptPlanAccount' AND service_key = '${key}'` }),
        });
        expect(response.ok).toBe(true);
        const stateRows = ((await response.json()) as { rows: unknown[] }).rows;
        expect(stateRows.length).toBeGreaterThan(0);
        const stateText = JSON.stringify(stateRows);
        for (const s of [SENTINEL_ACCESS, SENTINEL_REFRESH, NEW_ACCESS, NEW_REFRESH]) expect(stateText).not.toContain(s);
      });
    });
  }
});

// AII-1355: the real store, keyed from RUNNER_TOKEN_SECRET, behind the same object.
describe("ChatGptPlanAccount with the hosted session key", () => {
  const SECRET = "SENTINEL-RUNNER-TOKEN-SECRET-xyz";
  const dbPath = path.join(os.tmpdir(), `chatgpt-plan-hosted-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const previousDb = process.env.DEDUP_DB_PATH;
  let environments: Map<string, RestateEnvironment>;
  let fetchCalls = 0;
  const logs: string[] = [];

  const store = createModelSessionStore({
    keys: createModelSessionKeyProvider(),
    verifyOwner: () => false,
    authorizeOperator: () => false,
  });

  beforeAll(async () => {
    process.env.DEDUP_DB_PATH = dbPath;
    for (const m of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    }
    const object = createChatGptPlanAccount({
      store,
      fetch: (async () => { fetchCalls += 1; throw new Error("unexpected network call"); }) as typeof fetch,
      now: Date.now,
    });
    environments = await startVariants([object]);
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await stopAll(environments);
    closeDb();
    if (previousDb === undefined) delete process.env.DEDUP_DB_PATH; else process.env.DEDUP_DB_PATH = previousDb;
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  });

  const refreshCall = (env: RestateEnvironment, key: string) =>
    callObject<ChatGptPlanRefreshResult>(env.baseUrl(), "ChatGptPlanAccount", key, "refresh", { reason: "requested" });
  const invocations = (env: RestateEnvironment, key: string) =>
    queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'ChatGptPlanAccount' AND target_service_key = '${key}'`);

  for (const [label] of VARIANTS) {
    const env = () => {
      const e = environments.get(label);
      if (!e) throw new Error(`environment "${label}" did not start`);
      return e;
    };

    describe(label, () => {
      it("round-trips a record, maps key_mismatch/key_unavailable/no_state, and leaks neither secret nor key", async () => {
        const derivedKey = (vi.stubEnv("RUNNER_TOKEN_SECRET", SECRET), createModelSessionKeyProvider().current()!.key);
        const rec = record({ accessTokenExpiresAt: Date.now() + 2 * HOUR });

        // set + none -> missing
        const profile = `hosted-${randomUUID()}`;
        expect(await refreshCall(env(), profile)).toEqual({ outcome: "missing", nextAt: null });

        // set + same secret -> fresh
        const written = store.writePlanRecord({ profileId: profile, expectedSequence: null, sessionData: serializeChatGptPlanRecord(rec) });
        expect(written.ok).toBe(true);
        const fresh = await refreshCall(env(), profile);
        expect(fresh.outcome).toBe("fresh");
        expect(fresh.nextAt).toBe(rec.accessTokenExpiresAt - 10 * 60_000);

        // set + different secret -> reauth_required, nothing scheduled
        vi.stubEnv("RUNNER_TOKEN_SECRET", `${SECRET}-rotated`);
        const res = await refreshCall(env(), profile);
        expect(res).toEqual({ outcome: "reauth_required", nextAt: null });

        // unset -> transient, retry in 2 minutes
        vi.stubEnv("RUNNER_TOKEN_SECRET", "");
        const before = Date.now();
        const unset = await refreshCall(env(), profile);
        expect(unset.outcome).toBe("transient");
        expect(unset.nextAt!).toBeGreaterThanOrEqual(before + 2 * 60_000);
        expect(fetchCalls).toBe(0);

        // nothing sensitive in logs, journal, or state
        const secrets = [SECRET, derivedKey.toString("hex"), derivedKey.toString("base64"), SENTINEL_ACCESS, SENTINEL_REFRESH];
        const rows = await invocations(env(), profile);
        const journal = (await Promise.all(rows.map(async (r) => journalText(await journalEntries(env().adminAPIBaseUrl(), String(r.id)))))).join("\n");
        const response = await fetch(`${env().adminAPIBaseUrl()}/query`, { // restate-test-allow: the one state-table read
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ query: `SELECT * FROM state WHERE service_name = 'ChatGptPlanAccount' AND service_key = '${profile}'` }),
        });
        const stateText = JSON.stringify(((await response.json()) as { rows: unknown[] }).rows);
        for (const text of [journal, stateText, logs.join("\n")]) {
          for (const s of secrets) expect(text).not.toContain(s);
        }
        vi.unstubAllEnvs();
      });
    });
  }
});
