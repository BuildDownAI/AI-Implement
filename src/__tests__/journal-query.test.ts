import { describe, expect, it, vi } from "vitest";
import { PAGE_ROUTES } from "../access-page-grants.js";
import {
  buildJournalQueries,
  handleJournalRequest,
  readJournal,
  validateJournalLookup,
} from "../restate/journal-query.js";

describe("validateJournalLookup", () => {
  it("accepts service+key and id", () => {
    expect(validateJournalLookup({ service: "KgRefresh", key: "abc-123" })).toEqual({ service: "KgRefresh", key: "abc-123" });
    expect(validateJournalLookup({ id: "inv_1abc.def:x-y" })).toEqual({ id: "inv_1abc.def:x-y" });
  });

  it.each([
    [{ service: "KgRefresh", key: "a'b" }, "key"],
    [{ service: "KgRefresh", key: "" }, "key"],
    [{ service: "KgRefresh", key: "k".repeat(129) }, "key"],
    [{ service: "Kg Refresh", key: "k" }, "service"],
    [{ service: "KgRefresh" }, "key"],
    [{ key: "k" }, "service"],
    [{ id: "" }, "id"],
    [{ id: "x".repeat(129) }, "id"],
    [{}, "id"],
  ])("rejects %j naming %s", (query, field) => {
    const result = validateJournalLookup(query as Record<string, string>);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error.startsWith(`${field}:`)).toBe(true);
  });

  it("accepts a 128-character key", () => {
    expect(validateJournalLookup({ service: "S", key: "k".repeat(128) })).toEqual({ service: "S", key: "k".repeat(128) });
  });
});

describe("buildJournalQueries", () => {
  it("quotes values and leaves no raw quote (even when validation is bypassed)", () => {
    const q = buildJournalQueries({ service: "S'x", key: "k'y" });
    expect(q.invocation).toContain("target_service_name = 'S''x'");
    expect(q.invocation).toContain("target_service_key = 'k''y'");
    expect(q.invocation).toContain("ORDER BY created_at DESC LIMIT 1");
    expect(q.journal("i'd")).toContain("WHERE id = 'i''d' ORDER BY index");
    expect(q.promises("S'x", "k'y")).toContain("service_name = 'S''x' AND service_key = 'k''y'");
  });

  it("looks up by id", () => {
    expect(buildJournalQueries({ id: "inv_1" }).invocation).toContain("WHERE id = 'inv_1' ORDER BY created_at DESC LIMIT 1");
  });
});

function rowsFetch(responses: Array<unknown[] | Error>): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify({ rows: next }), { status: 200 });
  });
}

describe("readJournal", () => {
  const invocation = { id: "inv_1", target_service_name: "KgRefresh", target_service_key: "k", status: "completed" };

  it("returns null without further queries when no invocation matches", async () => {
    const fetchImpl = rowsFetch([[]]);
    expect(await readJournal({ id: "nope" }, { fetchImpl: fetchImpl as never, adminBaseUrl: "http://x" })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("trims entries, parses entry_json, and nulls oversized or malformed ones", async () => {
    const fetchImpl = rowsFetch([
      [invocation],
      [
        { index: 0, entry_type: "Run", name: "step", completed: true, promise_name: null, entry_json: '{"a":1}', appended_at: 1, sleep_wakeup_at: null, extra: "dropped" },
        { index: 1, entry_type: "Run", name: "big", completed: true, entry_json: JSON.stringify({ s: "x".repeat(5000) }) },
        { index: 2, entry_type: "Run", name: "bad", completed: true, entry_json: "{not json" },
      ],
      [{ service_name: "KgRefresh", service_key: "k", key: "report", completed: true }],
    ]);
    const result = await readJournal({ id: "inv_1" }, { fetchImpl: fetchImpl as never, adminBaseUrl: "http://x" });
    expect(result?.invocation).toEqual(invocation);
    expect(result?.entries.map((e) => e.entry)).toEqual([{ a: 1 }, null, null]);
    expect(result?.entries[0]).toEqual({
      index: 0, entryType: "Run", name: "step", completed: true, promiseName: null, appendedAt: 1, sleepWakeupAt: null, entry: { a: 1 },
    });
    expect(result?.promises).toHaveLength(1);
    // The promises query uses the resolved invocation's service and key.
    const lastBody = JSON.parse((fetchImpl.mock.calls[2][1] as { body: string }).body).query as string;
    expect(lastBody).toContain("service_name = 'KgRefresh' AND service_key = 'k'");
  });
});

describe("handleJournalRequest", () => {
  it("answers 400 without calling the admin API on a bad lookup", async () => {
    const fetchImpl = vi.fn();
    const r = await handleJournalRequest({ service: "KgRefresh", key: "x'y" }, { fetchImpl: fetchImpl as never });
    expect(r.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("answers 404 and 503", async () => {
    expect(await handleJournalRequest({ id: "a" }, { fetchImpl: rowsFetch([[]]) as never })).toEqual({ status: 404, body: { error: "no invocation" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await handleJournalRequest({ id: "a" }, { fetchImpl: rowsFetch([new Error("down")]) as never })).toEqual({
      status: 503,
      body: { error: "restate unavailable" },
    });
  });
});

describe("PAGE_ROUTES", () => {
  it("grants the journal page its one route", () => {
    expect(PAGE_ROUTES.journal).toEqual(["/api/restate/journal"]);
  });
});
