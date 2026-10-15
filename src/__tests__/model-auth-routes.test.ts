/**
 * Behavioral tests for `src/model-auth-routes.ts` (AII-1387) on a real `http.Server` and a temp SQLite
 * file. Synthetic credentials only. `npm run typecheck` excludes `src/__tests__`, so type-check this file
 * explicitly with a throwaway tsconfig.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type * as DedupModule from "../dedup.js";
import type * as RoutesModule from "../model-auth-routes.js";
import type { ModelAuthRuntime } from "../model-auth-runtime.js";

const BEARER = "SYNTH_BEARER_" + "b".repeat(40);
const ACCESS_TOKEN = "SYNTH-CHATGPT-ACCESS-TOKEN";
const REFRESH_TOKEN = "SYNTH-CHATGPT-REFRESH-TOKEN";
const ID_TOKEN = "SYNTH-CHATGPT-ID-TOKEN";
const KEY = crypto.createHash("sha256").update("synthetic-routes-key").digest();
const NOW = 1_000_000;
const BINDING = { stage: "implementation", profileId: "cdx1", profileRevision: 4, authMode: "codex-subscription" };

let dbPath: string;
let dedup: typeof DedupModule;
let routesMod: typeof RoutesModule;
let runtime: ModelAuthRuntime;
let refreshSpy: Mock<(id: string) => Promise<void>>;
let server: http.Server | undefined;
let output: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

const hash = (b: string) => crypto.createHash("sha256").update(b, "utf8").digest("hex");

function seedDispatch(opts: { scope?: string; expiresAt?: number; revokedAt?: number | null; released?: boolean } = {}) {
  const db = dedup.getDb();
  const profile = { id: "cdx1", identity: "id", revision: 4, agent: "codex", provider: "openai", authMode: "codex-subscription" };
  const stage = { agent: "codex", provider: "openai", model: "m", accountProfileId: "cdx1", invocationTimeoutMs: 1000 };
  const src = { agent: "project", provider: "project", model: "project", accountProfileId: "project", invocationTimeoutMs: "project" };
  const stages = { planning: stage, implementation: stage, review: stage };
  const profiles = { planning: profile, implementation: profile, review: profile };
  const sources = { planning: src, implementation: src, review: src };
  db.prepare(
    `INSERT INTO run_agent_config_snapshots (snapshot_id, dispatch_id, project_key, resolved_config_json, source_map_json, config_revision_ids_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "s1", "d1", "proj", JSON.stringify({ stages, profiles }), JSON.stringify(sources),
    JSON.stringify({ orchestratorDefault: { configRevisionId: "r1", revision: 1 }, project: { configRevisionId: "r2", revision: 1 } }),
    NOW,
  );
  db.prepare(
    `INSERT INTO dispatch_admissions (dispatch_id, mapping_key, issue_scope, issue_id, lifecycle_owner, phase, backend, created_at, released_at, release_reason, generation)
     VALUES ('d1', 'm', 'issue', 'i1', 'legacy', 'implementation', 'fly-machines', ?, ?, ?, 0)`,
  ).run(NOW, opts.released ? NOW : null, opts.released ? "done" : null);
  db.prepare(
    `INSERT INTO model_credential_grants (grant_id, dispatch_id, snapshot_id, project_key, backend, audience, bearer_hash, scope_json, expires_at, revoked_at)
     VALUES ('g1', 'd1', 's1', 'proj', 'fly', 'model-auth', ?, ?, ?, ?)`,
  ).run(hash(BEARER), opts.scope ?? JSON.stringify([BINDING]), opts.expiresAt ?? NOW + 600_000, opts.revokedAt ?? null);
}

function seedPlan(expiresAt: number) {
  const r = runtime.sessionStore.writePlanRecord({
    profileId: "cdx1",
    expectedSequence: null,
    sessionData: JSON.stringify({
      version: 1, email: "user@example.com", issuer: "https://auth.openai.com", subject: "sub-1", clientId: "client-1",
      extAgentHostId: "host-1", idToken: ID_TOKEN, accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN,
      tokenType: "Bearer", scopes: ["chatgpt.tokens.use.direct"], accessTokenExpiresAt: expiresAt, earliestRefreshAt: null,
      savedAt: NOW - 1000,
    }),
  });
  expect(r.ok).toBe(true);
}

async function start(onFly: boolean): Promise<string> {
  const routes = routesMod.createModelAuthRoutes({ runtime, onFly, requestPlanRefresh: (id) => refreshSpy(id), now: () => NOW });
  server = http.createServer((req, res) => {
    const p = (req.url ?? "/").split("?")[0]!;
    if (routes.matches(p)) {
      void routes.handle(req, res);
      return;
    }
    res.writeHead(404);
    res.end("other");
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const call = (base: string, route: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  fetch(`${base}/runner/model-auth/${route}`, {
    method: init.method ?? "POST",
    headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json", ...init.headers },
    body: init.method === "GET" ? undefined : JSON.stringify(init.body ?? { version: 1, profileId: "cdx1" }),
  });

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `model-auth-routes-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  vi.resetModules();
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  dedup.getDb();
  const own = await import("../model-session-ownership.js");
  const storeMod = await import("../model-session-store.js");
  routesMod = await import("../model-auth-routes.js");
  const sessionStore = storeMod.createModelSessionStore({
    keys: { current: () => ({ keyId: "k1", key: KEY }), get: (id) => (id === "k1" ? KEY : undefined) },
    verifyOwner: own.sessionOwnerVerifier,
    authorizeOperator: () => false,
    db: () => dedup.getDb(),
  });
  runtime = {
    sessionStore,
    ownership: own.createModelSessionOwnership({ store: sessionStore, probe: () => "unknown", now: () => NOW }),
    credentials: {
      sessionStore,
      resolveProtectedSecret: () => null,
      getProfileRevision: (id, revision) => ({
        profileId: id, identity: "id", revision, agent: "codex", provider: "openai", authMode: "codex-subscription",
        allowedProjectKeys: ["proj"], status: "active",
      }),
      lookupReference: () => "model-account:cdx1",
    },
    preparationDeps: () => {
      throw new Error("unused");
    },
  } as ModelAuthRuntime;
  refreshSpy = vi.fn(async (_id: string) => undefined);
  output = "";
  logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void (output += a.join(" ") + "\n"));
  errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void (output += a.join(" ") + "\n"));
});

afterEach(async () => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  dedup.closeDb();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
});

function noLeak() {
  for (const s of [BEARER, ACCESS_TOKEN, REFRESH_TOKEN, ID_TOKEN]) expect(output).not.toContain(s);
}

describe("model-auth routes over HTTP", () => {
  it("matches only the three routes", async () => {
    await start(false);
    const r = routesMod.createModelAuthRoutes({ runtime, onFly: false, requestPlanRefresh: async () => undefined });
    expect(r.matches("/runner/model-auth/checkout")).toBe(true);
    expect(r.matches("/runner/model-auth/checkpoint")).toBe(true);
    expect(r.matches("/runner/model-auth/finish")).toBe(true);
    expect(r.matches("/runner/model-auth/other")).toBe(false);
    expect(r.matches("/runner/cycle-summary")).toBe(false);
  });

  it("falls through for an unknown runner path", async () => {
    const base = await start(false);
    const res = await fetch(`${base}/runner/model-auth/unknown`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("other");
  });

  it("answers 405 for GET, not 404", async () => {
    seedDispatch();
    const base = await start(false);
    const res = await call(base, "checkout", { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("answers 403 on Fly without x-forwarded-proto https", async () => {
    seedDispatch();
    seedPlan(NOW + 600_000);
    const base = await start(true);
    const res = await call(base, "checkout");
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(ACCESS_TOKEN);
    const ok = await call(base, "checkout", { headers: { "x-forwarded-proto": "https" } });
    expect(ok.status).toBe(200);
  });

  it("serves a ChatGPT access token with no-store and one log line", async () => {
    seedDispatch();
    seedPlan(NOW + 600_000);
    const base = await start(false);
    const res = await call(base, "checkout");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain(ACCESS_TOKEN);
    expect(refreshSpy).not.toHaveBeenCalled();
    const lines = output.split("\n").filter((l) => l.startsWith("[model-auth]"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("cdx1");
    noLeak();
  });

  it.each([
    ["revoked", { revokedAt: NOW - 1 }],
    ["expired", { expiresAt: NOW - 1 }],
    ["released admission", { released: true }],
    ["unparseable scope_json", { scope: "{not json" }],
  ])("refuses a %s grant", async (_name, opts) => {
    seedDispatch(opts);
    seedPlan(NOW + 600_000);
    const base = await start(false);
    const res = await call(base, "checkout");
    expect(res.status).not.toBe(200);
    const text = await res.text();
    expect(text).toContain('"ok":false');
    expect(text).not.toContain(ACCESS_TOKEN);
    noLeak();
  });

  it("requests a plan refresh once for a near-expiry token", async () => {
    seedDispatch();
    seedPlan(NOW + 30_000);
    const base = await start(false);
    const res = await call(base, "checkout");
    expect(res.status).not.toBe(200);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith("cdx1");
    noLeak();
  });

  it("refuses an unknown bearer and logs nothing secret", async () => {
    seedDispatch();
    const base = await start(false);
    const other = "OTHER_BEARER_" + "c".repeat(40);
    const res = await call(base, "checkout", { headers: { authorization: `Bearer ${other}` } });
    expect(res.status).toBe(401);
    expect(output).not.toContain(other);
    noLeak();
  });
});
