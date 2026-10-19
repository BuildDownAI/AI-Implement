// Real Restate coverage for the kg-refresh scheduled pipeline (AII-1432, ADR 042). The real
// `createKgRefreshSchedulePipeline` and `createKgRepo` run against stand-in `orchestratorTools` and
// `KgRefresh` services whose answers the scenario sets. A lease is planted through the admin state API.
//
// Run with `npm run test:restate`; excluded from `npm test`.
import * as restate from "@restatedev/restate-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKgRefreshSchedulePipeline } from "../../restate/kg-refresh-schedule.js";
import { createKgRepo } from "../../restate/kg-repo.js";
import type { BusyRead, FireAnswer, ScheduledPipeline } from "../../restate/pipeline-schedule.js";
import { createPipelineSchedule } from "../../restate/pipeline-schedule.js";
import type { RestateEnvironment } from "./harness.js";
import { VARIANTS, callObject, callService, eventually, setObjectStates, settle, startVariants, stopAll } from "./harness.js";
import type { PipelineScheduleAdapter, ScheduleWorld } from "./pipeline-schedule-contract.js";
import { pipelineScheduleContractKeys, registerPipelineScheduleContract } from "./pipeline-schedule-contract.js";

const LABELS = VARIANTS.map(([label]) => label);
const KG_RULES = ["a", "b", "b2", "c", "d", "e", "f", "g"];
const kgKey = (label: string, rule: string): string => `kg-${label}-${rule}`;
const slugOf = (key: string): string => `owner/${key}`;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BEFORE = Date.UTC(2026, 9, 14, 2, 0);
const DUE = Date.UTC(2026, 9, 14, 3, 30);
const OCCURRENCE = "2026-10-14T03:00:00.000Z";
const PREVIOUS = "2026-10-13T03:00:00.000Z";

interface ToolCall {
  caller: { kind: string };
  args: unknown;
}

interface World extends ScheduleWorld {
  label: string;
  key: string;
  clock: number;
  log: string[];
  toolCalls: ToolCall[];
  cancels: Array<{ runId: string; reason: string | undefined }>;
  /** Raw `{ status, body }` answers for the tool, consumed in order; empty means 202 with a fresh run id. */
  toolAnswers: Array<{ status: number; body: Record<string, unknown> } | "is-error">;
  crashNext: boolean;
  started: number;
  ids: Set<string>;
  fromFire(answer: FireAnswer): void;
}

const worlds = new Map<string, World>();
let current: World | null = null;
let envs: Map<string, RestateEnvironment>;

/** The newest world that knows a run id: a one-way cancel lands after its scenario's check returned, and both variants share these stand-ins. */
const ownerOf = (runId: string): World | undefined =>
  [...worlds.values()].reverse().find((w) => w.ids.has(runId));

const world = (): World => {
  if (!current) throw new Error("no current world");
  return current;
};

function newWorld(key: string): World {
  const label = LABELS.find((l) => key.includes(`-${l}-`));
  if (!label) throw new Error(`no variant label in ${key}`);
  const w: World = {
    label,
    key,
    clock: 0,
    log: [],
    toolCalls: [],
    cancels: [],
    toolAnswers: [],
    crashNext: false,
    started: 0,
    ids: new Set(),
    fromFire: (answer) => {
      if (answer.outcome === "busy") w.toolAnswers.push({ status: 409, body: { error: "refresh-in-progress" } });
      else if (answer.outcome === "refused") w.toolAnswers.push({ status: 422, body: { error: "preflight-failed", detail: answer.detail } });
      else w.toolAnswers.push({ status: 202, body: { refreshing: true, triggerId: answer.runId } });
    },
    setClock: (ms) => {
      w.clock = ms;
    },
    setBusy: async (read: BusyRead) => {
      const admin = envs.get(label)!.adminAPIBaseUrl();
      if (!read.busy) {
        await setObjectStates(admin, "KgRepo", slugOf(key), { inFlight: null, held: null });
        return;
      }
      const holder = read.holder ?? "other-run";
      w.ids.add(holder);
      // A hold is `KgRepo` state (AII-1489): the marker plus the stored hold.
      const held = read.awaitingDecision
        ? { triggerId: holder, dispatchId: holder, decideBy: DUE + 10 * DAY, report: { ok: false, failureCode: "KG_SNAPSHOT_HELD", snapshotPr: 7 }, steps: [] }
        : null;
      await setObjectStates(admin, "KgRepo", slugOf(key), { inFlight: { triggerId: holder, startedAt: 0 }, held });
    },
    queueFire: (...answers) => {
      for (const a of answers) w.fromFire(a);
    },
    crashAfterNextFire: () => {
      w.crashNext = true;
    },
    calls: () => [...w.log],
  };
  worlds.set(key, w);
  current = w;
  return w;
}

