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
import type { AccessRole } from "../access-entries.js";
import { clearAccessBindings, clearOrgClaimRole, recordOrgClaimRole, refreshEffectiveAllowlist } from "../access-entries.js";
import { getDb } from "../dedup.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";

export type AccessBindStatus = "bound" | "already-bound" | "conflict";
export type AccessBindOutcome = AccessBindStatus | "unavailable";

const bindSchema = z.object({ provider: z.string().min(1), subject: z.string().min(1) }).strict();
type BindInput = z.infer<typeof bindSchema>;

const clearSchema = z.object({ actor: z.string().nullable() }).strict();
type ClearInput = z.infer<typeof clearSchema>;

const recordClaimSchema = z
  .object({
    provider: z.string().min(1),
    subject: z.string().min(1),
    role: z.enum(["admin", "user"]),
    expiresAt: z.number().int(),
  })
  .strict();
type RecordClaimInput = z.infer<typeof recordClaimSchema>;

const clearClaimSchema = z.object({ provider: z.string().min(1) }).strict();
type ClearClaimInput = z.infer<typeof clearClaimSchema>;

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
    // Exclusive on the same key as `bind`, so a clear and a bind for one address never interleave.
    clear: restate.handlers.object.exclusive(
      { input: serde.zod(clearSchema) },
      async (ctx: ObjectContext, input: ClearInput): Promise<{ removed: number }> => {
        const value = ctx.key.trim().toLowerCase();
        // One SQLite transaction (rows, legacy columns, audit entry); a replay after commit deletes nothing.
        const removed = await ctx.run("clear", () => clearAccessBindings(value, input.actor));
        return { removed };
      },
    ),
    // The single writer of `org_claim_roles`. The row is keyed (address, provider), so a replay overwrites itself.
    recordClaimRole: restate.handlers.object.exclusive(
      { input: serde.zod(recordClaimSchema) },
      async (ctx: ObjectContext, input: RecordClaimInput): Promise<{ recorded: true }> => {
        const email = ctx.key.trim().toLowerCase();
        await ctx.run("record-claim-role", () =>
          recordOrgClaimRole({ email, provider: input.provider, sub: input.subject }, input.role as AccessRole, input.expiresAt),
        );
        return { recorded: true };
      },
    ),
    clearClaimRole: restate.handlers.object.exclusive(
      { input: serde.zod(clearClaimSchema) },
      async (ctx: ObjectContext, input: ClearClaimInput): Promise<{ removed: number }> => {
        const email = ctx.key.trim().toLowerCase();
        const removed = await ctx.run("clear-claim-role", () => clearOrgClaimRole({ email, provider: input.provider }));
        return { removed };
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
  // `already-bound` also refreshes: this process's cache may be stale, and a stale cache sends the same
  // identity back through the ingress on every sign-in until the TTL expires.
  if (outcome === "bound" || outcome === "already-bound") refreshEffectiveAllowlist();
  return outcome;
}

/**
 * Clears an address's bindings through the object, so bind and clear are serialized. Throws when the
 * ingress is unreachable: there is deliberately no direct-delete fallback.
 */
export async function clearAccessBindingsViaObject(
  address: string,
  actor: string | null,
  deps: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<number> {
  const key = address.trim().toLowerCase();
  const base = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const ingress = restateClients.connect({
    url: deps.baseUrl ?? RESTATE_INGRESS_BASE_URL,
    fetch: (input, init) => base(input as never, { ...init, signal: AbortSignal.timeout(INGRESS_TIMEOUT_MS) }),
  });
  const result = await ingress.objectClient<AccessBindingDefinition>({ name: "AccessBinding" }, key).clear({ actor });
  refreshEffectiveAllowlist();
  return result.removed;
}

/** Records a claim-granted role through the object. Never throws: `false` means the ingress was unreachable and callers must deny. */
export async function recordClaimRoleViaObject(
  address: string,
  input: { provider: string; subject: string; role: AccessRole; expiresAt: number },
  deps: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const key = address.trim().toLowerCase();
  const base = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  try {
    const ingress = restateClients.connect({
      url: deps.baseUrl ?? RESTATE_INGRESS_BASE_URL,
      fetch: (i, init) => base(i as never, { ...init, signal: AbortSignal.timeout(INGRESS_TIMEOUT_MS) }),
    });
    await ingress.objectClient<AccessBindingDefinition>({ name: "AccessBinding" }, key).recordClaimRole(input);
    return true;
  } catch {
    console.warn(`[access-binding] record-claim-role unavailable ${key} via ${input.provider}`);
    return false;
  }
}

/** Clears a claim-granted role through the object. Never throws: `false` means the ingress was unreachable and callers must deny. */
export async function clearClaimRoleViaObject(
  address: string,
  provider: string,
  deps: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const key = address.trim().toLowerCase();
  const base = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  try {
    const ingress = restateClients.connect({
      url: deps.baseUrl ?? RESTATE_INGRESS_BASE_URL,
      fetch: (i, init) => base(i as never, { ...init, signal: AbortSignal.timeout(INGRESS_TIMEOUT_MS) }),
    });
    await ingress.objectClient<AccessBindingDefinition>({ name: "AccessBinding" }, key).clearClaimRole({ provider });
    return true;
  } catch {
    console.warn(`[access-binding] clear-claim-role unavailable ${key} via ${provider}`);
    return false;
  }
}
