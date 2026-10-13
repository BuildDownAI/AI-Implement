/**
 * `RunnerBackend` — a Virtual Object, one per execution backend, holding that backend's
 * deployment-wide, non-secret settings (AII-1243, ADR 039). `fly-machines` holds the sessions app
 * and region; `github-actions` has an empty schema, reserved. Per-pipeline settings live in the
 * `<Backend>RunProfile/<pipeline>` objects (ADR 037); secrets stay in env and never enter a schema,
 * because Restate journals every handler input.
 *
 * Same contract as `FlyMachineProfile`: `get` (shared), `set` (exclusive, ingressPrivate; the
 * `set_runner_backend` tool is the only writer), `seed` (exclusive; writes only when empty).
 * `set` merges the given fields over the stored state, so one field can change without the other.
 */
import * as restate from "@restatedev/restate-sdk";
import type { ObjectContext, ObjectSharedContext } from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";

export interface FlyMachinesBackendState {
  app: string | null;
  region: string | null;
}

export type GithubActionsBackendState = Record<string, never>;

/** One strict schema per backend key. No token or other secret field exists in any of them. */
export const RUNNER_BACKEND_SCHEMAS = {
  "fly-machines": z.object({ app: z.string().min(1).nullable(), region: z.string().min(1).nullable() }).strict(),
  "github-actions": z.object({}).strict(),
} as const;

export type RunnerBackendKey = keyof typeof RUNNER_BACKEND_SCHEMAS;

export const RUNNER_BACKEND_KEYS = Object.keys(RUNNER_BACKEND_SCHEMAS) as RunnerBackendKey[];

export const isRunnerBackendKey = (key: string): key is RunnerBackendKey =>
  Object.prototype.hasOwnProperty.call(RUNNER_BACKEND_SCHEMAS, key);

const STATE_KEY = "state";

const invalid = (message: string): restate.TerminalError => new restate.TerminalError(message, { errorCode: 400 });

function schemaFor(key: string) {
  if (!isRunnerBackendKey(key)) throw invalid(`unknown runner backend "${key}"; expected one of ${RUNNER_BACKEND_KEYS.join(", ")}`);
  return RUNNER_BACKEND_SCHEMAS[key];
}

/** Validates a complete state against the key's strict schema. Throws `TerminalError` 400. */
export function parseBackendState(key: string, value: unknown): Record<string, unknown> {
  const parsed = schemaFor(key).safeParse(value);
  if (!parsed.success) throw invalid(`invalid ${key} settings: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

/** Pure: merges `patch` over `base` (undefined fields skipped) and validates the result. Throws `TerminalError` 400. */
export function mergeBackendState(key: string, base: Record<string, unknown> | null, patch: Record<string, unknown>): Record<string, unknown> {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const defaults = key === "fly-machines" ? { app: null, region: null } : {};
  return parseBackendState(key, { ...defaults, ...base, ...defined });
}

const bodySchema = z.record(z.string(), z.unknown());

async function read(ctx: ObjectSharedContext): Promise<Record<string, unknown> | null> {
  schemaFor(ctx.key);
  return (await ctx.get<Record<string, unknown>>(STATE_KEY)) ?? null;
}

async function set(ctx: ObjectContext, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const next = mergeBackendState(ctx.key, await ctx.get<Record<string, unknown>>(STATE_KEY), patch);
  ctx.set<Record<string, unknown>>(STATE_KEY, next);
  return next;
}

async function seed(ctx: ObjectContext, state: Record<string, unknown>): Promise<{ seeded: boolean }> {
  const valid = mergeBackendState(ctx.key, null, state);
  if ((await ctx.get<Record<string, unknown>>(STATE_KEY)) !== null) return { seeded: false };
  ctx.set<Record<string, unknown>>(STATE_KEY, valid);
  return { seeded: true };
}

/** `get` answers the stored state, or null when nothing was ever written. */
export const runnerBackend = restate.object({
  name: "RunnerBackend",
  handlers: {
    get: restate.handlers.object.shared(read),
    set: restate.handlers.object.exclusive({ input: serde.zod(bodySchema), ingressPrivate: true }, set),
    seed: restate.handlers.object.exclusive({ input: serde.zod(bodySchema) }, seed),
  },
});

export type RunnerBackendDefinition = typeof runnerBackend;
/** A typed client handle for callers outside this module (the tools, the boot seed, the cache). */
export const RunnerBackend: RunnerBackendDefinition = { name: "RunnerBackend" } as RunnerBackendDefinition;
