/**
 * `PipelineSchedule` — a Virtual Object, one per scheduled pipeline, that runs the pipeline once a
 * day at a set local time (AII-1431, ADR 042). A schedule is a state, not a timer: each day has one
 * occurrence, and `lastFiredOccurrence` records whether that occurrence fired, the way the
 * `dispatched` row marks a picked-up issue. The poll loop is the tick (`checkPipelineSchedules`).
 * There is no delayed self-send and no pending invocation, so there is nothing to cancel or re-arm.
 *
 * Same contract shape as `RunnerBackend` (ADR 039): `get` (shared), `set` (exclusive, ingressPrivate),
 * and strict validation that throws a `TerminalError` 400 and leaves state unchanged. No `seed`
 * handler exists: an empty object already means "off". No secret enters state, because Restate
 * journals every handler input.
 */
import * as restate from "@restatedev/restate-sdk";
import type { ObjectContext, ObjectSharedContext } from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import { isDeployHeld } from "../deploy-hold.js";
import { getRestateStatus } from "./status.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";

export type BusyRead =
  | { busy: false }
  | { busy: true; holder: string | null; awaitingDecision: boolean };

export type FireAnswer =
  /** The run started. */
  | { outcome: "started"; runId: string }
  /** The start was refused because the worker is busy: NOT fired. */
  | { outcome: "busy"; detail: string }
  /** Any other refusal: fired, and not retried this occurrence. */
  | { outcome: "refused"; detail: string };

export interface ScheduledPipeline {
  /** No side effects. Durable calls through ctx only. */
  busy(ctx: ObjectContext): Promise<BusyRead>;
  /** Optional. Ends a run this schedule started that waits for a person's decision. Must be idempotent. */
  replace?(ctx: ObjectContext, runId: string): Promise<void>;
  fire(ctx: ObjectContext): Promise<FireAnswer>;
}

export interface PipelineScheduleDeps {
  pipelines: Record<string, ScheduledPipeline>;
  /** Test only. Production leaves this unset and uses ctx.date.now(). */
  now?: (ctx: ObjectSharedContext) => Promise<number>;
}

export interface ScheduleResult {
  at: string;
  occurrence: string;
  outcome: "started" | "refused" | "replaced";
  runId?: string;
  detail?: string;
}

export interface PipelineScheduleState {
  enabled: boolean;
  time?: string;
  zone?: string;
  lastFiredOccurrence: string | null;
  lastStartedRunId: string | null;
  lastResult: ScheduleResult | null;
}

export type CheckAction = "none" | "replaced" | "started" | "refused" | "busy";

const STATE_KEY = "state";
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 86_400_000;

const invalid = (message: string): restate.TerminalError => new restate.TerminalError(message, { errorCode: 400 });

function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const setSchema = z
  .object({
    enabled: z.boolean().optional(),
    time: z.string().regex(TIME_PATTERN, "time must be HH:MM, 24-hour").optional(),
    zone: z.string().min(1).refine(isValidZone, "zone must be an IANA time zone").optional(),
  })
  .strict();

const bodySchema = z.record(z.string(), z.unknown());

// --- time arithmetic (Intl only; no date library) -------------------------------------------------

interface LocalParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function zoneParts(ms: number, zone: string): LocalParts {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, f);
  }
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== "literal") out[p.type] = Number(p.value);
  return { y: out.year, m: out.month, d: out.day, h: out.hour, mi: out.minute, s: out.second };
}

/** The zone's offset from UTC at an instant, in ms (local wall clock as UTC, minus the instant). */
function offsetMs(ms: number, zone: string): number {
  const t = Math.floor(ms / 1000) * 1000;
  const p = zoneParts(t, zone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - t;
}

/**
 * The instant at which `zone` shows the wall time `wall` (given as a UTC-labelled ms value).
 * A repeated wall time (fall-back) resolves to the first instant; a skipped one (spring-forward gap)
 * resolves to the first valid instant after the gap.
 */
function resolveLocal(wall: number, zone: string): number {
  const before = offsetMs(wall - DAY_MS, zone);
  const after = offsetMs(wall + DAY_MS, zone);
  const offsets = before === after ? [before] : [before, after];
  const valid = offsets.map((o) => wall - o).filter((t) => offsetMs(t, zone) === wall - t);
  if (valid.length > 0) return Math.min(...valid);
  // In a gap: `lo` still has the old offset, `hi` the new one; find the transition by minutes.
  let lo = wall - after;
  let hi = wall - before;
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
    if (offsetMs(mid, zone) === after) hi = mid;
    else lo = mid;
  }
  return hi;
}

