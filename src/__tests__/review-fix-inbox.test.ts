import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as DedupModule from "../dedup.js";
import type * as InboxModule from "../review-fix-inbox.js";
import type { ScopedPrIdentity } from "../review-fix-contract.js";

let dbPath: string;
let dedup: typeof DedupModule;
let inbox: typeof InboxModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `review-fix-inbox-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  inbox = await import("../review-fix-inbox.js");
  dedup.getDb();
});

afterEach(() => {
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
});

function makeDestination(overrides: Partial<ScopedPrIdentity> = {}): ScopedPrIdentity {
  return { installationId: 7, repository: "acme/app", prNumber: 42, ...overrides };
}

describe("acceptDelivery", () => {
  it("returns the original acceptance after a restart before the HTTP ack (same payload replayed)", async () => {
    const destination = makeDestination();
    const outcome1 = inbox.acceptDelivery({
      authenticatedSource: "github",
      deliveryId: "evt-1",
      kind: "feedback",
      destination,
      payload: { text: "please fix X" },
    });
    expect(outcome1.status).toBe("accepted");

    // Simulate a process restart: close the handle, reset modules, and re-import
    // against the SAME durable file rather than a fresh tmp DB.
    dedup.closeDb();
    vi.resetModules();
    dedup = await import("../dedup.js");
    inbox = await import("../review-fix-inbox.js");

    const outcome2 = inbox.acceptDelivery({
      authenticatedSource: "github",
      deliveryId: "evt-1",
      kind: "feedback",
      destination,
      payload: { text: "please fix X" },
    });

    expect(outcome2.status).toBe("accepted");
    if (outcome1.status === "accepted" && outcome2.status === "accepted") {
      expect(outcome2.delivery).toEqual(outcome1.delivery);
    }
    const count = dedup.getDb().prepare("SELECT COUNT(*) AS n FROM review_fix_inbox").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("rejects conflicting reuse of the same identity instead of overwriting the stored row", () => {
    const destination = makeDestination();
    const first = inbox.acceptDelivery({
      authenticatedSource: "github",
      deliveryId: "evt-2",
      kind: "feedback",
      destination,
      payload: { text: "original" },
    });
    expect(first.status).toBe("accepted");
    const originalHash = first.status === "accepted" ? first.delivery.payloadHash : null;

    const conflict = inbox.acceptDelivery({
      authenticatedSource: "github",
      deliveryId: "evt-2",
      kind: "feedback",
      destination,
      payload: { text: "different content" },
    });
    expect(conflict.status).toBe("conflict");
    if (conflict.status === "conflict") {
      expect(conflict.delivery.payload).toEqual({ text: "original" });
      expect(conflict.delivery.conflictCount).toBe(1);
      expect(conflict.delivery.conflictAt).not.toBeNull();
    }

    const stored = inbox.getDelivery("github", "evt-2");
    expect(stored?.payload).toEqual({ text: "original" });
    expect(stored?.kind).toBe("feedback");
    expect(stored?.destination).toEqual(destination);
    expect(stored?.payloadHash).toEqual(originalHash);
    expect(stored?.deliveryState).toBe("pending");
    const count = dedup.getDb().prepare("SELECT COUNT(*) AS n FROM review_fix_inbox").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("records a conflict marker that survives closing and reopening the database, and increments on repeated conflicting reuse", async () => {
    const destination = makeDestination();
    inbox.acceptDelivery({
      authenticatedSource: "github",
      deliveryId: "evt-conflict-durable",
      kind: "feedback",
      destination,
      payload: { text: "original" },
    });

    inbox.acceptDelivery({
      authenticatedSource: "github",
      deliveryId: "evt-conflict-durable",
      kind: "feedback",
      destination,
      payload: { text: "different content" },
    });

    dedup.closeDb();
    vi.resetModules();
    dedup = await import("../dedup.js");
    inbox = await import("../review-fix-inbox.js");

    const afterReopen = inbox.getDelivery("github", "evt-conflict-durable");
    expect(afterReopen?.conflictCount).toBe(1);
    expect(afterReopen?.conflictAt).not.toBeNull();
    expect(afterReopen?.payload).toEqual({ text: "original" });

    // A second, distinct conflicting reuse increments the counter rather than
    // resetting it, and a matching replay of the originally accepted content
    // must not touch the marker at all.
    const secondConflict = inbox.acceptDelivery({
      authenticatedSource: "github",
      deliveryId: "evt-conflict-durable",
      kind: "feedback",
      destination,
      payload: { text: "yet another content" },
    });
    expect(secondConflict.status).toBe("conflict");
    if (secondConflict.status === "conflict") {
      expect(secondConflict.delivery.conflictCount).toBe(2);
    }

    const replay = inbox.acceptDelivery({
      authenticatedSource: "github",
      deliveryId: "evt-conflict-durable",
      kind: "feedback",
      destination,
      payload: { text: "original" },
    });
    expect(replay.status).toBe("accepted");
    if (replay.status === "accepted") {
      expect(replay.delivery.conflictCount).toBe(2);
    }
  });

  it("cannot report accepted when the underlying write fails, and leaves no partial row", () => {
    const db = dedup.getDb();
    db.exec(`
      CREATE TEMP TRIGGER trg_forced_failure BEFORE INSERT ON review_fix_inbox
      WHEN NEW.event_id = 'fail-me'
      BEGIN SELECT RAISE(ABORT, 'forced failure'); END
    `);

    expect(() =>
      inbox.acceptDelivery({
        authenticatedSource: "github",
        deliveryId: "fail-me",
        kind: "feedback",
        destination: makeDestination(),
        payload: { text: "x" },
      }),
    ).toThrow(/forced failure/);

    expect(inbox.getDelivery("github", "fail-me")).toBeNull();

    // A subsequent, un-triggered accept still works normally — the failed
    // transaction left no lingering state behind.
    const outcome = inbox.acceptDelivery({
      authenticatedSource: "github",
      deliveryId: "evt-3",
      kind: "feedback",
      destination: makeDestination(),
      payload: { text: "x" },
    });
    expect(outcome.status).toBe("accepted");
  });

  it("requires and stores an explicit destination for every event kind", () => {
    const kinds = ["feedback", "result", "cancellation", "terminal-effect"] as const;
    for (const kind of kinds) {
      const destination = makeDestination({ prNumber: 100 + kinds.indexOf(kind) });
      const outcome = inbox.acceptDelivery({
        authenticatedSource: "github",
        deliveryId: `evt-kind-${kind}`,
        kind,
        destination,
        payload: { kind },
      });
      expect(outcome.status).toBe("accepted");
      if (outcome.status === "accepted") {
        expect(outcome.delivery.destination).toEqual(destination);
        expect(outcome.delivery.kind).toBe(kind);
      }
    }
  });

  it("rejects a delivery that omits its destination, at the runtime-validation level", () => {
    const outcome = inbox.acceptDelivery({
      authenticatedSource: "github",
      deliveryId: "evt-no-destination",
      kind: "feedback",
      destination: undefined as unknown as ScopedPrIdentity,
      payload: { text: "x" },
    });
    expect(outcome.status).toBe("rejected");
    expect(inbox.getDelivery("github", "evt-no-destination")).toBeNull();
  });

  it("rejects an unsupported event kind", () => {
    const outcome = inbox.acceptDelivery({
      authenticatedSource: "github",
      deliveryId: "evt-bad-kind",
      kind: "not-a-real-kind" as unknown as InboxModule.ReviewFixEventKind,
      destination: makeDestination(),
      payload: {},
    });
    expect(outcome.status).toBe("rejected");
  });
});

describe("claimDeliveries", () => {
  it("leases a delivery claim recoverable after a crash, retrying the same destination identity", () => {
    const destination = makeDestination();
    inbox.acceptDelivery({
      authenticatedSource: "github",
      deliveryId: "evt-claim",
      kind: "result",
      destination,
      payload: { ok: true },
    });

    const now = 1_000_000;
    const firstClaim = inbox.claimDeliveries({ now, leaseMs: 60_000 });
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]!.deliveryId).toBe("evt-claim");
    expect(firstClaim[0]!.destination).toEqual(destination);

    // A second claim attempt before the lease expires (simulating another
    // worker, or the same one polling again) must not double-claim it.
    const stillLeased = inbox.claimDeliveries({ now: now + 1_000, leaseMs: 60_000 });
    expect(stillLeased).toHaveLength(0);

    // After the lease expires — e.g. the worker that claimed it crashed before
    // sending or before acking — the same row, with the same destination
    // identity, becomes claimable again.
    const afterExpiry = inbox.claimDeliveries({ now: now + 61_000, leaseMs: 60_000 });
    expect(afterExpiry).toHaveLength(1);
    expect(afterExpiry[0]!.deliveryId).toBe("evt-claim");
    expect(afterExpiry[0]!.destination).toEqual(destination);
  });

  it("claims oldest-accepted-first and never returns an already-delivered row", () => {
    inbox.acceptDelivery({
      authenticatedSource: "github",
      deliveryId: "evt-old",
      kind: "feedback",
      destination: makeDestination(),
      payload: { seq: 1 },
    });
    inbox.acceptDelivery({
      authenticatedSource: "github",
      deliveryId: "evt-new",
      kind: "feedback",
      destination: makeDestination(),
      payload: { seq: 2 },
    });
    inbox.ackDelivery("github", "evt-old");

    const claimed = inbox.claimDeliveries({ now: Date.now() });
    expect(claimed.map((d) => d.deliveryId)).toEqual(["evt-new"]);
  });
});

describe("retryDelivery", () => {
  it("reschedules a claimed delivery for immediate redelivery without waiting for lease expiry", () => {
    inbox.acceptDelivery({
      authenticatedSource: "runner",
      deliveryId: "evt-retry",
      kind: "cancellation",
      destination: makeDestination(),
      payload: {},
    });
    const now = 2_000_000;
    inbox.claimDeliveries({ now, leaseMs: 5 * 60_000 });

    const retried = inbox.retryDelivery("runner", "evt-retry", now + 500);
    expect(retried.status).toBe("scheduled");

    // Reclaimable immediately at the rescheduled time, well before the original lease would expire.
    const reclaimed = inbox.claimDeliveries({ now: now + 1_000 });
    expect(reclaimed.map((d) => d.deliveryId)).toEqual(["evt-retry"]);
  });

  it("returns not_found for an unknown delivery and already_delivered for a terminal one", () => {
    expect(inbox.retryDelivery("runner", "unknown").status).toBe("not_found");

    inbox.acceptDelivery({
      authenticatedSource: "runner",
      deliveryId: "evt-done",
      kind: "result",
      destination: makeDestination(),
      payload: {},
    });
    inbox.ackDelivery("runner", "evt-done");
    expect(inbox.retryDelivery("runner", "evt-done").status).toBe("already_delivered");
  });
});

describe("ackDelivery", () => {
  it("is idempotent: acking an already-acked delivery is a no-op success, not an error", () => {
    inbox.acceptDelivery({
      authenticatedSource: "github",
      deliveryId: "evt-ack",
      kind: "terminal-effect",
      destination: makeDestination(),
      payload: {},
    });

    const first = inbox.ackDelivery("github", "evt-ack", 5_000);
    expect(first.status).toBe("ok");
    if (first.status === "ok") expect(first.delivery.deliveredAt).toBe(5_000);

    const second = inbox.ackDelivery("github", "evt-ack", 9_000);
    expect(second.status).toBe("ok");
    if (second.status === "ok") expect(second.delivery.deliveredAt).toBe(5_000); // unchanged, not re-stamped
  });

  it("returns a typed not-found result for an unknown delivery", () => {
    const outcome = inbox.ackDelivery("github", "does-not-exist");
    expect(outcome.status).toBe("not_found");
  });
});

describe("tombstoneDelivery", () => {
  it("tombstones independently of payload retention", () => {
    inbox.acceptDelivery({
      authenticatedSource: "github",
      deliveryId: "evt-tomb",
      kind: "feedback",
      destination: makeDestination(),
      payload: { text: "keep me" },
    });

    const tombstoned = inbox.tombstoneDelivery("github", "evt-tomb", 42_000);
    expect(tombstoned.status).toBe("ok");
    if (tombstoned.status === "ok") {
      expect(tombstoned.delivery.tombstonedAt).toBe(42_000);
      expect(tombstoned.delivery.payload).toEqual({ text: "keep me" }); // payload untouched by tombstoning
    }

    // Tombstoning again does not move the timestamp (idempotent), and a
    // separate payload purge (simulated directly here, since this module
    // documents no purge path yet) does not clear the tombstone.
    const again = inbox.tombstoneDelivery("github", "evt-tomb", 99_000);
    expect(again.status).toBe("ok");
    if (again.status === "ok") expect(again.delivery.tombstonedAt).toBe(42_000);

    dedup.getDb().prepare("UPDATE review_fix_inbox SET payload_json = 'null' WHERE event_id = 'evt-tomb'").run();
    const afterPurge = inbox.getDelivery("github", "evt-tomb");
    expect(afterPurge?.tombstonedAt).toBe(42_000);
    expect(afterPurge?.payload).toBeNull();
  });

  it("returns a typed not-found result for an unknown delivery", () => {
    expect(inbox.tombstoneDelivery("github", "does-not-exist").status).toBe("not_found");
  });
});

describe("no lifecycle or dispatch decisions leak into this module", () => {
  it("imports neither dispatch/lifecycle queues nor tracker/provider modules", () => {
    const source = fs.readFileSync(path.join(__dirname, "../review-fix-inbox.ts"), "utf8");
    const forbidden = [
      "comment-gapfill-queue.js",
      "review-fix-queue.js",
      "fly-machines.js",
      "github.js",
      "providers/",
    ];
    for (const module of forbidden) {
      expect(source).not.toContain(module);
    }
  });
});
