// ADR 034 rule 4 proof for the `decide` promise. Its senders (the admin route and the MCP tool) land
// with AII-1257, so this drives the registered shared handler through a minimal context and checks what
// it hands the workflow: a defined value the deadline peek can see, refused when no decision is open.
import { describe, expect, it } from "vitest";
import { createKgRefreshWorkflow } from "../restate/kg-refresh-workflow.js";

type SharedHandler = (ctx: unknown, input: unknown) => Promise<void>;

function fakeCtx(state: Record<string, unknown>, promises: Map<string, unknown>) {
  return {
    get: async (key: string) => state[key] ?? null,
    promise: (name: string) => ({
      peek: async () => promises.get(name),
      resolve: async (value: unknown) => { promises.set(name, value); },
    }),
  };
}

describe("KgRefresh.decide", () => {
  const workflow = createKgRefreshWorkflow({ retentionMs: 1000, kgSourceRepo: "Org/kg", rail: {} } as never) as unknown as {
    workflow: { decide: SharedHandler };
  };
  const decide = workflow.workflow.decide;
  const cancel = (workflow.workflow as unknown as { cancel: SharedHandler }).cancel;

  it("the cancel handler refuses the reserved COMMITTED reason and answers past-merge after the commit", async () => {
    const promises = new Map<string, unknown>();
    const ctx = fakeCtx({ triggerId: "t1", step: "merge" }, promises);
    await expect(cancel(ctx, { reason: "__kg-refresh-committed__" })).rejects.toMatchObject({ code: 400 });
    promises.set("cancel", "__kg-refresh-committed__");
    await expect(cancel(ctx, { reason: "operator_cancelled" })).rejects.toMatchObject({ code: 409, message: "past-merge" });
  });

  it("contract: KgRefresh.decide — resolves the promise with the input once a decision is open, then answers already-decided", async () => {
    const promises = new Map<string, unknown>();
    const ctx = fakeCtx({ triggerId: "t1", step: "decision" }, promises);
    const input = { action: "accept", actor: "ada@example.com" };
    await decide(ctx, input);
    expect(promises.get("decide")).toEqual(input);
    // A second accept is already-decided; a cancel after the commit is past-merge.
    await expect(decide(ctx, { action: "accept", actor: "bob@example.com" })).rejects.toMatchObject({ code: 409, message: "already-decided" });
    promises.set("cancel", "__kg-refresh-committed__");
    await expect(decide(ctx, { action: "cancel", actor: "bob@example.com" })).rejects.toMatchObject({ code: 409, message: "past-merge" });
    expect(promises.get("decide")).toEqual(input);
  });

  it("a cancel after an accept and before the commit resolves the cancel promise", async () => {
    const promises = new Map<string, unknown>();
    const ctx = fakeCtx({ triggerId: "t1", step: "decision" }, promises);
    await decide(ctx, { action: "accept", actor: "ada@example.com" });
    await decide(ctx, { action: "cancel", actor: "bob@example.com" });
    expect(promises.get("cancel")).toBe("cancelled");
  });

  it("a second decision after a cancel answers already-decided", async () => {
    const promises = new Map<string, unknown>();
    const ctx = fakeCtx({ triggerId: "t1", step: "decision" }, promises);
    await decide(ctx, { action: "cancel", actor: "ada@example.com" });
    await expect(decide(ctx, { action: "cancel", actor: "bob@example.com" })).rejects.toMatchObject({ code: 409, message: "already-decided" });
  });

  it("answers no-decision-open when the run is not at the gate", async () => {
    const promises = new Map<string, unknown>();
    const ctx = fakeCtx({ triggerId: "t1", step: "await-progress" }, promises);
    await expect(decide(ctx, { action: "accept", actor: "ada@example.com" })).rejects.toMatchObject({ code: 409, message: "no-decision-open" });
    expect(promises.has("decide")).toBe(false);
  });
});