function occurrenceOn(today: LocalParts, shiftDays: number, time: string, zone: string): number {
  const [h, mi] = time.split(":").map(Number);
  return resolveLocal(Date.UTC(today.y, today.m - 1, today.d + shiftDays, h, mi), zone);
}

/** The ISO instant of the most recent local `time` in `zone` at or before `nowMs`. Pure. */
export function latestOccurrence(nowMs: number, time: string, zone: string): string {
  const today = zoneParts(nowMs, zone);
  for (const shift of [0, -1, -2]) {
    const t = occurrenceOn(today, shift, time, zone);
    if (t <= nowMs) return new Date(t).toISOString();
  }
  throw new Error(`no occurrence of ${time} in ${zone} at or before ${nowMs}`);
}

/** The ISO instant of the first local `time` in `zone` after `nowMs`. Pure. */
export function nextOccurrence(nowMs: number, time: string, zone: string): string {
  const today = zoneParts(nowMs, zone);
  for (const shift of [0, 1, 2]) {
    const t = occurrenceOn(today, shift, time, zone);
    if (t > nowMs) return new Date(t).toISOString();
  }
  throw new Error(`no occurrence of ${time} in ${zone} after ${nowMs}`);
}

// --- the object -----------------------------------------------------------------------------------

export function createPipelineSchedule(deps: PipelineScheduleDeps) {
  const clock = (ctx: ObjectSharedContext): Promise<number> => (deps.now ? deps.now(ctx) : ctx.date.now());
  const known = (key: string): boolean => Object.prototype.hasOwnProperty.call(deps.pipelines, key);

  async function get(ctx: ObjectSharedContext): Promise<(PipelineScheduleState & { nextOccurrence?: string }) | null> {
    const state = await ctx.get<PipelineScheduleState>(STATE_KEY);
    if (!state) return null;
    if (!state.enabled || !state.time || !state.zone) return state;
    return { ...state, nextOccurrence: nextOccurrence(await clock(ctx), state.time, state.zone) };
  }

  async function set(ctx: ObjectContext, body: Record<string, unknown>): Promise<PipelineScheduleState> {
    if (!known(ctx.key)) throw invalid(`unknown pipeline "${ctx.key}"; expected one of ${Object.keys(deps.pipelines).join(", ")}`);
    const parsed = setSchema.safeParse(body);
    if (!parsed.success) {
      throw invalid(`invalid schedule: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ")}`);
    }
    const patch = parsed.data;
    const prev = await ctx.get<PipelineScheduleState>(STATE_KEY);
    const next: PipelineScheduleState = {
      enabled: patch.enabled ?? prev?.enabled ?? false,
      time: patch.time ?? prev?.time,
      zone: patch.zone ?? prev?.zone,
      lastFiredOccurrence: prev?.lastFiredOccurrence ?? null,
      lastStartedRunId: prev?.lastStartedRunId ?? null,
      lastResult: prev?.lastResult ?? null,
    };
    if (next.enabled && (!next.time || !next.zone)) throw invalid("a schedule needs both time and zone before it can be enabled");
    const turnedOn = next.enabled && !prev?.enabled;
    const moved = next.time !== prev?.time || next.zone !== prev?.zone;
    if (next.enabled && next.time && next.zone && (turnedOn || moved)) {
      // The occurrence that is already in the past counts as fired: turning on a 03:00 schedule at 14:00 must not fire at once.
      next.lastFiredOccurrence = latestOccurrence(await clock(ctx), next.time, next.zone);
    }
    ctx.set<PipelineScheduleState>(STATE_KEY, next);
    return next;
  }

  async function check(ctx: ObjectContext): Promise<{ action: CheckAction }> {
    const pipeline = Object.prototype.hasOwnProperty.call(deps.pipelines, ctx.key) ? deps.pipelines[ctx.key] : undefined;
    const state = await ctx.get<PipelineScheduleState>(STATE_KEY);
    if (!pipeline || !state?.enabled || !state.time || !state.zone) return { action: "none" };

    const now = await clock(ctx);
    const occurrence = latestOccurrence(now, state.time, state.zone);
    if (occurrence === state.lastFiredOccurrence) return { action: "none" };

    const read = await pipeline.busy(ctx);
    if (read.busy) {
      const holder = read.holder;
      const replaceable =
        holder !== null &&
        read.awaitingDecision &&
        holder === state.lastStartedRunId &&
        pipeline.replace !== undefined &&
        !(state.lastResult?.outcome === "replaced" && state.lastResult.runId === holder);
      if (!replaceable) return { action: "none" };
      await pipeline.replace!(ctx, holder);
      ctx.set<PipelineScheduleState>(STATE_KEY, {
        ...state,
        lastResult: { at: new Date(now).toISOString(), occurrence, outcome: "replaced", runId: holder },
      });
      return { action: "replaced" };
    }

    const answer = await pipeline.fire(ctx);
    const at = new Date(now).toISOString();
    switch (answer.outcome) {
      case "started":
        ctx.set<PipelineScheduleState>(STATE_KEY, {
          ...state,
          lastFiredOccurrence: occurrence,
          lastStartedRunId: answer.runId,
          lastResult: { at, occurrence, outcome: "started", runId: answer.runId },
        });
        return { action: "started" };
      case "refused":
        ctx.set<PipelineScheduleState>(STATE_KEY, {
          ...state,
          lastFiredOccurrence: occurrence,
          lastResult: { at, occurrence, outcome: "refused", detail: answer.detail },
        });
        return { action: "refused" };
      case "busy":
        return { action: "busy" };
    }
  }

  return restate.object({
    name: "PipelineSchedule",
    handlers: {
      get: restate.handlers.object.shared(get),
      set: restate.handlers.object.exclusive({ input: serde.zod(bodySchema), ingressPrivate: true }, set),
      check: restate.handlers.object.exclusive(check),
    },
  });
}

