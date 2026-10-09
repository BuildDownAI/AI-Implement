import { expect, it, vi } from "vitest";

const restateRetentionMs = vi.hoisted(() => vi.fn(() => 30 * 24 * 60 * 60 * 1000));
vi.mock("../restate/retention.js", () => ({ restateRetentionMs }));

import { createPlanningRunWorkflow } from "../restate/planning-run-workflow.js";
import { createReviewFixAttempt } from "../restate/review-fix-attempt.js";

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const TEN_DAYS = 10 * 24 * 60 * 60 * 1000;

function retentions(def: unknown): number[] {
  const out: number[] = [];
  JSON.stringify(def, (_k, v) => {
    if (typeof v === "number" && (v === THIRTY_DAYS || v === TEN_DAYS)) out.push(v);
    return v;
  });
  return out;
}

const factories = [
  { name: "PlanningRun", build: (extra: object) => createPlanningRunWorkflow({ ...extra } as never) },
  { name: "ReviewFixAttempt", build: (extra: object) => createReviewFixAttempt({ ...extra } as never) },
];

for (const { name, build } of factories) {
  it(`${name} reads the configured retention once at build time`, () => {
    restateRetentionMs.mockClear();
    const def = build({});
    expect(restateRetentionMs).toHaveBeenCalledTimes(1);
    expect(retentions(def).length).toBeGreaterThan(0);
    expect(new Set(retentions(def))).toEqual(new Set([THIRTY_DAYS]));
  });

  it(`${name} retentionMs override wins and skips the setting read`, () => {
    restateRetentionMs.mockClear();
    const def = build({ retentionMs: TEN_DAYS });
    expect(restateRetentionMs).not.toHaveBeenCalled();
    expect(new Set(retentions(def))).toEqual(new Set([TEN_DAYS]));
  });
}
