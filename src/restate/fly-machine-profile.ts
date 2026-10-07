/**
 * `FlyMachineProfile` — a Virtual Object, one per pipeline phase (`kg-refresh`, ...), that holds
 * the pipeline's Fly machine config (AII-1106 step 2a). `set` is exclusive, so two admins'
 * concurrent writes serialize instead of one read-merge-write losing the other.
 *
 * Only journaled context calls, no `ctx.run`: the object touches no outside system. Nothing
 * calls it yet; step 2b wires the callers.
 */
import * as restate from "@restatedev/restate-sdk";
import type { ObjectContext, ObjectSharedContext } from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";

export interface FlyMachineProfileConfig {
  cpuKind: "shared" | "performance";
  /** One of 1, 2, 4, 8, 16. */
  cpus: number;
  /** 256..65536. */
  memoryMb: number;
  idleTimeoutMs: number;
}

export interface FlyMachineProfileView {
  config: FlyMachineProfileConfig;
  source: "profile" | "default";
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export const FLY_MACHINE_PROFILE_DEFAULTS: Record<string, FlyMachineProfileConfig> = {
  "kg-refresh": { cpuKind: "performance", cpus: 2, memoryMb: 8192, idleTimeoutMs: SEVEN_DAYS_MS },
};

const VALID_CPUS = [1, 2, 4, 8, 16];
const MIN_MEMORY_MB = 256;
const MAX_MEMORY_MB = 65536;
const MIN_IDLE_TIMEOUT_MS = 60_000;
// Same figure as `PERFORMANCE_MIN_MB_PER_CPU` in kg-refresh-production.ts; defined here because
// that module imports this one.
const PERFORMANCE_MIN_MB_PER_CPU = 2048;

const PROFILE_KEY = "profile";

const configSchema = z.object({
  cpuKind: z.enum(["shared", "performance"]),
  cpus: z.number(),
  memoryMb: z.number(),
  idleTimeoutMs: z.number(),
});
const patchSchema = configSchema.partial();

function invalid(message: string): restate.TerminalError {
  return new restate.TerminalError(message, { errorCode: 400 });
}

/** Validates a complete config, naming the offending field. Throws `TerminalError` 400. */
function validateConfig(c: FlyMachineProfileConfig): FlyMachineProfileConfig {
  if (!VALID_CPUS.includes(c.cpus)) throw invalid(`cpus must be one of ${VALID_CPUS.join(", ")}, got ${c.cpus}`);
  if (!Number.isInteger(c.memoryMb) || c.memoryMb < MIN_MEMORY_MB || c.memoryMb > MAX_MEMORY_MB) {
    throw invalid(`memoryMb must be an integer between ${MIN_MEMORY_MB} and ${MAX_MEMORY_MB}, got ${c.memoryMb}`);
  }
  if (!Number.isFinite(c.idleTimeoutMs) || c.idleTimeoutMs < MIN_IDLE_TIMEOUT_MS) {
    throw invalid(`idleTimeoutMs must be at least ${MIN_IDLE_TIMEOUT_MS}, got ${c.idleTimeoutMs}`);
  }
  if (c.cpuKind === "performance" && c.memoryMb < PERFORMANCE_MIN_MB_PER_CPU * c.cpus) {
    throw invalid(
      `memoryMb ${c.memoryMb} is below the ${PERFORMANCE_MIN_MB_PER_CPU} MB-per-CPU minimum for cpuKind "performance" with ${c.cpus} cpus`,
    );
  }
  return c;
}

/**
 * Merges `patch` over `base` and validates the result. With no base (an unknown pipeline), the
 * patch must be a complete config. Throws `TerminalError` 400; pure, so it needs no Restate.
 */
export function mergeProfile(base: FlyMachineProfileConfig | null, patch: Partial<FlyMachineProfileConfig>): FlyMachineProfileConfig {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<FlyMachineProfileConfig>;
  const merged = { ...base, ...defined };
  const missing = (Object.keys(configSchema.shape) as (keyof FlyMachineProfileConfig)[]).filter((k) => merged[k] === undefined);
  if (missing.length > 0) {
    throw invalid(`no profile or default exists for this pipeline; use seed or set every field (missing: ${missing.join(", ")})`);
  }
  return validateConfig(merged as FlyMachineProfileConfig);
}

export function createFlyMachineProfile() {
  async function read(ctx: ObjectSharedContext): Promise<FlyMachineProfileView | null> {
    const stored = await ctx.get<FlyMachineProfileConfig>(PROFILE_KEY);
    if (stored) return { config: stored, source: "profile" };
    const fallback = FLY_MACHINE_PROFILE_DEFAULTS[ctx.key];
    return fallback ? { config: { ...fallback }, source: "default" } : null;
  }

  async function set(ctx: ObjectContext, patch: Partial<FlyMachineProfileConfig>): Promise<FlyMachineProfileView | null> {
    const current = await read(ctx);
    ctx.set<FlyMachineProfileConfig>(PROFILE_KEY, mergeProfile(current?.config ?? null, patch));
    return read(ctx);
  }

  async function seed(ctx: ObjectContext, config: FlyMachineProfileConfig): Promise<{ seeded: boolean }> {
    const valid = mergeProfile(null, config);
    if ((await ctx.get<FlyMachineProfileConfig>(PROFILE_KEY)) !== null) return { seeded: false };
    ctx.set<FlyMachineProfileConfig>(PROFILE_KEY, valid);
    return { seeded: true };
  }

  return restate.object({
    name: "FlyMachineProfile",
    handlers: {
      get: restate.handlers.object.shared(read),
      set: restate.handlers.object.exclusive({ input: serde.zod(patchSchema), ingressPrivate: true }, set),
      seed: restate.handlers.object.exclusive({ input: serde.zod(configSchema) }, seed),
    },
  });
}