export type PipelineScheduleDefinition = ReturnType<typeof createPipelineSchedule>;

// --- the poll-loop caller -------------------------------------------------------------------------

export interface CheckPipelineSchedulesDeps {
  restateReady?: () => boolean;
  deployHeld?: () => boolean;
  fetchImpl?: typeof fetch;
}

const CHECK_TIMEOUT_MS = 10_000;

/**
 * Asks each pipeline's schedule whether its occurrence is due. Makes no call during a deploy hold (a
 * new invocation must not start on the draining deployment, AII-1281) or while Restate is not ready.
 * A failed call logs one line and never throws: a schedule fault must not stop the poll cycle.
 */
export async function checkPipelineSchedules(keys: readonly string[], deps: CheckPipelineSchedulesDeps = {}): Promise<void> {
  if ((deps.deployHeld ?? isDeployHeld)()) return;
  const ready =
    deps.restateReady ??
    (() => {
      const restateStatus = getRestateStatus();
      return restateStatus.sidecar.state === "ready" && restateStatus.registration.state === "registered";
    });
  if (!ready()) return;
  const fetchImpl = deps.fetchImpl ?? fetch;
  for (const key of keys) {
    try {
      const response = await fetchImpl(`${RESTATE_INGRESS_BASE_URL}/PipelineSchedule/${encodeURIComponent(key)}/check`, {
        method: "POST",
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (!response.ok) console.warn(`[pipeline-schedule] check ${key} answered HTTP ${response.status}`);
    } catch (err) {
      console.warn(`[pipeline-schedule] check ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
