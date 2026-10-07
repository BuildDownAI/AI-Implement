import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectRunnerComments, fetchPlanningContextFromOrchestrator, postRunnerCycleSummary, postRunnerResult } from "../runner-result.js";
import type { ReferenceRepoResult } from "../reference-repos.js";
import type { FindingDisposition } from "../pipeline/finding-dispositions.js";
import { makeReviewFixResult } from "./helpers/builders.js";
import { fakeFetch, hangUntilAborted, type Reply } from "./helpers/fake-fetch.js";
import { testDir } from "./helpers/test-dir.js";

describe("collectRunnerComments", () => {
  it("sorts the dependency-install comment ahead of reviewer feedback and run autopsy/stats files", () => {
    const workspaceDir = testDir("comments");
    const commentsDir = join(workspaceDir, "ai-output", "comments");
    mkdirSync(commentsDir, { recursive: true });
    writeFileSync(join(commentsDir, "95-run-stats.md"), "stats");
    writeFileSync(join(commentsDir, "80-reviewer-feedback.md"), "feedback");
    writeFileSync(join(commentsDir, "90-run-autopsy.md"), "autopsy");
    writeFileSync(join(commentsDir, "70-dependency-install.md"), "install");

    const bodies = collectRunnerComments(workspaceDir).map((c) => c.body);
    expect(bodies).toEqual(["install", "feedback", "autopsy", "stats"]);
  });
});

