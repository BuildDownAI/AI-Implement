import { describe, expect, it, vi } from "vitest";
import { scrubOperatorLegacyTokens } from "../restate/operator-legacy-scrub.js";

function store(initial: string | null = null) {
  let row = initial;
  return { read: () => row, write: (iso: string) => { row = iso; }, get: () => row };
}

describe("scrubOperatorLegacyTokens", () => {
  it("does nothing when the row already exists", async () => {
    const fetchImpl = vi.fn();
    const rowStore = store("2026-10-13T00:00:00.000Z");
    const result = await scrubOperatorLegacyTokens({ fetchImpl: fetchImpl as unknown as typeof fetch, rowStore });
    expect(result.ran).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
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
    const result = await scrubOperatorLegacyTokens({ fetchImpl: fetchImpl as unknown as typeof fetch, rowStore });
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
    const result = await scrubOperatorLegacyTokens({ fetchImpl: fetchImpl as unknown as typeof fetch, rowStore, now: () => new Date("2026-10-13T01:02:03.000Z") });
    expect(result).toEqual({ ran: true, scrubbed: 0, purged: 1 });
    expect(rowStore.get()).toBe("2026-10-13T01:02:03.000Z");
  });
});
