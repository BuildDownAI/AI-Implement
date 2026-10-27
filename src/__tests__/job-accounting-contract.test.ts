// The recorded exchanges of `list_job_accounting` (AII-1566): each docs/contracts/list_job_accounting/<scenario>.json
// holds one `{ request, status, response }` made through the real route as the control-plane `service` caller:
// the request body, the HTTP status, and the exact response body the route returns (the MCP envelope included). The control
// plane copies these files, so a change to the response must change them on purpose:
// regenerate with UPDATE_CONTRACT_FIXTURES=1 npx vitest run src/__tests__/job-accounting-contract.test.ts
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type * as restate from "@restatedev/restate-sdk";
import type * as AdminModule from "../admin.js";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import type * as ToolsModule from "../restate/tools.js";
import { callTool } from "../restate/tools-client.js";
import { JOB_ACCOUNTING_MAX_PAGE_SIZE, JobAccountingArgsSchema } from "../job-accounting.js";
import { z } from "zod";
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

interface Exchange {
  request: { args: Record<string, unknown> };
  status: number;
  response: { content: Array<{ type: string; text: string }>; isError?: boolean };
}

/**
 * The Restate ingress in front of the handler: it checks the wire input with the handler's zod serde and answers a
 * rejection 400 `{ code, message, source }`, which `callTool` turns into an `isError` result. Anything it accepts
 * reaches the real handler. The 400 body is built here, but job-accounting-tool.restate.test.ts (`npm run test:restate`)
 * sends the same rejected argument to the real restate-server and asserts its body equals invalid-args.json. The
 * message embeds zod's error text, so a zod upgrade can change it: both tests then fail and the fixture is regenerated.
 */
function ingress(handlerName: string, caller: Parameters<typeof tools.listJobAccountingTool>[1]["caller"]): typeof fetch {
  return (async (_url: unknown, init?: { body?: string }) => {
    const wire = z.object({ caller: z.unknown(), args: JobAccountingArgsSchema }).safeParse(JSON.parse(init?.body ?? "{}"));
    if (!wire.success) {
      const body = { code: 400, message: `Failed to deserialize input: ${wire.error.message}`, source: "invocation" };
      return new Response(JSON.stringify(body), { status: 400 });
    }
    const res = await tools.listJobAccountingTool(fakeContext(handlerName), { caller, args: wire.data.args });
    return new Response(JSON.stringify(res), { status: 200 });
  }) as typeof fetch;
}

/** `POST /api/tools/list_job_accounting` as the control plane, through the real route, `callTool` and the real tool handler. */
async function exchange(body: { args: Record<string, unknown> }): Promise<Exchange> {
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
      return callTool(name, args, caller, {
        restateReady: () => true,
        permitsExternalCall: () => true,
        ingressBaseUrl: "http://restate.test",
        fetchImpl: ingress(name, caller),
      });
    },
  };
  const req = new MockRequest("/api/tools/list_job_accounting", "POST", { authorization: `Bearer ${token}` }, JSON.stringify(body));
  const res = new MockResponse();
  const config = { adminAccessCode: null, flySessionsToken: null, flySessionsApp: null, flySessionsRegion: null, githubAppId: "a", githubAppPrivateKey: "k" };
  const registry = { forMapping: async () => null, forAllMappings: async () => [], invalidate: () => {} };
  admin.handleAdminRequest(req as never, res as never, config as never, registry as never, deps);
  await res.done;
  return { request: body, status: res.statusCode, response: JSON.parse(res.body) };
}

/** The page inside a successful exchange; the body is compact JSON, so re-serialising the parse gives the text back. */
function pageOf(recorded: Exchange): any {
  expect(recorded.status).toBe(200);
  expect(recorded.response.isError).toBeFalsy();
  const text = recorded.response.content[0].text;
  const page = JSON.parse(text);
  expect(text).toBe(JSON.stringify(page));
  return page;
}

