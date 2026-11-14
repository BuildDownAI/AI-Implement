import { randomUUID } from "node:crypto";
/** One destination per stored key reference. Secrets never cross this object's ingress. */
import * as restate from "@restatedev/restate-sdk";
import type { ObjectContext } from "@restatedev/restate-sdk";
import * as clients from "@restatedev/restate-sdk-clients";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import { getDb } from "../dedup.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";

import { readKeyBinding } from "../key-bindings.js";
export { initKeyBindingsTable, readKeyBinding } from "../key-bindings.js";

export type KeyBindStatus = "bound" | "already-bound" | "conflict";
export type KeyBindOutcome = KeyBindStatus | "unavailable";
const bindSchema = z.object({ destination: z.string().min(1) }).strict();
export const keyBinding = restate.object({
  name: "KeyBinding",
  handlers: {
    bind: restate.handlers.object.exclusive({ input: serde.zod(bindSchema) }, async (ctx: ObjectContext, input: z.infer<typeof bindSchema>): Promise<{ status: KeyBindStatus }> => {
      const status = await ctx.run("bind", () => getDb().transaction((): KeyBindStatus => {
        if (!isCurrentOperation(ctx)) return "conflict";
        const existing = readKeyBinding(ctx.key);
        if (existing) return existing.destination === input.destination ? "already-bound" : "conflict";
        getDb().prepare("INSERT INTO key_bindings (key_ref, destination, bound_at) VALUES (?, ?, ?)")
          .run(ctx.key, input.destination, Date.now());
        return "bound";
      })());
      return { status };
    }),
    clear: restate.handlers.object.exclusive({ input: serde.zod(z.object({}).strict()) }, async (ctx: ObjectContext): Promise<{ removed: number }> => {
      const removed = await ctx.run("clear", () => getDb().transaction(() =>
        isCurrentOperation(ctx) ? getDb().prepare("DELETE FROM key_bindings WHERE key_ref = ?").run(ctx.key).changes : 0)());
      return { removed };
    }),
  },
});

const operationEpoch = randomUUID();

// The token is transport metadata, never a secret. A timed-out invocation must
// check its live fence in the same transaction as its binding mutation.
function isCurrentOperation(ctx: ObjectContext): boolean {
  const token = ctx.request().headers.get("x-key-binding-operation");
  return token === undefined || (token.startsWith(`${operationEpoch}:`) && !!getDb().prepare("SELECT 1 FROM key_binding_operations WHERE operation_id = ? AND key_ref = ?").get(token, ctx.key));
}
function startOperation(keyRef: string): string {
  const token = `${operationEpoch}:${randomUUID()}`;
  getDb().prepare("INSERT INTO key_binding_operations VALUES (?, ?)").run(token, keyRef);
  return token;
}
function finishOperation(token: string): void {
  getDb().prepare("DELETE FROM key_binding_operations WHERE operation_id = ?").run(token);
}

type IngressDeps = { baseUrl?: string; fetchImpl?: typeof fetch };
function client(keyRef: string, deps: IngressDeps, token: string) {
  const base = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  return clients.connect({
    url: deps.baseUrl ?? RESTATE_INGRESS_BASE_URL,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("x-key-binding-operation", token);
      return base(input as never, { ...init, headers, signal: AbortSignal.timeout(5_000) });
    },
  }).objectClient<typeof keyBinding>({ name: "KeyBinding" }, keyRef);
}

export async function bindKey(keyRef: string, destination: string, deps: IngressDeps = {}): Promise<KeyBindOutcome> {
  const token = startOperation(keyRef);
  let outcome: KeyBindOutcome;
  try { outcome = (await client(keyRef, deps, token).bind({ destination })).status; }
  catch { outcome = "unavailable"; }
  finally { finishOperation(token); }
  console.log(`[key-binding] bind ${outcome} ${keyRef} via ${destination}`);
  return outcome;
}

export async function clearKeyBinding(keyRef: string, deps: IngressDeps = {}): Promise<number> {
  const token = startOperation(keyRef);
  try {
    const { removed } = await client(keyRef, deps, token).clear({});
    console.log(`[key-binding] clear ${removed} ${keyRef}`);
    return removed;
  } catch {
    console.log(`[key-binding] clear unavailable ${keyRef}`);
    throw new Error("key binding service unavailable");
  } finally { finishOperation(token); }
}
