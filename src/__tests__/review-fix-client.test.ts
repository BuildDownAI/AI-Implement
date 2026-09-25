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

  it("leaves a terminal-effect row pending rather than dropping it, since no route exists yet", async () => {
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
    expect(row?.deliveryState).not.toBe("delivered");
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
