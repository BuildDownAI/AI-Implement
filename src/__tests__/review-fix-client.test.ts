// Unit tests for the review-fix delivery pump and facade (src/restate/review-fix-client.ts,
// AII-802). No Docker, no live Restate server: the facade is exercised against a faked
// fetch (consistent with tools-client.ts's own unit tests, tools.test.ts) and the pump is
// exercised against the real durable inbox (review-fix-inbox.ts, AII-781) backed by a
// throwaway SQLite file, with a fake facade standing in for the sidecar.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as DedupModule from "../dedup.js";
import type * as InboxModule from "../review-fix-inbox.js";
import type * as ClientModule from "../restate/review-fix-client.js";
import type { ScopedPrIdentity } from "../review-fix-contract.js";

let dbPath: string;
let dedup: typeof DedupModule;
let inbox: typeof InboxModule;
let client: typeof ClientModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `review-fix-client-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  inbox = await import("../review-fix-inbox.js");
  client = await import("../restate/review-fix-client.js");
  dedup.getDb();
});

afterEach(() => {
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
  vi.unstubAllGlobals();
});

function makeDestination(overrides: Partial<ScopedPrIdentity> = {}): ScopedPrIdentity {
  return { installationId: 7, repository: "acme/app", prNumber: 42, ...overrides };
}

function makeFakeFacade(overrides: Partial<ClientModule.ReviewFixDeliveryFacade> = {}): ClientModule.ReviewFixDeliveryFacade {
  return {
    deliverFeedback: vi.fn(async () => ({ status: "accepted" }) as const),
    deliverResult: vi.fn(async () => ({ status: "accepted" }) as const),
    deliverCancel: vi.fn(async () => ({ status: "accepted" }) as const),
    ...overrides,
  };
}

describe("createRestateReviewFixFacade", () => {
  it("posts to the ReviewFixPR object's feedback handler with an idempotency-key header", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return { ok: true } as Response;
    });
    const facade = client.createRestateReviewFixFacade({ ingressBaseUrl: "http://sidecar", fetchImpl: fetchImpl as unknown as typeof fetch });

    const outcome = await facade.deliverFeedback(makeDestination(), "feedback:github:evt-1");

    expect(outcome).toEqual({ status: "accepted" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`http://sidecar/ReviewFixPR/${encodeURIComponent(JSON.stringify([7, "acme/app", 42]))}/feedback`);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["idempotency-key"]).toBe("feedback:github:evt-1");
  });

  it("degrades a connection failure to unavailable rather than throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const facade = client.createRestateReviewFixFacade({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const outcome = await facade.deliverCancel("attempt-1", "cancellation:github:evt-1");
    expect(outcome).toEqual({ status: "unavailable" });
  });

  it("degrades a non-2xx response to unavailable", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }) as Response);
    const facade = client.createRestateReviewFixFacade({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const outcome = await facade.deliverResult(
      {
        version: 1,
        attemptId: "attempt-1",
        installationId: 7,
        repository: "acme/app",
        prNumber: 42,
        deadlineAt: Date.now() + 1000,
        githubRunId: 1,
        githubRunAttempt: 1,
        outputCommit: "a".repeat(40),
      },
      "result:github:evt-1",
    );
    expect(outcome).toEqual({ status: "unavailable" });
  });

  it("treats a request that never resolves as unavailable once the configured timeout elapses, instead of hanging forever", async () => {
    // Simulates a stalled sidecar connection: fetch never resolves on its own, but must
    // still react to the AbortSignal invoke() is expected to pass through fetchImpl's init.
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
        }),
    );
    const facade = client.createRestateReviewFixFacade({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 20,
    });

    const outcome = await facade.deliverCancel("attempt-1", "cancellation:github:evt-1");

    expect(outcome).toEqual({ status: "unavailable" });
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });
});