const standInTools = restate.service({
  name: "orchestratorTools",
  handlers: {
    trigger_kg_refresh: async (ctx: restate.Context, input: ToolCall) => {
      const w = world();
      const answer = await ctx.run("record", () => {
        w.log.push("fire");
        w.toolCalls.push(input);
        const next = w.toolAnswers.shift();
        if (next === "is-error") return "is-error" as const;
        return next ?? { status: 202, body: { refreshing: true, triggerId: `run-${w.key}-${++w.started}` } };
      });
      if (answer !== "is-error" && answer.status === 202) w.ids.add(String(answer.body.triggerId));
      if (answer === "is-error") return { isError: true, content: [{ type: "text", text: "tool failed" }] };
      return { content: [{ type: "text", text: JSON.stringify(answer) }] };
    },
  },
});

/** Stands in for the resumed run `KgRepo.decide` starts: records the decision it carries, then stays in flight so the lock follows it. */
const standInKgRefresh = restate.workflow({
  name: "KgRefresh",
  handlers: {
    run: async (ctx: restate.WorkflowContext, input: { resume?: { hold: { triggerId: string }; reason?: string } }): Promise<void> => {
      const resume = input?.resume;
      if (!resume) return;
      await ctx.run("record", () => {
        ownerOf(resume.hold.triggerId)?.cancels.push({ runId: resume.hold.triggerId, reason: resume.reason });
      });
      await ctx.promise<boolean>("never").get();
    },
  },
});

/** The real pipeline, with durable spies for the contract's call log and the crash-after-fire injection. */
function spied(key: string): ScheduledPipeline {
  const real = createKgRefreshSchedulePipeline(slugOf(key));
  return {
    busy: async (ctx) => {
      await ctx.run("spy-busy", () => {
        worldFor(key).log.push("busy");
      });
      return real.busy(ctx);
    },
    replace: async (ctx, runId) => {
      // The contract reads its call log right after `check`, but the cancel itself is a one-way send; the log marks the pipeline's decision.
      await ctx.run("spy-replace", () => {
        worldFor(key).log.push(`replace:${runId}`);
      });
      await real.replace!(ctx, runId);
    },
    fire: async (ctx) => {
      const answer = await real.fire(ctx);
      await ctx.run(
        "spy-crash",
        () => {
          const w = worldFor(key);
          if (w.crashNext) {
            w.crashNext = false;
            throw new Error("injected crash: fire committed, caller never observed the answer");
          }
        },
        { maxRetryAttempts: 3 },
      );
      return answer;
    },
  };
}

const worldFor = (key: string): World => {
  const w = worlds.get(key);
  if (!w) throw new Error(`no world for ${key}`);
  return w;
};

const scheduleCaller = restate.service({
  name: "PipelineSchedulePrivateCaller",
  handlers: {
    set: async (ctx: restate.Context, input: { key: string; body: unknown }): Promise<unknown> =>
      ctx.genericCall({
        service: "PipelineSchedule",
        method: "set",
        key: input.key,
        parameter: input.body,
        inputSerde: restate.serde.json as restate.Serde<unknown>,
        outputSerde: restate.serde.json as restate.Serde<unknown>,
      }),
  },
});

