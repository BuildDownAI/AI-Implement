/**
 * `FlyMachineProfile` — a Virtual Object, one per pipeline phase (`kg-refresh`, ...), that holds
 * the pipeline's Fly machine config (AII-1106 step 2a). `set` is exclusive, so two admins'
 * concurrent writes serialize instead of one read-merge-write losing the other.
 *
 * Step 3a (AII-1131) makes it the owner of the one machine the pipeline keeps between runs: `claim`,
 * `attach`, `release`, `expire` (ADR 037). The run's env never enters the object (Restate journals every
 * handler input), so the workflow's dispatch step does create / update / start; the object decides
 * identity, hold, timer, scrub, and destroy. Only the `ctx.run` closures call `deps.fly`.
 *
 * Its callers are the KG refresh workflow, `set_fly_machine_profile`, and the boot seed.
 */
import * as restate from "@restatedev/restate-sdk";
import type { ObjectContext, ObjectSharedContext } from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import type { Machine } from "../fly-machines.js";

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
/** Fly performance machines need at least this much memory per CPU. Shared with kg-refresh-production.ts. */
export const PERFORMANCE_MIN_MB_PER_CPU = 2048;

const PROFILE_KEY = "profile";
const MACHINE_KEY = "machine";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Machine metadata the dispatch step stamps and the reaper reads; one definition for both. */
export {
  DURABLE_RUNNER_PURPOSE_KEY,
  DURABLE_RUNNER_PURPOSE_VALUE,
  DURABLE_RUNNER_PIPELINE_KEY,
  DURABLE_RUNNER_DISPATCH_ID_KEY,
} from "../durable-runner.js";
/** Stamped by `release` as epoch seconds; the reaper destroys a durable-runner machine past it. */
export const DURABLE_UNTIL_KEY = "durable_until";

export interface FlyMachineProfileDeps {
  /** Bound to FLY_SESSIONS_TOKEN + FLY_SESSIONS_APP by the composer; a fake in tests. */
  fly: {
    getMachine(id: string): Promise<Machine>;
    /** getMachine, then updateMachine with `env: {}` and the same config otherwise. Update on a stopped machine does not start it. */
    clearMachineEnv(id: string, metadata?: Record<string, string>): Promise<void>;
    destroyMachine(id: string): Promise<void>;
  };
  /** Test seam for a short idle timeout; production leaves it unset. */
  idleTimeoutMsOverride?: number;
}

export interface MachineHold {
  dispatchId: string;
  attempt: number;
}

/** `machineId` is unset between a `claim` that found no machine and the `attach` that records one. */
export interface KeptMachineState {
  machineId?: string;
  lastUsedAt: number;
  heldBy: MachineHold | null;
}

const claimSchema = z.object({ dispatchId: z.string().min(1), attempt: z.number().int().min(1).optional() }).strict();
const attachSchema = z.object({ dispatchId: z.string().min(1), machineId: z.string().min(1), attempt: z.number().int().min(1).optional(), replaces: z.string().min(1).optional() }).strict();
const releaseSchema = z.object({ dispatchId: z.string().min(1) }).strict();
const expireSchema = z.object({ releasedAt: z.number() }).strict();

export type ClaimDecision =
  | { kind: "conflict"; message: string }
  | { kind: "grant"; machineId: string | null; next: KeptMachineState };

/** Pure: who may take the kept machine. `now` stamps `lastUsedAt` on a new or changed hold. */
export function decideClaim(machine: KeptMachineState | null, dispatchId: string, attempt: number, now: number): ClaimDecision {
  const held = machine?.heldBy ?? null;
  if (machine && held) {
    if (held.dispatchId !== dispatchId) {
      return { kind: "conflict", message: `machine held by ${held.dispatchId} attempt ${held.attempt}` };
    }
    if (attempt < held.attempt) {
      return { kind: "conflict", message: `stale claim: ${dispatchId} attempt ${attempt} is below the hold's attempt ${held.attempt}` };
    }
    if (attempt === held.attempt) return { kind: "grant", machineId: machine.machineId ?? null, next: machine };
    return { kind: "grant", machineId: machine.machineId ?? null, next: { ...machine, lastUsedAt: now, heldBy: { dispatchId, attempt } } };
  }
  const next: KeptMachineState = { ...(machine?.machineId ? { machineId: machine.machineId } : {}), lastUsedAt: now, heldBy: { dispatchId, attempt } };
  return { kind: "grant", machineId: machine?.machineId ?? null, next };
}

export type AttachDecision =
  | { kind: "conflict"; message: string }
  | { kind: "unchanged" }
  | { kind: "record"; next: KeptMachineState; replaced: string | null };

