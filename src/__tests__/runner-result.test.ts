import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchPlanningContextFromOrchestrator, postRunnerResult } from "../runner-result.js";
import type { ReferenceRepoResult } from "../reference-repos.js";

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
    // vi.spyOn returns the existing spy when a method is already mocked, so an
    // unrestored console spy carries the previous test's calls into the next one.
    vi.restoreAllMocks();
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

  it("logs the phase and outcome when the post succeeds", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });

    await postRunnerResult({
      workspaceDir: "/tmp",
      phase: "implementation",
      outcome: "success",
      prUrl: "https://github.com/o/r/pull/1",
      callbackUrl: "https://cb",
      fetchImpl,
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("POST ok phase=implementation outcome=success"),
    );
  });

  it("includes referenceRepoResults in body when non-empty", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    const referenceRepoResults: ReferenceRepoResult[] = [
      { repo: "https://github.com/a/b", path: "refs/b", ref: undefined, arrived: false, cause: "ref-not-found" },
    ];

    await postRunnerResult({
      workspaceDir: "/tmp",
      phase: "implementation",
      outcome: "success",
      prUrl: "https://github.com/o/r/pull/1",
      callbackUrl: "https://cb",
      referenceRepoResults,
      fetchImpl,
    });

    const body = JSON.parse(vi.mocked(fetchImpl).mock.calls[0][1]!.body as string);
    expect(body.referenceRepoResults).toEqual(referenceRepoResults);
  });

  it("omits referenceRepoResults from body when array is empty", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });

    await postRunnerResult({
      workspaceDir: "/tmp",
      phase: "implementation",
      outcome: "success",
      prUrl: "https://github.com/o/r/pull/1",
      callbackUrl: "https://cb",
      referenceRepoResults: [],
      fetchImpl,
    });

    const body = JSON.parse(vi.mocked(fetchImpl).mock.calls[0][1]!.body as string);
    expect(body).not.toHaveProperty("referenceRepoResults");
  });

  it("omits referenceRepoResults from body when not provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });

    await postRunnerResult({
      workspaceDir: "/tmp",
      phase: "implementation",
      outcome: "success",
      prUrl: "https://github.com/o/r/pull/1",
      callbackUrl: "https://cb",
      fetchImpl,
    });

    const body = JSON.parse(vi.mocked(fetchImpl).mock.calls[0][1]!.body as string);
    expect(body).not.toHaveProperty("referenceRepoResults");
  });

  it("logs the status and does not claim success when the post is refused", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => '{"error":"already_consumed"}',
    });

    await postRunnerResult({
      workspaceDir: "/tmp",
      phase: "implementation",
      outcome: "success",
      prUrl: "https://github.com/o/r/pull/1",
      callbackUrl: "https://cb",
      fetchImpl,
    });

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("POST failed HTTP 409"));
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("POST ok"));
  });
});
