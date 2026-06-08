import { describe, it, expect, vi } from "vitest";
import { fetchPlanningContextFromOrchestrator } from "../runner-result.js";

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