describe("reviewFixDeliveryIdempotencyKey", () => {
  it("is stable across repeated calls for the same logical event (a lost acceptance response)", () => {
    const delivery = { kind: "feedback" as const, authenticatedSource: "github", deliveryId: "evt-1" };
    const first = client.reviewFixDeliveryIdempotencyKey(delivery);
    const second = client.reviewFixDeliveryIdempotencyKey(delivery);
    expect(second).toBe(first);
    expect(first).toBe("feedback:github:evt-1");
  });

  it("differs across event kinds for the same authenticatedSource/deliveryId pair", () => {
    const a = client.reviewFixDeliveryIdempotencyKey({ kind: "result", authenticatedSource: "runner", deliveryId: "evt-9" });
    const b = client.reviewFixDeliveryIdempotencyKey({ kind: "cancellation", authenticatedSource: "runner", deliveryId: "evt-9" });
    expect(a).not.toBe(b);
  });
});

describe("ReviewFixDeliveryPump — mark-delivered only on acceptance", () => {
  it("claims only completion events while deploy admission is closed", async () => {
    let admissionOpen = false;
    const claim = vi.fn(() => []);
    const pump = new client.ReviewFixDeliveryPump({ claim, permitsNewFeedback: () => admissionOpen, now: () => 1_000 });
    await pump.tick();
    expect(claim).toHaveBeenLastCalledWith(expect.objectContaining({ completionOnly: true }));
    admissionOpen = true;
    await pump.tick();
    expect(claim).toHaveBeenLastCalledWith(expect.objectContaining({ completionOnly: false }));
  });

  it("delivers cancellation during a real deploy hold and resumes queued feedback afterward", async () => {
    const { initSettingsTable } = await import("../runner-mode.js");
    const { setDeployHold, clearDeployHold } = await import("../deploy-hold.js");
    initSettingsTable();
    const destination = makeDestination();
    inbox.acceptDelivery({ authenticatedSource: "github", deliveryId: "feedback-held", kind: "feedback", destination, payload: {} });
    inbox.acceptDelivery({ authenticatedSource: "github", deliveryId: "cancel-live", kind: "cancellation", destination, payload: { attemptId: "attempt-1" } });
    const facade = makeFakeFacade();
    const pump = new client.ReviewFixDeliveryPump({ facade, now: () => 1_000 });
    setDeployHold();
    try {
      expect(await pump.tick()).toBe(1);
      expect(facade.deliverFeedback).not.toHaveBeenCalled();
      expect(facade.deliverCancel).toHaveBeenCalledTimes(1);
      expect(inbox.getDelivery("github", "feedback-held")?.deliveryState).toBe("pending");
    } finally {
      clearDeployHold();
    }
    expect(await pump.tick()).toBe(1);
    expect(facade.deliverFeedback).toHaveBeenCalledTimes(1);
    expect(inbox.getDelivery("github", "feedback-held")?.deliveryState).toBe("delivered");
  });
  it("never acks when the facade reports unavailable, leaving the row claimed", async () => {
    const destination = makeDestination();
    inbox.acceptDelivery({
      authenticatedSource: "github",
      deliveryId: "evt-1",
      kind: "feedback",
      destination,
      payload: {},
    });

    const facade = makeFakeFacade({ deliverFeedback: vi.fn(async () => ({ status: "unavailable" }) as const) });
    const pump = new client.ReviewFixDeliveryPump({ facade, now: () => 1_000 });

    const delivered = await pump.tick();

    expect(delivered).toBe(0);
    expect(facade.deliverFeedback).toHaveBeenCalledTimes(1);
    const row = inbox.getDelivery("github", "evt-1");
    expect(row?.deliveryState).not.toBe("delivered");
  });

  it("acks exactly the delivered row when the facade accepts", async () => {
    const destination = makeDestination();
    inbox.acceptDelivery({
      authenticatedSource: "github",
      deliveryId: "evt-2",
      kind: "feedback",
      destination,
      payload: {},
    });

    const facade = makeFakeFacade();
    const pump = new client.ReviewFixDeliveryPump({ facade, now: () => 1_000 });

    const delivered = await pump.tick();

    expect(delivered).toBe(1);
    const row = inbox.getDelivery("github", "evt-2");
    expect(row?.deliveryState).toBe("delivered");
  });
});

