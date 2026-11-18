/**
 * `GhaRunProfile` — a Virtual Object, one per pipeline phase (`kg-refresh`, ...), that holds the pipeline's
 * GitHub Actions run settings (AII-1244). The one thing the orchestrator controls on a GitHub Actions run is the
 * job timeout, sent as the `job_timeout_minutes` dispatch input. Runner size stays with the repo variable
 * `AI_IMPLEMENT_RUNNER_LABEL`. It meets the run-profile contract in `run-profile.ts`.
 */
import * as restate from "@restatedev/restate-sdk";
import type { ObjectContext, ObjectSharedContext } from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import type { RunProfileView } from "./run-profile.js";

export interface GhaRunProfileConfig {
  /** Integer 10..360. */
  jobTimeoutMinutes: number;
}

export type GhaRunProfileView = RunProfileView<GhaRunProfileConfig>;

export const MIN_JOB_TIMEOUT_MINUTES = 10;
export const MAX_JOB_TIMEOUT_MINUTES = 360;

export const GHA_RUN_PROFILE_DEFAULTS: Record<string, GhaRunProfileConfig> = {
  "kg-refresh": { jobTimeoutMinutes: 240 },
};

const PROFILE_KEY = "profile";

const configSchema = z.object({
  jobTimeoutMinutes: z.number().int().min(MIN_JOB_TIMEOUT_MINUTES).max(MAX_JOB_TIMEOUT_MINUTES),
}).strict();
const patchSchema = configSchema.partial().strict();

function invalid(message: string): restate.TerminalError {
  return new restate.TerminalError(message, { errorCode: 400 });
}

/** Validates a complete config, naming the offending field. Throws `TerminalError` 400. */
function validateConfig(c: Partial<GhaRunProfileConfig>): GhaRunProfileConfig {
  const parsed = configSchema.safeParse(c);
  if (parsed.success) return parsed.data;
  throw invalid(`jobTimeoutMinutes must be an integer between ${MIN_JOB_TIMEOUT_MINUTES} and ${MAX_JOB_TIMEOUT_MINUTES}, got ${String(c.jobTimeoutMinutes)}`);
}

export function createGhaRunProfile() {
  async function read(ctx: ObjectSharedContext): Promise<GhaRunProfileView | null> {
    const stored = await ctx.get<GhaRunProfileConfig>(PROFILE_KEY);
    if (stored) return { config: stored, source: "profile" };
    const fallback = GHA_RUN_PROFILE_DEFAULTS[ctx.key];
    return fallback ? { config: { ...fallback }, source: "default" } : null;
  }

  async function set(ctx: ObjectContext, patch: Partial<GhaRunProfileConfig>): Promise<GhaRunProfileView | null> {
    const current = await read(ctx);
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<GhaRunProfileConfig>;
    const merged = { ...current?.config, ...defined };
    if (merged.jobTimeoutMinutes === undefined) {
      throw invalid("no profile or default exists for this pipeline; use seed or set every field (missing: jobTimeoutMinutes)");
    }
    ctx.set<GhaRunProfileConfig>(PROFILE_KEY, validateConfig(merged));
    return read(ctx);
  }

  async function seed(ctx: ObjectContext, config: GhaRunProfileConfig): Promise<{ seeded: boolean }> {
    const valid = validateConfig(config);
    if ((await ctx.get<GhaRunProfileConfig>(PROFILE_KEY)) !== null) return { seeded: false };
    ctx.set<GhaRunProfileConfig>(PROFILE_KEY, valid);
    return { seeded: true };
  }

  return restate.object({
    name: "GhaRunProfile",
    handlers: {
      get: restate.handlers.object.shared(read),
      set: restate.handlers.object.exclusive({ input: serde.zod(patchSchema), ingressPrivate: true }, set),
      seed: restate.handlers.object.exclusive({ input: serde.zod(configSchema) }, seed),
    },
  });
}

export type GhaRunProfileDefinition = ReturnType<typeof createGhaRunProfile>;
/** A typed client handle for callers outside this module (the workflow, the tools). */
export const GhaRunProfile: GhaRunProfileDefinition = { name: "GhaRunProfile" } as GhaRunProfileDefinition;
