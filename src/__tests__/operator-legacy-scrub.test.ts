import { afterEach, describe, expect, it, vi } from "vitest";
import { resetRestateStatus, setRestateStatus } from "../restate/status.js";
import { scrubOperatorLegacyTokens } from "../restate/operator-legacy-scrub.js";

function store(initial: string | null = null, log: string[] = []) {
  let row = initial;
  return {
    read: () => row,
    write: (iso: string) => { log.push("write"); row = iso; },
    clear: () => { log.push("clear"); row = null; },
    get: () => row,
  };
}

const legacyFamily = { service_key: "op1", value_utf8: JSON.stringify({ currentToken: "raw" }) };

describe("scrubOperatorLegacyTokens", () => {
  afterEach(() => resetRestateStatus());

  it("makes no call and writes no row when Restate is not registered", async () => {
    const fetchImpl = vi.fn();
    const log: string[] = [];
    const rowStore = store("2026-10-13T00:00:00.000Z", log);
    const result = await scrubOperatorLegacyTokens({ fetchImpl: fetchImpl as unknown as typeof fetch, rowStore, restateReady: () => false });
    expect(result).toEqual({ ran: false, scrubbed: 0, purged: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log).toEqual([]);
    expect(rowStore.get()).toBe("2026-10-13T00:00:00.000Z");
  });

  it("defaults readiness to getRestateStatus: unreachable registration skips", async () => {
    setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "unreachable" } });
    const fetchImpl = vi.fn();
    const log: string[] = [];
    const rowStore = store(null, log);
    const result = await scrubOperatorLegacyTokens({ fetchImpl: fetchImpl as unknown as typeof fetch, rowStore });
    expect(result.ran).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log).toEqual([]);
    expect(rowStore.get()).toBeNull();
  });

  it("does nothing when the row exists and no family holds a legacy token", async () => {
    const queries: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      queries.push(JSON.parse(init?.body as string).query as string);
      return new Response(JSON.stringify({ rows: [{ service_key: "op1", value_utf8: JSON.stringify({ currentToken: "" }) }] }), { status: 200 });
    });
    const log: string[] = [];
    const rowStore = store("2026-10-13T00:00:00.000Z", log);
    const result = await scrubOperatorLegacyTokens({ fetchImpl: fetchImpl as unknown as typeof fetch, rowStore, restateReady: () => true });
    expect(result).toEqual({ ran: false, scrubbed: 0, purged: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(queries[0]).toContain("FROM state");
    expect(log).toEqual([]);
    expect(rowStore.get()).toBe("2026-10-13T00:00:00.000Z");
  });

  it("closes the row before scrubbing when the row exists and a legacy token is found", async () => {
    const log: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/query")) {
        const q = JSON.parse(init?.body as string).query as string;
        log.push("query");
        return new Response(JSON.stringify({ rows: q.includes("FROM state") ? [legacyFamily] : [{ id: "inv_1" }] }), { status: 200 });
      }
      log.push(url.includes("dropLegacyToken") ? "drop" : "purge");
      return new Response("{}", { status: 200 });
    });
    const rowStore = store("2026-10-13T00:00:00.000Z", log);
    const result = await scrubOperatorLegacyTokens({ fetchImpl: fetchImpl as unknown as typeof fetch, rowStore, restateReady: () => true, now: () => new Date("2026-10-14T00:00:00.000Z") });
    expect(result).toEqual({ ran: true, scrubbed: 1, purged: 1 });
    expect(log).toEqual(["query", "clear", "drop", "query", "purge", "write"]);
    expect(rowStore.get()).toBe("2026-10-14T00:00:00.000Z");
  });

  it("leaves no row when a scrub step fails after the row was cleared", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/query")) return new Response(JSON.stringify({ rows: [legacyFamily] }), { status: 200 });
      return new Response("boom", { status: 500 });
    });
    const rowStore = store("2026-10-13T00:00:00.000Z");
    const result = await scrubOperatorLegacyTokens({ fetchImpl: fetchImpl as unknown as typeof fetch, rowStore, restateReady: () => true });
    expect(result.ran).toBe(false);
    expect(rowStore.get()).toBeNull();
  });

  it("writes no row when a purge fails, so the next boot retries", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/query")) {
        const q = JSON.parse(init?.body as string).query as string;
        return new Response(JSON.stringify({ rows: q.includes("FROM state") ? [] : [{ id: "inv_1" }] }), { status: 200 });
      }
      return new Response("boom", { status: 500 });
    });
    const rowStore = store();
    const result = await scrubOperatorLegacyTokens({ fetchImpl: fetchImpl as unknown as typeof fetch, rowStore, restateReady: () => true });
    expect(result.ran).toBe(false);
    expect(rowStore.get()).toBeNull();
  });

  it("treats an already-purged invocation (404) as success and writes the row", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/query")) {
        const q = JSON.parse(init?.body as string).query as string;
        return new Response(JSON.stringify({ rows: q.includes("FROM state") ? [] : [{ id: "inv_1" }] }), { status: 200 });
      }
      return new Response("gone", { status: 404 });
    });
    const rowStore = store();
    const result = await scrubOperatorLegacyTokens({ fetchImpl: fetchImpl as unknown as typeof fetch, rowStore, restateReady: () => true, now: () => new Date("2026-10-13T01:02:03.000Z") });
    expect(result).toEqual({ ran: true, scrubbed: 0, purged: 1 });
    expect(rowStore.get()).toBe("2026-10-13T01:02:03.000Z");
  });
});
