import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcileDispatched, type DedupReconcileDeps } from "../dedup-reconcile.js";
import type { RepoMapping } from "../config.js";

type States = Map<string, "active" | "completed" | "cancelled">;

function mapping(provider: string): RepoMapping {
  return { ticketingProvider: provider } as unknown as RepoMapping;
}

function stub(id: string, impl: (ids: string[]) => Promise<States>) {
  return { id, fetchLifecycleStates: vi.fn(impl) } as unknown as {
    id: string;
    fetchLifecycleStates: ReturnType<typeof vi.fn>;
  };
}

let clear: ReturnType<typeof vi.fn>;
let recordNotFound: ReturnType<typeof vi.fn>;
let logError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clear = vi.fn();
  recordNotFound = vi.fn(async () => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  logError = vi.spyOn(console, "error").mockImplementation(() => {});
  logError.mockClear();
});

function run(
  rows: DedupReconcileDeps["rows"],
  providers: Record<string, ReturnType<typeof stub>>,
  extra: Partial<DedupReconcileDeps> = {},
) {
  return reconcileDispatched({
    rows,
    mappings: { LIN: mapping("linear"), LIN2: mapping("linear"), JIR: mapping("jira") },
    latestJobTeamKey: () => null,
    providerFor: async (m) => providers[m.ticketingProvider] as never,
    clear: clear as never,
    recordNotFound: recordNotFound as never,
    ...extra,
  });
}

describe("reconcileDispatched", () => {
  it("keeps both rows when the Linear stub throws; Jira follows its own answer", async () => {
    const linear = stub("linear", async () => { throw new Error("boom"); });
    const jira = stub("jira", async () => new Map([["j1", "active"]]) as States);
    const s = await run(
      [{ issueId: "l1", teamKey: "LIN" }, { issueId: "j1", teamKey: "JIR" }],
      { linear, jira },
    );
    expect(clear).not.toHaveBeenCalled();
    expect(recordNotFound).not.toHaveBeenCalled();
    expect(s).toMatchObject({ kept: 1, keptProviderError: 1 });
    expect(linear.fetchLifecycleStates).toHaveBeenCalledTimes(1);
    expect(linear.fetchLifecycleStates).toHaveBeenCalledWith(["l1"]);
    expect(jira.fetchLifecycleStates).toHaveBeenCalledTimes(1);
    expect(jira.fetchLifecycleStates).toHaveBeenCalledWith(["j1"]);
  });

  it("calls each provider once with its own ids, across rows and mappings", async () => {
    const linear = stub("linear", async () => new Map([["a", "active"], ["b", "active"]]) as States);
    const jira = stub("jira", async () => new Map([["c", "active"]]) as States);
    const s = await run(
      [{ issueId: "a", teamKey: "LIN" }, { issueId: "b", teamKey: "LIN2" }, { issueId: "c", teamKey: "JIR" }],
      { linear, jira },
    );
    expect(linear.fetchLifecycleStates).toHaveBeenCalledTimes(1);
    expect(linear.fetchLifecycleStates).toHaveBeenCalledWith(["a", "b"]);
    expect(jira.fetchLifecycleStates).toHaveBeenCalledWith(["c"]);
    expect(s.kept).toBe(3);
  });

  it("keeps an active row", async () => {
    const linear = stub("linear", async () => new Map([["a", "active"]]) as States);
    const s = await run([{ issueId: "a", teamKey: "LIN" }], { linear });
    expect(clear).not.toHaveBeenCalled();
    expect(s.kept).toBe(1);
  });

  it.each(["completed", "cancelled"] as const)("clears a %s row without a breaker failure", async (state) => {
    const linear = stub("linear", async () => new Map([["a", state]]) as States);
    const s = await run([{ issueId: "a", teamKey: "LIN" }], { linear });
    expect(clear).toHaveBeenCalledWith("a");
    expect(recordNotFound).not.toHaveBeenCalled();
    expect(s.clearedTerminal).toBe(1);
  });

  it("clears and records not-found when the owning tracker omits the id", async () => {
    const linear = stub("linear", async () => new Map() as States);
    const s = await run([{ issueId: "a", teamKey: "LIN" }], { linear });
    expect(clear).toHaveBeenCalledWith("a");
    expect(recordNotFound).toHaveBeenCalledWith("a");
    expect(s.clearedNotFound).toBe(1);
  });

  it("keeps rows when fetchLifecycleStates throws, logging once per provider", async () => {
    const linear = stub("linear", async () => { throw new Error("x"); });
    const s = await run([{ issueId: "a", teamKey: "LIN" }, { issueId: "b", teamKey: "LIN" }], { linear });
    expect(clear).not.toHaveBeenCalled();
    expect(s.keptProviderError).toBe(2);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it("keeps rows when providerFor throws", async () => {
    const s = await run([{ issueId: "a", teamKey: "LIN" }], {}, {
      providerFor: async () => { throw new Error("no provider"); },
    });
    expect(clear).not.toHaveBeenCalled();
    expect(recordNotFound).not.toHaveBeenCalled();
    expect(s.keptProviderError).toBe(1);
  });

  it("clears a row whose mapping was removed, with no breaker failure", async () => {
    const s = await run([{ issueId: "a", teamKey: "GONE" }], {});
    expect(clear).toHaveBeenCalledWith("a");
    expect(recordNotFound).not.toHaveBeenCalled();
    expect(s.clearedMappingRemoved).toBe(1);
  });

  it("keeps a row with no team key from either source", async () => {
    const latest = vi.fn(() => null);
    const s = await run([{ issueId: "a", teamKey: null }], {}, { latestJobTeamKey: latest });
    expect(latest).toHaveBeenCalledWith("a");
    expect(clear).not.toHaveBeenCalled();
    expect(s.keptUnplaced).toBe(1);
  });

  it("places a NULL row through latestJobTeamKey; a non-null key skips the lookup", async () => {
    const jira = stub("jira", async () => new Map([["a", "active"], ["b", "active"]]) as States);
    const latest = vi.fn((id: string) => (id === "a" ? "JIR" : null));
    const s = await run([{ issueId: "a", teamKey: null }, { issueId: "b", teamKey: "JIR" }], { jira }, { latestJobTeamKey: latest });
    expect(latest).toHaveBeenCalledTimes(1);
    expect(latest).toHaveBeenCalledWith("a");
    expect(jira.fetchLifecycleStates).toHaveBeenCalledWith(["a", "b"]);
    expect(s.kept).toBe(2);
  });

  it("continues after recordNotFound throws", async () => {
    const linear = stub("linear", async () => new Map() as States);
    recordNotFound.mockRejectedValueOnce(new Error("hook"));
    const s = await run([{ issueId: "a", teamKey: "LIN" }, { issueId: "b", teamKey: "LIN" }], { linear });
    expect(recordNotFound).toHaveBeenCalledTimes(2);
    expect(s.clearedNotFound).toBe(2);
  });
});
