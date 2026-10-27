// The recorded exchanges of `list_job_accounting` (AII-1566): each docs/contracts/list_job_accounting/<scenario>.json
// holds one `{ request, response }` made through the real route as the control-plane `service` caller. The control
// plane copies these files, so a change to the response must change them on purpose:
// regenerate with UPDATE_CONTRACT_FIXTURES=1 npx vitest run src/__tests__/job-accounting-contract.test.ts
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type * as restate from "@restatedev/restate-sdk";
import type * as AdminModule from "../admin.js";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import type * as ToolsModule from "../restate/tools.js";
import { fakeFetch } from "./helpers/fake-fetch.js";
import { testDb } from "./helpers/test-db.js";

const ISSUER = "https://cp.builddown.test";
const BASE_URL = "https://orch-a.example.com";
const DIR = new URL("../../docs/contracts/list_job_accounting/", import.meta.url);
const T = 1_700_000_000_000; // every stored time is an offset from here; all are long settled
const SHA_1 = "1".repeat(40);
const SHA_2 = "2".repeat(40);

let admin: typeof AdminModule;
let dedup: typeof DedupModule;
let log: typeof LogModule;
let tools: typeof ToolsModule;
let signingKey: CryptoKey;

class MockRequest extends EventEmitter {
  constructor(public url: string, public method: string, public headers: Record<string, string>, body: string) {
    super();
    const release = (event: string | symbol): void => {
      if (event !== "data" && event !== "end") return;
      this.off("newListener", release);
      process.nextTick(() => {
        this.emit("data", Buffer.from(body));
        this.emit("end");
      });
    };
    this.on("newListener", release);
  }
}

class MockResponse {
  statusCode = 200;
  body = "";
  private resolver!: () => void;
  done = new Promise<void>((resolve) => { this.resolver = resolve; });
  writeHead(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }
  end(chunk?: string): void {
    this.body = chunk ?? "";
    this.resolver();
  }
}

function fakeContext(handlerName: string): restate.Context {
  return {
    request: () => ({ target: { handler: handlerName } }),
    run: async (name: unknown, action?: unknown) => (typeof name === "function" ? (name as () => unknown) : (action as () => unknown))(),
  } as unknown as restate.Context;
}

beforeEach(async () => {
  ({ admin, dedup, log, tools } = (await testDb({
    modules: {
      admin: () => import("../admin.js"),
      dedup: () => import("../dedup.js"),
      log: () => import("../log.js"),
      tools: () => import("../restate/tools.js"),
    },
  })).modules);
  const cp = await import("../control-plane-token.js");
  cp.resetControlPlaneTokenCache();
  const pair = await generateKeyPair("ES256");
  signingKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  fakeFetch({
    "GET /.well-known/openid-configuration": { json: { jwks_uri: `${ISSUER}/jwks` } },
    "GET /jwks": { json: { keys: [jwk] } },
  }).install();
  vi.stubEnv("BUILDDOWN_OIDC_ISSUER", ISSUER);
  vi.stubEnv("OAUTH_REDIRECT_BASE_URL", BASE_URL);
});

/** `POST /api/tools/list_job_accounting` as the control plane, through the real route and the real tool handler. */
async function exchange(body: { args: Record<string, unknown> }): Promise<{ request: unknown; response: unknown }> {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ scope: "orchestrator:read" })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(BASE_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(signingKey);
  const deps: AdminModule.AdminDeps = {
    callTool: async (name, args, caller) => {
      expect(caller).toEqual({ kind: "service", email: null, role: "user" });
      const res = await tools.listJobAccountingTool(fakeContext(name), { caller, args });
      return { status: "ok" as const, content: res.content, isError: res.isError };
    },
  };
  const req = new MockRequest("/api/tools/list_job_accounting", "POST", { authorization: `Bearer ${token}` }, JSON.stringify(body));
  const res = new MockResponse();
  const config = { adminAccessCode: null, flySessionsToken: null, flySessionsApp: null, flySessionsRegion: null, githubAppId: "a", githubAppPrivateKey: "k" };
  const registry = { forMapping: async () => null, forAllMappings: async () => [], invalidate: () => {} };
  admin.handleAdminRequest(req as never, res as never, config as never, registry as never, deps);
  await res.done;
  expect(res.statusCode).toBe(200);
  const payload = JSON.parse(res.body) as { content: Array<{ text: string }>; isError?: boolean };
  expect(payload.isError).toBeFalsy();
  return { request: body, response: JSON.parse(payload.content[0].text) };
}

function check(scenario: string, recorded: { request: unknown; response: unknown }): void {
  const file = new URL(`${scenario}.json`, DIR);
  const text = `${JSON.stringify(recorded, null, 2)}\n`;
  if (process.env.UPDATE_CONTRACT_FIXTURES === "1") {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, text);
    return;
  }
  const hint = `Regenerate with UPDATE_CONTRACT_FIXTURES=1 npx vitest run src/__tests__/job-accounting-contract.test.ts, and tell the control plane: it copies these files.`;
  if (!existsSync(file)) throw new Error(`Recorded exchange docs/contracts/list_job_accounting/${scenario}.json is missing. ${hint}`);
  if (readFileSync(file, "utf8") !== text) {
    throw new Error(`The list_job_accounting response for "${scenario}" differs from docs/contracts/list_job_accounting/${scenario}.json. ${hint}\nActual:\n${text}`);
  }
}

