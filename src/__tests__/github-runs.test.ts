import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { findWorkflowRunId, getWorkflowRunStatus, findPrForRun } from "../github.js";

describe("findWorkflowRunId", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns the run ID for a recent run", async () => {
    const now = new Date();
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        workflow_runs: [
          { id: 999, created_at: now.toISOString() },
          { id: 998, created_at: new Date(now.getTime() - 120_000).toISOString() },
        ],
      }),
    } as Response);

    const runId = await findWorkflowRunId(
      "token", "org", "repo", "workflow.yml", "main",
      new Date(now.getTime() - 60_000),
    );
    expect(runId).toBe(999);
  });

  it("returns null when no run is recent enough", async () => {
    const old = new Date("2024-01-01T00:00:00Z");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        workflow_runs: [
          { id: 999, created_at: old.toISOString() },
        ],
      }),
    } as Response);

    const runId = await findWorkflowRunId(
      "token", "org", "repo", "workflow.yml", "main",
      new Date("2025-01-01T00:00:00Z"),
    );
    expect(runId).toBeNull();
  });

  it("returns null on API failure", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    const runId = await findWorkflowRunId("token", "org", "repo", "w.yml", "main", new Date());
    expect(runId).toBeNull();
  });

  it("returns null when no runs exist", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ workflow_runs: [] }),
    } as Response);

    const runId = await findWorkflowRunId("token", "org", "repo", "w.yml", "main", new Date(0));
    expect(runId).toBeNull();
  });
});

describe("getWorkflowRunStatus", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns status and conclusion for a completed run", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/org/repo/actions/runs/123",
      }),
    } as Response);

    const result = await getWorkflowRunStatus("token", "org", "repo", 123);
    expect(result).toEqual({
      status: "completed",
      conclusion: "success",
      html_url: "https://github.com/org/repo/actions/runs/123",
    });
  });

  it("returns in_progress status with null conclusion", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: "in_progress",
        conclusion: null,
        html_url: "https://github.com/org/repo/actions/runs/456",
      }),
    } as Response);

    const result = await getWorkflowRunStatus("token", "org", "repo", 456);
    expect(result?.status).toBe("in_progress");
    expect(result?.conclusion).toBeNull();
  });

  it("returns null on API failure", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    const result = await getWorkflowRunStatus("token", "org", "repo", 123);
    expect(result).toBeNull();
  });
});

describe("findPrForRun", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns PR URL when a PR exists for the run's branch", async () => {
    vi.mocked(fetch)
      // First call: get run details
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ head_branch: "feature-branch" }),
      } as Response)
      // Second call: search for PRs
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([{ html_url: "https://github.com/org/repo/pull/42" }]),
      } as Response);

    const prUrl = await findPrForRun("token", "org", "repo", 123);
    expect(prUrl).toBe("https://github.com/org/repo/pull/42");
  });

  it("returns null when no PR exists", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ head_branch: "feature-branch" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([]),
      } as Response);

    const prUrl = await findPrForRun("token", "org", "repo", 123);
    expect(prUrl).toBeNull();
  });

  it("returns null when run fetch fails", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    const prUrl = await findPrForRun("token", "org", "repo", 123);
    expect(prUrl).toBeNull();
  });
});
