/**
 * `AccessBinding` — a Virtual Object, one per normalized allowlist address, that is the only writer of
 * `access_entry_bindings` (AII-1523). An address binds once per sign-in provider; the exclusive `bind`
 * handler serializes two first sign-ins for the same address, so the first wins and the second gets
 * `conflict` and is refused. The handler input is address (the key), provider and subject — none a secret.
 */
import * as restate from "@restatedev/restate-sdk";
import type { ObjectContext } from "@restatedev/restate-sdk";
import * as restateClients from "@restatedev/restate-sdk-clients";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import { refreshEffectiveAllowlist } from "../access-entries.js";
import { getDb } from "../dedup.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";

export type AccessBindStatus = "bound" | "already-bound" | "conflict";
export type AccessBindOutcome = AccessBindStatus | "unavailable";

const bindSchema = z.object({ provider: z.string().min(1), subject: z.string().min(1) }).strict();
type BindInput = z.infer<typeof bindSchema>;

const INGRESS_TIMEOUT_MS = 5_000;

/** Read, then insert, in one SQLite transaction: a replay after commit sees its own row and says `already-bound`. */
export function bindStep(value: string, provider: string, subject: string): AccessBindStatus {
  const db = getDb();
  return db.transaction((): AccessBindStatus => {
    const existing = db
      .prepare("SELECT subject FROM access_entry_bindings WHERE value = ? AND provider = ?")
      .get(value, provider) as { subject: string } | undefined;
    if (existing) return existing.subject === subject ? "already-bound" : "conflict";
    db.prepare("INSERT INTO access_entry_bindings (value, provider, subject, bound_at) VALUES (?, ?, ?, ?)")
      .run(value, provider, subject, Date.now());
    return "bound";
  })();
}

export const accessBinding = restate.object({
  name: "AccessBinding",
  handlers: {
    bind: restate.handlers.object.exclusive(
      { input: serde.zod(bindSchema) },
      async (ctx: ObjectContext, input: BindInput): Promise<{ status: AccessBindStatus }> => {
        const value = ctx.key.trim().toLowerCase();
        const status = await ctx.run("bind", () => bindStep(value, input.provider, input.subject));
        return { status };
      },
    ),
  },
});

export type AccessBindingDefinition = typeof accessBinding;

/**
 * Binds an identity through the object and refreshes the cached allowlist. Never throws: an unreachable
 * ingress is `unavailable`, and callers must deny. Logs address and provider only.
 */
export async function bindAccessIdentity(
  address: string,
  provider: string,
  subject: string,
  deps: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<AccessBindOutcome> {
  const key = address.trim().toLowerCase();
  const base = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  let outcome: AccessBindOutcome;
  try {
    const ingress = restateClients.connect({
      url: deps.baseUrl ?? RESTATE_INGRESS_BASE_URL,
      // A hung Restate must fail closed rather than hang the sign-in callback.
      fetch: (input, init) => base(input as never, { ...init, signal: AbortSignal.timeout(INGRESS_TIMEOUT_MS) }),
    });
    const result = await ingress
      .objectClient<AccessBindingDefinition>({ name: "AccessBinding" }, key)
      .bind({ provider, subject });
    outcome = result.status;
  } catch {
    outcome = "unavailable";
  }
  console.log(`[access-binding] ${outcome} ${key} via ${provider}`);
  if (outcome === "bound") refreshEffectiveAllowlist();
  return outcome;
}