/** Pure: whether the machine the workflow created for this dispatch is recorded. */
export function decideAttach(machine: KeptMachineState | null, dispatchId: string, machineId: string, attempt: number, now: number, replaces?: string): AttachDecision {
  const held = machine?.heldBy ?? null;
  if (!machine || !held || held.dispatchId !== dispatchId) {
    return { kind: "conflict", message: `attach by ${dispatchId}, which does not hold the machine${held ? ` (held by ${held.dispatchId} attempt ${held.attempt})` : ""}` };
  }
  if (machine.machineId === machineId) return { kind: "unchanged" };
  const next: KeptMachineState = { machineId, lastUsedAt: now, heldBy: held };
  if (machine.machineId === undefined) return { kind: "record", next, replaced: null };
  // The dispatch step found the recorded machine destroyed or 404 and created this one: replace at any attempt.
  if (replaces !== undefined && replaces === machine.machineId) return { kind: "record", next, replaced: machine.machineId };
  if (attempt > held.attempt || (attempt === held.attempt && attempt > 1)) {
    return { kind: "record", next, replaced: machine.machineId };
  }
  return { kind: "conflict", message: `attach of ${machineId} at attempt ${attempt} cannot replace ${machine.machineId} held at attempt ${held.attempt}` };
}

export type ExpireDecision = { kind: "destroy"; machineId: string } | { kind: "noop" };

/** Pure: destroy only the machine released at exactly `releasedAt` and not re-held since. */
export function decideExpire(machine: KeptMachineState | null, releasedAt: number): ExpireDecision {
  if (!machine || machine.heldBy !== null || machine.lastUsedAt !== releasedAt || machine.machineId === undefined) return { kind: "noop" };
  return { kind: "destroy", machineId: machine.machineId };
}

const conflict = (message: string): restate.TerminalError => new restate.TerminalError(message, { errorCode: 409 });
const is404 = (err: unknown): boolean => err instanceof Error && /\(404\)/.test(err.message);

const configSchema = z.object({
  cpuKind: z.enum(["shared", "performance"]),
  cpus: z.number(),
  memoryMb: z.number(),
  idleTimeoutMs: z.number(),
}).strict();
const patchSchema = configSchema.partial().strict();

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

