// The pure deadline decision of the owned-run wait (AII-1039, ADR 034 rule 2): one test per
// row of the issue's table. No ctx, no timers — `now` is an input.
import { describe, expect, it } from "vitest";
import { decideAtDeadline, type DeadlineInput } from "../restate/owned-run-wait.js";

const BOOTSTRAP = 1_000;
const TOTAL = 5_000;

function input(overrides: Partial<DeadlineInput>): DeadlineInput {
  return {
    now: 0,
    bootstrapDeadlineAt: BOOTSTRAP,
    totalDeadlineAt: TOTAL,
    startedSeen: false,
    resultSignal: "report",
    ...overrides,
  };
}

describe("decideAtDeadline", () => {
  it("row 1: a resolved result signal wins, even past both deadlines", () => {
    expect(decideAtDeadline(input({ now: TOTAL + 1, peekedResult: { ok: true } }))).toEqual({ kind: "signal", name: "report" });
    expect(decideAtDeadline(input({ now: 0, startedSeen: true, bootstrapDeadlineAt: undefined, peekedResult: false })))
      .toEqual({ kind: "signal", name: "report" });
  });

  it("row 2: started evidence at the bootstrap deadline continues with the total deadline", () => {
    expect(decideAtDeadline(input({ now: BOOTSTRAP, peekedStarted: true }))).toEqual({ kind: "continue", nextDeadlineAt: TOTAL });
  });

  it("row 3: no started evidence at the bootstrap deadline is a bootstrap timeout", () => {
    expect(decideAtDeadline(input({ now: BOOTSTRAP }))).toEqual({ kind: "bootstrap_timeout" });
    expect(decideAtDeadline(input({ now: BOOTSTRAP + 1 }))).toEqual({ kind: "bootstrap_timeout" });
  });

  it("row 4: at the total deadline with no result it is a total timeout, with or without started evidence", () => {
    expect(decideAtDeadline(input({ now: TOTAL }))).toEqual({ kind: "total_timeout" });
    expect(decideAtDeadline(input({ now: TOTAL, startedSeen: true }))).toEqual({ kind: "total_timeout" });
    expect(decideAtDeadline(input({ now: TOTAL + 10, peekedStarted: true }))).toEqual({ kind: "total_timeout" });
    expect(decideAtDeadline(input({ now: TOTAL, bootstrapDeadlineAt: undefined }))).toEqual({ kind: "total_timeout" });
  });

  it("row 5: before the bootstrap deadline, with no started evidence, it continues with the bootstrap deadline", () => {
    expect(decideAtDeadline(input({ now: BOOTSTRAP - 1 }))).toEqual({ kind: "continue", nextDeadlineAt: BOOTSTRAP });
    expect(decideAtDeadline(input({ now: 0, peekedStarted: true }))).toEqual({ kind: "continue", nextDeadlineAt: BOOTSTRAP });
  });

  it("row 6: started evidence known, or no bootstrap deadline, continues with the total deadline", () => {
    expect(decideAtDeadline(input({ now: BOOTSTRAP + 1, startedSeen: true }))).toEqual({ kind: "continue", nextDeadlineAt: TOTAL });
    expect(decideAtDeadline(input({ now: 10, bootstrapDeadlineAt: undefined }))).toEqual({ kind: "continue", nextDeadlineAt: TOTAL });
    expect(decideAtDeadline(input({ now: BOOTSTRAP + 1, bootstrapDeadlineAt: undefined, peekedStarted: true })))
      .toEqual({ kind: "continue", nextDeadlineAt: TOTAL });
  });
});
