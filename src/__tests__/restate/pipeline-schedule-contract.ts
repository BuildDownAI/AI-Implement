// The contract suite for a scheduled pipeline (AII-1431, ADR 042). A pipeline describes its fake
// with a PipelineScheduleAdapter and calls registerPipelineScheduleContract inside a describe block of
// its own `*.restate.test.ts` file. The file is not named `.test.ts`, so vitest does not collect it.
// Scenarios move the clock through the adapter's world and never sleep.
import type { BusyRead, FireAnswer } from "../../restate/pipeline-schedule.js";
import type { RestateEnvironment } from "./harness.js";
import { describe, expect, it } from "vitest";
import { VARIANTS, callObject } from "./harness.js";

/** One scenario's fake pipeline. `calls` records `busy`, `replace:<runId>`, and `fire`, one string per effect. */
export interface ScheduleWorld {
  /** The clock `deps.now` reads, in ms. */
  setClock(ms: number): void;
  /** What `busy` answers from now on. Default `{ busy: false }`. */
  setBusy(read: BusyRead): void;
  /** Queues answers for the next `fire` calls; once empty, `fire` answers `started` with a fresh run id. */
  queueFire(...answers: FireAnswer[]): void;
  /** The next `fire` commits its effect, then throws once, as if the caller crashed before seeing the answer. */
  crashAfterNextFire(): void;
  calls(): string[];
}

export interface PipelineScheduleAdapter {
  name: string;
  /** Makes a fresh world for `key` (one of `pipelineScheduleContractKeys()`). Called before the scenario's first request. */
  world(key: string): ScheduleWorld;
  /** Calls `set` through the ingressPrivate forwarder. */
  set(baseUrl: string, key: string, body: unknown): Promise<unknown>;
}

const SCENARIOS = 11;
const TIME = "03:00";
const ZONE = "UTC";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 02:00 UTC on 2026-10-14: the day's 03:00 occurrence is still ahead. */
const BEFORE = Date.UTC(2026, 9, 14, 2, 0);
/** 03:30 UTC on 2026-10-14: the day's occurrence is due. */
const DUE = Date.UTC(2026, 9, 14, 3, 30);
const OCCURRENCE = "2026-10-14T03:00:00.000Z";
const PREVIOUS = "2026-10-13T03:00:00.000Z";
const NEXT_OCCURRENCE = "2026-10-15T03:00:00.000Z";

/** Every object key the suite uses; the test file registers a pipeline under each. */
export function pipelineScheduleContractKeys(): string[] {
  const keys: string[] = [];
  for (const [label] of VARIANTS) for (let n = 1; n <= SCENARIOS; n++) keys.push(`contract-${label}-${n}`);
  return keys;
}

interface ScheduleView {
  enabled: boolean;
  lastFiredOccurrence: string | null;
  lastStartedRunId: string | null;
  lastResult: { outcome: string; runId?: string; occurrence?: string } | null;
  nextOccurrence?: string;
}