interface JobSeed {
  id: string;
  at: number;
  invocations?: number;
  complete?: boolean;
  shas?: string[];
}

/** A finished implementation job with pinned times; `changed_at` is pinned last because the triggers stamp the wall clock. */
function seed(job: JobSeed): void {
  const db = dedup.getDb();
  const rowId = log.appendLog({ issueId: `issue-${job.id}`, dispatchId: job.id, executionMode: "fly-machines" });
  db.prepare(
    `UPDATE dispatch_log SET dispatched_at = ?, status = 'completed', conclusion = 'success', completed_at = ?, issue_identifier = ?,
       issue_title = ?, repo = 'acme/widgets', pr_url = ?, tracker_kind = 'linear', issue_url = ?, compute_started_at = ?, compute_stopped_at = ?
     WHERE id = ?`,
  ).run(
    job.at - 600_000, job.at, `AII-${job.id}`, `Job ${job.id}`, `https://github.com/acme/widgets/pull/${job.id.length}`,
    `https://linear.app/acme/issue/AII-${job.id}`, job.at - 500_000, job.at - 1000, rowId,
  );
  for (let i = 0; i < (job.invocations ?? 0); i++) {
    db.prepare(
      `INSERT INTO model_invocation_attribution (invocation_id, dispatch_id, stage, profile_id, profile_revision, agent, provider, model,
         auth_mode, status, started_at, completed_at, usage_json)
       VALUES (?, ?, ?, 'p', 1, 'claude', 'anthropic', 'claude-model', 'api_key', 'succeeded', ?, ?, ?)`,
    ).run(
      `${job.id}-inv-${i}`, job.id, i === 0 ? "implementation" : "review", job.at - 400_000, job.at - 300_000,
      JSON.stringify({ tokensIn: 1000 * (i + 1), tokensOut: 100 * (i + 1), costUsd: 0.25 * (i + 1), costStatus: "reported", attempts: 1 }),
    );
  }
  if (job.shas) log.recordPushedCommits(job.id, job.shas, job.at);
  if (job.complete) log.recordInvocationsComplete(job.id, job.at);
  pin(job.id, job.at);
}

function pin(id: string, changedAt: number): void {
  dedup.getDb().prepare("UPDATE dispatch_log SET changed_at = ? WHERE dispatch_id = ?").run(changedAt, id);
}

function seedThree(): void {
  seed({ id: "job-a", at: T + 1000, invocations: 2, complete: true, shas: [SHA_1] });
  seed({ id: "job-b", at: T + 2000, invocations: 1, complete: true, shas: [] });
  seed({ id: "job-c", at: T + 3000, invocations: 1, complete: true, shas: [SHA_2] });
}

describe("recorded list_job_accounting exchanges", () => {
  it("first-page", async () => {
    seedThree();
    const recorded = await exchange({ args: { pageSize: 2 } });
    expect((recorded.response as { nextCursor: unknown }).nextCursor).not.toBeNull();
    check("first-page", recorded);
  });

  it("next-page", async () => {
    seedThree();
    const recorded = await exchange({ args: { cursor: { changedAt: T + 1000, dispatchId: "job-a" }, pageSize: 1 } });
    expect((recorded.response as { nextCursor: unknown }).nextCursor).not.toBeNull();
    check("next-page", recorded);
  });

  it("short-page", async () => {
    seedThree();
    const recorded = await exchange({ args: { cursor: { changedAt: T + 1000, dispatchId: "job-a" }, pageSize: 5 } });
    expect((recorded.response as { nextCursor: unknown }).nextCursor).toBeNull();
    check("short-page", recorded);
  });

  it("empty", async () => {
    const recorded = await exchange({ args: {} });
    expect((recorded.response as { records: unknown[] }).records).toEqual([]);
    check("empty", recorded);
  });

  it("changed-again", async () => {
    seedThree();
    // job-a was served before the cursor below; a late review conclusion then rewrote it.
    dedup.getDb().prepare("UPDATE dispatch_log SET conclusion = 'approved_late' WHERE dispatch_id = 'job-a'").run();
    pin("job-a", T + 9000);
    const recorded = await exchange({ args: { cursor: { changedAt: T + 3000, dispatchId: "job-c" }, pageSize: 5 } });
    const records = (recorded.response as { records: Array<{ dispatchId: string; changedAt: number }> }).records;
    expect(records.map((r) => [r.dispatchId, r.changedAt])).toEqual([["job-a", T + 9000]]);
    check("changed-again", recorded);
  });

  it("partial-usage", async () => {
    seed({ id: "job-whole", at: T + 1000, invocations: 2, complete: true, shas: [SHA_1] });
    seed({ id: "job-legacy", at: T + 2000, invocations: 1 });
    seed({ id: "job-none", at: T + 3000 });
    const recorded = await exchange({ args: { pageSize: 5 } });
    const usage = (recorded.response as { records: Array<{ usage: string }> }).records.map((r) => r.usage);
    expect(usage).toEqual(["reported", "partial", "unknown"]);
    check("partial-usage", recorded);
  });

  it("pruned", async () => {
    seedThree();
    dedup.getDb().prepare("DELETE FROM dispatch_log WHERE dispatch_id = 'job-b'").run();
    const recorded = await exchange({ args: { pageSize: 5 } });
    expect((recorded.response as { prunedThrough: unknown }).prunedThrough).toEqual({ changedAt: T + 2000, dispatchId: "job-b" });
    check("pruned", recorded);
  });
});
