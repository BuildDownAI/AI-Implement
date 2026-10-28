// The recorded exchanges of `list_job_accounting` (AII-1566): each docs/contracts/list_job_accounting/<scenario>.json
// holds one `{ request, status, response }` made through the real route as the control-plane `service` caller:
// the request body, the HTTP status, and the exact response body the route returns (the MCP envelope included). The control
// plane copies these files, so a change to the response must change them on purpose:
// regenerate with UPDATE_CONTRACT_FIXTURES=1 npx vitest run src/__tests__/job-accounting-contract.test.ts
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type * as restate from "@restatedev/restate-sdk";
import type * as AdminModule from "../admin.js";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import type * as AccountingModule from "../job-accounting.js";
import type * as ToolsModule from "../restate/tools.js";
import { callTool } from "../restate/tools-client.js";
import { JOB_ACCOUNTING_MAX_PAGE_SIZE, JobAccountingArgsSchema, JobAccountingCursorSchema, JobAccountingRecordSchema, RECORD_TEXT_MAX } from "../job-accounting.js";
import { z } from "zod";
import { fakeFetch } from "./helpers/fake-fetch.js";
import { testDb } from "./helpers/test-db.js";
import { seedBoundary } from "./helpers/job-accounting-boundary.js";

const ISSUER = "https://cp.builddown.test";
const BASE_URL = "https://orch-a.example.com";
const DIR = new URL("../../docs/contracts/list_job_accounting/", import.meta.url);
const T = 1_700_000_000_000; // every stored time is an offset from here; all are long settled
const SHA_1 = "1".repeat(40);
const SHA_2 = "2".repeat(40);

