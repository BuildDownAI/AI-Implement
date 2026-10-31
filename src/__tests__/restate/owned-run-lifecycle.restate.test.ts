// Real Restate coverage for the owned-run lifecycle kit (src/restate/owned-run-lifecycle.ts,
// AII-1062, ADR 036). A small fixture workflow uses the four kit functions and awaitOwnedRun, and
// the shared contract suite runs against it on both variants. The fixture's effects are in-process
// fakes keyed by workflow key that record every call.
//
// Run with `npm run test:restate`; excluded from `npm test`.
import * as restate from "@restatedev/restate-sdk";
import type { WorkflowContext, WorkflowSharedContext } from "@restatedev/restate-sdk";
import type { RestateEnvironment } from "./harness.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { acceptOwnedRunReport, cleanupOwnedRun, readOwnedRunStatus, reportOwnedRunOutcome, reserveOwnedRun } from "../../restate/owned-run-lifecycle.js";
import { awaitOwnedRun, type OwnedRunStatus } from "../../restate/owned-run-wait.js";
import { registerOwnedRunContract, type OwnedRunAdapter, type OwnedRunFaults } from "./owned-run-contract.js";
import { VARIANTS, callWorkflow, crashAfterFirstCall, eventually, gate, type Gate, startVariants, stopAll } from "./harness.js";

interface FixtureInput {
  totalMs: number;
}

interface World {
  calls: string[];
  faults: OwnedRunFaults;
  reserved: boolean;
  accepted: number;
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
  const w: World = { calls: [], faults, accepted: 0, reserved: false, runId: null, launch: async () => "" };
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
    report: restate.handlers.workflow.shared(async (ctx: WorkflowSharedContext, value: unknown) =>
      acceptOwnedRunReport(ctx, "report", value, () => { world(ctx.key).accepted++; })),
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
      report: (value) => callWorkflow(baseUrl, "OwnedRunLifecycleFixture", key, "report", value),
      acceptedCount: () => world(key).accepted,
      finish: async () => {
        await callWorkflow(baseUrl, "OwnedRunLifecycleFixture", key, "report");
      },
    };
  },
  calls: (key) => [...world(key).calls],
};

let environments: Map<string, RestateEnvironment>;

beforeAll(async () => {
  environments = await startVariants([fixture, intakeFixture]);
}, 60_000);

afterAll(async () => {
  await stopAll(environments);
});

registerOwnedRunContract(adapter, (label) => {
  const env = environments.get(label);
  if (!env) throw new Error(`environment "${label}" did not start`);
  return env;
});

// Isolated intake fixture exposes the promise without starting an owning run.
const intakeWorlds = new Map<string, { count: number; attempts: number; crashed: boolean; fail?: boolean; crash?: boolean; gate?: Gate; resolveChecks?: number; claimants?: Set<string> }>();
const intakeFixture = restate.workflow({
  name: "OwnedRunIntakeFixture",
  handlers: {
    run: async (ctx: WorkflowContext) => ctx.promise("report"),
    report: restate.handlers.workflow.shared({ retryPolicy: { maxAttempts: 3, initialInterval: 10 } }, async (ctx: WorkflowSharedContext, input: { value: unknown; omit?: boolean }) => {
      const w = intakeWorlds.get(ctx.key)!;
      // Throw precisely after the successful record-usage step, before ResolvePromise is issued.
      const wrapped = new Proxy(ctx, {
        get(target, property) {
          if (property === "promise") return (name: string) => {
            const promise = target.promise(name);
            return new Proxy(promise, {
              get(p, prop) {
                if (prop === "resolve" && name === "owned-run-report-owner:report") return async (value: string) => {
                  w.claimants?.add(value);
                  return p.resolve(value);
                };
                if (prop === "resolve" && name === "report") return async (value: unknown) => {
                  expect(w.count).toBe(input.omit ? 0 : 1);
                  w.resolveChecks = (w.resolveChecks ?? 0) + 1;
                  if (w.crash && !w.crashed) { w.crashed = true; throw new Error("crash after record-usage"); }
                  return p.resolve(value);
                };
                const result = Reflect.get(p, prop);
                return typeof result === "function" ? result.bind(p) : result;
              },
            });
          };
          const result = Reflect.get(target, property);
          return typeof result === "function" ? result.bind(target) : result;
        },
      });
      return acceptOwnedRunReport(wrapped, "report", input.value, input.omit ? undefined : async () => {
        w.attempts++;
        if (w.fail) throw new Error("usage storage unavailable");
        await w.gate?.wait();
        w.count++;
      });
    }),
    peek: restate.handlers.workflow.shared(async (ctx: WorkflowSharedContext) => {
      const value = await ctx.promise("report").peek();
      return { resolved: value !== undefined, value: value ?? null };
    }),
  },
});