export function registerPipelineScheduleContract(
  adapter: PipelineScheduleAdapter,
  envFor: (label: string) => RestateEnvironment,
): void {
  const labels = VARIANTS.map(([label]) => label);

  function begin(label: string, n: number) {
    const key = `contract-${label}-${n}`;
    const baseUrl = envFor(label).baseUrl();
    const world = adapter.world(key);
    return {
      world,
      key,
      get: () => callObject<ScheduleView | null>(baseUrl, "PipelineSchedule", key, "get", undefined),
      check: () => callObject<{ action: string }>(baseUrl, "PipelineSchedule", key, "check", undefined),
      set: (body: unknown) => adapter.set(baseUrl, key, body),
      /** Turns the schedule on at 02:00 (before the day's occurrence), then moves the clock to 03:30 so it is due. */
      turnOnAndDue: async () => {
        world.setClock(BEFORE);
        await adapter.set(baseUrl, key, { enabled: true, time: TIME, zone: ZONE });
        world.setClock(DUE);
      },
    };
  }
  const count = (calls: string[], what: string) => calls.filter((c) => c === what).length;

  describe(`pipeline-schedule contract: ${adapter.name}`, () => {
    it.each(labels)("1. off: check calls nothing (%s)", async (label) => {
      const s = begin(label, 1);
      s.world.setClock(DUE);
      expect(await s.check()).toEqual({ action: "none" });
      await s.set({ enabled: false, time: TIME, zone: ZONE });
      await s.check();
      expect(s.world.calls()).toEqual([]);
    }, 30_000);

    it.each(labels)("2. on, not due: nothing (%s)", async (label) => {
      const s = begin(label, 2);
      await s.turnOnAndDue();
      s.world.setClock(BEFORE + 30 * 60_000);
      await s.check();
      expect(s.world.calls()).toEqual([]);
      expect((await s.get())?.lastFiredOccurrence).toBe(PREVIOUS);
    }, 30_000);

    it.each(labels)("3. due and busy: no fire and still due; free on the next check: one fire (%s)", async (label) => {
      const s = begin(label, 3);
      await s.turnOnAndDue();
      s.world.setBusy({ busy: true, holder: null, awaitingDecision: false });
      await s.check();
      expect(s.world.calls()).toEqual(["busy"]);
      expect((await s.get())?.lastFiredOccurrence).toBe(PREVIOUS);
      s.world.setBusy({ busy: false });
      await s.check();
      expect(s.world.calls()).toEqual(["busy", "busy", "fire"]);
      expect((await s.get())?.lastFiredOccurrence).toBe(OCCURRENCE);
    }, 30_000);

    it.each(labels)("4. due and free: one started fire; a second check in the same occurrence does nothing (%s)", async (label) => {
      const s = begin(label, 4);
      await s.turnOnAndDue();
      expect(await s.check()).toEqual({ action: "started" });
      expect(await s.check()).toEqual({ action: "none" });
      expect(s.world.calls()).toEqual(["busy", "fire"]);
      const state = await s.get();
      expect(state?.lastFiredOccurrence).toBe(OCCURRENCE);
      expect(state?.lastStartedRunId).toMatch(/^run-/);
      expect(state?.lastResult).toMatchObject({ outcome: "started", runId: state?.lastStartedRunId });
    }, 30_000);

    it.each(labels)("5. a fire answered busy stays due; the next check fires (%s)", async (label) => {
      const s = begin(label, 5);
      await s.turnOnAndDue();
      s.world.queueFire({ outcome: "busy", detail: "worker took a run" });
      await s.check();
      expect((await s.get())?.lastFiredOccurrence).toBe(PREVIOUS);
      await s.check();
      expect(count(s.world.calls(), "fire")).toBe(2);
      expect((await s.get())?.lastFiredOccurrence).toBe(OCCURRENCE);
    }, 30_000);

    it.each(labels)("6. a refused fire counts as fired: no retry this occurrence, one attempt at the next (%s)", async (label) => {
      const s = begin(label, 6);
      await s.turnOnAndDue();
      s.world.queueFire({ outcome: "refused", detail: "nope" });
      await s.check();
      await s.check();
      expect(count(s.world.calls(), "fire")).toBe(1);
      const state = await s.get();
      expect(state?.lastFiredOccurrence).toBe(OCCURRENCE);
      expect(state?.lastResult).toMatchObject({ outcome: "refused" });
      s.world.setClock(DUE + DAY);
      await s.check();
      expect(count(s.world.calls(), "fire")).toBe(2);
      expect((await s.get())?.lastFiredOccurrence).toBe(NEXT_OCCURRENCE);
    }, 30_000);

    it.each(labels)("7. the last started run awaits a decision: one replace, no second, then one fire when it is gone (%s)", async (label) => {
      const s = begin(label, 7);
      await s.turnOnAndDue();
      await s.check();
      const runId = (await s.get())?.lastStartedRunId;
      expect(runId).toBeTruthy();
      s.world.setClock(DUE + DAY);
      s.world.setBusy({ busy: true, holder: runId!, awaitingDecision: true });
      await s.check();
      expect(s.world.calls().filter((c) => c.startsWith("replace"))).toEqual([`replace:${runId}`]);
      expect((await s.get())?.lastResult).toMatchObject({ outcome: "replaced", runId });
      await s.check();
      expect(s.world.calls().filter((c) => c.startsWith("replace"))).toHaveLength(1);
      expect(count(s.world.calls(), "fire")).toBe(1);
      s.world.setBusy({ busy: false });
      await s.check();
      expect(count(s.world.calls(), "fire")).toBe(2);
      expect((await s.get())?.lastFiredOccurrence).toBe(NEXT_OCCURRENCE);
    }, 30_000);

    it.each(labels)("8. a holder that is not the last started run (a manual run) is not replaced; still due (%s)", async (label) => {
      const s = begin(label, 8);
      await s.turnOnAndDue();
      s.world.setBusy({ busy: true, holder: "manual-run", awaitingDecision: true });
      await s.check();
      expect(s.world.calls()).toEqual(["busy"]);
      expect((await s.get())?.lastFiredOccurrence).toBe(PREVIOUS);
    }, 30_000);

    it.each(labels)("9. a crash after fire returns still fires exactly once (%s)", async (label) => {
      const s = begin(label, 9);
      await s.turnOnAndDue();
      s.world.crashAfterNextFire();
      await s.check();
      expect(count(s.world.calls(), "fire")).toBe(1);
      const state = await s.get();
      expect(state?.lastFiredOccurrence).toBe(OCCURRENCE);
      expect(state?.lastStartedRunId).toMatch(/^run-/);
    }, 30_000);

    it.each(labels)("10. turning on after today's time does not fire today; it fires at the next occurrence (%s)", async (label) => {
      const s = begin(label, 10);
      s.world.setClock(Date.UTC(2026, 9, 14, 14, 0));
      await s.set({ enabled: true, time: TIME, zone: ZONE });
      await s.check();
      expect(s.world.calls()).toEqual([]);
      expect((await s.get())?.nextOccurrence).toBe(NEXT_OCCURRENCE);
      s.world.setClock(Date.UTC(2026, 9, 15, 3, 30));
      await s.check();
      expect(count(s.world.calls(), "fire")).toBe(1);
    }, 30_000);

    it.each(labels)("11. a bad time, bad zone, or unknown key is a 400 and changes nothing (%s)", async (label) => {
      const s = begin(label, 11);
      await s.set({ enabled: true, time: TIME, zone: ZONE });
      const before = await s.get();
      for (const body of [{ time: "24:00" }, { time: "3:00" }, { zone: "Mars/Olympus" }, { enabled: "yes" }, { surprise: 1 }]) {
        await expect(s.set(body)).rejects.toThrow(/400/);
      }
      await expect(adapter.set(envFor(label).baseUrl(), "contract-unknown-key", { enabled: false })).rejects.toThrow(/400/);
      expect(await s.get()).toEqual(before);
      expect(await callObject(envFor(label).baseUrl(), "PipelineSchedule", "contract-unknown-key", "get", undefined)).toBeNull();
    }, 30_000);
  });
}