const adapter: PipelineScheduleAdapter = {
  name: "kg-refresh pipeline",
  world: (key) => newWorld(key),
  set: (baseUrl, key, body) => callService(baseUrl, "PipelineSchedulePrivateCaller", "set", { key, body }),
};

beforeAll(async () => {
  const keys = [...pipelineScheduleContractKeys(), ...LABELS.flatMap((l) => KG_RULES.map((r) => kgKey(l, r)))];
  const schedule = createPipelineSchedule({
    pipelines: Object.fromEntries(keys.map((k) => [k, spied(k)])),
    now: async (ctx) => worldFor(ctx.key).clock,
  });
  envs = await startVariants([schedule, scheduleCaller, createKgRepo({ workflowName: "KgRefresh" }), standInKgRefresh, standInTools]);
}, 60_000);

afterAll(async () => {
  await stopAll(envs);
});

registerPipelineScheduleContract(adapter, (label) => envs.get(label)!);

describe("kg-refresh schedule rules", () => {
  function begin(label: string, rule: string) {
    const key = kgKey(label, rule);
    const baseUrl = envs.get(label)!.baseUrl();
    const w = newWorld(key);
    return {
      w,
      get: () => callObject<{ lastFiredOccurrence: string | null; lastStartedRunId: string | null; lastResult: { outcome: string; detail?: string } | null }>(baseUrl, "PipelineSchedule", key, "get", undefined),
      check: () => callObject<{ action: string }>(baseUrl, "PipelineSchedule", key, "check", undefined),
      turnOnAndDue: async () => {
        w.setClock(BEFORE);
        await adapter.set(baseUrl, key, { enabled: true, time: "03:00", zone: "UTC" });
        w.setClock(DUE);
      },
    };
  }

  it.each(LABELS)("(a) a manual refresh held at the decision gate is not cancelled; still due (%s)", async (label) => {
    const s = begin(label, "a");
    await s.turnOnAndDue();
    await s.w.setBusy({ busy: true, holder: "manual-run", awaitingDecision: true });
    expect(await s.check()).toEqual({ action: "none" });
    expect(s.w.calls().filter((c) => c.startsWith("replace"))).toEqual([]);
    expect(s.w.cancels).toEqual([]);
    expect(s.w.toolCalls).toEqual([]);
    expect((await s.get()).lastFiredOccurrence).toBe(PREVIOUS);
  }, 30_000);

  it.each(LABELS)("(b) a run this schedule started, held at the next occurrence: one cancel, then one new fire (%s)", async (label) => {
    const s = begin(label, "b");
    await s.turnOnAndDue();
    expect(await s.check()).toEqual({ action: "started" });
    const runId = (await s.get()).lastStartedRunId!;
    s.w.setClock(DUE + DAY);
    await s.w.setBusy({ busy: true, holder: runId, awaitingDecision: true });
    expect(await s.check()).toEqual({ action: "replaced" });
    expect(await s.check()).toEqual({ action: "none" });
    await eventually(() => s.w.cancels, (c) => c.length >= 1, { label: "cancel send" });
    expect(s.w.cancels).toEqual([{ runId, reason: "superseded_by_schedule" }]);
    expect(s.w.toolCalls).toHaveLength(1);
    await s.w.setBusy({ busy: false });
    expect(await s.check()).toEqual({ action: "started" });
    expect(s.w.toolCalls).toHaveLength(2);
    await settle(500);
    expect(s.w.cancels).toHaveLength(1);
  }, 30_000);

  it.each(LABELS)("(b2) a run past the gate is not cancelled; the occurrence waits (%s)", async (label) => {
    const s = begin(label, "b2");
    await s.turnOnAndDue();
    await s.check();
    const runId = (await s.get()).lastStartedRunId!;
    s.w.setClock(DUE + DAY);
    await s.w.setBusy({ busy: true, holder: runId, awaitingDecision: false });
    expect(await s.check()).toEqual({ action: "none" });
    expect(s.w.calls().filter((c) => c.startsWith("replace"))).toEqual([]);
    expect(s.w.cancels).toEqual([]);
    expect(s.w.toolCalls).toHaveLength(1);
  }, 30_000);

  it.each(LABELS)("(g) a run a person accepted is never replaced: the hold is gone, so the schedule only waits (%s)", async (label) => {
    const s = begin(label, "g");
    await s.turnOnAndDue();
    await s.check();
    const runId = (await s.get()).lastStartedRunId!;
    s.w.setClock(DUE + DAY);
    await s.w.setBusy({ busy: true, holder: runId, awaitingDecision: true });
    const baseUrl = envs.get(label)!.baseUrl();
    await callObject(baseUrl, "KgRepo", slugOf(s.w.key), "decide", { action: "accept", actor: "ada@example.com", triggerId: runId });
    await eventually(() => s.w.cancels, (c) => c.length >= 1, { label: "resumed run started" });
    expect(await s.check()).toEqual({ action: "none" });
    expect(s.w.calls().filter((c) => c.startsWith("replace"))).toEqual([]);
    await settle(500);
    // Only the accept's own resume was recorded, with no superseded reason.
    expect(s.w.cancels).toEqual([{ runId, reason: undefined }]);
    expect(s.w.toolCalls).toHaveLength(1);
  }, 30_000);

  it.each(LABELS)("(c) a PR-check dry run holding the lease is not cancelled and nothing fires (%s)", async (label) => {
    const s = begin(label, "c");
    await s.turnOnAndDue();
    // A dry run waits on its PR check, not at the decision gate; its trigger id is not a schedule run.
    await s.w.setBusy({ busy: true, holder: "dry-run-1", awaitingDecision: false });
    expect(await s.check()).toEqual({ action: "none" });
    expect(s.w.calls().filter((c) => c.startsWith("replace"))).toEqual([]);
    expect(s.w.cancels).toEqual([]);
    expect(s.w.toolCalls).toEqual([]);
  }, 30_000);

  it.each(LABELS)("(d) 409 deploy-in-progress leaves the occurrence due (%s)", async (label) => {
    const s = begin(label, "d");
    await s.turnOnAndDue();
    s.w.toolAnswers.push({ status: 409, body: { error: "deploy-in-progress" } });
    expect(await s.check()).toEqual({ action: "busy" });
    expect((await s.get()).lastFiredOccurrence).toBe(PREVIOUS);
    expect(await s.check()).toEqual({ action: "started" });
    expect(s.w.toolCalls).toHaveLength(2);
  }, 30_000);

  it.each(LABELS)("(e) 422 preflight-failed counts as fired, refused, with no second call (%s)", async (label) => {
    const s = begin(label, "e");
    await s.turnOnAndDue();
    s.w.toolAnswers.push({ status: 422, body: { error: "preflight-failed", detail: "token mint 403" } });
    expect(await s.check()).toEqual({ action: "refused" });
    expect(await s.check()).toEqual({ action: "none" });
    const state = await s.get();
    expect(state.lastFiredOccurrence).toBe(OCCURRENCE);
    expect(state.lastResult?.outcome).toBe("refused");
    expect(state.lastResult?.detail).toContain("preflight-failed");
    expect(state.lastResult?.detail).toContain("token mint 403");
    expect(s.w.toolCalls).toHaveLength(1);
  }, 30_000);

  it.each(LABELS)("(f) the fire carries the system caller and empty args; an isError result is refused (%s)", async (label) => {
    const s = begin(label, "f");
    await s.turnOnAndDue();
    s.w.toolAnswers.push("is-error");
    expect(await s.check()).toEqual({ action: "refused" });
    expect(s.w.toolCalls).toHaveLength(1);
    expect(s.w.toolCalls[0].caller.kind).toBe("system");
    expect(s.w.toolCalls[0].args).toEqual({});
    expect((await s.get()).lastResult?.detail).toContain("tool failed");
  }, 30_000);
});
