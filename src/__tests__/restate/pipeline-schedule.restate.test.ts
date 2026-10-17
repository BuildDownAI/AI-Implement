// Real Restate coverage for the PipelineSchedule object (AII-1431, ADR 042). One fake pipeline per
// contract key; the shared contract suite runs against it on both variants. `set` is ingressPrivate,
// so a forwarder service plays the part of the writer tool (step 3 of AII-1403).
//
// Run with `npm run test:restate`; excluded from `npm test`.
import * as restate from "@restatedev/restate-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BusyRead, FireAnswer, ScheduledPipeline } from "../../restate/pipeline-schedule.js";
import { createPipelineSchedule } from "../../restate/pipeline-schedule.js";
import type { RestateEnvironment } from "./harness.js";
import { VARIANTS, callObject, eventually, queryInvocations, callService, crashAfterFirstCall, startVariants, stopAll } from "./harness.js";
import { orchestratorTools, setKgRefreshToolDeps } from "../../restate/tools.js";
import type { PipelineScheduleAdapter, ScheduleWorld } from "./pipeline-schedule-contract.js";
import { pipelineScheduleContractKeys, registerPipelineScheduleContract } from "./pipeline-schedule-contract.js";

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

interface World extends ScheduleWorld {
  log: string[];
  clock: number;
  busyRead: BusyRead;
  /** The answer a crashed first attempt committed, adopted by the retry. */
  inflight: FireAnswer | null;
  launch: () => Promise<FireAnswer>;
}

const worlds = new Map<string, World>();

function newWorld(key: string): World {
  const queue: FireAnswer[] = [];
  let runs = 0;
  const launchOnce = async (): Promise<FireAnswer> => {
    w.log.push("fire");
    w.inflight = queue.shift() ?? { outcome: "started", runId: `run-${key}-${++runs}` };
    return w.inflight;
  };
  const w: World = {
    log: [],
    clock: 0,
    busyRead: { busy: false },
    inflight: null,
    launch: launchOnce,
    setClock: (ms) => {
      w.clock = ms;
    },
    setBusy: (read) => {
      w.busyRead = read;
    },
    queueFire: (...answers) => {
      queue.push(...answers);
    },
    crashAfterNextFire: () => {
      w.launch = crashAfterFirstCall(launchOnce);
    },
    calls: () => [...w.log],
  };
  worlds.set(key, w);
  return w;
}

const worldFor = (key: string): World => {
  const w = worlds.get(key);
  if (!w) throw new Error(`no world for ${key}`);
  return w;
};

function fakePipeline(key: string): ScheduledPipeline {
  return {
    busy: (ctx) =>
      ctx.run("busy", async () => {
        const w = worldFor(key);
        w.log.push("busy");
        return w.busyRead;
      }),
    replace: async (ctx, runId) => {
      await ctx.run("replace", async () => {
        worldFor(key).log.push(`replace:${runId}`);
      });
    },
    fire: async (ctx) => {
      const w = worldFor(key);
      // Check, then launch, in one step: a retry after a crash adopts the answer the first try committed.
      const answer = await ctx.run(
        "fire",
        async () => {
          return w.inflight ?? (await w.launch());
        },
        { maxRetryAttempts: 3 },
      );
      w.inflight = null;
      return answer;
    },
  };
}

const adapter: PipelineScheduleAdapter = {
  name: "fake pipeline",
  world: (key) => newWorld(key),
  set: (baseUrl, key, body) => callService(baseUrl, "PipelineSchedulePrivateCaller", "set", { key, body }),
};

const TOOL_KEYS = VARIANTS.flatMap(([label]) => [`tool-${label}-a`, `tool-${label}-b`, `tool-${label}-c`]);

let envs: Map<string, RestateEnvironment>;

beforeAll(async () => {
  const keys = [...pipelineScheduleContractKeys(), ...TOOL_KEYS];
  const schedule = createPipelineSchedule({
    pipelines: Object.fromEntries(keys.map((k) => [k, fakePipeline(k)])),
    now: async (ctx) => worldFor(ctx.key).clock,
  });
  envs = await startVariants([schedule, scheduleCaller, orchestratorTools]);
}, 60_000);

afterAll(async () => {
  await stopAll(envs);
});

registerPipelineScheduleContract(adapter, (label) => envs.get(label)!);

interface ToolResult { content?: Array<{ text: string }>; isError?: boolean }

const ADMIN = { kind: "human", email: "admin@example.com", role: "admin" };
const USER = { kind: "human", email: "user@example.com", role: "user" };