describe("ReviewFixDeliveryPump — transient retry", () => {
  it("redelivers the same pending row after the sidecar recovers, without fabricating a new identity", async () => {
    const destination = makeDestination();
    inbox.acceptDelivery({
      authenticatedSource: "github",
      deliveryId: "evt-flaky",
      kind: "feedback",
      destination,
      payload: {},
    });

    let attempts = 0;
    const seenKeys: string[] = [];
    const facade = makeFakeFacade({
      deliverFeedback: vi.fn(async (_dest, idempotencyKey: string) => {
        attempts++;
        seenKeys.push(idempotencyKey);
        return attempts < 3 ? ({ status: "unavailable" } as const) : ({ status: "accepted" } as const);
      }),
    });

    let now = 1_000;
    const pump = new client.ReviewFixDeliveryPump({ facade, now: () => now, retryDelayMs: 500 });

    expect(await pump.tick()).toBe(0);
    now += 600;
    expect(await pump.tick()).toBe(0);
    now += 600;
    expect(await pump.tick()).toBe(1);

    expect(attempts).toBe(3);
    expect(new Set(seenKeys).size).toBe(1); // same idempotency key every attempt — no fresh UUID per retry
    expect(inbox.getDelivery("github", "evt-flaky")?.deliveryState).toBe("delivered");
  });
});

describe("ReviewFixDeliveryPump — restart recovery", () => {
  it("picks up a row left claimed by a crashed pump instance instead of ignoring it as in-flight", async () => {
    const destination = makeDestination();
    inbox.acceptDelivery({
      authenticatedSource: "github",
      deliveryId: "evt-crash",
      kind: "feedback",
      destination,
      payload: {},
    });
    // Simulate a previous pump instance that claimed the row and then crashed before acking.
    inbox.claimDeliveries({ now: 1_000, leaseMs: 60_000 });
    expect(inbox.getDelivery("github", "evt-crash")?.deliveryState).toBe("claimed");

    const facade = makeFakeFacade();
    // A fresh pump instance, started well after the original lease elapsed.
    const pump = new client.ReviewFixDeliveryPump({ facade, now: () => 1_000 + 61_000 });

    const delivered = await pump.tick();

    expect(delivered).toBe(1);
    expect(facade.deliverFeedback).toHaveBeenCalledTimes(1);
    expect(inbox.getDelivery("github", "evt-crash")?.deliveryState).toBe("delivered");
  });
});

