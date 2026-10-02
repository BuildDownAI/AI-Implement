// Real Restate coverage for the shared owned-run wait (src/restate/owned-run-wait.ts, AII-1039,
// ADR 034). A fixture workflow calls awaitOwnedRun in the three case shapes of AII-1037
// (kg-refresh, planning, review-fix) on both variants. Each deadline scenario holds the workflow
// at a gate inside readStatus until the deadline has passed, so the deadline decision is the
// thing under test. Timing uses eventually/waitForStep/gate from harness.ts, never a raw sleep.
//
// Run with `npm run test:restate`; excluded from `npm test`.
import * as restate from "@restatedev/restate-sdk";
import type { WorkflowContext, WorkflowSharedContext } from "@restatedev/restate-sdk";
import type { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { awaitOwnedRun, type OwnedRunEvent, type OwnedRunStatus } from "../../restate/owned-run-wait.js";
import { VARIANTS, callWorkflow, eventually, gate, startVariants, stopAll, waitForStep, type Gate } from "./harness.js";

type Shape = "kg-refresh" | "planning" | "review-fix";

interface FixtureInput {
  shape: Shape;
  tickMs: number;
  bootstrapMs?: number;
  totalMs: number;
  /** Start the first call with startedSeen already true. */
  startedSeen?: boolean;
  /** After the first event, call again (a second phase), keeping startedSeen. */
  secondCall?: boolean;
  /** Park in a journaled step before the wait, so the wait starts after the deadline has passed. */
  holdBeforeWait?: boolean;
}

interface FixtureResult {
  events: OwnedRunEvent[];
  /** ctx.promise calls made by the helper in the final attempt, across every call. */
  promiseCalls: number;
}

interface FixtureStatus {
  step: string | null;
  bootstrapDeadlineAt: number | null;
  totalDeadlineAt: number | null;
}

const SIGNALS: Record<Shape, string[]> = {
  "kg-refresh": ["report", "cancel", "progress"],
  planning: ["report"],
  "review-fix": ["report", "cancel"],
};

// In-process fakes the workflow's readStatus reads, keyed by workflow key. The endpoint runs in
// this process, so a test sets the script before it starts the workflow.
const statusScripts = new Map<string, (call: number) => Promise<OwnedRunStatus>>();
const statusCalls = new Map<string, number>();
// Gates a workflow parks on before it calls the helper, keyed by workflow key.
const holdGates = new Map<string, Gate>();

const fixture = restate.workflow({
  name: "OwnedRunWaitFixture",
  handlers: {
    run: async (ctx: WorkflowContext, input: FixtureInput): Promise<FixtureResult> => {
      let promiseCalls = 0;
      const counting = new Proxy(ctx, {
        get(target, prop) {
          const value = Reflect.get(target, prop) as unknown;
          if (prop === "promise") {
            return (name: string) => {
              promiseCalls += 1;
              return target.promise(name);
            };
          }
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      }) as WorkflowContext;

      const startedAt = await ctx.date.now();
      const bootstrapDeadlineAt = input.bootstrapMs === undefined ? undefined : startedAt + input.bootstrapMs;
      const totalDeadlineAt = startedAt + input.totalMs;
      ctx.set("bootstrapDeadlineAt", bootstrapDeadlineAt ?? null);
      ctx.set("totalDeadlineAt", totalDeadlineAt);
      ctx.set("step", "waiting");

      const key = ctx.key;
      let statusIndex = 0;
      const readStatus = input.shape === "review-fix"
        ? undefined
        : async (): Promise<OwnedRunStatus> => {
            const index = statusIndex++;
            return ctx.run(`status-${index}`, async () => {
              statusCalls.set(key, (statusCalls.get(key) ?? 0) + 1);
              const script = statusScripts.get(key);
              return script ? script(index) : "unknown";
            });
          };

      if (input.holdBeforeWait) {
        await ctx.run("hold-before-wait", async () => {
          await holdGates.get(key)?.wait();
        });
      }

      const events: OwnedRunEvent[] = [];
      let startedSeen = input.startedSeen ?? false;
      for (let call = 0; call < (input.secondCall ? 2 : 1); call++) {
        const event = await awaitOwnedRun(counting, {
          signals: SIGNALS[input.shape],
          resultSignal: "report",
          startedSignal: input.shape === "kg-refresh" ? "progress" : undefined,
          bootstrapDeadlineAt,
          totalDeadlineAt,
          tickMs: input.tickMs,
          readStatus,
          startedSeen,
        });
        events.push(event);
        if ((event.kind === "status" && event.status === "started") || (event.kind === "signal" && event.name === "progress")) {
          startedSeen = true;
        }
      }
      ctx.set("step", "done");
      return { events, promiseCalls };
    },
    report: restate.handlers.workflow.shared(async (ctx: WorkflowSharedContext, body: unknown) => {
      ctx.promise("report").resolve(body ?? { ok: true });
    }),
    cancel: restate.handlers.workflow.shared(async (ctx: WorkflowSharedContext, body: unknown) => {
      ctx.promise("cancel").resolve(body ?? "cancelled");
    }),
    progress: restate.handlers.workflow.shared(async (ctx: WorkflowSharedContext, body: unknown) => {
      ctx.promise("progress").resolve(body ?? true);
    }),
    status: restate.handlers.workflow.shared(async (ctx: WorkflowSharedContext): Promise<FixtureStatus> => ({
      step: (await ctx.get<string>("step")) ?? null,
      bootstrapDeadlineAt: (await ctx.get<number | null>("bootstrapDeadlineAt")) ?? null,
      totalDeadlineAt: (await ctx.get<number>("totalDeadlineAt")) ?? null,
    })),
  },
});

describe("awaitOwnedRun (Restate)", () => {
  let environments: Map<string, RestateTestEnvironment>;
  let counter = 0;

  beforeAll(async () => {
    environments = await startVariants([fixture]);
  }, 60_000);

  afterAll(async () => {
    await stopAll(environments);
  });

  function envFor(label: string): RestateTestEnvironment {
    const env = environments.get(label);
    if (!env) throw new Error(`environment "${label}" did not start`);
    return env;
  }

  /** Starts the fixture and waits for it to reach its wait. `done` settles with the result. */
  async function begin(
    label: string,
    input: FixtureInput,
    script?: (call: number) => Promise<OwnedRunStatus>,
    // A scenario that ends on its first tick can finish before "waiting" is observed.
    opts: { endsImmediately?: boolean } = {},
  ) {
    const baseUrl = envFor(label).baseUrl();
    const key = `wait-${label}-${counter++}`;
    if (input.holdBeforeWait) holdGates.set(key, gate("hold before wait"));
    if (script) statusScripts.set(key, script);
    const done = callWorkflow<FixtureResult>(baseUrl, "OwnedRunWaitFixture", key, "run", input);
    const read = () => callWorkflow<FixtureStatus>(baseUrl, "OwnedRunWaitFixture", key, "status");
    if (!opts.endsImmediately) await waitForStep(read, "waiting");
    const send = (signal: "report" | "cancel" | "progress", body: unknown = undefined) =>
      callWorkflow(baseUrl, "OwnedRunWaitFixture", key, signal, body ?? {});
    const hold = holdGates.get(key);
    return { key, done, read, send, hold };
  }

  /** Waits until the wall clock is past the named deadline of the running fixture. */
  async function pastDeadline(read: () => Promise<FixtureStatus>, which: "bootstrapDeadlineAt" | "totalDeadlineAt"): Promise<void> {
    const status = await read();
    const at = status[which];
    if (at === null) throw new Error(`no ${which} on this fixture`);
    await eventually(() => Date.now(), (now) => now > at, { label: `wall clock past ${which}` });
  }

  /** A script whose first status read parks on the returned gate, then answers `unknown`. */
  function gated(label: string): { script: (call: number) => Promise<OwnedRunStatus>; held: Gate } {
    const held = gate(label);
    return {
      held,
      script: async (call) => {
        if (call === 0) await held.wait();
        return "unknown";
      },
    };
  }

  const labels = VARIANTS.map(([label]) => label);
  const KG = { shape: "kg-refresh", tickMs: 50, bootstrapMs: 400, totalMs: 4_000 } as const;

  describe("kg-refresh shape", () => {
    it.each(labels)("report wins (%s)", async (label) => {
      const run = await begin(label, KG);
      await run.send("report", { ok: true });
      const result = await run.done;
      expect(result.events).toEqual([{ kind: "signal", name: "report", value: { ok: true } }]);
    });

    it.each(labels)("cancel wins (%s)", async (label) => {
      const run = await begin(label, KG);
      await run.send("cancel", "operator");
      const result = await run.done;
      expect(result.events).toEqual([{ kind: "signal", name: "cancel", value: "operator" }]);
    });

    it.each(labels)("progress wins (%s)", async (label) => {
      const run = await begin(label, KG);
      await run.send("progress", true);
      const result = await run.done;
      expect(result.events).toEqual([{ kind: "signal", name: "progress", value: true }]);
    });

    it.each(labels)("status started moves the wait past the bootstrap deadline (%s)", async (label) => {
      const held = gate("second-call status read");
      const run = await begin(label, { ...KG, secondCall: true }, async (call) => {
        if (call === 0) return "started";
        if (call === 1) await held.wait();
        return "unknown";
      });
      // The second call has startedSeen, so the bootstrap deadline no longer applies.
      await held.reached();
      await pastDeadline(run.read, "bootstrapDeadlineAt");
      await run.send("report", { ok: true });
      held.release();
      const result = await run.done;
      expect(result.events).toEqual([
        { kind: "status", status: "started" },
        { kind: "signal", name: "report", value: { ok: true } },
      ]);
    });

    it.each(labels)("status ended (%s)", async (label) => {
      const run = await begin(label, KG, async () => "ended", { endsImmediately: true });
      const result = await run.done;
      expect(result.events).toEqual([{ kind: "status", status: "ended" }]);
    });

    it.each(labels)("a bootstrap timeout with no signal and no started evidence (%s)", async (label) => {
      const { script, held } = gated("bootstrap timeout");
      const run = await begin(label, KG, script);
      await held.reached();
      await pastDeadline(run.read, "bootstrapDeadlineAt");
      held.release();
      const result = await run.done;
      expect(result.events).toEqual([{ kind: "bootstrap_timeout" }]);
    });

    it.each(labels)("started evidence at the bootstrap deadline is reported as started, not a timeout (%s)", async (label) => {
      const { script, held } = gated("started at bootstrap deadline");
      const run = await begin(label, KG, script);
      await held.reached();
      await pastDeadline(run.read, "bootstrapDeadlineAt");
      await run.send("progress", true);
      held.release();
      const result = await run.done;
      expect(result.events).toEqual([{ kind: "status", status: "started" }]);
    });

    it.each(labels)("a total timeout once started evidence is known (%s)", async (label) => {
      const { script, held } = gated("total timeout");
      const run = await begin(label, { ...KG, bootstrapMs: 100, totalMs: 500, startedSeen: true }, script);
      await held.reached();
      await pastDeadline(run.read, "totalDeadlineAt");
      held.release();
      const result = await run.done;
      expect(result.events).toEqual([{ kind: "total_timeout" }]);
    });

    it.each(labels)("a report resolved while the gate holds the tick past the bootstrap deadline wins (%s)", async (label) => {
      const { script, held } = gated("report past bootstrap deadline");
      const run = await begin(label, KG, script);
      await held.reached();
      await pastDeadline(run.read, "bootstrapDeadlineAt");
      await run.send("report", { ok: true });
      held.release();
      const result = await run.done;
      expect(result.events).toEqual([{ kind: "signal", name: "report", value: { ok: true } }]);
    });

    it.each(labels)("a report resolved while the gate holds the tick past the total deadline wins (%s)", async (label) => {
      const { script, held } = gated("report past total deadline");
      const run = await begin(label, { ...KG, bootstrapMs: 100, totalMs: 500, startedSeen: true }, script);
      await held.reached();
      await pastDeadline(run.read, "totalDeadlineAt");
      await run.send("report", { ok: true });
      held.release();
      const result = await run.done;
      expect(result.events).toEqual([{ kind: "signal", name: "report", value: { ok: true } }]);
    });

    it.each(labels)("the signal arms are created once per call, not once per tick (%s)", async (label) => {
      const run = await begin(label, { ...KG, tickMs: 20, bootstrapMs: undefined, totalMs: 30_000 });
      await eventually(() => statusCalls.get(run.key) ?? 0, (calls) => calls >= 4, { label: "four ticks" });
      await run.send("report", { ok: true });
      const result = await run.done;
      expect(result.events).toHaveLength(1);
      expect(result.promiseCalls).toBe(SIGNALS["kg-refresh"].length);
    });
  });

  describe("planning shape", () => {
    const PLANNING = { shape: "planning", tickMs: 50, totalMs: 4_000 } as const;

    it.each(labels)("report wins (%s)", async (label) => {
      const run = await begin(label, PLANNING);
      await run.send("report", { ok: true });
      const result = await run.done;
      expect(result.events).toEqual([{ kind: "signal", name: "report", value: { ok: true } }]);
    });

    it.each(labels)("a second call after report returns ended (%s)", async (label) => {
      const run = await begin(label, { ...PLANNING, secondCall: true }, async (call) => (call === 0 ? "unknown" : "ended"));
      await run.send("report", { ok: true });
      const result = await run.done;
      expect(result.events).toEqual([
        { kind: "signal", name: "report", value: { ok: true } },
        { kind: "status", status: "ended" },
      ]);
    });

    it.each(labels)("a report resolved while the gate holds the tick past the total deadline wins (%s)", async (label) => {
      const { script, held } = gated("planning report past total deadline");
      const run = await begin(label, { ...PLANNING, totalMs: 400 }, script);
      await held.reached();
      await pastDeadline(run.read, "totalDeadlineAt");
      await run.send("report", { ok: true });
      held.release();
      const result = await run.done;
      expect(result.events).toEqual([{ kind: "signal", name: "report", value: { ok: true } }]);
    });

    it.each(labels)("total timeout (%s)", async (label) => {
      const { script, held } = gated("planning total timeout");
      const run = await begin(label, { ...PLANNING, totalMs: 400 }, script);
      await held.reached();
      await pastDeadline(run.read, "totalDeadlineAt");
      held.release();
      const result = await run.done;
      expect(result.events).toEqual([{ kind: "total_timeout" }]);
    });
  });

  describe("review-fix shape", () => {
    const REVIEW_FIX = { shape: "review-fix", tickMs: 50, totalMs: 4_000 } as const;

    it.each(labels)("report wins, with no status read (%s)", async (label) => {
      const run = await begin(label, REVIEW_FIX);
      await run.send("report", { ok: true });
      const result = await run.done;
      expect(result.events).toEqual([{ kind: "signal", name: "report", value: { ok: true } }]);
      expect(statusCalls.get(run.key)).toBeUndefined();
    });

    it.each(labels)("cancel wins (%s)", async (label) => {
      const run = await begin(label, REVIEW_FIX);
      await run.send("cancel", "operator");
      const result = await run.done;
      expect(result.events).toEqual([{ kind: "signal", name: "cancel", value: "operator" }]);
    });

    // No status read, so the workflow parks in a journaled step before the wait instead.
    it.each(labels)("a report resolved before the wait starts past the total deadline wins (%s)", async (label) => {
      const run = await begin(label, { ...REVIEW_FIX, totalMs: 400, holdBeforeWait: true });
      await run.hold!.reached();
      await pastDeadline(run.read, "totalDeadlineAt");
      await run.send("report", { ok: true });
      run.hold!.release();
      const result = await run.done;
      expect(result.events).toEqual([{ kind: "signal", name: "report", value: { ok: true } }]);
    });

    it.each(labels)("total timeout (%s)", async (label) => {
      const run = await begin(label, { ...REVIEW_FIX, totalMs: 400 });
      const result = await run.done;
      expect(result.events).toEqual([{ kind: "total_timeout" }]);
    });
  });
});
