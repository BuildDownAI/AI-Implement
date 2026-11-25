import { describe, it, expect, vi } from "vitest";
import { reconcileClosedIssues, CLOSED_ISSUE_RECONCILE_LIMIT } from "../closed-issue-reconcile.js";
import { ClosedIssueReconcileError } from "../providers/types.js";
import { makeMapping } from "./helpers/builders.js";

const jira = () => makeMapping({ ticketingConfig: { kind: "jira", jql: "project = P", repoFieldValue: null, statusFieldOverride: null, repoFieldOverride: null, profilesFieldOverride: null, baseBranchFieldOverride: null } });

describe("reconcileClosedIssues", () => {
  it("skips paused and non-Jira mappings before resolving providers", async () => {
    const providerFor = vi.fn();
    await reconcileClosedIssues({ getMappings: () => ({ paused: { ...jira(), paused: true }, linear: makeMapping() }), providerFor });
    expect(providerFor).not.toHaveBeenCalled();
  });

  it("sorts mappings, injects team keys, shares the budget and stops at exhaustion", async () => {
    const reconcileClosedPrReady = vi.fn().mockResolvedValueOnce(["P-1", "P-2"]).mockResolvedValueOnce(["P-3", "P-4", "P-5"]);
    const providerFor = vi.fn(async () => ({ reconcileClosedPrReady }));
    await reconcileClosedIssues({ getMappings: () => ({ C: jira(), B: jira(), A: jira() }), providerFor });
    expect(reconcileClosedPrReady.mock.calls.map(([mapping, limit]) => [mapping.teamKey, limit])).toEqual([["A", CLOSED_ISSUE_RECONCILE_LIMIT], ["B", 3]]);
    expect(providerFor).toHaveBeenCalledTimes(2);
  });

  it("continues after an error and skips providers without the optional method", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const reconcileClosedPrReady = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([]);
      const providerFor = vi.fn().mockResolvedValueOnce({}).mockResolvedValue({ reconcileClosedPrReady });
      await reconcileClosedIssues({ getMappings: () => ({ A: jira(), B: jira(), C: jira() }), providerFor });
      expect(reconcileClosedPrReady).toHaveBeenCalledTimes(2);
      expect(reconcileClosedPrReady.mock.calls[1][1]).toBe(5);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("B"), expect.any(Error));
    } finally { warning.mockRestore(); }
  });

  it("charges partial writes and an uncertain failed request before continuing", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const reconcileClosedPrReady = vi.fn().mockRejectedValueOnce(new ClosedIssueReconcileError(3, new Error("write failed"))).mockResolvedValueOnce(["P-4", "P-5"]);
      await reconcileClosedIssues({ getMappings: () => ({ A: jira(), B: jira(), C: jira() }), providerFor: async () => ({ reconcileClosedPrReady }) });
      expect(reconcileClosedPrReady.mock.calls.map(([, limit]) => limit)).toEqual([5, 2]);
    } finally { warning.mockRestore(); }
  });
});
