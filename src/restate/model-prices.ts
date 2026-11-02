/** Public control-plane prices, cached by ModelPrices/builddown. */
import * as restate from "@restatedev/restate-sdk";
import * as clients from "@restatedev/restate-sdk-clients";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";

export const MODEL_PRICES_REFRESH_INTERVAL_MS = 6 * 60 * 60_000;
const STATE_KEY = "state";

// The documented wire shape. Producer-schema parity must be verified against the
// authentic Control-Plane schema before this issue is complete.
const rate = z.string().regex(/^\d+(?:\.\d+)?$/);
const priceSchema = z.object({
  model: z.string(),
  version: z.string(),
  effectiveFrom: z.string().nullable(),
  inputUsd: rate,
  outputUsd: rate,
  cacheReadUsd: rate,
  cacheWriteUsd: rate,
}).strict();
const responseSchema = z.object({ prices: z.array(priceSchema) }).strict();
export type ModelPrice = z.infer<typeof priceSchema>;
export type ModelPricesError = "not-configured" | "network" | "http" | "invalid-body";
export interface ModelPricesCurrent {
  prices: ModelPrice[];
  fetchedAt: number | null;
  lastError: ModelPricesError | null;
}
interface State extends ModelPricesCurrent { nextAt: number }
const inputSchema = z.object({
  reason: z.enum(["boot", "requested", "scheduled"]),
  scheduledFor: z.number().optional(),
}).strict();
type RefreshInput = z.infer<typeof inputSchema>;

export interface ModelPricesDeps {
  issuer: () => string | undefined;
  fetch: typeof fetch;
  /** Shorter delays allow tests to exercise actual durable timer delivery. */
  refreshIntervalMs?: number;
}

/** Reject credentials as well as non-HTTPS configuration; never send cookies or tokens. */
function pricesUrl(issuer: string | undefined): string | null {
  if (!issuer?.startsWith("https://")) return null;
  try {
    const url = new URL(issuer);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return `${issuer.replace(/\/$/, "")}/api/model-prices`;
  } catch { return null; }
}
const unconfigured = (): ModelPricesCurrent => ({ prices: [], fetchedAt: null, lastError: "not-configured" });

export function createModelPrices(deps: ModelPricesDeps) {
  async function refresh(ctx: restate.ObjectContext, input: RefreshInput): Promise<number | null> {
    const url = pricesUrl(deps.issuer());
    if (!url) return null;
    const previous = await ctx.get<State>(STATE_KEY);
    // Boot is an exclusive check-and-arm: repeated boots preserve the existing timer.
    if (input.reason === "boot" && previous?.nextAt !== undefined) return previous.nextAt;
    if (input.reason === "scheduled" && input.scheduledFor !== previous?.nextAt) return previous?.nextAt ?? null;
    const result = await ctx.run("read model prices", async (): Promise<
      { prices: ModelPrice[]; error: null } | { error: ModelPricesError }
    > => {
      try {
        const response = await deps.fetch(url, {
          credentials: "omit", redirect: "error", signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) return { error: "http" };
        try {
          const parsed = responseSchema.safeParse(await response.json());
          return parsed.success ? { prices: parsed.data.prices, error: null } : { error: "invalid-body" };
        } catch { return { error: "invalid-body" }; }
      } catch { return { error: "network" }; }
    }, { maxRetryAttempts: 1 });
    const now = await ctx.date.now();
    // Strictly advance the guard even for two requested reads within one millisecond.
    const nextAt = Math.max(now + (deps.refreshIntervalMs ?? MODEL_PRICES_REFRESH_INTERVAL_MS), (previous?.nextAt ?? 0) + 1);
    ctx.set<State>(STATE_KEY, {
      prices: result.error === null ? result.prices : previous?.prices ?? [],
      fetchedAt: result.error === null ? now : previous?.fetchedAt ?? null,
      lastError: result.error,
      nextAt,
    });
    const self = ctx.objectSendClient({ name: "ModelPrices" } as restate.VirtualObjectDefinition<"ModelPrices", unknown>, ctx.key) as unknown as {
      refresh(input: RefreshInput, opts: restate.SendOpts<RefreshInput>): void;
    };
    self.refresh({ reason: "scheduled", scheduledFor: nextAt }, restate.rpc.sendOpts({ delay: nextAt - now }));
    ctx.console.info(`[ModelPrices] ${result.error ?? "updated"} next=${new Date(nextAt).toISOString()}`);
    return nextAt;
  }
  async function current(ctx: restate.ObjectSharedContext): Promise<ModelPricesCurrent> {
    if (!pricesUrl(deps.issuer())) return unconfigured();
    const state = await ctx.get<State>(STATE_KEY);
    return { prices: state?.prices ?? [], fetchedAt: state?.fetchedAt ?? null, lastError: state?.lastError ?? null };
  }
  return restate.object({ name: "ModelPrices", handlers: {
    refresh: restate.handlers.object.exclusive({ input: serde.zod(inputSchema) }, refresh),
    current: restate.handlers.object.shared(current),
  } });
}
export type ModelPricesDefinition = ReturnType<typeof createModelPrices>;
export const modelPrices = createModelPrices({
  issuer: () => process.env.BUILDDOWN_OIDC_ISSUER,
  fetch: (...args) => fetch(...args),
});

/** Called after successful endpoint registration; the object deduplicates boot sends. */
export async function armModelPricesSchedule(): Promise<void> {
  if (!pricesUrl(process.env.BUILDDOWN_OIDC_ISSUER)) return;
  await clients.connect({ url: RESTATE_INGRESS_BASE_URL })
    .objectSendClient<ModelPricesDefinition>({ name: "ModelPrices" }, "builddown")
    .refresh({ reason: "boot" });
}
