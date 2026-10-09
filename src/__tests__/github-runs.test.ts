import { describe, it, expect } from "vitest";
import { findWorkflowRunId, getWorkflowRunStatus, findPrForRun } from "../github.js";
import { fakeFetch, type Reply } from "./helpers/fake-fetch.js";

/** Serves the runs list of `workflow.yml` (or `workflowFile`) in org/repo. */
function runsList(reply: Reply, workflowFile = "workflow.yml"): void {
  fakeFetch({ [`GET /repos/org/repo/actions/workflows/${workflowFile}/runs`]: reply }).install();
}

describe("findWorkflowRunId", () => {
  it("returns the run ID for a recent run", async () => {
    const now = new Date();
    runsList({
      json: {
        workflow_runs: [
          { id: 999, created_at: now.toISOString() },
          { id: 998, created_at: new Date(now.getTime() - 120_000).toISOString() },
        ],
      },
    });

    const runId = await findWorkflowRunId(
      "token", "org", "repo", "workflow.yml", "main",
      new Date(now.getTime() - 60_000),
    );
    expect(runId).toBe(999);
  });

  it("returns null when no run is recent enough", async () => {
    const old = new Date("2024-01-01T00:00:00Z");
    runsList({ json: { workflow_runs: [{ id: 999, created_at: old.toISOString() }] } });

    const runId = await findWorkflowRunId(
      "token", "org", "repo", "workflow.yml", "main",
      new Date("2025-01-01T00:00:00Z"),
    );
    expect(runId).toBeNull();
  });

  it("returns null on API failure", async () => {
    runsList({ status: 404 }, "w.yml");
    const runId = await findWorkflowRunId("token", "org", "repo", "w.yml", "main", new Date());
    expect(runId).toBeNull();
  });

  it("returns null when no runs exist", async () => {
    runsList({ json: { workflow_runs: [] } }, "w.yml");

    const runId = await findWorkflowRunId("token", "org", "repo", "w.yml", "main", new Date(0));
    expect(runId).toBeNull();
  });

  describe("with issueIdentifier", () => {
    it("skips a newer run titled for another issue and returns the older run titled for this issue", async () => {
      const now = new Date();
      runsList({
        json: {
          workflow_runs: [
            { id: 999, created_at: now.toISOString(), display_title: "Claude AI Implementation — OTHER-1" },
            { id: 998, created_at: new Date(now.getTime() - 60_000).toISOString(), display_title: "Claude AI Implementation — AII-743" },
          ],
        },
      });

      const runId = await findWorkflowRunId(
        "token", "org", "repo", "workflow.yml", "main",
        new Date(now.getTime() - 120_000),
        undefined,
        "AII-743",
      );
      expect(runId).toBe(998);
    });

    it("returns an untitled (old-template) run only when no titled run matches", async () => {
      const now = new Date();
      runsList({ json: { workflow_runs: [{ id: 997, created_at: now.toISOString() }] } });

      const runId = await findWorkflowRunId(
        "token", "org", "repo", "workflow.yml", "main",
        new Date(now.getTime() - 60_000),
        undefined,
        "AII-743",
      );
      expect(runId).toBe(997);
    });

    it("prefers a titled match over an earlier-seen untitled fallback candidate", async () => {
      const now = new Date();
      runsList({
        json: {
          workflow_runs: [
            { id: 996, created_at: now.toISOString() }, // untitled, seen first
            { id: 995, created_at: new Date(now.getTime() - 60_000).toISOString(), display_title: "Claude AI Implementation — AII-743" },
          ],
        },
      });

      const runId = await findWorkflowRunId(
        "token", "org", "repo", "workflow.yml", "main",
        new Date(now.getTime() - 120_000),
        undefined,
        "AII-743",
      );
      expect(runId).toBe(995);
    });

    it("returns null when only another issue's run is available", async () => {
      const now = new Date();
      runsList({
        json: { workflow_runs: [{ id: 994, created_at: now.toISOString(), display_title: "Claude AI Implementation — OTHER-1" }] },
      });

      const runId = await findWorkflowRunId(
        "token", "org", "repo", "workflow.yml", "main",
        new Date(now.getTime() - 60_000),
        undefined,
        "AII-743",
      );
      expect(runId).toBeNull();
    });

    it("does not let a substring match link a shorter issue key to a longer one's run", async () => {
      const now = new Date();
      runsList({
        json: {
          workflow_runs: [
            // Newer run, titled for a different (longer) issue key that contains "AII-74" as a substring.
            { id: 993, created_at: now.toISOString(), display_title: "Claude AI Implementation — AII-743" },
            // Older run, titled for the exact issue being looked up.
            { id: 992, created_at: new Date(now.getTime() - 60_000).toISOString(), display_title: "Claude AI Implementation — AII-74" },
          ],
        },
      });

      const runId = await findWorkflowRunId(
        "token", "org", "repo", "workflow.yml", "main",
        new Date(now.getTime() - 120_000),
        undefined,
        "AII-74",
      );
      expect(runId).toBe(992);
    });

    it("never returns another issue's run when only that run is present, even as a substring match", async () => {
      const now = new Date();
      runsList({
        json: { workflow_runs: [{ id: 991, created_at: now.toISOString(), display_title: "Claude AI Implementation — AII-743" }] },
      });

      const runId = await findWorkflowRunId(
        "token", "org", "repo", "workflow.yml", "main",
        new Date(now.getTime() - 60_000),
        undefined,
        "AII-74",
      );
      expect(runId).not.toBe(991);
      expect(runId).toBeNull();
    });
  });
});

