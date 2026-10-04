// Real Restate coverage for the owned-run lifecycle kit (src/restate/owned-run-lifecycle.ts,
// AII-1062, ADR 036). A small fixture workflow uses the four kit functions and awaitOwnedRun, and
// the shared contract suite runs against it on both variants. The fixture's effects are in-process
// fakes keyed by workflow key that record every call.
//
// Run with `npm run test:restate`; excluded from `npm test`.
import * as restate from "@restatedev/restate-sdk";
import type { WorkflowContext, WorkflowSharedContext } from "@restatedev/restate-sdk";
import type { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll } from "vitest";
import { cleanupOwnedRun, readOwnedRunStatus, reportOwnedRunOutcome, reserveOwnedRun } from "../../restate/owned-run-lifecycle.js";
import { awaitOwnedRun, type OwnedRunStatus } from "../../restate/owned-run-wait.js";
import { registerOwnedRunContract, type OwnedRunAdapter, type OwnedRunFaults } from "./owned-run-contract.js";
import { callWorkflow, crashAfterFirstCall, startVariants, stopAll } from "./harness.js";

interface FixtureInput {
  totalMs: number;
}

interface World {
  calls: string[];
  faults: OwnedRunFaults;
  reserved: boolean;
  runId: string | null;
  launch: () => Promise<string>;
}

const worlds = new Map<string, World>();

function world(key: string): World {
  const found = worlds.get(key);
  if (!found) throw new Error(`no world for ${key}`);
  return found;
}

function newWorld(key: string, faults: OwnedRunFaults): World {
  const w: World = { calls: [], faults, reserved: false, runId: null, launch: async () => "" };
  const launch = async (): Promise<string> => {
    w.calls.push("launch");
    w.runId = runIdFor(key);
    return w.runId;
  };
  w.launch = faults.crashAfterLaunch ? crashAfterFirstCall(launch) : launch;
  return w;
}

const runIdFor = (key: string) => `run-${key}`;

const fixture = restate.workflow({
  name: "OwnedRunLifecycleFixture",
  handlers: {
    run: async (ctx: WorkflowContext, input: FixtureInput): Promise<{ outcome: string }> => {
      const w = world(ctx.key);

      // The reservation is idempotent per key, so a retry after a commit still answers true.
      const held = await reserveOwnedRun(ctx, async () => {
        w.calls.push("reserve");
        if (w.faults.refuseReservation) return false;
        w.reserved = true;
        return true;
      });
      if (!held) return { outcome: "refused" };

      // Check, then launch, in one step: a retry after a crash adopts the run the first try started.
      const runId = await ctx.run("launch", async () => w.runId ?? (await w.launch()), { maxRetryAttempts: 3 });

      const totalDeadlineAt = (await ctx.date.now()) + input.totalMs;
      ctx.set("step", "waiting");
      let reads = 0;
      const event = await awaitOwnedRun(ctx, {
        signals: ["report"],
        resultSignal: "report",
        totalDeadlineAt,
        tickMs: 50,
        readStatus: () =>
          readOwnedRunStatus(ctx, `status-${reads++}`, async (): Promise<OwnedRunStatus> => {
            w.calls.push("status");
            if (w.faults.failStatusRead) throw new Error("injected status read failure");
            return "unknown";
          }),
      });

      let outcome = "reported";
      if (event.kind !== "signal") {
        await ctx.run("stop", async () => {
          w.calls.push("stop");
        });
        outcome = "timed_out";
      }

      await cleanupOwnedRun(ctx, async () => {
        w.calls.push(`cleanup:${runId}`);
        if (w.faults.failCleanup) throw new Error("injected cleanup failure");
      });
      await reportOwnedRunOutcome(ctx, async () => {
        w.calls.push("outcome");
        if (w.faults.failOutcome) throw new Error("injected outcome failure");
      });
      await ctx.run("release", async () => {
        w.calls.push("release");
      });
      ctx.set("step", "done");
      return { outcome };
    },
    report: restate.handlers.workflow.shared(async (ctx: WorkflowSharedContext) => {
      ctx.promise("report").resolve({ ok: true });
    }),
    status: restate.handlers.workflow.shared(async (ctx: WorkflowSharedContext) => ({
      step: (await ctx.get<string>("step")) ?? null,
    })),
  },
});

const adapter: OwnedRunAdapter = {
  name: "OwnedRunLifecycleFixture",
  start(baseUrl, key, { faults, totalMs }) {
    worlds.set(key, newWorld(key, faults));
    return {
      runId: runIdFor(key),
      done: callWorkflow(baseUrl, "OwnedRunLifecycleFixture", key, "run", { totalMs } satisfies FixtureInput),
      read: () => callWorkflow<{ step: string | null }>(baseUrl, "OwnedRunLifecycleFixture", key, "status"),
      finish: async () => {
        await callWorkflow(baseUrl, "OwnedRunLifecycleFixture", key, "report");
      },
    };
  },
  calls: (key) => [...world(key).calls],
};

let environments: Map<string, RestateTestEnvironment>;

beforeAll(async () => {
  environments = await startVariants([fixture]);
}, 60_000);

afterAll(async () => {
  await stopAll(environments);
});

registerOwnedRunContract(adapter, (label) => {
  const env = environments.get(label);
  if (!env) throw new Error(`environment "${label}" did not start`);
  return env;
});
