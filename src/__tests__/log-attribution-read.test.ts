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

describe("getPushedCommits failures", () => {
  it("reads a thrown database error as unknown, warning by class name only", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = dedup.getDb();
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("dispatch_job_report")) throw new TypeError("PLANTED-SECRET-MESSAGE");
      return prepare(sql);
    }) as never);
    expect(log.getPushedCommits("d1")).toBeNull();
    expect(warn.mock.calls.join(" ")).not.toContain("PLANTED-SECRET-MESSAGE");
  });

  it.each([["an object", `{"a":1}`], ["a non-string array", `[1,2]`], ["invalid JSON", `not json`]])(
    "reads %s in pushed_shas_json as unknown",
    (_name, payload) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      log.recordPushedCommits("d-bad", []);
      dedup.getDb().prepare("UPDATE dispatch_job_report SET pushed_shas_json = ? WHERE dispatch_id = ?").run(payload, "d-bad");
      expect(log.getPushedCommits("d-bad")).toBeNull();
    },
  );
});

describe("selected invocation attribution through the Job read model", () => {
  function insertStage(invocationId: string, dispatchId: string, stage: string) {
    dedup.getDb().prepare(`INSERT INTO model_invocation_attribution
      (invocation_id, dispatch_id, stage, profile_id, profile_revision, agent, provider, model, auth_mode,
       config_revision_id, snapshot_id, status, started_at, completed_at, usage_json)
      VALUES (?, ?, ?, 'p1', 1, 'codex', 'openai', 'm', 'openai-api-key', NULL, ?, 'succeeded', 1, 2, ?)`)
      .run(invocationId, dispatchId, stage, `snap-${dispatchId}`, JSON.stringify({
        availability: "complete", tokensIn: 1, tokensOut: 1, costUsd: null, costStatus: "unavailable", outcome: "success",
      }));
  }

  it("keeps the last stored row as the Job attribution when many rows exist for a dispatch", () => {
    job("d-many");
    for (const [id, stage] of [["i1", "implementation"], ["r1", "review"], ["i2", "implementation"], ["r2", "review"], ["i3", "implementation"]]) {
      insertStage(id, "d-many", stage);
    }
    expect(log.getJobByDispatchId("d-many")!.attribution).toMatchObject({ invocationId: "i3", stage: "implementation" });
    expect(log.getInvocationAttribution("d-many")).toMatchObject({ invocationId: "i3" });
  });

  it("stores pushed commits once per dispatch and tells an empty list from an unreported one", () => {
    expect(log.recordPushedCommits("d-sha", ["a".repeat(40)])).toBe(true);
    expect(log.recordPushedCommits("d-sha", ["b".repeat(40)])).toBe(false);
    expect(log.recordPushedCommits("d-empty", [])).toBe(true);
    expect(log.getPushedCommits("d-sha")).toEqual(["a".repeat(40)]);
    expect(log.getPushedCommits("d-empty")).toEqual([]);
    expect(log.getPushedCommits("d-never")).toBeNull();
  });

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
