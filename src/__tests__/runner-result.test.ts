import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchPlanningContextFromOrchestrator, postRunnerResult } from "../runner-result.js";

describe("fetchPlanningContextFromOrchestrator", () => {
  it("GETs /runner/planning-context with the progress token and returns the context", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ planningContext: "## Planning Context\n\nUse the widget pattern." }),
    })) as unknown as typeof fetch;

    const ctx = await fetchPlanningContextFromOrchestrator({
      callbackUrl: "https://orch.example.com/",
      progressToken: "ptok",
      fetchImpl,
    });

    expect(ctx).toBe("## Planning Context\n\nUse the widget pattern.");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://orch.example.com/runner/planning-context",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer ptok" }),
      }),
    );
  });

  it("returns empty string on a non-ok response (best-effort)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, text: async () => "" })) as unknown as typeof fetch;
    const ctx = await fetchPlanningContextFromOrchestrator({
      callbackUrl: "https://orch.example.com",
      progressToken: "ptok",
      fetchImpl,
    });
    expect(ctx).toBe("");
  });

  it("returns empty string when the orchestrator is unreachable", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const ctx = await fetchPlanningContextFromOrchestrator({
      callbackUrl: "https://orch.example.com",
      progressToken: "ptok",
      fetchImpl,
    });
    expect(ctx).toBe("");
  });
});

describe("postRunnerResult", () => {
  beforeEach(() => {
    vi.stubEnv("RUN_TOKEN", "run-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Task 4: the runner now always reports an outcome — the caller (run-autonomous.ts)
  // is solely responsible for deciding success vs. coded failure. postRunnerResult
  // itself must never silently skip the callback on this shape of input anymore.
  it("sends the callback even when an implementation success has no prUrl", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });

    await postRunnerResult({
      workspaceDir: "/tmp",
      phase: "implementation",
      outcome: "success",
      callbackUrl: "https://cb",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