describe("fetchPlanningContextFromOrchestrator", () => {
  it("GETs /runner/planning-context with the progress token and returns the context", async () => {
    const orchestrator = fakeFetch({
      "GET /runner/planning-context": { json: { planningContext: "## Planning Context\n\nUse the widget pattern." } },
    });

    const ctx = await fetchPlanningContextFromOrchestrator({
      callbackUrl: "https://orch.example.com/",
      progressToken: "ptok",
      fetchImpl: orchestrator.fetch,
    });

    expect(ctx).toBe("## Planning Context\n\nUse the widget pattern.");
    expect(orchestrator.calls[0]!.url.href).toBe("https://orch.example.com/runner/planning-context");
    expect(orchestrator.calls[0]!.headers.get("Authorization")).toBe("Bearer ptok");
  });

  it("returns empty string on a non-ok response (best-effort)", async () => {
    const orchestrator = fakeFetch({ "GET /runner/planning-context": { status: 401 } });
    const ctx = await fetchPlanningContextFromOrchestrator({
      callbackUrl: "https://orch.example.com",
      progressToken: "ptok",
      fetchImpl: orchestrator.fetch,
    });
    expect(ctx).toBe("");
  });

  it("returns empty string when the orchestrator is unreachable", async () => {
    const orchestrator = fakeFetch({
      "GET /runner/planning-context": () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const ctx = await fetchPlanningContextFromOrchestrator({
      callbackUrl: "https://orch.example.com",
      progressToken: "ptok",
      fetchImpl: orchestrator.fetch,
    });
    expect(ctx).toBe("");
  });
});

describe("postRunnerCycleSummary", () => {
  it("retries a transient response with the identical authenticated payload", async () => {
    const orchestrator = fakeFetch({ "POST /runner/cycle-summary": [{ status: 503 }, { status: 200 }] });
    const summary = { id: "feedback-loop.1", completedAt: 123 } as Parameters<typeof postRunnerCycleSummary>[0]["summary"];
    expect(await postRunnerCycleSummary({ callbackUrl: "https://cb/", progressToken: "pilot-progress", summary, fetchImpl: orchestrator.fetch })).toBe(true);
    expect(orchestrator.calls).toHaveLength(2);
    expect(orchestrator.calls[0]!.url.href).toBe("https://cb/runner/cycle-summary");
    expect(orchestrator.calls[0]!.headers.get("Authorization")).toBe("Bearer pilot-progress");
    expect(orchestrator.calls[0]!.body).toBe(orchestrator.calls[1]!.body);
  });
});

describe("postRunnerResult", () => {
  // The step reads ai-output/comments from its workspace, so each test gets an empty one.
  let workspaceDir: string;

  // The orchestrator's result endpoint: one reply for every request, or a list served in order.
  function resultEndpoint(reply: Reply | Reply[] = {}) {
    return fakeFetch({ "POST /runner/result": reply });
  }

  function sentBody(endpoint: ReturnType<typeof resultEndpoint>) {
    return JSON.parse(endpoint.calls[0]!.body);
  }

  beforeEach(() => {
    vi.stubEnv("RUN_TOKEN", "run-token");
    workspaceDir = testDir("runner-result");
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
    const endpoint = resultEndpoint();

    await postRunnerResult({
      workspaceDir,
      phase: "implementation",
      outcome: "success",
      callbackUrl: "https://cb",
      fetchImpl: endpoint.fetch,
    });

    expect(endpoint.calls).toHaveLength(1);
  });

  it("logs the phase and outcome when the post succeeds", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const endpoint = resultEndpoint();

    await postRunnerResult({
      workspaceDir,
      phase: "implementation",
      outcome: "success",
      prUrl: "https://github.com/o/r/pull/1",
      callbackUrl: "https://cb",
      fetchImpl: endpoint.fetch,
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("POST ok phase=implementation outcome=success"),
    );
  });

  it("includes referenceRepoResults in body when non-empty", async () => {
    const endpoint = resultEndpoint();
    const referenceRepoResults: ReferenceRepoResult[] = [
      { repo: "https://github.com/a/b", path: "refs/b", ref: undefined, arrived: false, cause: "ref-not-found" },
    ];

    await postRunnerResult({
      workspaceDir,
      phase: "implementation",
      outcome: "success",
      prUrl: "https://github.com/o/r/pull/1",
      callbackUrl: "https://cb",
      referenceRepoResults,
      fetchImpl: endpoint.fetch,
    });

    expect(sentBody(endpoint).referenceRepoResults).toEqual(referenceRepoResults);
  });

  it("omits referenceRepoResults from body when array is empty", async () => {
    const endpoint = resultEndpoint();

    await postRunnerResult({
      workspaceDir,
      phase: "implementation",
      outcome: "success",
      prUrl: "https://github.com/o/r/pull/1",
      callbackUrl: "https://cb",
      referenceRepoResults: [],
      fetchImpl: endpoint.fetch,
    });

    expect(sentBody(endpoint)).not.toHaveProperty("referenceRepoResults");
  });

  it("omits referenceRepoResults from body when not provided", async () => {
    const endpoint = resultEndpoint();

    await postRunnerResult({
      workspaceDir,
      phase: "implementation",
      outcome: "success",
      prUrl: "https://github.com/o/r/pull/1",
      callbackUrl: "https://cb",
      fetchImpl: endpoint.fetch,
    });

    expect(sentBody(endpoint)).not.toHaveProperty("referenceRepoResults");
  });

  it("includes findingDispositions in body when non-empty", async () => {
    const endpoint = resultEndpoint();
    const findingDispositions: FindingDisposition[] = [
      { findingKey: "a".repeat(64), disposition: "fixed", reason: "addressed it" },
    ];

    await postRunnerResult({
      workspaceDir,
      phase: "implementation",
      outcome: "success",
      prUrl: "https://github.com/o/r/pull/1",
      callbackUrl: "https://cb",
      findingDispositions,
      fetchImpl: endpoint.fetch,
    });

    expect(sentBody(endpoint).findingDispositions).toEqual(findingDispositions);
  });

  it("omits findingDispositions from body when array is empty", async () => {
    const endpoint = resultEndpoint();

    await postRunnerResult({
      workspaceDir,
      phase: "implementation",
      outcome: "success",
      prUrl: "https://github.com/o/r/pull/1",
      callbackUrl: "https://cb",
      findingDispositions: [],
      fetchImpl: endpoint.fetch,
    });

    expect(sentBody(endpoint)).not.toHaveProperty("findingDispositions");
  });

  it("omits findingDispositions from body when not provided", async () => {
    const endpoint = resultEndpoint();

    await postRunnerResult({
      workspaceDir,
      phase: "implementation",
      outcome: "success",
      prUrl: "https://github.com/o/r/pull/1",
      callbackUrl: "https://cb",
      fetchImpl: endpoint.fetch,
    });

    expect(sentBody(endpoint)).not.toHaveProperty("findingDispositions");
  });

  it("includes guardVerdict and partTable in body when present (AII-632)", async () => {
    const endpoint = resultEndpoint();

    await postRunnerResult({
      workspaceDir,
      phase: "kg-refresh",
      outcome: "success",
      guardVerdict: "clean",
      partTable: [{ part: "comment.nt", prev: "9995", new: "9995" }],
      callbackUrl: "https://cb",
      fetchImpl: endpoint.fetch,
    });

    const body = sentBody(endpoint);
    expect(body.guardVerdict).toBe("clean");
    expect(body.partTable).toEqual([{ part: "comment.nt", prev: "9995", new: "9995" }]);
  });

  it("omits guardVerdict and partTable from body when not provided", async () => {
    const endpoint = resultEndpoint();

    await postRunnerResult({
      workspaceDir,
      phase: "kg-refresh",
      outcome: "success",
      callbackUrl: "https://cb",
      fetchImpl: endpoint.fetch,
    });

    const body = sentBody(endpoint);
    expect(body).not.toHaveProperty("guardVerdict");
    expect(body).not.toHaveProperty("partTable");
  });

  it("includes reviewFix in body when present (AII-777)", async () => {
    const endpoint = resultEndpoint();
    const reviewFix = makeReviewFixResult();

    await postRunnerResult({
      workspaceDir,
      phase: "gap-analysis",
      outcome: "success",
      prUrl: "https://github.com/o/r/pull/1",
      callbackUrl: "https://cb",
      reviewFix,
      fetchImpl: endpoint.fetch,
    });

    expect(sentBody(endpoint).reviewFix).toEqual(reviewFix);
  });

  it("omits reviewFix from body when not provided", async () => {
    const endpoint = resultEndpoint();

    await postRunnerResult({
      workspaceDir,
      phase: "implementation",
      outcome: "success",
      prUrl: "https://github.com/o/r/pull/1",
      callbackUrl: "https://cb",
      fetchImpl: endpoint.fetch,
    });

    expect(sentBody(endpoint)).not.toHaveProperty("reviewFix");
  });

  it("does not retry a legacy (no reviewFix) call on a transient 503 — single-attempt behavior is unchanged (AII-794)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const endpoint = resultEndpoint({ status: 503, text: "unavailable" });

    await postRunnerResult({
      workspaceDir,
      phase: "implementation",
      outcome: "failure",
      callbackUrl: "https://cb",
      fetchImpl: endpoint.fetch,
    });

    expect(endpoint.calls).toHaveLength(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("POST failed HTTP 503"));
  });

  describe("pilot bounded retry/backoff (AII-794)", () => {
    it("retries a lost ACK and resends a byte-identical canonical body until it succeeds", async () => {
      const sleepCalls: number[] = [];
      const endpoint = resultEndpoint([{ status: 503, text: "unavailable" }, { status: 503, text: "unavailable" }, {}]);

      await postRunnerResult({
        workspaceDir,
        phase: "gap-analysis",
        outcome: "success",
        prUrl: "https://github.com/acme/widgets/pull/42",
        callbackUrl: "https://cb",
        reviewFix: makeReviewFixResult(),
        fetchImpl: endpoint.fetch,
        sleepImpl: async (ms) => { sleepCalls.push(ms); },
      });

      expect(endpoint.calls).toHaveLength(3);
      expect(new Set(endpoint.calls.map((call) => call.body)).size).toBe(1);
      expect(sleepCalls).toHaveLength(2);
    });

    it("stops immediately on a terminal 409 conflict response without retrying", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const endpoint = resultEndpoint({ status: 409, text: '{"error":"conflict"}' });

      await postRunnerResult({
        workspaceDir,
        phase: "gap-analysis",
        outcome: "success",
        callbackUrl: "https://cb",
        reviewFix: makeReviewFixResult(),
        fetchImpl: endpoint.fetch,
        sleepImpl: async () => {},
      });

      expect(endpoint.calls).toHaveLength(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("HTTP 409"));
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("terminal, not retrying"));
    });

    it("stops immediately on a terminal 410 stale response without retrying", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const endpoint = resultEndpoint({ status: 410, text: '{"error":"stale"}' });

      await postRunnerResult({
        workspaceDir,
        phase: "gap-analysis",
        outcome: "failure",
        callbackUrl: "https://cb",
        reviewFix: makeReviewFixResult(),
        fetchImpl: endpoint.fetch,
        sleepImpl: async () => {},
      });

      expect(endpoint.calls).toHaveLength(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("terminal, not retrying"));
    });

    it("gives up once the stored deadline plus delivery grace elapses, logging an explicit no-result outcome", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const endpoint = resultEndpoint({ status: 503, text: "unavailable" });
      let virtualNow = 1_000_000;
      const reviewFix = makeReviewFixResult({ deadlineAt: virtualNow });

      await postRunnerResult({
        workspaceDir,
        phase: "gap-analysis",
        outcome: "failure",
        callbackUrl: "https://cb",
        reviewFix,
        fetchImpl: endpoint.fetch,
        now: () => virtualNow,
        // Jumps 20 minutes per backoff wait — past the 15-minute delivery grace after one attempt.
        sleepImpl: async () => { virtualNow += 20 * 60_000; },
      });

      expect(endpoint.calls).toHaveLength(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("POST no-result"));
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("deadline exceeded"));
    });

    it("aborts a pending fetch at the per-attempt transport timeout instead of leaving it in flight (AII-794)", async () => {
      const endpoint = resultEndpoint(hangUntilAborted);

      await postRunnerResult({
        workspaceDir,
        phase: "gap-analysis",
        outcome: "success",
        callbackUrl: "https://cb",
        reviewFix: makeReviewFixResult(),
        fetchImpl: endpoint.fetch,
        transportTimeoutMs: 10,
        sleepImpl: async () => {},
      });

      // Every attempt that timed out must have actually aborted the in-flight request — not
      // merely stopped awaiting it — so a later retry never races a still-running earlier one.
      expect(endpoint.calls.every((call) => call.signal?.aborted)).toBe(true);
      expect(endpoint.calls.length).toBeGreaterThan(1);
    });

    it("never logs raw response text or a thrown error's message — only a normalized reason (AII-794)", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const secret = "Bearer sk-super-secret-token-should-never-be-logged";
      // First attempt: the credential-shaped string arrives via the response body.
      // Every later attempt: it arrives via a thrown error's message instead.
      const endpoint = resultEndpoint((call) => {
        if (endpoint.calls.indexOf(call) === 0) return { status: 503, text: secret };
        throw new Error(`upstream said: ${secret}`);
      });

      await postRunnerResult({
        workspaceDir,
        phase: "gap-analysis",
        outcome: "failure",
        callbackUrl: "https://cb",
        reviewFix: makeReviewFixResult(),
        fetchImpl: endpoint.fetch,
        sleepImpl: async () => {},
      });

      expect(endpoint.calls.length).toBeGreaterThan(1);
      for (const args of errSpy.mock.calls) {
        for (const arg of args) {
          if (typeof arg === "string") expect(arg).not.toContain(secret);
        }
      }
    });

    it("bounds retries by attempt count even when the deadline is far in the future", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const endpoint = resultEndpoint({ status: 503, text: "unavailable" });

      await postRunnerResult({
        workspaceDir,
        phase: "gap-analysis",
        outcome: "failure",
        callbackUrl: "https://cb",
        reviewFix: makeReviewFixResult({ deadlineAt: Date.now() + 24 * 60 * 60_000 }),
        fetchImpl: endpoint.fetch,
        sleepImpl: async () => {},
      });

      expect(endpoint.calls.length).toBeGreaterThan(1);
      expect(endpoint.calls.length).toBeLessThanOrEqual(8);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("POST no-result"));
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("retry attempts exhausted"));
    });
  });

  it("logs the status and does not claim success when the post is refused", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const endpoint = resultEndpoint({ status: 409, text: '{"error":"already_consumed"}' });

    await postRunnerResult({
      workspaceDir,
      phase: "implementation",
      outcome: "success",
      prUrl: "https://github.com/o/r/pull/1",
      callbackUrl: "https://cb",
      fetchImpl: endpoint.fetch,
    });

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("POST failed HTTP 409"));
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("POST ok"));
  });
});