it.each(VARIANTS)("intake JSON states, omitted callback, crash recovery and exhausted storage (%s)", async (label) => {
  const baseUrl = environments.get(label)!.baseUrl();
  for (const [index, value] of [null, [1, 2], { nested: { z: 1, a: 2 } }].entries()) {
    const key = `json-${label}-${index}`;
    const w = { count: 0, attempts: 0, crashed: false };
    intakeWorlds.set(key, w);
    const report = (value: unknown) => callWorkflow(baseUrl, "OwnedRunIntakeFixture", key, "report", { value });
    expect(await report(value)).toEqual({ status: "accepted" });
    expect(await callWorkflow(baseUrl, "OwnedRunIntakeFixture", key, "peek")).toEqual({ resolved: true, value });
    expect(w.count).toBe(1);
    expect(await report(index === 2 ? { nested: { a: 2, z: 1 } } : value)).toEqual({ status: "duplicate" });
    await expect(report(index === 1 ? [2, 1] : "different")).rejects.toThrow(/409/);
    expect(w.count).toBe(1);
  }
  for (const mode of ["omit", "crash", "fail"] as const) {
    const key = `${mode}-${label}`;
    const w = { count: 0, attempts: 0, crashed: false, resolveChecks: 0, crash: mode === "crash", fail: mode === "fail" };
    intakeWorlds.set(key, w);
    const result = callWorkflow(baseUrl, "OwnedRunIntakeFixture", key, "report", { value: { ok: true }, omit: mode === "omit" });
    if (mode === "fail") {
      await expect(result).rejects.toThrow();
      expect(w.attempts).toBe(3);
      expect(await callWorkflow(baseUrl, "OwnedRunIntakeFixture", key, "peek")).toEqual({ resolved: false, value: null });
      w.fail = false;
      const recoveredValue = { recovered: true };
      expect(await callWorkflow(baseUrl, "OwnedRunIntakeFixture", key, "report", { value: recoveredValue })).toEqual({ status: "accepted" });
      expect(w.count).toBe(1);
      expect(w.attempts).toBe(4);
      expect(await callWorkflow(baseUrl, "OwnedRunIntakeFixture", key, "peek")).toEqual({ resolved: true, value: recoveredValue });
      expect(await callWorkflow(baseUrl, "OwnedRunIntakeFixture", key, "report", { value: recoveredValue })).toEqual({ status: "duplicate" });
      expect(w.count).toBe(1);
    } else {
      expect(await result).toEqual({ status: "accepted" });
      expect(w.count).toBe(mode === "omit" ? 0 : 1);
      expect(w.crashed).toBe(mode === "crash");
      expect(w.resolveChecks).toBeGreaterThanOrEqual(mode === "crash" ? 2 : 1);
      expect(await callWorkflow(baseUrl, "OwnedRunIntakeFixture", key, "peek")).toEqual({ resolved: true, value: { ok: true } });
    }
  }
}, 60_000);


it.each(VARIANTS)("concurrent equal and different reports record once (%s)", async (label) => {
  const baseUrl = environments.get(label)!.baseUrl();
  for (const different of [false, true]) {
    const key = `concurrent-${label}-${different}`;
    const callbackGate = gate(`record-usage ${key}`);
    const w = { count: 0, attempts: 0, crashed: false, gate: callbackGate, claimants: new Set<string>() };
    intakeWorlds.set(key, w);
    const report = (value: unknown) => callWorkflow(baseUrl, "OwnedRunIntakeFixture", key, "report", { value });
    const first = report({ tokens: 1 });
    await callbackGate.reached();
    // Start the contender while the winner is still inside its recording step.
    const second = report({ tokens: different ? 2 : 1 });
    const settled = Promise.allSettled([first, second]);
    try {
      await eventually(() => w.claimants.size, (size) => size === 2, { label: "both concurrent reports claiming intake" });
      expect(await callWorkflow(baseUrl, "OwnedRunIntakeFixture", key, "peek")).toEqual({ resolved: false, value: null });
      expect(w.count).toBe(0);
    } finally {
      callbackGate.release();
    }
    const outcomes = await settled;
    expect(outcomes[0]).toEqual({ status: "fulfilled", value: { status: "accepted" } });
    if (different) {
      expect(outcomes[1].status).toBe("rejected");
      if (outcomes[1].status === "rejected") expect(String(outcomes[1].reason)).toMatch(/409/);
    } else {
      expect(outcomes[1]).toEqual({ status: "fulfilled", value: { status: "duplicate" } });
    }
    expect(w.count).toBe(1);
    expect(w.attempts).toBe(1);
    expect(await callWorkflow(baseUrl, "OwnedRunIntakeFixture", key, "peek")).toEqual({ resolved: true, value: { tokens: 1 } });
  }
});