describe("ReviewFixDeliveryPump — clean stop", () => {
  it("start() then stop() immediately causes no unhandled rejection and no claim before a subsequent start()", async () => {
    vi.useFakeTimers();
    try {
      const claimSpy = vi.fn(inbox.claimDeliveries);
      const facade = makeFakeFacade();
      const pump = new client.ReviewFixDeliveryPump({ facade, claim: claimSpy });

      pump.start();
      pump.stop();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(claimSpy).not.toHaveBeenCalled();
      expect(pump.status().state).toBe("stopped");

      pump.start();
      expect(pump.status().state).toBe("running");
      pump.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() on a pump that never started does not throw", () => {
    const pump = new client.ReviewFixDeliveryPump({ facade: makeFakeFacade() });
    expect(() => pump.stop()).not.toThrow();
  });
});

describe("ReviewFixDeliveryPump — drain pause", () => {
  it("prevents new claims while leaving an already-claimed row untouched for resumption", async () => {
    const destination = makeDestination();
    inbox.acceptDelivery({
      authenticatedSource: "github",
      deliveryId: "evt-paused",
      kind: "feedback",
      destination,
      payload: {},
    });
    // Simulate a row already claimed (e.g. by this pump's own prior tick, or a sibling process).
    inbox.claimDeliveries({ now: 1_000, leaseMs: 60_000 });

    const claimSpy = vi.fn(inbox.claimDeliveries);
    const facade = makeFakeFacade();
    let now = 1_000;
    const pump = new client.ReviewFixDeliveryPump({ facade, claim: claimSpy, now: () => now });

    pump.pause();
    const delivered = await pump.tick();

    expect(delivered).toBe(0);
    expect(claimSpy).not.toHaveBeenCalled();
    expect(facade.deliverFeedback).not.toHaveBeenCalled();
    // The already-claimed row is left exactly as it was — not cleared, not failed.
    expect(inbox.getDelivery("github", "evt-paused")?.deliveryState).toBe("claimed");

    pump.resume();
    now += 61_000; // past the original lease, matching the restart-recovery lease-expiry semantics
    const deliveredAfterResume = await pump.tick();
    expect(deliveredAfterResume).toBe(1);
    expect(inbox.getDelivery("github", "evt-paused")?.deliveryState).toBe("delivered");
  });
});

describe("ReviewFixDeliveryPump — barrier re-check mid-batch", () => {
  it("finishes cancellation but starts no new feedback after the deploy hold begins", async () => {
    const destination = makeDestination();
    for (const [index, deliveryId, kind] of [[1, "feedback-a", "feedback"], [2, "feedback-b", "feedback"], [3, "cancel-c", "cancellation"]] as const) {
      inbox.acceptDelivery({ authenticatedSource: "github", deliveryId, kind, destination, payload: { attemptId: "attempt-1" } });
      dedup.getDb().prepare("UPDATE review_fix_inbox SET accepted_at = ? WHERE event_id = ?").run(index, deliveryId);
    }
    let admissionOpen = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const deliverFeedback = vi.fn(async () => { await gate; return { status: "accepted" } as const; });
    const deliverCancel = vi.fn(async () => ({ status: "accepted" }) as const);
    const pump = new client.ReviewFixDeliveryPump({ facade: makeFakeFacade({ deliverFeedback, deliverCancel }), permitsNewFeedback: () => admissionOpen, now: () => 1_000 });
    const pending = pump.tick();
    admissionOpen = false;
    release();
    expect(await pending).toBe(2);
    expect(deliverFeedback).toHaveBeenCalledTimes(1);
    expect(deliverCancel).toHaveBeenCalledTimes(1);
    expect(inbox.getDelivery("github", "feedback-b")).toMatchObject({ deliveryState: "pending", retryAt: 6_000 });
  });
  // Regression for a stop()/pause() called while a multi-row batch is still awaiting its
  // first endpoint call: without a re-check before every row, the in-flight tick would
  // keep initiating endpoint calls for the rest of the claimed batch even after the
  // caller believed delivery had stopped.
  function acceptTwo(prefix: string): ScopedPrIdentity {
    const destination = makeDestination();
    inbox.acceptDelivery({ authenticatedSource: "github", deliveryId: `${prefix}-a`, kind: "feedback", destination, payload: {} });
    inbox.acceptDelivery({ authenticatedSource: "github", deliveryId: `${prefix}-b`, kind: "feedback", destination, payload: {} });
    return destination;
  }

  it("stop() during an in-flight tick starts no further endpoint call for the rest of that batch", async () => {
    acceptTwo("evt-stop");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deliverFeedback = vi.fn(async () => {
      await gate;
      return { status: "accepted" } as const;
    });
    const pump = new client.ReviewFixDeliveryPump({ facade: makeFakeFacade({ deliverFeedback }), now: () => 1_000 });

    const tickPromise = pump.tick();
    // The first row's facade call is already in flight (awaiting `gate`) by this point.
    pump.stop();
    release();
    const delivered = await tickPromise;

    expect(delivered).toBe(1);
    expect(deliverFeedback).toHaveBeenCalledTimes(1);
    // The second row was claimed with the batch but never reached: left claimed, not
    // touched, so it is recoverable once its lease elapses (same as restart recovery).
    expect(inbox.getDelivery("github", "evt-stop-b")?.deliveryState).toBe("claimed");
  });

  it("pause() during an in-flight tick starts no further endpoint call for the rest of that batch", async () => {
    acceptTwo("evt-pause");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deliverFeedback = vi.fn(async () => {
      await gate;
      return { status: "accepted" } as const;
    });
    const pump = new client.ReviewFixDeliveryPump({ facade: makeFakeFacade({ deliverFeedback }), now: () => 1_000 });

    const tickPromise = pump.tick();
    pump.pause();
    release();
    const delivered = await tickPromise;

    expect(delivered).toBe(1);
    expect(deliverFeedback).toHaveBeenCalledTimes(1);
    expect(inbox.getDelivery("github", "evt-pause-b")?.deliveryState).toBe("claimed");
  });
});

describe("ReviewFixDeliveryPump — invalid payload vs. facade unavailable", () => {
  it("reports a locally-invalid cancellation payload separately from a genuine facade outage, in both the reschedule cadence and status()", async () => {
    const destination = makeDestination();
    inbox.acceptDelivery({
      authenticatedSource: "runner",
      deliveryId: "evt-poison",
      kind: "cancellation",
      // No attemptId: extractAttemptId() will fail — this can never succeed by retrying
      // the sidecar, unlike a real outage.
      destination,
      payload: {},
    });

    const facade = makeFakeFacade();
    const pump = new client.ReviewFixDeliveryPump({ facade, now: () => 1_000, retryDelayMs: 500, invalidRetryDelayMs: 60_000 });

    const delivered = await pump.tick();

    expect(delivered).toBe(0);
    expect(facade.deliverCancel).not.toHaveBeenCalled(); // never touches the network
    const status = pump.status();
    expect(status.lastTickInvalid).toBe(1);
    expect(status.lastTickUnavailable).toBe(0);
    // Rescheduled at the longer invalid-payload cadence, not the short transient-retry one.
    const row = inbox.getDelivery("runner", "evt-poison");
    expect(row?.deliveryState).toBe("pending");
    expect(row?.retryAt).toBe(1_000 + 60_000);
  });

  it("counts a genuine facade outage under lastTickUnavailable, not lastTickInvalid", async () => {
    const destination = makeDestination();
    inbox.acceptDelivery({ authenticatedSource: "github", deliveryId: "evt-down", kind: "feedback", destination, payload: {} });

    const facade = makeFakeFacade({ deliverFeedback: vi.fn(async () => ({ status: "unavailable" }) as const) });
    const pump = new client.ReviewFixDeliveryPump({ facade, now: () => 1_000 });

    const delivered = await pump.tick();

    expect(delivered).toBe(0);
    const status = pump.status();
    expect(status.lastTickInvalid).toBe(0);
    expect(status.lastTickUnavailable).toBe(1);
  });

  it("never logs a secret-shaped value from a malformed stored result's version field", async () => {
    const destination = makeDestination();
    const secret = "super-secret-token-value";
    inbox.acceptDelivery({
      authenticatedSource: "runner",
      deliveryId: "evt-poison-version",
      kind: "result",
      destination,
      // An unsupported version fails validateReviewFixMetadata, whose error message
      // interpolates the raw `version` value via JSON.stringify — this must never reach
      // a log line, even though the pump still needs to classify and reschedule it.
      payload: { version: secret },
    });

    const facade = makeFakeFacade();
    const pump = new client.ReviewFixDeliveryPump({ facade, now: () => 1_000, invalidRetryDelayMs: 60_000 });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const delivered = await pump.tick();

      expect(delivered).toBe(0);
      expect(pump.status().lastTickInvalid).toBe(1);
      expect(facade.deliverResult).not.toHaveBeenCalled();

      const allLoggedText = [...logSpy.mock.calls, ...warnSpy.mock.calls].map((call) => call.join(" ")).join("\n");
      expect(allLoggedText).not.toContain(secret);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe("ReviewFixDeliveryPump — routing", () => {
  it("routes a result event to deliverResult with the validated, secret-free payload", async () => {
    const destination = makeDestination();
    const resultPayload = {
      version: 1,
      attemptId: "attempt-42",
      installationId: destination.installationId,
      repository: destination.repository,
      prNumber: destination.prNumber,
      deadlineAt: Date.now() + 60_000,
      githubRunId: 100,
      githubRunAttempt: 1,
      outputCommit: "b".repeat(40),
      // A secret-shaped field that must never reach the facade — validation strips
      // anything outside the recognised ReviewFixResultMetadataV1 shape.
      apiToken: "super-secret-value",
    };
    inbox.acceptDelivery({
      authenticatedSource: "runner",
      deliveryId: "evt-result",
      kind: "result",
      destination,
      payload: resultPayload,
    });

    const facade = makeFakeFacade();
    const pump = new client.ReviewFixDeliveryPump({ facade, now: () => 1_000 });

    const delivered = await pump.tick();

    expect(delivered).toBe(1);
    expect(facade.deliverResult).toHaveBeenCalledTimes(1);
    const [forwarded] = (facade.deliverResult as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(forwarded.attemptId).toBe("attempt-42");
    expect(Object.keys(forwarded)).not.toContain("apiToken");
  });

  it("routes a cancellation event to deliverCancel with the attemptId extracted from the payload", async () => {
    const destination = makeDestination();
    inbox.acceptDelivery({
      authenticatedSource: "runner",
      deliveryId: "evt-cancel",
      kind: "cancellation",
      destination,
      payload: { attemptId: "attempt-99" },
    });

    const facade = makeFakeFacade();
    const pump = new client.ReviewFixDeliveryPump({ facade, now: () => 1_000 });

    const delivered = await pump.tick();

    expect(delivered).toBe(1);
    expect(facade.deliverCancel).toHaveBeenCalledWith("attempt-99", expect.any(String));
  });

  it("leaves a terminal-effect row unclaimed for exact-identity finalizer reconciliation", async () => {
    const destination = makeDestination();
    inbox.acceptDelivery({
      authenticatedSource: "runner",
      deliveryId: "evt-terminal",
      kind: "terminal-effect",
      destination,
      payload: {},
    });

    const facade = makeFakeFacade();
    const pump = new client.ReviewFixDeliveryPump({ facade, now: () => 1_000 });

    const delivered = await pump.tick();

    expect(delivered).toBe(0);
    expect(facade.deliverFeedback).not.toHaveBeenCalled();
    expect(facade.deliverResult).not.toHaveBeenCalled();
    expect(facade.deliverCancel).not.toHaveBeenCalled();
    const row = inbox.getDelivery("runner", "evt-terminal");
    expect(row?.deliveryState).toBe("pending");
    expect(pump.status().lastTickUnavailable).toBe(0);
  });
});

describe("no launch/finalize/recovery decisions leak into this module", () => {
  it("imports neither worker/finalizer ports nor dispatch/runner modules", () => {
    const source = fs.readFileSync(path.join(__dirname, "../restate/review-fix-client.ts"), "utf8");
    const forbidden = [
      "review-fix-ports.js",
      "review-fix-attempt.js",
      "fly-machines.js",
      "local-docker.js",
      "github.js",
      "local-gapfill.js",
      "review-fix-queue.js",
      "comment-gapfill-queue.js",
      "providers/",
    ];
    for (const module of forbidden) {
      expect(source).not.toContain(module);
    }
  });
});
