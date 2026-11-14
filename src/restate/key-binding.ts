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
        getDb().prepare("DELETE FROM key_bindings WHERE key_ref = ?").run(ctx.key).changes)());
      return { removed };
    }),
  },
});

type IngressDeps = { baseUrl?: string; fetchImpl?: typeof fetch };
function client(keyRef: string, deps: IngressDeps) {
  const base = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  return clients.connect({
    url: deps.baseUrl ?? RESTATE_INGRESS_BASE_URL,
    fetch: (input, init) => base(input as never, { ...init, signal: AbortSignal.timeout(5_000) }),
  }).objectClient<typeof keyBinding>({ name: "KeyBinding" }, keyRef);
}

export async function bindKey(keyRef: string, destination: string, deps: IngressDeps = {}): Promise<KeyBindOutcome> {
  let outcome: KeyBindOutcome;
  try { outcome = (await client(keyRef, deps).bind({ destination })).status; }
  catch { outcome = "unavailable"; }
  console.log(`[key-binding] bind ${outcome} ${keyRef} via ${destination}`);
  return outcome;
}

export async function clearKeyBinding(keyRef: string, deps: IngressDeps = {}): Promise<number> {
  try {
    const { removed } = await client(keyRef, deps).clear({});
    console.log(`[key-binding] clear ${removed} ${keyRef}`);
    return removed;
  } catch {
    console.log(`[key-binding] clear unavailable ${keyRef}`);
    throw new Error("key binding service unavailable");
  }
}
