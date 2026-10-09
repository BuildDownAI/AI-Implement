import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityReporter, type ActivityAlert } from "../pipeline/activity-reporter.js";
import { fakeFetch, type FakeFetch, type Reply } from "./helpers/fake-fetch.js";

const ACCEPTED: Reply = { json: { acknowledged: true, outcome: "accepted", attemptId: "attempt-1" } };

/** The orchestrator's `/runner/activity` endpoint, answering with `reply` (a list is served one per request). */
function activityEndpoint(reply: Reply | Reply[]): FakeFetch {
  return fakeFetch({ "POST /runner/activity": reply });
}

const networkError: Reply = () => {
  throw new TypeError("fetch failed");
};

describe("ActivityReporter", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("never serializes secret fixtures: Authorization header, RUN_TOKEN-style value, forwarded env secret", async () => {
    vi.stubEnv("RUN_TOKEN", "runner-secret-abc123");
    vi.stubEnv("AI_IMPLEMENT_FORWARDED_SECRETS", "NPM_TOKEN");
    vi.stubEnv("NPM_TOKEN", "npm_secret_value_xyz789");

    const orchestrator = activityEndpoint(ACCEPTED);
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [],
    });

    reporter.record({
      cycle: 1,
      kind: "tool_call",
      action: "Bash",
      detail: {
        headers: { Authorization: "Bearer sk-super-secret-header-token" },
        // A value that isn't under a suspiciously-named key — echoed tool output.
        stdout: "curl -H 'Authorization: Bearer sk-super-secret-header-token' https://example.test",
        env: "NPM_TOKEN=npm_secret_value_xyz789 RUN_TOKEN=runner-secret-abc123",
      },
    });

    await reporter.flush();

    expect(orchestrator.calls).toHaveLength(1);
    const serialized = orchestrator.calls[0].body;
    expect(serialized).not.toContain("sk-super-secret-header-token");
    expect(serialized).not.toContain("npm_secret_value_xyz789");
    expect(serialized).not.toContain("runner-secret-abc123");
  });

  it("never journals a field carrying hidden model reasoning", async () => {
    const orchestrator = activityEndpoint(ACCEPTED);
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [],
    });

    reporter.record({
      cycle: 1,
      kind: "tool_call",
      action: "Edit",
      detail: {
        reasoning: "the private chain-of-thought that led to this edit, never to be journaled",
        file: "src/foo.ts",
      } as any,
    });

    await reporter.flush();

    const serialized = orchestrator.calls[0].body;
    expect(serialized).not.toContain("chain-of-thought");
    expect(serialized).toContain("src/foo.ts");
  });

  it("truncates a redacted event over the per-event byte cap and marks it explicitly", async () => {
    const orchestrator = activityEndpoint(ACCEPTED);
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [],
      maxEventBytes: 100,
    });

    reporter.record({ cycle: 1, kind: "tool_result", action: "Read", detail: { output: "x".repeat(5000) } });
    await reporter.flush();

    const events = JSON.parse(orchestrator.calls[0].body).events;
    expect(events).toHaveLength(1);
    expect(events[0].truncated).toBe(true);
    expect(Buffer.byteLength(events[0].payload, "utf8")).toBeLessThanOrEqual(100);
    expect(reporter.getStats().truncatedCount).toBe(1);
  });

  it("rejects further events locally once the per-attempt byte cap is reached, with one recorded marker", async () => {
    const orchestrator = activityEndpoint(ACCEPTED);
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [],
      maxEventBytes: 1000,
      maxAttemptBytes: 120,
    });

    for (let i = 0; i < 20; i++) {
      reporter.record({ cycle: 1, kind: "tool_call", action: "Bash", detail: { i } });
    }

    const stats = reporter.getStats();
    expect(stats.attemptLimitReached).toBe(true);
    // Far fewer buffered events than the 20 record() calls: the cap stopped growth.
    expect(stats.bufferedCount).toBeLessThan(10);

    await reporter.flush();
    const sentKinds = JSON.parse(orchestrator.calls[0].body).events.map((e: any) => e.kind);
    expect(sentKinds.filter((k: string) => k === "activity_limit_reached")).toHaveLength(1);
  });

  it("treats a resend of the same identity/payload as a no-op success (duplicate), and alerts on conflict without endless retry", async () => {
    // Duplicate: server reports 200/duplicate for a retried batch — success, buffer clears.
    {
      const orchestrator = activityEndpoint({ json: { acknowledged: true, outcome: "duplicate", attemptId: "attempt-1" } });
      const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
        fetchImpl: orchestrator.fetch,
        retryDelaysMs: [],
      });
      reporter.record({ cycle: 1, kind: "tool_call", action: "Bash", detail: { i: 1 } });
      await reporter.flush();
      expect(reporter.getStats().bufferedCount).toBe(0);
      expect(reporter.getStats().alerts).toHaveLength(0);
    }

    // Conflict: server reports 409 for a payload mismatch — alert raised, not retried forever.
    {
      const alerts: ActivityAlert[] = [];
      const orchestrator = activityEndpoint({
        status: 409,
        json: { acknowledged: false, outcome: "conflict", attemptId: "attempt-1", reason: "different payload already stored" },
      });
      const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
        fetchImpl: orchestrator.fetch,
        retryDelaysMs: [0, 0, 0],
        onAlert: (a) => alerts.push(a),
      });
      reporter.record({ cycle: 1, kind: "tool_call", action: "Bash", detail: { i: 1 } });
      await reporter.flush();

      expect(orchestrator.calls).toHaveLength(1); // no retry on a definitive rejection
      expect(reporter.getStats().bufferedCount).toBe(0);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].kind).toBe("payload_conflict");
    }
  });

  it("keeps producer/sequence/payload unchanged across a retried send", async () => {
    // The first attempt fails at the network; the retry is the one that succeeds.
    const orchestrator = activityEndpoint([networkError, ACCEPTED]);

    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [0],
    });
    reporter.record({ cycle: 1, kind: "tool_call", action: "Bash", detail: { i: 1 } });
    await reporter.flush();

    expect(orchestrator.calls).toHaveLength(2);
    expect(orchestrator.calls[1].body).toBe(orchestrator.calls[0].body);
    const sent = JSON.parse(orchestrator.calls[1].body);
    expect(sent.attemptId).toBe("attempt-1");
    expect(sent.producerId).toBe("producer-1");
    expect(sent.events[0].sequence).toBe(0);
  });

  it("leaves buffered events in place (not dropped) until the transport call reports success", async () => {
    const orchestrator = activityEndpoint(() => {
      throw new TypeError("network down");
    });

    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [0],
    });
    reporter.record({ cycle: 1, kind: "tool_call", action: "Bash", detail: { i: 1 } });

    expect(reporter.getStats().bufferedCount).toBe(1);
    await reporter.flush();
    // Both attempts exhausted, still failing: event stays buffered for a later flush().
    expect(reporter.getStats().bufferedCount).toBe(1);
    expect(orchestrator.calls).toHaveLength(2);
  });

  it("makes a gap from buffer overflow, and a missing tail after the final marker, visible in its own bookkeeping", async () => {
    const orchestrator = activityEndpoint(ACCEPTED);
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [],
      maxBufferedEvents: 2,
    });

    for (let i = 0; i < 5; i++) {
      reporter.record({ cycle: 1, kind: "tool_call", action: "Bash", detail: { i } });
    }
    reporter.finalize();

    const stats = reporter.getStats();
    expect(stats.overflowCount).toBeGreaterThan(0);
    expect(stats.droppedRanges.some((r) => r.reason === "buffer_overflow")).toBe(true);
    expect(stats.missingTail).toBe(true);
  });

  it("bounds enqueueing past the buffer cap with an explicit overflow marker rather than unbounded growth", () => {
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl: fakeFetch({}).fetch,
      maxBufferedEvents: 2,
    });

    for (let i = 0; i < 5; i++) {
      reporter.record({ cycle: 1, kind: "tool_call", action: "Bash", detail: { i } });
    }

    const stats = reporter.getStats();
    expect(stats.bufferedCount).toBe(2);
    expect(stats.overflowCount).toBe(3);
    expect(stats.droppedRanges).toHaveLength(3);
  });

  it("bounds shutdown even when the transport hangs forever, and records the dropped range", async () => {
    // Never settles and ignores its AbortSignal (unlike hangUntilAborted), so the bound
    // comes from the reporter's own hang guard, not from the request's timeout signal.
    const orchestrator = activityEndpoint(() => new Promise<never>(() => {}));
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [0],
      transportTimeoutMs: 30,
    });
    reporter.record({ cycle: 1, kind: "tool_call", action: "Bash", detail: { i: 1 } });

    const start = Date.now();
    await reporter.shutdown();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000);
    const stats = reporter.getStats();
    expect(stats.closed).toBe(true);
    expect(stats.droppedRanges.some((r) => r.reason === "transport_failure")).toBe(true);
    expect(stats.bufferedCount).toBe(0);
  }, 10_000);

  it("exposes no coupling to step/cycle-summary reporting", () => {
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl: fakeFetch({}).fetch,
    });
    expect("report" in reporter).toBe(false);
  });

  it("resolves the closing send instead of spinning forever when it is rejected with a definitive non-410 status", async () => {
    const orchestrator = activityEndpoint([
      ACCEPTED, // initial batch
      { status: 409, json: { acknowledged: false, outcome: "conflict", attemptId: "attempt-1", reason: "stale final marker" } }, // closing send
    ]);

    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [],
    });

    reporter.record({ cycle: 1, kind: "tool_call", action: "Bash", detail: { i: 1 } });
    await reporter.flush(); // drains the buffer first, so the closing send below is batch-empty
    reporter.finalize();

    await reporter.flush(); // must resolve rather than looping on the repeated 409

    // One call to drain the buffer, one for the closing send — no spin.
    expect(orchestrator.calls).toHaveLength(2);
    const stats = reporter.getStats();
    expect(stats.finalSequenceSent).toBe(true);
  });

  it("keeps a missing-tail signal visible when events are dropped after the per-attempt byte limit is reached, even if the final send succeeds", async () => {
    const orchestrator = activityEndpoint(ACCEPTED);
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [],
      maxEventBytes: 1000,
      maxAttemptBytes: 120,
    });

    for (let i = 0; i < 50; i++) {
      reporter.record({ cycle: 1, kind: "tool_call", action: "Bash", detail: { i } });
    }
    reporter.finalize();
    await reporter.flush();

    const stats = reporter.getStats();
    expect(stats.attemptLimitReached).toBe(true);
    expect(stats.droppedRanges.some((r) => r.reason === "attempt_limit_reached")).toBe(true);
    expect(stats.finalSequenceSent).toBe(true);
    expect(stats.missingTail).toBe(true);
  });

  it("drops the remaining buffer as a visible gap when a mid-stream batch is rejected as stale (410), rather than waiting for shutdown()", async () => {
    const orchestrator = activityEndpoint([
      { status: 410, json: { acknowledged: false, outcome: "conflict", attemptId: "attempt-1", reason: "stream stale" } },
      ACCEPTED,
    ]);

    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [],
      batchSize: 5,
    });

    for (let i = 0; i < 12; i++) {
      reporter.record({ cycle: 1, kind: "tool_call", action: "Bash", detail: { i } });
    }

    await reporter.flush();

    // Only the first (rejected) batch is sent — flush() must not keep going
    // once the stream is closed, and it must not silently strand the rest.
    expect(orchestrator.calls).toHaveLength(1);
    const stats = reporter.getStats();
    expect(stats.closed).toBe(true);
    expect(stats.bufferedCount).toBe(0);
    expect(stats.droppedRanges.some((r) => r.reason === "transport_failure" && r.fromSequence === 5 && r.toSequence === 11)).toBe(true);
    expect(stats.missingTail).toBe(true);
  });

  it("records a DroppedRange for a rejected non-final batch, keeping missingTail true even after later batches succeed", async () => {
    const orchestrator = activityEndpoint([
      { status: 409, json: { acknowledged: false, outcome: "conflict", attemptId: "attempt-1", reason: "different payload already stored" } }, // batch 0-4
      ACCEPTED, // batch 5-9
      ACCEPTED, // batch 10-11 + final marker
    ]);

    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [],
      batchSize: 5,
    });

    for (let i = 0; i < 12; i++) {
      reporter.record({ cycle: 1, kind: "tool_call", action: "Bash", detail: { i } });
    }
    reporter.finalize();

    await reporter.flush();

    const stats = reporter.getStats();
    expect(stats.closed).toBe(false); // a 409 (unlike 410) does not close the stream
    expect(stats.finalSequenceSent).toBe(true);
    expect(stats.bufferedCount).toBe(0);
    expect(stats.droppedRanges.some((r) => r.reason === "transport_failure" && r.fromSequence === 0 && r.toSequence === 4)).toBe(true);
    expect(stats.missingTail).toBe(true);
  });

  it("redacts an entire array subtree under a credential-shaped key rather than recursing past it", async () => {
    const orchestrator = activityEndpoint(ACCEPTED);
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [],
    });

    reporter.record({
      cycle: 1,
      kind: "tool_result",
      action: "Bash",
      detail: { tokens: ["secret1"], note: "kept" } as any,
    });
    await reporter.flush();

    const serialized = orchestrator.calls[0].body;
    expect(serialized).not.toContain("secret1");
    expect(serialized).toContain("kept");
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts an entire nested-object subtree under a credential-shaped key rather than recursing past it", async () => {
    const orchestrator = activityEndpoint(ACCEPTED);
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [],
    });

    reporter.record({
      cycle: 1,
      kind: "tool_result",
      action: "Bash",
      detail: { credentials: { raw: "secret2" }, note: "kept" } as any,
    });
    await reporter.flush();

    const serialized = orchestrator.calls[0].body;
    expect(serialized).not.toContain("secret2");
    expect(serialized).toContain("kept");
    expect(serialized).toContain("[REDACTED]");
  });

  it("sends the finalSequence marker once the buffer has drained, closing the stream", async () => {
    const orchestrator = activityEndpoint(ACCEPTED);
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [],
    });

    reporter.record({ cycle: 1, kind: "tool_call", action: "Bash", detail: { i: 1 } });
    reporter.finalize();
    await reporter.flush();

    expect(orchestrator.calls).toHaveLength(1);
    expect(JSON.parse(orchestrator.calls[0].body).finalSequence).toBe(reporter.getStats().finalSequence);
    expect(reporter.getStats().finalSequenceSent).toBe(true);
    expect(reporter.getStats().missingTail).toBe(false);
  });

  it("closes an empty stream with a valid, stable marker across transport retries", async () => {
    // The real handleRunnerActivity now authenticates its bearer against a
    // prepared attempt (AII-803) — this client-side test exercises only
    // ActivityReporter's own retry/finalSequence stability, so a canned
    // success response (as every other case in this file uses) stands in
    // for the server's acceptance.
    const orchestrator = activityEndpoint([
      () => {
        throw new TypeError("temporary network failure");
      },
      ACCEPTED,
    ]);
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [0],
      now: () => 1_800_000_000_000,
    });

    reporter.finalize();
    await reporter.flush();

    const bodies = orchestrator.calls.map((c) => JSON.parse(c.body));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[1]).toMatchObject({
      finalSequence: 0,
      events: [{ sequence: 0, kind: "activity_stream_empty", timestamp: 1_800_000_000_000 }],
    });
    expect(reporter.getStats().finalSequenceSent).toBe(true);
    expect(reporter.getStats().missingTail).toBe(false);
  });
});
