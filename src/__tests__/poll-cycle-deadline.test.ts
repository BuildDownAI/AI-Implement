import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  beginCycle,
  endCycle,
  abandonCycle,
  isCurrentCycle,
  getPollStats,
  runWithDeadline,
  _resetPollCycleState,
} from "../poll-cycle.js";
import { defaultFetchSignal } from "../github.js";

const srcDir = path.resolve(import.meta.dirname, "..");

beforeEach(() => {
  _resetPollCycleState();
});

describe("poll cycle state management", () => {
  it("beginCycle returns null when a cycle is already in progress", () => {
    const first = beginCycle();
    expect(first).not.toBeNull();

    const second = beginCycle();
    expect(second).toBeNull();

    endCycle(first!.cycleId);
  });

  it("abandonCycle releases the lock so the next cycle can begin", () => {
    const first = beginCycle()!;
    abandonCycle();

    const second = beginCycle();
    expect(second).not.toBeNull();
    expect(second!.cycleId).toBe(first.cycleId + 1);
    endCycle(second!.cycleId);
  });

  it("pollCount increments with each cycle", () => {
    const c1 = beginCycle()!;
    abandonCycle();
    const c2 = beginCycle()!;
    endCycle(c2.cycleId);

    const { pollCount } = getPollStats();
    expect(pollCount).toBe(2);
    expect(c2.cycleId).toBe(2);
  });
});

describe("isCurrentCycle guard", () => {
  it("returns true for the active cycle and false for a stale one", () => {
    const c1 = beginCycle()!;
    expect(isCurrentCycle(c1.cycleId)).toBe(true);

    abandonCycle();
    const c2 = beginCycle()!;

    // c1 is now stale — a dispatch guard must block it
    expect(isCurrentCycle(c1.cycleId)).toBe(false);
    expect(isCurrentCycle(c2.cycleId)).toBe(true);

    endCycle(c2.cycleId);
  });

  it("a stale endCycle does not release the lock for the running cycle", () => {
    const c1 = beginCycle()!;
    abandonCycle();
    const c2 = beginCycle()!;

    // c1's body finishing (stale): should be a no-op
    endCycle(c1.cycleId);

    // c2 should still be holding the lock
    expect(beginCycle()).toBeNull();

    endCycle(c2.cycleId);
  });
});

describe("lastPollStartedAt and lastPollFinishedAt", () => {
  it("lastPollStartedAt is set by beginCycle, lastPollFinishedAt by endCycle", () => {
    expect(getPollStats().lastPollStartedAt).toBeNull();
    expect(getPollStats().lastPollFinishedAt).toBeNull();

    const c = beginCycle()!;
    expect(getPollStats().lastPollStartedAt).not.toBeNull();
    expect(getPollStats().lastPollFinishedAt).toBeNull();

    endCycle(c.cycleId);
    expect(getPollStats().lastPollFinishedAt).not.toBeNull();
    expect(getPollStats().lastPollFinishedAt!.getTime()).toBeGreaterThanOrEqual(
      getPollStats().lastPollStartedAt!.getTime(),
    );
  });

  it("lastPollFinishedAt is not updated when a stale cycle ends (stall detection)", () => {
    // Complete a normal cycle so lastPollFinishedAt has a value
    const c1 = beginCycle()!;
    endCycle(c1.cycleId);
    const { lastPollFinishedAt: finAfterNormal } = getPollStats();
    expect(finAfterNormal).not.toBeNull();

    // Abandoned cycle: deadline fires, new cycle starts, stale body ends
    const c2 = beginCycle()!;
    abandonCycle();
    const c3 = beginCycle()!;

    // Stale c2 body finishing — should not update lastPollFinishedAt
    endCycle(c2.cycleId); // no-op: c2.cycleId !== currentCycleId (c3)
    expect(getPollStats().lastPollFinishedAt).toBe(finAfterNormal);

    endCycle(c3.cycleId);
  });
});

describe("runWithDeadline", () => {
  it("deadline fires → lock clears → next cycle can start (polls increments)", async () => {
    const c = beginCycle()!;
    const neverResolves = () => new Promise<void>(() => {});

    await runWithDeadline(c.cycleId, c.started, 10, neverResolves, () => {});

    // Lock is released — next cycle must succeed
    const next = beginCycle();
    expect(next).not.toBeNull();
    expect(next!.cycleId).toBe(c.cycleId + 1);
    endCycle(next!.cycleId);

    expect(getPollStats().pollCount).toBe(2);
  });

  it("onTimeout is called exactly once with the cycle id and elapsed seconds", async () => {
    const c = beginCycle()!;
    const calls: Array<{ id: number; elapsed: number }> = [];

    await runWithDeadline(
      c.cycleId,
      c.started,
      10,
      () => new Promise<void>(() => {}),
      (id, elapsed) => calls.push({ id, elapsed }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe(c.cycleId);
    expect(calls[0].elapsed).toBeGreaterThanOrEqual(0);
  });

  it("normal body completion clears the lock without calling onTimeout", async () => {
    const c = beginCycle()!;
    const timeoutCalls: number[] = [];

    await runWithDeadline(
      c.cycleId,
      c.started,
      100_000,
      async () => { /* completes immediately */ },
      (id) => timeoutCalls.push(id),
    );

    expect(timeoutCalls).toHaveLength(0);
    const next = beginCycle();
    expect(next).not.toBeNull();
    endCycle(next!.cycleId);
  });

  it("stale cycle cannot dispatch: isCurrentCycle returns false after a newer cycle starts", () => {
    // Simulate what happens when deadline fires mid-body:
    // c1 starts, deadline fires (abandonCycle), c2 starts
    const c1 = beginCycle()!;
    abandonCycle(); // deadline fires
    const c2 = beginCycle()!;
    endCycle(c2.cycleId);

    // Guard check that poll body would perform before each dispatch
    const dispatchAttempts: number[] = [];
    if (isCurrentCycle(c1.cycleId)) {
      dispatchAttempts.push(c1.cycleId);
    }

    expect(dispatchAttempts).toHaveLength(0); // guard blocked stale dispatch
  });
});

describe("defaultFetchSignal", () => {
  it("returns an AbortSignal instance that is initially not aborted", () => {
    const signal = defaultFetchSignal();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });
});

describe("static: every fetch passes a signal", () => {
  function fetchLinesWithoutSignal(filePath: string): string[] {
    const lines = readFileSync(filePath, "utf8").split("\n");
    const missing: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (/await fetch\(/.test(lines[i])) {
        const window = lines.slice(i, i + 10).join("\n");
        if (!/signal:/.test(window)) {
          missing.push(`line ${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    return missing;
  }

  it("every fetch in github.ts passes a signal", () => {
    const missing = fetchLinesWithoutSignal(path.join(srcDir, "github.ts"));
    expect(missing).toEqual([]);
  });

  it("every fetch in providers/linear.ts passes a signal", () => {
    const missing = fetchLinesWithoutSignal(path.join(srcDir, "providers/linear.ts"));
    expect(missing).toEqual([]);
  });

  it("merge-up.ts has no direct fetch calls", () => {
    const content = readFileSync(path.join(srcDir, "merge-up.ts"), "utf8");
    expect(content).not.toMatch(/await fetch\(/);
  });

  it("feature-branch.ts has no direct fetch calls", () => {
    const content = readFileSync(path.join(srcDir, "feature-branch.ts"), "utf8");
    expect(content).not.toMatch(/await fetch\(/);
  });
});