/** The readable name of a seeded job, and the UUID-shaped dispatch id stored for it (the only shape the tool serves). */
function jid(name: string): string {
  const h = createHash("sha1").update(name).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

let admin: typeof AdminModule;
let dedup: typeof DedupModule;
let log: typeof LogModule;
let tools: typeof ToolsModule;
let acc: typeof AccountingModule;
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
  ({ admin, dedup, log, tools, acc } = (await testDb({
    modules: {
      admin: () => import("../admin.js"),
      dedup: () => import("../dedup.js"),
      log: () => import("../log.js"),
      tools: () => import("../restate/tools.js"),
      acc: () => import("../job-accounting.js"),
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
  const rowId = log.appendLog({ issueId: `issue-${job.id}`, dispatchId: jid(job.id), executionMode: "fly-machines" });
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
      `${job.id}-inv-${i}`, jid(job.id), i === 0 ? "implementation" : "review", job.at - 400_000, job.at - 300_000,
      JSON.stringify({ tokensIn: 1000 * (i + 1), tokensOut: 100 * (i + 1), costUsd: 0.25 * (i + 1), costStatus: "reported", attempts: 1 }),
    );
  }
  if (job.shas) log.recordPushedCommits(jid(job.id), job.shas, job.at);
  if (job.complete) log.recordInvocationsComplete(jid(job.id), job.at);
  pin(job.id, job.at);
}

function pin(name: string, changedAt: number): void {
  dedup.getDb().prepare("UPDATE dispatch_log SET changed_at = ? WHERE dispatch_id = ?").run(changedAt, jid(name));
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
    const recorded = await exchange({ args: { cursor: { changedAt: T + 1000, dispatchId: jid("job-a") }, pageSize: 1 } });
    expect(pageOf(recorded).nextCursor).not.toBeNull();
    check("next-page", recorded);
  });

  it("short-page", async () => {
    seedThree();
    const recorded = await exchange({ args: { cursor: { changedAt: T + 1000, dispatchId: jid("job-a") }, pageSize: 5 } });
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
    dedup.getDb().prepare("UPDATE dispatch_log SET conclusion = 'approved_late' WHERE dispatch_id = ?").run(jid("job-a"));
    pin("job-a", T + 9000);
    const recorded = await exchange({ args: { cursor: { changedAt: T + 3000, dispatchId: jid("job-c") }, pageSize: 5 } });
    const records = pageOf(recorded).records as Array<{ dispatchId: string; changedAt: number }>;
    expect(records.map((r) => [r.dispatchId, r.changedAt])).toEqual([[jid("job-a"), T + 9000]]);
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
    dedup.getDb().prepare("DELETE FROM dispatch_log WHERE dispatch_id = ?").run(jid("job-b"));
    const recorded = await exchange({ args: { pageSize: 5 } });
    expect(pageOf(recorded).prunedThrough).toEqual({ changedAt: T + 2000, dispatchId: jid("job-b") });
    check("pruned", recorded);
  });

  it("final-pull", async () => {
    // The clock is pinned a minute after job-fresh finished; job-old settled long before.
    const now = T + 10_000_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    seed({ id: "job-old", at: T + 1000, invocations: 1, complete: true, shas: [SHA_1] });
    seed({ id: "job-fresh", at: now - 60_000, invocations: 1, complete: true, shas: [SHA_2] });
    expect(pageOf(await exchange({ args: {} })).records.map((r: { dispatchId: string }) => r.dispatchId)).toEqual([jid("job-old")]);
    const recorded = await exchange({ args: { includeUnsettled: true } });
    expect(pageOf(recorded).records.map((r: { dispatchId: string }) => r.dispatchId)).toEqual([jid("job-old"), jid("job-fresh")]);
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
        return typeof value === "string" && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity)
          && (schema.pattern === undefined || new RegExp(schema.pattern).test(value));
      case "integer":
      case "number":
        return typeof value === "number" && Number.isFinite(value) && (schema.type !== "integer" || Number.isInteger(value))
          && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity)
          && value < (schema.exclusiveMaximum ?? Infinity) && value > (schema.exclusiveMinimum ?? -Infinity);
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
    const ok = { cursor: { changedAt: 1, dispatchId: jid("a") } };
    expect(validate(schema, ok)).toBe(true);
    expect(validate(schema, { cursor: { changedAt: 8.64e15, dispatchId: "log-12" } })).toBe(true);
    for (const bad of [
      { cursor: { changedAt: 1, dispatchId: "" } },
      { cursor: { changedAt: 1, dispatchId: "x".repeat(201) } },
      { cursor: { changedAt: 1, dispatchId: "a" } },
      { cursor: { changedAt: 1, dispatchId: `${jid("a")}\u0000` } },
      { cursor: { changedAt: 1, dispatchId: "\ud800" } },
      { cursor: { changedAt: 8.64e15 + 1, dispatchId: jid("a") } },
      { cursor: { changedAt: -1, dispatchId: jid("a") } },
      { cursor: { changedAt: 1.5, dispatchId: jid("a") } },
      { cursor: { dispatchId: jid("a") } },
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

describe("list_job_accounting strict arguments", () => {
  it("rejects unknown keys in the arguments and the cursor", () => {
    expect(JobAccountingArgsSchema.safeParse({ pageSize: 5, foo: 1 }).success).toBe(false);
    expect(JobAccountingArgsSchema.safeParse({ cursor: { changedAt: 1, dispatchId: jid("a"), x: 1 } }).success).toBe(false);
    expect(JobAccountingCursorSchema.safeParse({ changedAt: 1, dispatchId: jid("a"), x: 1 }).success).toBe(false);
  });

  it("answers an unknown argument with the same isError as invalid-args", async () => {
    const recorded = await exchange({ args: { pageSize: 5, foo: 1 } });
    expect(recorded.response.isError).toBe(true);
    expect(recorded.response.content[0].text).toContain("400");
  });
});

describe("list_job_accounting record.schema.json", () => {
  const schemaFile = new URL("record.schema.json", DIR);
  const schemaText = `${JSON.stringify(z.toJSONSchema(JobAccountingRecordSchema), null, 2)}\n`;
  const hint = "Regenerate with UPDATE_CONTRACT_FIXTURES=1 npx vitest run src/__tests__/job-accounting-contract.test.ts, and tell the control plane: it copies this file.";

  /** The subset of JSON Schema that record.schema.json uses; no validator library is a dependency. */
  function validate(schema: any, value: unknown): boolean {
    if (schema.anyOf) return schema.anyOf.some((s: any) => validate(s, value));
    if (schema.enum) return schema.enum.includes(value);
    if (Array.isArray(schema.type)) return schema.type.some((type: string) => validate({ ...schema, type }, value));
    switch (schema.type) {
      case "null":
        return value === null;
      case "array":
        return Array.isArray(value) && value.length <= (schema.maxItems ?? Infinity) && value.every((v) => validate(schema.items, v));
      case "object": {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
        const v = value as Record<string, unknown>;
        if ((schema.required ?? []).some((k: string) => !(k in v))) return false;
        if (schema.additionalProperties === false && Object.keys(v).some((k) => !(k in (schema.properties ?? {})))) return false;
        return Object.entries(schema.properties ?? {}).every(([k, sub]) => !(k in v) || validate(sub, v[k]));
      }
      case "string":
        return typeof value === "string" && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity)
          && (schema.pattern === undefined || new RegExp(schema.pattern).test(value));
      case "integer":
      case "number":
        return typeof value === "number" && Number.isFinite(value) && (schema.type !== "integer" || Number.isInteger(value))
          && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity)
          && value < (schema.exclusiveMaximum ?? Infinity) && value > (schema.exclusiveMinimum ?? -Infinity);
      default:
        throw new Error(`record.schema.json uses an unsupported schema: ${JSON.stringify(schema)}`);
    }
  }

  const load = () => JSON.parse(readFileSync(schemaFile, "utf8"));

  it("matches the schema in code", () => {
    if (process.env.UPDATE_CONTRACT_FIXTURES === "1") {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(schemaFile, schemaText);
      return;
    }
    if (!existsSync(schemaFile)) throw new Error(`docs/contracts/list_job_accounting/record.schema.json is missing. ${hint}`);
    if (readFileSync(schemaFile, "utf8") !== schemaText) throw new Error(`record.schema.json differs from JobAccountingRecordSchema. ${hint}\nActual:\n${schemaText}`);
  });

  it("validates every record of the recorded exchanges", () => {
    const schema = load();
    const scenarios = ["first-page", "next-page", "short-page", "empty", "changed-again", "partial-usage", "pruned", "final-pull"];
    let seen = 0;
    for (const scenario of scenarios) {
      const recorded = JSON.parse(readFileSync(new URL(`${scenario}.json`, DIR), "utf8")) as Exchange;
      for (const record of JSON.parse(recorded.response.content[0].text).records) {
        expect(validate(schema, record), `${scenario} ${record.dispatchId}`).toBe(true);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("rejects text over the cap, too many invocations and unknown keys", () => {
    const schema = load();
    const recorded = JSON.parse(readFileSync(new URL("first-page.json", DIR), "utf8")) as Exchange;
    const record = JSON.parse(recorded.response.content[0].text).records[0];
    expect(validate(schema, record)).toBe(true);
    const long = "x".repeat(RECORD_TEXT_MAX + 1);
    expect(validate(schema, { ...record, issue: { ...record.issue, title: long } })).toBe(false);
    expect(validate(schema, { ...record, pushedShas: [long] })).toBe(false);
    expect(validate(schema, { ...record, invocations: Array.from({ length: 201 }, () => record.invocations[0]) })).toBe(false);
  });

  // boundary-records.json
  const file = new URL("boundary-records.json", DIR);
  const NOW = 2_000_000_000_000;

  function served(): Array<{ case: string; record: unknown }> {
    const cases = seedBoundary(dedup, log);
    // includeUnsettled: one boundary job finished at the Date limit
    const records = acc.listJobAccounting({ now: NOW, pageSize: JOB_ACCOUNTING_MAX_PAGE_SIZE, includeUnsettled: true }).records;
    return records.map((record) => ({ case: cases.find((c) => c.dispatchId === record.dispatchId)!.case, record }));
  }

  it("boundary-records.json matches the records the code serves from the boundary seed", () => {
    const text = `${JSON.stringify(served(), null, 2)}\n`;
    if (process.env.UPDATE_CONTRACT_FIXTURES === "1") {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(file, text);
      return;
    }
    if (!existsSync(file)) throw new Error(`docs/contracts/list_job_accounting/boundary-records.json is missing. ${hint}`);
    if (readFileSync(file, "utf8") !== text) throw new Error(`boundary-records.json differs from what the boundary seed serves. ${hint}`);
  });

  it("boundary-records.json holds records that pass both the zod schema and record.schema.json", () => {
    const schema = JSON.parse(readFileSync(new URL("record.schema.json", DIR), "utf8"));
    const wrapped = JSON.parse(readFileSync(file, "utf8")) as Array<{ case: string; record: any }>;
    expect(wrapped.length).toBeGreaterThanOrEqual(9);
    for (const { case: note, record } of wrapped) {
      expect(note.length).toBeGreaterThan(0);
      expect(JobAccountingRecordSchema.safeParse(record).success, note).toBe(true);
      expect(validate(schema, record), note).toBe(true);
    }
  });

  it("rejects, by the JSON schema, a record where a text has a NUL or a count is negative", () => {
    const schema = JSON.parse(readFileSync(new URL("record.schema.json", DIR), "utf8"));
    const [{ record }] = JSON.parse(readFileSync(file, "utf8")) as Array<{ record: any }>;
    expect(validate(schema, { ...record, issue: { ...record.issue, title: "a\u0000b" } })).toBe(false);
    expect(validate(schema, { ...record, pr: { ...record.pr, number: -1 } })).toBe(false);
    expect(validate(schema, { ...record, dispatchId: "x".repeat(201) })).toBe(false);
    expect(validate(schema, { ...record, dispatchId: "" })).toBe(false);
  });

  it("rejects, by the JSON schema and zod alike, a time above 8.64e15, a cost outside 0 <= cost < 1e15 and an id of no known format", () => {
    const schema = JSON.parse(readFileSync(new URL("record.schema.json", DIR), "utf8"));
    const wrapped = JSON.parse(readFileSync(file, "utf8")) as Array<{ case: string; record: any }>;
    const record = wrapped.find((w) => w.record.invocations.length > 0)!.record;
    const cost = (costUsd: number) => ({ ...record, invocations: [{ ...record.invocations[0], costUsd }] });
    const bad: Array<[string, unknown]> = [
      ["dispatchedAt", { ...record, dispatchedAt: 8.64e15 + 1 }],
      ["completedAt", { ...record, completedAt: 8.64e15 + 1 }],
      ["changedAt", { ...record, changedAt: 8.64e15 + 1 }],
      ["negative time", { ...record, changedAt: -1 }],
      ["startedAt", { ...record, compute: { ...record.compute, startedAt: 8.64e15 + 1 } }],
      ["stoppedAt", { ...record, compute: { ...record.compute, stoppedAt: 8.64e15 + 1 } }],
      ["cost -1", cost(-1)],
      ["cost 1e15", cost(1e15)],
      ["id job-a", { ...record, dispatchId: "job-a" }],
      ["id with NUL", { ...record, dispatchId: `${jid("a")}\u0000` }],
      ["id with a lone surrogate", { ...record, dispatchId: "\ud800" }],
      ["id with a space", { ...record, dispatchId: `${jid("a")} ` }],
    ];
    for (const [what, r] of bad) {
      expect(validate(schema, r), what).toBe(false);
      expect(JobAccountingRecordSchema.safeParse(r).success, what).toBe(false);
    }
    const good: Array<[string, unknown]> = [
      ["time at 8.64e15", { ...record, completedAt: 8.64e15, compute: { ...record.compute, startedAt: 8.64e15, stoppedAt: null } }],
      ["cost 0", cost(0)],
      ["cost under 1e15", cost(999_999_999_999_999)],
      ["log id", { ...record, dispatchId: "log-4" }],
      ["review-fix id", { ...record, dispatchId: `reviewfix-${"a".repeat(64)}-999` }],
    ];
    for (const [what, r] of good) {
      expect(validate(schema, r), what).toBe(true);
      expect(JobAccountingRecordSchema.safeParse(r).success, what).toBe(true);
    }
  });
});
