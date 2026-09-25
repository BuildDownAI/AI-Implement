import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityReporter, type ActivityAlert } from "../pipeline/activity-reporter.js";

function response(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function capturingFetch(results: Response[]): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; body: unknown }>;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const res = results[Math.min(i, results.length - 1)];
    i++;
    return res;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

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

    const { fetchImpl, calls } = capturingFetch([response(200, { acknowledged: true, outcome: "accepted", attemptId: "attempt-1" })]);
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl,
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

    expect(calls).toHaveLength(1);
    const serialized = JSON.stringify(calls[0].body);
    expect(serialized).not.toContain("sk-super-secret-header-token");
    expect(serialized).not.toContain("npm_secret_value_xyz789");
    expect(serialized).not.toContain("runner-secret-abc123");
  });

  it("never journals a field carrying hidden model reasoning", async () => {
    const { fetchImpl, calls } = capturingFetch([response(200, { acknowledged: true, outcome: "accepted", attemptId: "attempt-1" })]);
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl,
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

    const serialized = JSON.stringify(calls[0].body);
    expect(serialized).not.toContain("chain-of-thought");
    expect(serialized).toContain("src/foo.ts");
  });

  it("truncates a redacted event over the per-event byte cap and marks it explicitly", async () => {
    const { fetchImpl, calls } = capturingFetch([response(200, { acknowledged: true, outcome: "accepted", attemptId: "attempt-1" })]);
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl,
      retryDelaysMs: [],
      maxEventBytes: 100,
    });

    reporter.record({ cycle: 1, kind: "tool_result", action: "Read", detail: { output: "x".repeat(5000) } });
    await reporter.flush();

    const events = (calls[0].body as any).events;
    expect(events).toHaveLength(1);
    expect(events[0].truncated).toBe(true);
    expect(Buffer.byteLength(events[0].payload, "utf8")).toBeLessThanOrEqual(100);
    expect(reporter.getStats().truncatedCount).toBe(1);
  });

  it("rejects further events locally once the per-attempt byte cap is reached, with one recorded marker", async () => {
    const { fetchImpl, calls } = capturingFetch([response(200, { acknowledged: true, outcome: "accepted", attemptId: "attempt-1" })]);
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl,
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
    const sentKinds = (calls[0].body as any).events.map((e: any) => e.kind);
    expect(sentKinds.filter((k: string) => k === "activity_limit_reached")).toHaveLength(1);
  });

  it("treats a resend of the same identity/payload as a no-op success (duplicate), and alerts on conflict without endless retry", async () => {
    // Duplicate: server reports 200/duplicate for a retried batch — success, buffer clears.
    {
      const { fetchImpl } = capturingFetch([response(200, { acknowledged: true, outcome: "duplicate", attemptId: "attempt-1" })]);
      const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
        fetchImpl,
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
      const { fetchImpl, calls } = capturingFetch([response(409, { acknowledged: false, outcome: "conflict", attemptId: "attempt-1", reason: "different payload already stored" })]);
      const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
        fetchImpl,
        retryDelaysMs: [0, 0, 0],
        onAlert: (a) => alerts.push(a),
      });
      reporter.record({ cycle: 1, kind: "tool_call", action: "Bash", detail: { i: 1 } });
      await reporter.flush();

      expect(calls).toHaveLength(1); // no retry on a definitive rejection
      expect(reporter.getStats().bufferedCount).toBe(0);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].kind).toBe("payload_conflict");
    }
  });

  it("keeps producer/sequence/payload unchanged across a retried send", async () => {
    const { fetchImpl, calls } = capturingFetch([
      // simulate a network failure by throwing on first call via a wrapping fetchImpl below
      response(200, { acknowledged: true, outcome: "accepted", attemptId: "attempt-1" }),
    ]);
    let attempt = 0;
    const flaky = (async (url: string | URL, init?: RequestInit) => {
      attempt++;
      if (attempt === 1) throw new TypeError("fetch failed");
      return fetchImpl(url, init);
    }) as typeof fetch;

    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl: flaky,
      retryDelaysMs: [0],
    });
    reporter.record({ cycle: 1, kind: "tool_call", action: "Bash", detail: { i: 1 } });
    await reporter.flush();

    expect(calls).toHaveLength(1); // only the successful attempt hit the capturing fetch
    expect(attempt).toBe(2);
    const sent = calls[0].body as any;
    expect(sent.attemptId).toBe("attempt-1");
    expect(sent.producerId).toBe("producer-1");
    expect(sent.events[0].sequence).toBe(0);
  });

  it("leaves buffered events in place (not dropped) until the transport call reports success", async () => {
    let calls = 0;
    const failing = (async () => {
      calls++;
      throw new TypeError("network down");
    }) as typeof fetch;

    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl: failing,
      retryDelaysMs: [0],
    });
    reporter.record({ cycle: 1, kind: "tool_call", action: "Bash", detail: { i: 1 } });

    expect(reporter.getStats().bufferedCount).toBe(1);
    await reporter.flush();
    // Both attempts exhausted, still failing: event stays buffered for a later flush().
    expect(reporter.getStats().bufferedCount).toBe(1);
    expect(calls).toBe(2);
  });

  it("makes a gap from buffer overflow, and a missing tail after the final marker, visible in its own bookkeeping", async () => {
    const { fetchImpl } = capturingFetch([response(200, { acknowledged: true, outcome: "accepted", attemptId: "attempt-1" })]);
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl,
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
      fetchImpl: (async () => response(200)) as typeof fetch,
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
    const hanging = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl: hanging,
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
      fetchImpl: (async () => response(200)) as typeof fetch,
    });
    expect("report" in reporter).toBe(false);
  });

  it("resolves the closing send instead of spinning forever when it is rejected with a definitive non-410 status", async () => {
    const responses = [
      response(200, { acknowledged: true, outcome: "accepted", attemptId: "attempt-1" }), // initial batch
      response(409, { acknowledged: false, outcome: "conflict", attemptId: "attempt-1", reason: "stale final marker" }), // closing send
    ];
    let i = 0;
    const calls: unknown[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      const res = responses[Math.min(i, responses.length - 1)];
      i++;
      return res;
    }) as typeof fetch;

    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl,
      retryDelaysMs: [],
    });

    reporter.record({ cycle: 1, kind: "tool_call", action: "Bash", detail: { i: 1 } });
    await reporter.flush(); // drains the buffer first, so the closing send below is batch-empty
    reporter.finalize();

    await reporter.flush(); // must resolve rather than looping on the repeated 409

    // One call to drain the buffer, one for the closing send — no spin.
    expect(calls).toHaveLength(2);
    const stats = reporter.getStats();
    expect(stats.finalSequenceSent).toBe(true);
  });

  it("keeps a missing-tail signal visible when events are dropped after the per-attempt byte limit is reached, even if the final send succeeds", async () => {
    const { fetchImpl } = capturingFetch([response(200, { acknowledged: true, outcome: "accepted", attemptId: "attempt-1" })]);
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl,
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
    const responses = [
      response(410, { acknowledged: false, outcome: "conflict", attemptId: "attempt-1", reason: "stream stale" }),
      response(200, { acknowledged: true, outcome: "accepted", attemptId: "attempt-1" }),
    ];
    let i = 0;
    const calls: unknown[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      const res = responses[Math.min(i, responses.length - 1)];
      i++;
      return res;
    }) as typeof fetch;

    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl,
      retryDelaysMs: [],
      batchSize: 5,
    });

    for (let i = 0; i < 12; i++) {
      reporter.record({ cycle: 1, kind: "tool_call", action: "Bash", detail: { i } });
    }

    await reporter.flush();

    // Only the first (rejected) batch is sent — flush() must not keep going
    // once the stream is closed, and it must not silently strand the rest.
    expect(calls).toHaveLength(1);
    const stats = reporter.getStats();
    expect(stats.closed).toBe(true);
    expect(stats.bufferedCount).toBe(0);
    expect(stats.droppedRanges.some((r) => r.reason === "transport_failure" && r.fromSequence === 5 && r.toSequence === 11)).toBe(true);
    expect(stats.missingTail).toBe(true);
  });

  it("records a DroppedRange for a rejected non-final batch, keeping missingTail true even after later batches succeed", async () => {
    const responses = [
      response(409, { acknowledged: false, outcome: "conflict", attemptId: "attempt-1", reason: "different payload already stored" }), // batch 0-4
      response(200, { acknowledged: true, outcome: "accepted", attemptId: "attempt-1" }), // batch 5-9
      response(200, { acknowledged: true, outcome: "accepted", attemptId: "attempt-1" }), // batch 10-11 + final marker
    ];
    let i = 0;
    const fetchImpl = (async () => {
      const res = responses[Math.min(i, responses.length - 1)];
      i++;
      return res;
    }) as typeof fetch;

    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl,
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
    const { fetchImpl, calls } = capturingFetch([response(200, { acknowledged: true, outcome: "accepted", attemptId: "attempt-1" })]);
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl,
      retryDelaysMs: [],
    });

    reporter.record({
      cycle: 1,
      kind: "tool_result",
      action: "Bash",
      detail: { tokens: ["secret1"], note: "kept" } as any,
    });
    await reporter.flush();

    const serialized = JSON.stringify(calls[0].body);
    expect(serialized).not.toContain("secret1");
    expect(serialized).toContain("kept");
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts an entire nested-object subtree under a credential-shaped key rather than recursing past it", async () => {
    const { fetchImpl, calls } = capturingFetch([response(200, { acknowledged: true, outcome: "accepted", attemptId: "attempt-1" })]);
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl,
      retryDelaysMs: [],
    });

    reporter.record({
      cycle: 1,
      kind: "tool_result",
      action: "Bash",
      detail: { credentials: { raw: "secret2" }, note: "kept" } as any,
    });
    await reporter.flush();

    const serialized = JSON.stringify(calls[0].body);
    expect(serialized).not.toContain("secret2");
    expect(serialized).toContain("kept");
    expect(serialized).toContain("[REDACTED]");
  });

  it("sends the finalSequence marker once the buffer has drained, closing the stream", async () => {
    const { fetchImpl, calls } = capturingFetch([response(200, { acknowledged: true, outcome: "accepted", attemptId: "attempt-1" })]);
    const reporter = new ActivityReporter("https://orchestrator.test", "progress-token", "attempt-1", "producer-1", {
      fetchImpl,
      retryDelaysMs: [],
    });

    reporter.record({ cycle: 1, kind: "tool_call", action: "Bash", detail: { i: 1 } });
    reporter.finalize();
    await reporter.flush();

    expect(calls).toHaveLength(1);
    expect((calls[0].body as any).finalSequence).toBe(reporter.getStats().finalSequence);
    expect(reporter.getStats().finalSequenceSent).toBe(true);
    expect(reporter.getStats().missingTail).toBe(false);
  });
});
