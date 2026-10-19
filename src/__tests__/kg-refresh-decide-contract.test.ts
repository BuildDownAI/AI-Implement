// The decision door (AII-1489). `KgRefresh.cancel` keeps its reserved-reason and past-merge contract; a held
// snapshot is decided through `KgRepo.decide`, which this drives through a minimal object context and checks
// what it hands the resumed run. The binary-Restate tests cover the same door end to end.
import { describe, expect, it } from "vitest";
import { createKgRefreshWorkflow, type KgHold } from "../restate/kg-refresh-workflow.js";
import { createKgRepo } from "../restate/kg-repo.js";

type Handler = (ctx: unknown, input: unknown) => Promise<unknown>;

function fakeWorkflowCtx(state: Record<string, unknown>, promises: Map<string, unknown>) {
  return {
    get: async (key: string) => state[key] ?? null,
    promise: (name: string) => ({
      peek: async () => promises.get(name),
      resolve: async (value: unknown) => { promises.set(name, value); },
    }),
  };
}

describe("KgRefresh.cancel", () => {
  const workflow = createKgRefreshWorkflow({ retentionMs: 1000, kgSourceRepo: "Org/kg", rail: {} } as never) as unknown as {
    workflow: { cancel: Handler; decide?: Handler };
  };
  const cancel = workflow.workflow.cancel;

  it("refuses the reserved COMMITTED reason and answers past-merge after the commit", async () => {
    const promises = new Map<string, unknown>();
    const ctx = fakeWorkflowCtx({ triggerId: "t1", step: "merge" }, promises);
    await expect(cancel(ctx, { reason: "__kg-refresh-committed__" })).rejects.toMatchObject({ code: 400 });
    promises.set("cancel", "__kg-refresh-committed__");
    await expect(cancel(ctx, { reason: "operator_cancelled" })).rejects.toMatchObject({ code: 409, message: "past-merge" });
  });

  it("a cancel before the commit resolves the cancel promise", async () => {
    const promises = new Map<string, unknown>();
    const ctx = fakeWorkflowCtx({ triggerId: "t1", step: "resume" }, promises);
    await cancel(ctx, {});
    expect(promises.get("cancel")).toBe("cancelled");
  });

  it("has no decide handler: a held snapshot is not a running workflow", () => {
    expect(workflow.workflow.decide).toBeUndefined();
  });
});

const HOLD: KgHold = {
  triggerId: "t1", dispatchId: "t1", decideBy: 1_000_000,
  report: { ok: false, failureCode: "KG_SNAPSHOT_HELD", snapshotPr: 7, snapshotCommit: "c", snapshotBranch: "b" },
  steps: [],
};

function fakeRepoCtx(held: KgHold | null) {
  const state = new Map<string, unknown>(held ? [["held", held]] : []);
  const runs: Array<{ key: string; input: any }> = [];
  const ctx = {
    key: "Org/kg",
    get: async (k: string) => state.get(k) ?? null,
    set: (k: string, v: unknown) => { state.set(k, v); },
    clear: (k: string) => { state.delete(k); },
    date: { now: async () => 1 },
    rand: { uuidv4: () => "t2" },
    workflowSendClient: (_d: unknown, key: string) => ({ run: (input: unknown) => { runs.push({ key, input }); return { invocationId: Promise.resolve("inv-2") }; } }),
    objectSendClient: () => ({ watch: () => undefined }),
  };
  return { ctx, state, runs };
}

describe("KgRepo.decide", () => {
  const repo = createKgRepo({ workflowName: "KgRefresh" }) as unknown as { object: { decide: Handler } };
  const decide = repo.object.decide;

  it("answers no-decision-open with no hold, and ignores a timeout", async () => {
    const { ctx, runs } = fakeRepoCtx(null);
    await expect(decide(ctx, { action: "accept", actor: "ada@example.com" })).rejects.toMatchObject({ code: 409, message: "no-decision-open" });
    expect(await decide(ctx, { action: "timeout", triggerId: "t1" })).toBeNull();
    expect(runs).toEqual([]);
  });

  it("clears the hold and starts the resumed run once; a second accept answers no-decision-open", async () => {
    const { ctx, state, runs } = fakeRepoCtx(HOLD);
    expect(await decide(ctx, { action: "accept", actor: "ada@example.com", triggerId: "t1" })).toEqual({ triggerId: "t2" });
    expect(state.has("held")).toBe(false);
    expect(runs).toHaveLength(1);
    expect(runs[0].input.resume).toMatchObject({ action: "accept", actor: "ada@example.com", hold: { triggerId: "t1" } });
    await expect(decide(ctx, { action: "accept", actor: "bob@example.com" })).rejects.toMatchObject({ message: "no-decision-open" });
    expect(runs).toHaveLength(1);
  });

  it("refuses a stale triggerId and a timeout from an old hold", async () => {
    const { ctx, state, runs } = fakeRepoCtx(HOLD);
    await expect(decide(ctx, { action: "cancel", triggerId: "other" })).rejects.toMatchObject({ message: "no-decision-open" });
    expect(await decide(ctx, { action: "timeout", triggerId: "other" })).toBeNull();
    expect(state.has("held")).toBe(true);
    expect(runs).toEqual([]);
  });

  it("refuses an accept on a blocked hold and leaves the hold open", async () => {
    const blocked = { ...HOLD, report: { ...HOLD.report, acceptBlocked: true } };
    const { ctx, state, runs } = fakeRepoCtx(blocked);
    await expect(decide(ctx, { action: "accept", actor: "ada@example.com" })).rejects.toMatchObject({ code: 409, message: "accept-blocked" });
    expect(state.has("held")).toBe(true);
    expect(runs).toEqual([]);
  });
});