describe("getWorkflowRunStatus", () => {
  it("returns status and conclusion for a completed run", async () => {
    fakeFetch({
      "GET /repos/org/repo/actions/runs/123": {
        json: { status: "completed", conclusion: "success", html_url: "https://github.com/org/repo/actions/runs/123" },
      },
    }).install();

    const result = await getWorkflowRunStatus("token", "org", "repo", 123);
    expect(result).toEqual({
      status: "completed",
      conclusion: "success",
      html_url: "https://github.com/org/repo/actions/runs/123",
    });
  });

  it("returns in_progress status with null conclusion", async () => {
    fakeFetch({
      "GET /repos/org/repo/actions/runs/456": {
        json: { status: "in_progress", conclusion: null, html_url: "https://github.com/org/repo/actions/runs/456" },
      },
    }).install();

    const result = await getWorkflowRunStatus("token", "org", "repo", 456);
    expect(result?.status).toBe("in_progress");
    expect(result?.conclusion).toBeNull();
  });

  it("returns null on API failure", async () => {
    fakeFetch({ "GET /repos/org/repo/actions/runs/123": { status: 404 } }).install();
    const result = await getWorkflowRunStatus("token", "org", "repo", 123);
    expect(result).toBeNull();
  });
});

describe("findPrForRun", () => {
  it("returns PR URL when a PR exists for the run's branch", async () => {
    fakeFetch({
      "GET /repos/org/repo/actions/runs/123": { json: { head_branch: "feature-branch" } },
      "GET /repos/org/repo/pulls": { json: [{ html_url: "https://github.com/org/repo/pull/42" }] },
    }).install();

    const prUrl = await findPrForRun("token", "org", "repo", 123);
    expect(prUrl).toBe("https://github.com/org/repo/pull/42");
  });

  it("returns null when no PR exists", async () => {
    fakeFetch({
      "GET /repos/org/repo/actions/runs/123": { json: { head_branch: "feature-branch" } },
      "GET /repos/org/repo/pulls": { json: [] },
    }).install();

    const prUrl = await findPrForRun("token", "org", "repo", 123);
    expect(prUrl).toBeNull();
  });

  it("returns null when run fetch fails", async () => {
    fakeFetch({ "GET /repos/org/repo/actions/runs/123": { status: 404 } }).install();
    const prUrl = await findPrForRun("token", "org", "repo", 123);
    expect(prUrl).toBeNull();
  });
});
