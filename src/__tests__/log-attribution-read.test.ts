import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import { makeAppendLogEntry } from "./helpers/builders.js";
import { testDb } from "./helpers/test-db.js";

let dedup: typeof DedupModule;
let log: typeof LogModule;

beforeEach(async () => {
  ({ dedup, log } = (await testDb({ modules: { dedup: () => import("../dedup.js"), log: () => import("../log.js") } })).modules);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function job(dispatchId: string) {
  log.appendLog(makeAppendLogEntry({ dispatchId }));
}

let failure: Error;

function failReads(error: Error) {
  failure = error;
  if (vi.isMockFunction(dedup.getDb().prepare)) return;
  const db = dedup.getDb();
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    if (sql.includes("model_invocation_attribution")) throw failure;
    return prepare(sql);
  }) as never);
}

describe("readAttributionsByDispatch failures", () => {
  it("warns once per error class, by class name only", () => {
    job("d1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    failReads(new TypeError("PLANTED-SECRET-MESSAGE"));
    expect(log.getJobByDispatchId("d1")!.attribution).toBeNull();
    expect(log.getJobByDispatchId("d1")!.attribution).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.join(" ")).toContain("TypeError");
    expect(warn.mock.calls.join(" ")).not.toContain("PLANTED-SECRET-MESSAGE");
  });

  it("warns once more for a different error class", () => {
    job("d1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    failReads(new TypeError("a"));
    log.getJobByDispatchId("d1");
    failReads(new RangeError("b"));
    log.getJobByDispatchId("d1");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("stays silent when the table is missing", () => {
    job("d1");
    dedup.getDb().exec("DROP TABLE model_invocation_attribution");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(log.getJobByDispatchId("d1")!.attribution).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("selected invocation attribution through the Job read model", () => {
  function insert(invocationId: string, dispatchId: string, model: string, tokensIn: number) {
    dedup.getDb().prepare(`INSERT INTO model_invocation_attribution
      (invocation_id, dispatch_id, stage, profile_id, profile_revision, agent, provider, model, auth_mode,
       config_revision_id, snapshot_id, status, started_at, completed_at, usage_json)
      VALUES (?, ?, 'implementation', 'p1', 1, 'codex', 'openai', ?, 'openai-api-key', NULL, ?, 'succeeded', 1, 2, ?)`)
      .run(invocationId, dispatchId, model, `snap-${dispatchId}`, JSON.stringify({
        availability: "complete", tokensIn, tokensOut: 1, costUsd: null, costStatus: "unavailable", outcome: "success",
      }));
  }

  it("projects the selected dispatch's own latest invocation and never another dispatch's", () => {
    job("d-selected");
    job("d-other");
    insert("inv-old", "d-selected", "model-old", 10);
    insert("inv-new", "d-selected", "model-new", 20);
    insert("inv-other", "d-other", "model-other", 99);

    const selected = log.getJobByDispatchId("d-selected")!.attribution;
    expect(selected).toMatchObject({ invocationId: "inv-new", model: "model-new", usage: { tokensIn: 20, costUsd: null } });
    expect(log.getJobByDispatchId("d-other")!.attribution).toMatchObject({ invocationId: "inv-other", model: "model-other" });
  });
});
