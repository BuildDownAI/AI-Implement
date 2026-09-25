import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchPlanningContextFromOrchestrator, postRunnerResult } from "../runner-result.js";
import type { ReferenceRepoResult } from "../reference-repos.js";
import type { FindingDisposition } from "../pipeline/finding-dispositions.js";
import type { ReviewFixResultMetadataV1 } from "../review-fix-contract.js";

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

  it("includes findingDispositions in body when non-empty", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    const findingDispositions: FindingDisposition[] = [
      { findingKey: "a".repeat(64), disposition: "fixed", reason: "addressed it" },
    ];

    await postRunnerResult({
      workspaceDir: "/tmp",
      phase: "implementation",
      outcome: "success",
      prUrl: "https://github.com/o/r/pull/1",
      callbackUrl: "https://cb",
      findingDispositions,
      fetchImpl,
    });

    const body = JSON.parse(vi.mocked(fetchImpl).mock.calls[0][1]!.body as string);
    expect(body.findingDispositions).toEqual(findingDispositions);
  });

  it("omits findingDispositions from body when array is empty", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });

    await postRunnerResult({
      workspaceDir: "/tmp",
      phase: "implementation",
      outcome: "success",
      prUrl: "https://github.com/o/r/pull/1",
      callbackUrl: "https://cb",
      findingDispositions: [],
      fetchImpl,
    });

    const body = JSON.parse(vi.mocked(fetchImpl).mock.calls[0][1]!.body as string);
    expect(body).not.toHaveProperty("findingDispositions");
  });

  it("omits findingDispositions from body when not provided", async () => {
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
    expect(body).not.toHaveProperty("findingDispositions");
  });

  it("includes guardVerdict and partTable in body when present (AII-632)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });

    await postRunnerResult({
      workspaceDir: "/tmp",
      phase: "kg-refresh",
      outcome: "success",
      guardVerdict: "clean",
      partTable: [{ part: "comment.nt", prev: "9995", new: "9995" }],
      callbackUrl: "https://cb",
      fetchImpl,
    });

    const body = JSON.parse(vi.mocked(fetchImpl).mock.calls[0][1]!.body as string);
    expect(body.guardVerdict).toBe("clean");
    expect(body.partTable).toEqual([{ part: "comment.nt", prev: "9995", new: "9995" }]);
  });

  it("omits guardVerdict and partTable from body when not provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });

    await postRunnerResult({
      workspaceDir: "/tmp",
      phase: "kg-refresh",
      outcome: "success",
      callbackUrl: "https://cb",
      fetchImpl,
    });

    const body = JSON.parse(vi.mocked(fetchImpl).mock.calls[0][1]!.body as string);
    expect(body).not.toHaveProperty("guardVerdict");
    expect(body).not.toHaveProperty("partTable");
  });

  it("includes reviewFix in body when present (AII-777)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    const reviewFix: ReviewFixResultMetadataV1 = {
      version: 1,
      attemptId: "attempt-1",
      installationId: 1,
      repository: "acme/widgets",
      prNumber: 42,
      deadlineAt: 1_800_000_000_000,
      githubRunId: 555,
      githubRunAttempt: 1,
      outputCommit: "a".repeat(40),
    };

    await postRunnerResult({
      workspaceDir: "/tmp",
      phase: "gap-analysis",
      outcome: "success",
      prUrl: "https://github.com/o/r/pull/1",
      callbackUrl: "https://cb",
      reviewFix,
      fetchImpl,
    });

    const body = JSON.parse(vi.mocked(fetchImpl).mock.calls[0][1]!.body as string);
    expect(body.reviewFix).toEqual(reviewFix);
  });

  it("omits reviewFix from body when not provided", async () => {
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
    expect(body).not.toHaveProperty("reviewFix");
  });

  it("does not retry a legacy (no reviewFix) call on a transient 503 — single-attempt behavior is unchanged (AII-794)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "unavailable" });

    await postRunnerResult({
      workspaceDir: "/tmp",
      phase: "implementation",
      outcome: "failure",
      callbackUrl: "https://cb",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("POST failed HTTP 503"));
  });

  describe("pilot bounded retry/backoff (AII-794)", () => {
    function makeReviewFix(overrides: Partial<ReviewFixResultMetadataV1> = {}): ReviewFixResultMetadataV1 {
      return {
        version: 1,
        attemptId: "attempt-1",
        installationId: 1,
        repository: "acme/widgets",
        prNumber: 42,
        deadlineAt: Date.now() + 60 * 60_000,
        githubRunId: 555,
        githubRunAttempt: 1,
        outputCommit: "a".repeat(40),
        ...overrides,
      };
    }

    it("retries a lost ACK and resends a byte-identical canonical body until it succeeds", async () => {
      const bodies: string[] = [];
      const sleepCalls: number[] = [];
      let callCount = 0;
      const fetchImpl = vi.fn(async (_url: string, init: { body?: unknown }) => {
        bodies.push(init.body as string);
        callCount++;
        if (callCount < 3) return { ok: false, status: 503, text: async () => "unavailable" } as Response;
        return { ok: true, status: 200, text: async () => "" } as Response;
      });

      await postRunnerResult({
        workspaceDir: "/tmp",
        phase: "gap-analysis",
        outcome: "success",
        prUrl: "https://github.com/acme/widgets/pull/42",
        callbackUrl: "https://cb",
        reviewFix: makeReviewFix(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleepImpl: async (ms) => { sleepCalls.push(ms); },
      });

      expect(callCount).toBe(3);
      expect(new Set(bodies).size).toBe(1);
      expect(sleepCalls).toHaveLength(2);
    });

    it("stops immediately on a terminal 409 conflict response without retrying", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        text: async () => '{"error":"conflict"}',
      });

      await postRunnerResult({
        workspaceDir: "/tmp",
        phase: "gap-analysis",
        outcome: "success",
        callbackUrl: "https://cb",
        reviewFix: makeReviewFix(),
        fetchImpl,
        sleepImpl: async () => {},
      });

      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("HTTP 409"));
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("terminal, not retrying"));
    });

    it("stops immediately on a terminal 410 stale response without retrying", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: false,
        status: 410,
        text: async () => '{"error":"stale"}',
      });

      await postRunnerResult({
        workspaceDir: "/tmp",
        phase: "gap-analysis",
        outcome: "failure",
        callbackUrl: "https://cb",
        reviewFix: makeReviewFix(),
        fetchImpl,
        sleepImpl: async () => {},
      });

      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("terminal, not retrying"));
    });

    it("gives up once the stored deadline plus delivery grace elapses, logging an explicit no-result outcome", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "unavailable" });
      let virtualNow = 1_000_000;
      const reviewFix = makeReviewFix({ deadlineAt: virtualNow });

      await postRunnerResult({
        workspaceDir: "/tmp",
        phase: "gap-analysis",
        outcome: "failure",
        callbackUrl: "https://cb",
        reviewFix,
        fetchImpl,
        now: () => virtualNow,
        // Jumps 20 minutes per backoff wait — past the 15-minute delivery grace after one attempt.
        sleepImpl: async () => { virtualNow += 20 * 60_000; },
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("POST no-result"));
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("deadline exceeded"));
    });

    it("bounds retries by attempt count even when the deadline is far in the future", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "unavailable" });

      await postRunnerResult({
        workspaceDir: "/tmp",
        phase: "gap-analysis",
        outcome: "failure",
        callbackUrl: "https://cb",
        reviewFix: makeReviewFix({ deadlineAt: Date.now() + 24 * 60 * 60_000 }),
        fetchImpl,
        sleepImpl: async () => {},
      });

      expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
      expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(8);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("POST no-result"));
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("retry attempts exhausted"));
    });
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