function check(scenario: string, recorded: Exchange): void {
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

afterEach(() => {
  vi.useRealTimers();
});

describe("recorded list_job_accounting exchanges", () => {
  it("first-page", async () => {
    seedThree();
    const recorded = await exchange({ args: { pageSize: 2 } });
    expect(pageOf(recorded).nextCursor).not.toBeNull();
    check("first-page", recorded);
  });

  it("next-page", async () => {
    seedThree();
    const recorded = await exchange({ args: { cursor: { changedAt: T + 1000, dispatchId: "job-a" }, pageSize: 1 } });
    expect(pageOf(recorded).nextCursor).not.toBeNull();
    check("next-page", recorded);
  });

  it("short-page", async () => {
    seedThree();
    const recorded = await exchange({ args: { cursor: { changedAt: T + 1000, dispatchId: "job-a" }, pageSize: 5 } });
    expect(pageOf(recorded).nextCursor).toBeNull();
    check("short-page", recorded);
  });

  it("empty", async () => {
    const recorded = await exchange({ args: {} });
    expect(pageOf(recorded).records).toEqual([]);
    check("empty", recorded);
  });

  it("changed-again", async () => {
    seedThree();
    // job-a was served before the cursor below; a late review conclusion then rewrote it.
    dedup.getDb().prepare("UPDATE dispatch_log SET conclusion = 'approved_late' WHERE dispatch_id = 'job-a'").run();
    pin("job-a", T + 9000);
    const recorded = await exchange({ args: { cursor: { changedAt: T + 3000, dispatchId: "job-c" }, pageSize: 5 } });
    const records = pageOf(recorded).records as Array<{ dispatchId: string; changedAt: number }>;
    expect(records.map((r) => [r.dispatchId, r.changedAt])).toEqual([["job-a", T + 9000]]);
    check("changed-again", recorded);
  });

  it("partial-usage", async () => {
    seed({ id: "job-whole", at: T + 1000, invocations: 2, complete: true, shas: [SHA_1] });
    seed({ id: "job-legacy", at: T + 2000, invocations: 1 });
    seed({ id: "job-none", at: T + 3000 });
    const recorded = await exchange({ args: { pageSize: 5 } });
    const usage = (pageOf(recorded).records as Array<{ usage: string }>).map((r) => r.usage);
    expect(usage).toEqual(["reported", "partial", "unknown"]);
    check("partial-usage", recorded);
  });

  it("pruned", async () => {
    seedThree();
    dedup.getDb().prepare("DELETE FROM dispatch_log WHERE dispatch_id = 'job-b'").run();
    const recorded = await exchange({ args: { pageSize: 5 } });
    expect(pageOf(recorded).prunedThrough).toEqual({ changedAt: T + 2000, dispatchId: "job-b" });
    check("pruned", recorded);
  });

  it("final-pull", async () => {
    // The clock is pinned a minute after job-fresh finished; job-old settled long before.
    const now = T + 10_000_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    seed({ id: "job-old", at: T + 1000, invocations: 1, complete: true, shas: [SHA_1] });
    seed({ id: "job-fresh", at: now - 60_000, invocations: 1, complete: true, shas: [SHA_2] });
    expect(pageOf(await exchange({ args: {} })).records.map((r: { dispatchId: string }) => r.dispatchId)).toEqual(["job-old"]);
    const recorded = await exchange({ args: { includeUnsettled: true } });
    expect(pageOf(recorded).records.map((r: { dispatchId: string }) => r.dispatchId)).toEqual(["job-old", "job-fresh"]);
    check("final-pull", recorded);
  });

  it("invalid-args", async () => {
    const recorded = await exchange({ args: { includeUnsettled: "yes" } });
    expect(recorded.response.isError).toBe(true);
    expect(recorded.response.content[0].text).toContain("400");
    check("invalid-args", recorded);
  });
});

describe("list_job_accounting args.schema.json", () => {
  const schemaFile = new URL("args.schema.json", DIR);
  const schemaText = `${JSON.stringify(z.toJSONSchema(JobAccountingArgsSchema), null, 2)}\n`;
  const hint = "Regenerate with UPDATE_CONTRACT_FIXTURES=1 npx vitest run src/__tests__/job-accounting-contract.test.ts, and tell the control plane: it copies this file.";

  /** The subset of JSON Schema that args.schema.json uses; no validator library is a dependency. */
  function validate(schema: any, value: unknown, root: any = schema): boolean {
    if (schema.$ref) return validate(root, value, root);
    switch (schema.type) {
      case "object": {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
        const v = value as Record<string, unknown>;
        if ((schema.required ?? []).some((k: string) => !(k in v))) return false;
        if (schema.additionalProperties === false && Object.keys(v).some((k) => !(k in (schema.properties ?? {})))) return false;
        return Object.entries(schema.properties ?? {}).every(([k, sub]) => !(k in v) || validate(sub, v[k], root));
      }
      case "string":
        return typeof value === "string" && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity);
      case "integer":
      case "number":
        return typeof value === "number" && Number.isFinite(value) && (schema.type !== "integer" || Number.isInteger(value))
          && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
      case "boolean":
        return typeof value === "boolean";
      default:
        throw new Error(`args.schema.json uses an unsupported schema: ${JSON.stringify(schema)}`);
    }
  }

  const load = () => JSON.parse(readFileSync(schemaFile, "utf8"));

  it("matches the schema in code", () => {
    if (process.env.UPDATE_CONTRACT_FIXTURES === "1") {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(schemaFile, schemaText);
      return;
    }
    if (!existsSync(schemaFile)) throw new Error(`docs/contracts/list_job_accounting/args.schema.json is missing. ${hint}`);
    if (readFileSync(schemaFile, "utf8") !== schemaText) throw new Error(`args.schema.json differs from JobAccountingArgsSchema. ${hint}\nActual:\n${schemaText}`);
  });

  it("rejects what the tool rejects", () => {
    const schema = load();
    const ok = { cursor: { changedAt: 1, dispatchId: "a" } };
    expect(validate(schema, ok)).toBe(true);
    for (const bad of [
      { cursor: { changedAt: 1, dispatchId: "" } },
      { cursor: { changedAt: 1, dispatchId: "x".repeat(201) } },
      { cursor: { changedAt: 1.5, dispatchId: "a" } },
      { cursor: { dispatchId: "a" } },
      { pageSize: 0 },
      { pageSize: JOB_ACCOUNTING_MAX_PAGE_SIZE + 1 },
      { includeUnsettled: "yes" },
    ]) {
      expect(validate(schema, bad), JSON.stringify(bad)).toBe(false);
      expect(JobAccountingArgsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("accepts the request.args of every valid recorded exchange and rejects the invalid-args one", () => {
    const schema = load();
    const scenarios = ["first-page", "next-page", "short-page", "empty", "changed-again", "partial-usage", "pruned", "final-pull", "invalid-args"];
    for (const scenario of scenarios) {
      const args = JSON.parse(readFileSync(new URL(`${scenario}.json`, DIR), "utf8")).request.args;
      expect(validate(schema, args), scenario).toBe(scenario !== "invalid-args");
    }
  });
});
