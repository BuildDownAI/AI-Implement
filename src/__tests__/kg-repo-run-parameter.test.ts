import { describe, expect, it } from "vitest";
import { buildRunParameter } from "../restate/kg-repo.js";
import { kgRefreshRunInputSchema } from "../restate/kg-refresh-workflow.js";

describe("KgRepo run send parameter", () => {
  it("parses against kgRefreshRunInputSchema with every option preserved", () => {
    const param = buildRunParameter(
      {
        dryRun: true,
        kgSourceRef: "pr-head",
        acceptNewBaseline: true,
        actorEmail: "a@example.com",
        report: { repo: "o/r", prNumber: 7, sha: "abc", acceptBaseline: true },
      },
      "trig-1",
    );
    expect(kgRefreshRunInputSchema.parse(param)).toEqual(param);
  });

  it("carries the trigger id for a bare trigger", () => {
    const param = buildRunParameter({}, "trig-2");
    expect(kgRefreshRunInputSchema.parse(param)).toEqual({ triggerId: "trig-2" });
  });
});