export function createFlyMachineProfile(deps: FlyMachineProfileDeps) {
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

  async function claim(ctx: ObjectContext, input: z.infer<typeof claimSchema>): Promise<{ machineId: string | null }> {
    const attempt = input.attempt ?? 1;
    const machine = await ctx.get<KeptMachineState>(MACHINE_KEY);
    const decision = decideClaim(machine, input.dispatchId, attempt, await ctx.date.now());
    if (decision.kind === "conflict") throw conflict(decision.message);
    if (decision.next !== machine) ctx.set<KeptMachineState>(MACHINE_KEY, decision.next);
    ctx.console.info(`[FlyMachineProfile] claim ${ctx.key} dispatch=${input.dispatchId} attempt=${attempt} machine=${decision.machineId ?? "none"}`);
    return { machineId: decision.machineId };
  }

  async function attach(ctx: ObjectContext, input: z.infer<typeof attachSchema>): Promise<{ machineId: string }> {
    const attempt = input.attempt ?? 1;
    const machine = await ctx.get<KeptMachineState>(MACHINE_KEY);
    const decision = decideAttach(machine, input.dispatchId, input.machineId, attempt, await ctx.date.now(), input.replaces);
    if (decision.kind === "conflict") throw conflict(decision.message);
    if (decision.kind === "record") {
      ctx.set<KeptMachineState>(MACHINE_KEY, decision.next);
      if (decision.replaced) {
        ctx.console.warn(`[FlyMachineProfile] attach ${ctx.key} replaced ${decision.replaced} with ${input.machineId} (dispatch=${input.dispatchId} attempt=${attempt} replaces=${input.replaces ?? "none"}); the reaper removes the old one`);
      }
    }
    return { machineId: input.machineId };
  }

  async function release(ctx: ObjectContext, input: z.infer<typeof releaseSchema>): Promise<void> {
    const machine = await ctx.get<KeptMachineState>(MACHINE_KEY);
    if (!machine || machine.heldBy?.dispatchId !== input.dispatchId) {
      ctx.console.info(`[FlyMachineProfile] release ${ctx.key} by ${input.dispatchId} ignored: not the holder`);
      return;
    }
    const now = await ctx.date.now();
    const machineId = machine.machineId;
    if (machineId === undefined) {
      // A claim that found no machine and never attached one: nothing to scrub or time out.
      ctx.clear(MACHINE_KEY);
      ctx.console.info(`[FlyMachineProfile] release ${ctx.key} by ${input.dispatchId}: no machine was attached`);
      return;
    }
    const idleTimeoutMs = deps.idleTimeoutMsOverride ?? (await read(ctx))?.config.idleTimeoutMs ?? FLY_MACHINE_PROFILE_DEFAULTS["kg-refresh"].idleTimeoutMs;
    let scrubbed = true;
    try {
      await ctx.run("scrub", async () => {
        await deps.fly.clearMachineEnv(machineId, { [DURABLE_UNTIL_KEY]: String(Math.floor((now + idleTimeoutMs + ONE_DAY_MS) / 1000)) });
      }, { maxRetryAttempts: 3 });
    } catch (err) {
      if (restate.internal.isSuspendedError(err)) throw err;
      scrubbed = false;
      ctx.console.error(`[FlyMachineProfile] scrub of ${machineId} failed for ${ctx.key}; destroying it: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!scrubbed) {
      try {
        await ctx.run("destroy-unscrubbed", async () => {
          try {
            await deps.fly.destroyMachine(machineId);
          } catch (err) {
            if (!is404(err)) throw err;
          }
        }, { maxRetryAttempts: 3 });
      } catch (err) {
        // Still gone from the object's view; the reaper's durable_until rule is the backstop.
        if (restate.internal.isSuspendedError(err)) throw err;
        ctx.console.error(`[FlyMachineProfile] destroy of unscrubbed ${machineId} failed for ${ctx.key}: ${err instanceof Error ? err.message : String(err)}`);
      }
      ctx.clear(MACHINE_KEY);
    } else {
      ctx.set<KeptMachineState>(MACHINE_KEY, { machineId, lastUsedAt: now, heldBy: null });
    }
    ctx.console.info(`[FlyMachineProfile] release ${ctx.key} by ${input.dispatchId} machine=${machineId} scrubbed=${scrubbed}`);
    // Scheduled on both paths (the machine is already gone on the failure path, so it is a no-op).
    // Typed by hand: the object's own return type is circular inside its factory.
    const self = ctx.objectSendClient({ name: "FlyMachineProfile" } as restate.VirtualObjectDefinition<"FlyMachineProfile", unknown>, ctx.key) as unknown as {
      expire(input: { releasedAt: number }, opts: restate.SendOpts<{ releasedAt: number }>): void;
    };
    self.expire(
      { releasedAt: now },
      restate.rpc.sendOpts({ delay: idleTimeoutMs }),
    );
  }

  async function expire(ctx: ObjectContext, input: z.infer<typeof expireSchema>): Promise<void> {
    const machine = await ctx.get<KeptMachineState>(MACHINE_KEY);
    const decision = decideExpire(machine, input.releasedAt);
    if (decision.kind === "noop") return;
    const { machineId } = decision;
    await ctx.run("destroy", async () => {
      try {
        await deps.fly.destroyMachine(machineId);
      } catch (err) {
        if (!is404(err)) throw err;
      }
    }, { maxRetryAttempts: 3 });
    ctx.clear(MACHINE_KEY);
    ctx.console.info(`[FlyMachineProfile] expire ${ctx.key} destroyed idle machine ${machineId}`);
  }

  async function status(ctx: ObjectSharedContext): Promise<{ profile: FlyMachineProfileView | null; machine: KeptMachineState | null }> {
    return { profile: await read(ctx), machine: (await ctx.get<KeptMachineState>(MACHINE_KEY)) ?? null };
  }

  return restate.object({
    name: "FlyMachineProfile",
    handlers: {
      get: restate.handlers.object.shared(read),
      set: restate.handlers.object.exclusive({ input: serde.zod(patchSchema), ingressPrivate: true }, set),
      seed: restate.handlers.object.exclusive({ input: serde.zod(configSchema) }, seed),
      claim: restate.handlers.object.exclusive({ input: serde.zod(claimSchema), ingressPrivate: true }, claim),
      attach: restate.handlers.object.exclusive({ input: serde.zod(attachSchema), ingressPrivate: true }, attach),
      release: restate.handlers.object.exclusive({ input: serde.zod(releaseSchema), ingressPrivate: true }, release),
      expire: restate.handlers.object.exclusive({ input: serde.zod(expireSchema), ingressPrivate: true }, expire),
      status: restate.handlers.object.shared(status),
    },
  });
}

export type FlyMachineProfileDefinition = ReturnType<typeof createFlyMachineProfile>;
/** A typed client handle for callers outside this module (the workflow, the tools, the boot seed). */
export const FlyMachineProfile: FlyMachineProfileDefinition = { name: "FlyMachineProfile" } as FlyMachineProfileDefinition;
