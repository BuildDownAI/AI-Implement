// Real Restate coverage for the PipelineSchedule object (AII-1431, ADR 042). One fake pipeline per
// contract key; the shared contract suite runs against it on both variants. `set` is ingressPrivate,
// so a forwarder service plays the part of the writer tool (step 3 of AII-1403).
//
// Run with `npm run test:restate`; excluded from `npm test`.
import * as restate from "@restatedev/restate-sdk";
import { afterAll, beforeAll } from "vitest";
import type { BusyRead, FireAnswer, ScheduledPipeline } from "../../restate/pipeline-schedule.js";
import { createPipelineSchedule } from "../../restate/pipeline-schedule.js";
import type { RestateEnvironment } from "./harness.js";
import { callService, crashAfterFirstCall, startVariants, stopAll } from "./harness.js";
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

let envs: Map<string, RestateEnvironment>;

beforeAll(async () => {
  const keys = pipelineScheduleContractKeys();
  const schedule = createPipelineSchedule({
    pipelines: Object.fromEntries(keys.map((k) => [k, fakePipeline(k)])),
    now: async (ctx) => worldFor(ctx.key).clock,
  });
  envs = await startVariants([schedule, scheduleCaller]);
}, 60_000);

afterAll(async () => {
  await stopAll(envs);
});

registerPipelineScheduleContract(adapter, (label) => envs.get(label)!);
