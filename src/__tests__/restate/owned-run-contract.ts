// The contract suite for an owned run's lifecycle (AII-1062, ADR 036). A run kind describes its
// workflow with an OwnedRunAdapter and calls registerOwnedRunContract inside a describe block of
// its own `*.restate.test.ts` file. The file is not named `.test.ts`, so vitest does not collect
// it. Scenarios hold the workflow with `waitForStep` and never sleep.
import type { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { describe, expect, it } from "vitest";
import { VARIANTS, waitForStep } from "./harness.js";

/** Faults a scenario asks the adapter to inject. Each applies to every attempt of its step unless noted. */
export interface OwnedRunFaults {
  /** The status read throws on every attempt. */
  failStatusRead?: boolean;
  /** The reservation is refused. */
  refuseReservation?: boolean;
  /** The launch commits, then throws once, as if the caller crashed before it saw the answer. */
  crashAfterLaunch?: boolean;
  /** The cleanup throws on every attempt. */
  failCleanup?: boolean;
  /** The outcome function throws on every attempt. */
  failOutcome?: boolean;
}

export interface OwnedRunStart {
  faults: OwnedRunFaults;
  /** The total deadline of the run, from its start. Long unless the scenario tests the deadline. */
  totalMs: number;
}

export interface OwnedRunHandle {
  /** The id the launch gives the run; `cleanup` must receive exactly this. */
  runId: string;
  /** Settles when the workflow returns. */
  done: Promise<unknown>;
  /** The workflow's status read: `{ step }` is `"waiting"` while it waits on the run. */
  read(): Promise<{ step: string | null }>;
  /** Makes the run end normally (the result signal). */
  finish(): Promise<void>;
}

export interface OwnedRunAdapter {
  /** Names the describe block. */
  name: string;
  /** Starts the workflow under `key` on `baseUrl`, with the faults applied. */
  start(baseUrl: string, key: string, start: OwnedRunStart): OwnedRunHandle;
  /**
   * The calls the workflow's effects made for `key`, in order, one string per attempt: `reserve`,
   * `launch`, `status`, `stop`, `cleanup:<runId>`, `outcome`, `release`. The suite ignores `status`
   * where order matters.
   */
  calls(key: string): string[];
}

const LONG_MS = 60_000;
const DEADLINE_MS = 1_500;

export function registerOwnedRunContract(adapter: OwnedRunAdapter, envFor: (label: string) => RestateTestEnvironment): void {
  const labels = VARIANTS.map(([label]) => label);
  let counter = 0;

  function begin(label: string, start: OwnedRunStart) {
    const key = `contract-${label}-${counter++}`;
    const handle = adapter.start(envFor(label).baseUrl(), key, start);
    return { key, ...handle };
  }
  const withoutStatus = (calls: string[]) => calls.filter((call) => call !== "status");

  describe(`owned-run contract: ${adapter.name}`, () => {
    it.each(labels)("1. a status read that fails on each attempt still reaches the deadline, stops the run, and releases (%s)", async (label) => {
      const run = begin(label, { faults: { failStatusRead: true }, totalMs: DEADLINE_MS });
      await run.done;
      const calls = adapter.calls(run.key);
      expect(calls.filter((call) => call === "status").length).toBeGreaterThanOrEqual(3);
      expect(withoutStatus(calls)).toEqual(["reserve", "launch", "stop", `cleanup:${run.runId}`, "outcome", "release"]);
    }, 30_000);

    it.each(labels)("2. a crash after the launch step adopts the run and does not launch a second run (%s)", async (label) => {
      const run = begin(label, { faults: { crashAfterLaunch: true }, totalMs: LONG_MS });
      await waitForStep(run.read, "waiting");
      await run.finish();
      await run.done;
      const calls = withoutStatus(adapter.calls(run.key));
      expect(calls.filter((call) => call === "launch")).toHaveLength(1);
      expect(calls).toEqual(["reserve", "launch", `cleanup:${run.runId}`, "outcome", "release"]);
    }, 30_000);

    it.each(labels)("3. a normal end runs cleanup with the run id, the outcome once, then the release (%s)", async (label) => {
      const run = begin(label, { faults: {}, totalMs: LONG_MS });
      await waitForStep(run.read, "waiting");
      await run.finish();
      await run.done;
      expect(withoutStatus(adapter.calls(run.key))).toEqual(["reserve", "launch", `cleanup:${run.runId}`, "outcome", "release"]);
    }, 30_000);

    it.each(labels)("4. a refused reservation launches nothing, cleans up nothing, and releases nothing (%s)", async (label) => {
      const run = begin(label, { faults: { refuseReservation: true }, totalMs: LONG_MS });
      await run.done;
      const calls = adapter.calls(run.key);
      expect(calls).toContain("reserve");
      expect(calls.filter((call) => call === "launch" || call === "release" || call.startsWith("cleanup"))).toEqual([]);
    }, 30_000);

    it.each(labels)("5. a failed cleanup and a failed outcome still release (%s)", async (label) => {
      const run = begin(label, { faults: { failCleanup: true, failOutcome: true }, totalMs: LONG_MS });
      await waitForStep(run.read, "waiting");
      await run.finish();
      await run.done;
      const calls = withoutStatus(adapter.calls(run.key));
      expect(calls.some((call) => call === `cleanup:${run.runId}`)).toBe(true);
      expect(calls).toContain("outcome");
      expect(calls[calls.length - 1]).toBe("release");
      expect(calls.filter((call) => call === "release")).toHaveLength(1);
    }, 30_000);
  });
}