describe("schedule tools", () => {
  // The tools only check for a bound KG composition; a stub stands in for it.
  beforeAll(() => setKgRefreshToolDeps({} as Parameters<typeof setKgRefreshToolDeps>[0]));
  afterAll(() => setKgRefreshToolDeps(null));
  const labels = VARIANTS.map(([label]) => label);
  const url = (label: string): string => envs.get(label)!.baseUrl();
  const tool = (label: string, name: string, caller: unknown, args: unknown) =>
    callService<ToolResult>(url(label), "orchestratorTools", name, { caller, args });
  const read = async (label: string, pipeline: string) =>
    JSON.parse((await tool(label, "get_pipeline_schedule", USER, { pipeline })).content![0].text) as {
      pipeline: string;
      schedule: Record<string, unknown> | null;
      nextOccurrence: string | null;
    };
  const raw = (label: string, pipeline: string) => callObject<unknown>(url(label), "PipelineSchedule", pipeline, "get", undefined);

  it.each(labels)("a user is refused; an admin sets and get reads it back with a nextOccurrence (%s)", async (label) => {
    const key = `tool-${label}-a`;
    newWorld(key).setClock(Date.parse("2030-01-01T00:00:00Z"));
    const patch = { enabled: true, time: "03:00", zone: "America/Denver" };
    const refused = await tool(label, "set_pipeline_schedule", USER, { pipeline: key, patch });
    expect(refused.isError).toBe(true);
    expect(refused.content?.[0]?.text).toBe("forbidden: set_pipeline_schedule requires the admin role");
    expect(await raw(label, key)).toBeNull();

    const written = await tool(label, "set_pipeline_schedule", ADMIN, { pipeline: key, patch });
    expect(written.isError).toBeFalsy();
    const got = await read(label, key);
    expect(got.pipeline).toBe(key);
    expect(got.schedule).toMatchObject(patch);
    expect(got.schedule).not.toHaveProperty("nextOccurrence");
    expect(Date.parse(got.nextOccurrence!)).toBeGreaterThan(Date.parse("2030-01-01T00:00:00Z"));
  });

  it.each(labels)("bad time, bad zone, unknown pipeline, unknown field, and enabling without time answer 400 and change nothing (%s)", async (label) => {
    const key = `tool-${label}-b`;
    newWorld(key).setClock(Date.parse("2030-01-01T00:00:00Z"));
    const before = await raw(label, key);
    const refuse = async (pipeline: string, patch: unknown, match: RegExp) => {
      const res = await tool(label, "set_pipeline_schedule", ADMIN, { pipeline, patch });
      expect(res.isError).toBeFalsy();
      const body = JSON.parse(res.content![0].text) as { status: number; body: { error: string } };
      expect(body.status).toBe(400);
      expect(body.body.error).toMatch(match);
    };
    await refuse(key, { time: "3am" }, /time/);
    await refuse(key, { zone: "Mars/Base" }, /zone/);
    await refuse(key, { token: "x" }, /token|unrecognized/i);
    await refuse(key, { enabled: true }, /time and zone/);
    await refuse(`unknown-${label}`, { enabled: false }, /unknown pipeline/);
    expect(await raw(label, key)).toEqual(before);
  });

  it.each(labels)("get on an empty key answers a null schedule (%s)", async (label) => {
    const key = `tool-${label}-c`;
    newWorld(key);
    expect(await read(label, key)).toEqual({ pipeline: key, schedule: null, nextOccurrence: null });
  });
});

describe("schedule tools without the KG composition", () => {
  let bare: Map<string, RestateEnvironment>;
  beforeAll(async () => {
    setKgRefreshToolDeps(null);
    bare = await startVariants([orchestratorTools]);
  }, 60_000);
  afterAll(async () => {
    await stopAll(bare);
  });

  it.each(VARIANTS.map(([label]) => label))("answer without calling PipelineSchedule and strand nothing (%s)", async (label) => {
    const env = bare.get(label)!;
    const call = (name: string, caller: unknown, args: unknown) =>
      callService<ToolResult>(env.baseUrl(), "orchestratorTools", name, { caller, args });
    const text = (r: ToolResult) => JSON.parse(r.content![0].text) as unknown;

    expect(text(await call("get_pipeline_schedule", USER, { pipeline: "kg-refresh" }))).toEqual({
      pipeline: "kg-refresh",
      schedule: null,
      nextOccurrence: null,
      available: false,
    });
    const set = await call("set_pipeline_schedule", ADMIN, { pipeline: "kg-refresh", patch: { enabled: false } });
    expect(set.isError).toBeFalsy();
    expect(text(set)).toEqual({ status: 501, body: { error: "kg-source-repo-not-configured" } });

    const refused = await call("set_pipeline_schedule", USER, { pipeline: "kg-refresh", patch: { enabled: false } });
    expect(refused.isError).toBe(true);
    expect(refused.content?.[0]?.text).toBe("forbidden: set_pipeline_schedule requires the admin role");

    const admin = env.adminAPIBaseUrl();
    // The query must cover the tool calls: they show as completed, and nothing else is left running.
    await eventually(
      () => queryInvocations(admin, "target_service_name = 'orchestratorTools' AND status = 'completed'"),
      (rows) => rows.length >= 3,
    );
    await eventually(
      () => queryInvocations(admin, "status != 'completed'"),
      (rows) => rows.length === 0,
    );
  });
});
