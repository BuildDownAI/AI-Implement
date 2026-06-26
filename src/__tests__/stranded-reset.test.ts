import { describe, expect, it } from "vitest";
import { resetStrandedIssues } from "../stranded-reset.js";
import { FakeProvider } from "./providers/fake.js";
import type { AIImplementSnapshot, InProgressIssue } from "../providers/types.js";

function snapshot(inProgress: InProgressIssue[]): AIImplementSnapshot {
  return { needsPlanning: [], readyForImplementation: [], inProgress };
}

const never = () => false;

describe("resetStrandedIssues", () => {
  it("marks a stranded implementing issue failed (no live job, no dedup)", async () => {
    const provider = new FakeProvider({ recordCalls: true });
    await resetStrandedIssues(
      [snapshot([{ issueId: "a", scopeKey: "T1", phase: "implementing" }])],
      [provider],
      { isLive: never, isDispatched: never },
    );
    const call = provider.recordedCalls().find((c) => c.method === "markImplementationFailed");
    expect(call?.args[0]).toBe("a");
    expect(String(call?.args[1])).toContain("no active job");
  });

  it("marks a stranded planning issue failed via the planning verb", async () => {
    const provider = new FakeProvider({ recordCalls: true });
    await resetStrandedIssues(
      [snapshot([{ issueId: "b", scopeKey: "T1", phase: "planning" }])],
      [provider],
      { isLive: never, isDispatched: never },
    );
    const calls = provider.recordedCalls();
    expect(calls.find((c) => c.method === "markPlanningFailed")?.args[0]).toBe("b");
    expect(calls.find((c) => c.method === "markImplementationFailed")).toBeUndefined();
  });

  it("leaves an issue with a live in-flight job alone", async () => {
    const provider = new FakeProvider({ recordCalls: true });
    await resetStrandedIssues(
      [snapshot([{ issueId: "a", scopeKey: "T1", phase: "implementing" }])],
      [provider],
      { isLive: (id) => id === "a", isDispatched: never },
    );
    expect(provider.recordedCalls().some((c) => c.method.includes("Failed"))).toBe(false);
  });

  it("leaves an issue that still has a dedup entry alone (fresh dispatch guard)", async () => {
    const provider = new FakeProvider({ recordCalls: true });
    await resetStrandedIssues(
      [snapshot([{ issueId: "a", scopeKey: "T1", phase: "implementing" }])],
      [provider],
      { isLive: never, isDispatched: (id) => id === "a" },
    );
    expect(provider.recordedCalls().some((c) => c.method.includes("Failed"))).toBe(false);
  });

  it("resets only the stranded issues in a mixed batch", async () => {
    const provider = new FakeProvider({ recordCalls: true });
    const live = new Set(["live"]);
    const dispatched = new Set(["fresh"]);
    await resetStrandedIssues(
      [
        snapshot([
          { issueId: "live", scopeKey: "T1", phase: "implementing" },
          { issueId: "fresh", scopeKey: "T1", phase: "planning" },
          { issueId: "stranded", scopeKey: "T2", phase: "implementing" },
        ]),
      ],
      [provider],
      { isLive: (id) => live.has(id), isDispatched: (id) => dispatched.has(id) },
    );
    const failed = provider
      .recordedCalls()
      .filter((c) => c.method.includes("Failed"))
      .map((c) => c.args[0]);
    expect(failed).toEqual(["stranded"]);
  });
});
