// The recorded exchanges of `list_job_accounting` (AII-1566): each docs/contracts/list_job_accounting/<scenario>.json
// holds one `{ request, status, response }` made through the real route as the control-plane `service` caller:
// the request body, the HTTP status, and the exact response body the route returns (the MCP envelope included). The control
// plane copies these files, so a change to the response must change them on purpose:
// regenerate with UPDATE_CONTRACT_FIXTURES=1 npx vitest run src/__tests__/job-accounting-contract.test.ts
import { decodeJwt } from "jose";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import type * as AccountingModule from "../job-accounting.js";
import { JOB_ACCOUNTING_MAX_PAGE_SIZE, JobAccountingArgsSchema, JobAccountingCursorSchema, JobAccountingRecordSchema, RECORD_TEXT_MAX } from "../job-accounting.js";
import { z } from "zod";
import { testDb } from "./helpers/test-db.js";
import { recordExchange, checkExchange, type Exchange } from "./contract-recorder.js";
import { seedBoundary } from "./helpers/job-accounting-boundary.js";

type FixtureExchange = {
  request: Exchange["request"]["body"];
  status: number;
  response: Exchange["response"]["body"];
};

const DIR = new URL("../../docs/contracts/list_job_accounting/", import.meta.url);
const T = 1_700_000_000_000; // every stored time is an offset from here; all are long settled
const SHA_1 = "1".repeat(40);
const SHA_2 = "2".repeat(40);

/** The readable name of a seeded job, and the UUID-shaped dispatch id stored for it (the only shape the tool serves). */
function jid(name: string): string {
  const h = createHash("sha1").update(name).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

let dedup: typeof DedupModule;
let log: typeof LogModule;
let acc: typeof AccountingModule;

beforeEach(async () => {
  ({ dedup, log, acc } = (await testDb({
    modules: {
      dedup: () => import("../dedup.js"),
      log: () => import("../log.js"),
      acc: () => import("../job-accounting.js"),
    },
  })).modules);
});

/** The page inside a successful exchange; the body is compact JSON, so re-serialising the parse gives the text back. */
function pageOf(recorded: Exchange): any {
  expect(recorded.response.status).toBe(200);
  expect(recorded.response.body.isError).toBeFalsy();
  const text = recorded.response.body.content[0].text;
  const page = JSON.parse(text);
  expect(text).toBe(JSON.stringify(page));
  return page;
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
    const recorded = await recordExchange("list_job_accounting", { args: { pageSize: 2 } });
    expect(recorded.request).toEqual({ method: "POST", path: "/api/tools/list_job_accounting", body: { args: { pageSize: 2 } } });
    expect(pageOf(recorded).nextCursor).not.toBeNull();
    checkExchange("list_job_accounting", "first-page", recorded);
  });

  it("next-page", async () => {
    seedThree();
    const recorded = await recordExchange("list_job_accounting", { args: { cursor: { changedAt: T + 1000, dispatchId: jid("job-a") }, pageSize: 1 } });
    expect(pageOf(recorded).nextCursor).not.toBeNull();
    checkExchange("list_job_accounting", "next-page", recorded);
  });

  it("short-page", async () => {
    seedThree();
    const recorded = await recordExchange("list_job_accounting", { args: { cursor: { changedAt: T + 1000, dispatchId: jid("job-a") }, pageSize: 5 } });
    expect(pageOf(recorded).nextCursor).toBeNull();
    checkExchange("list_job_accounting", "short-page", recorded);
  });

  it("empty", async () => {
    const recorded = await recordExchange("list_job_accounting", { args: {} });
    expect(pageOf(recorded).records).toEqual([]);
    checkExchange("list_job_accounting", "empty", recorded);
  });

  it("changed-again", async () => {
    seedThree();
    // job-a was served before the cursor below; a late review conclusion then rewrote it.
    dedup.getDb().prepare("UPDATE dispatch_log SET conclusion = 'approved_late' WHERE dispatch_id = ?").run(jid("job-a"));
    pin("job-a", T + 9000);
    const recorded = await recordExchange("list_job_accounting", { args: { cursor: { changedAt: T + 3000, dispatchId: jid("job-c") }, pageSize: 5 } });
    const records = pageOf(recorded).records as Array<{ dispatchId: string; changedAt: number }>;
    expect(records.map((r) => [r.dispatchId, r.changedAt])).toEqual([[jid("job-a"), T + 9000]]);
    checkExchange("list_job_accounting", "changed-again", recorded);
  });

  it("partial-usage", async () => {
    seed({ id: "job-whole", at: T + 1000, invocations: 2, complete: true, shas: [SHA_1] });
    seed({ id: "job-legacy", at: T + 2000, invocations: 1 });
    seed({ id: "job-none", at: T + 3000 });
    const recorded = await recordExchange("list_job_accounting", { args: { pageSize: 5 } });
    const usage = (pageOf(recorded).records as Array<{ usage: string }>).map((r) => r.usage);
    expect(usage).toEqual(["reported", "partial", "unknown"]);
    checkExchange("list_job_accounting", "partial-usage", recorded);
  });

  it("pruned", async () => {
    seedThree();
    dedup.getDb().prepare("DELETE FROM dispatch_log WHERE dispatch_id = ?").run(jid("job-b"));
    const recorded = await recordExchange("list_job_accounting", { args: { pageSize: 5 } });
    expect(pageOf(recorded).prunedThrough).toEqual({ changedAt: T + 2000, dispatchId: jid("job-b") });
    checkExchange("list_job_accounting", "pruned", recorded);
  });

  it("final-pull", async () => {
    // The clock is pinned a minute after job-fresh finished; job-old settled long before.
    const now = T + 10_000_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    seed({ id: "job-old", at: T + 1000, invocations: 1, complete: true, shas: [SHA_1] });
    seed({ id: "job-fresh", at: now - 60_000, invocations: 1, complete: true, shas: [SHA_2] });
    expect(pageOf(await recordExchange("list_job_accounting", { args: {} })).records.map((r: { dispatchId: string }) => r.dispatchId)).toEqual([jid("job-old")]);
    const recorded = await recordExchange("list_job_accounting", { args: { includeUnsettled: true } });
    expect(pageOf(recorded).records.map((r: { dispatchId: string }) => r.dispatchId)).toEqual([jid("job-old"), jid("job-fresh")]);
    checkExchange("list_job_accounting", "final-pull", recorded);
  });

  it("invalid-args", async () => {
    const recorded = await recordExchange("list_job_accounting", { args: { includeUnsettled: "yes" } });
    expect(recorded.response.body.isError).toBe(true);
    expect(recorded.response.body.content[0].text).toContain("400");
    checkExchange("list_job_accounting", "invalid-args", recorded);
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
    const recorded = await recordExchange("list_job_accounting", { args: { pageSize: 5, foo: 1 } });
    expect(recorded.response.body.isError).toBe(true);
    expect(recorded.response.body.content[0].text).toContain("400");
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
      const recorded = JSON.parse(readFileSync(new URL(`${scenario}.json`, DIR), "utf8")) as FixtureExchange;
      for (const record of JSON.parse(recorded.response.content[0].text).records) {
        expect(validate(schema, record), `${scenario} ${record.dispatchId}`).toBe(true);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("rejects text over the cap, too many invocations and unknown keys", () => {
    const schema = load();
    const recorded = JSON.parse(readFileSync(new URL("first-page.json", DIR), "utf8")) as FixtureExchange;
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

// Recorder coverage uses another registered tool without publishing additional contracts.
describe("shared contract recorder", () => {
  it("refuses missing or changed fixtures unless the update value is exactly 1", async () => {
    const recorded = await recordExchange("list_job_accounting", { args: {} });
    for (const value of ["", "0", "true"]) {
      vi.stubEnv("UPDATE_CONTRACT_FIXTURES", value);
      expect(() => checkExchange("list_job_accounting", "empty", recorded)).not.toThrow();
      expect(() => checkExchange("list_job_accounting", "missing-recorder-scenario", recorded)).toThrow("is missing");
      expect(() => checkExchange("list_job_accounting", "empty", { ...recorded, response: { ...recorded.response, status: 418 } })).toThrow("differs");
    }
  });

  it("dispatches another tool and preserves default and supplied scope claims", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    const cp = await import("../control-plane-token.js");
    const verify = vi.spyOn(cp, "verifyControlPlaneToken");
    const first = await recordExchange("get_runner_mode", { args: {} });
    const explicit = await recordExchange("get_runner_mode", { args: {} }, { scope: "orchestrator:read" });
    expect(first).toEqual(explicit);
    expect(first.request).toEqual({ method: "POST", path: "/api/tools/get_runner_mode", body: { args: {} } });
    expect(first.response.status).toBe(200);
    expect(first.response.body.isError).toBeFalsy();
    expect(JSON.parse(first.response.body.content[0].text)).toHaveProperty("mode");
    await recordExchange("get_runner_mode", { args: {} }, { scope: "orchestrator:read custom:scope" });
    const claims = verify.mock.calls.map(([authorization]) => decodeJwt(authorization!.slice("Bearer ".length)));
    expect(claims).toHaveLength(3);
    expect(claims[0]).toEqual(claims[1]);
    expect(claims[0].scope).toBe("orchestrator:read");
    expect(claims[2]).toEqual({ ...claims[0], scope: "orchestrator:read custom:scope" });
  });
});
