/**
 * Behavioral tests for `src/dispatch-admission.ts` (AII-775). Exercises the module
 * directly against a temp SQLite file, matching `dispatch-gate.test.ts`'s harness.
 * `npm run typecheck` excludes `src/__tests__` and vitest strips types without
 * checking them, so the `prepare` synchronous-only contract is additionally
 * type-checked explicitly via `npx tsc --noEmit -p tsconfig.dispatch-admission-tests.json`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as AdmissionModule from "../dispatch-admission.js";

let dbPath: string;
let dedup: typeof DedupModule;
let admission: typeof AdmissionModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `dispatch-admission-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  admission = await import("../dispatch-admission.js");
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

const LEGACY = { kind: "legacy" as const };
const RESTATE_A = { kind: "restate" as const, attemptId: "attempt-a" };
const RESTATE_B = { kind: "restate" as const, attemptId: "attempt-b" };

function issueRequest(overrides: Partial<AdmissionModule.DispatchAdmissionRequest> = {}): AdmissionModule.DispatchAdmissionRequest {
  return {
    dispatchId: "dispatch-1",
    mappingKey: "AII",
    scope: { kind: "issue", issueScope: "team-a", issueId: "AII-1" },
    kind: "implementation",
    backend: "github-actions",
    lifecycleOwner: LEGACY,
    cap: 5,
    ...overrides,
  };
}

function prRequest(overrides: Partial<AdmissionModule.DispatchAdmissionRequest> = {}): AdmissionModule.DispatchAdmissionRequest {
  return {
    dispatchId: "dispatch-pr-1",
    mappingKey: "AII",
    scope: {
      kind: "pr",
      issueId: "AII-2",
      installationId: "7",
      repository: "BuildDownAI/AI-Implement",
      prNumber: 42,
    },
    kind: "gap-fill",
    backend: "github-actions",
    lifecycleOwner: LEGACY,
    cap: 5,
    ...overrides,
  };
}

describe("acquire — last-slot race across issue and PR paths", () => {
  it("two competing acquisitions for the last team slot yield exactly one winner", () => {
    const first = admission.acquire(issueRequest({ dispatchId: "issue-run", cap: 1 }));
    expect(first.ok).toBe(true);

    const second = admission.acquire(
      prRequest({ dispatchId: "pr-run", cap: 1, scope: { kind: "pr", issueId: "AII-9", installationId: "7", repository: "BuildDownAI/AI-Implement", prNumber: 99 } }),
    );
    expect(second).toEqual({ ok: false, reason: "at_capacity", count: 1, cap: 1 });
  });
});

describe("acquire — no double-spend or phantom release", () => {
  it("acquire A and B up to cap, release A, only one new acquire succeeds", () => {
    const a = admission.acquire(issueRequest({ dispatchId: "a", scope: { kind: "issue", issueScope: "s", issueId: "issue-a" }, cap: 2 }));
    const b = admission.acquire(issueRequest({ dispatchId: "b", scope: { kind: "issue", issueScope: "s", issueId: "issue-b" }, cap: 2 }));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const blocked = admission.acquire(issueRequest({ dispatchId: "c", scope: { kind: "issue", issueScope: "s", issueId: "issue-c" }, cap: 2 }));
    expect(blocked).toEqual({ ok: false, reason: "at_capacity", count: 2, cap: 2 });

    expect(a.ok && admission.release("a", LEGACY, a.record.generation, "finalized")).toEqual({ status: "released" });

    const c = admission.acquire(issueRequest({ dispatchId: "c", scope: { kind: "issue", issueScope: "s", issueId: "issue-c" }, cap: 2 }));
    expect(c.ok).toBe(true);

    const d = admission.acquire(issueRequest({ dispatchId: "d", scope: { kind: "issue", issueScope: "s", issueId: "issue-d" }, cap: 2 }));
    expect(d).toEqual({ ok: false, reason: "at_capacity", count: 2, cap: 2 });
  });

  it("releasing an already-released or never-acquired identity is a no-op and does not throw", () => {
    admission.acquire(issueRequest({ dispatchId: "a" }));
    expect(admission.release("a", LEGACY, 0, "finalized")).toEqual({ status: "released" });
    expect(admission.release("a", LEGACY, 0, "finalized")).toEqual({ status: "not_owner" });
    expect(admission.release("never-existed", LEGACY, 0, "finalized")).toEqual({ status: "not_owner" });
  });

  it("a mismatched-owner release does not clear a replacement's reservation", () => {
    admission.acquire(issueRequest({ dispatchId: "a", lifecycleOwner: RESTATE_A }));
    expect(admission.release("a", LEGACY, 0, "finalized")).toEqual({ status: "not_owner" });
    expect(admission.release("a", RESTATE_B, 0, "finalized")).toEqual({ status: "not_owner" });
    expect(admission.read("a")?.releasedAt).toBeNull();

    expect(admission.release("a", RESTATE_A, 0, "finalized")).toEqual({ status: "released" });
    expect(admission.read("a")?.releasedAt).not.toBeNull();
  });

  it("a mismatched-generation release does not clear a replacement's reservation even with the same owner", () => {
    // Regression for the review finding: `release` matching on (dispatchId, owner) alone
    // lets a delayed release from a released reservation clear its replacement whenever
    // both share an encoded owner — trivially true for every `{ kind: "legacy" }` holder.
    const a = admission.acquire(issueRequest({ dispatchId: "shared", lifecycleOwner: LEGACY }));
    expect(a.ok).toBe(true);
    if (!a.ok) throw new Error("unreachable");
    expect(admission.release("shared", LEGACY, a.record.generation, "finalized")).toEqual({ status: "released" });

    const b = admission.acquire(issueRequest({ dispatchId: "shared", lifecycleOwner: LEGACY }));
    expect(b.ok).toBe(true);
    if (!b.ok) throw new Error("unreachable");
    expect(b.record.generation).not.toBe(a.record.generation);

    // A's release replays with A's stale generation against B's owner-identical row.
    expect(admission.release("shared", LEGACY, a.record.generation, "launch_rejected")).toEqual({ status: "not_owner" });
    expect(admission.read("shared")?.releasedAt).toBeNull();
    expect(admission.count("AII")).toBe(1);

    expect(admission.release("shared", LEGACY, b.record.generation, "finalized")).toEqual({ status: "released" });
  });

  it("reacquiring an already-released dispatchId yields a fresh reservation, not a reused slot", () => {
    const first = admission.acquire(issueRequest({ dispatchId: "a" }));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    admission.release("a", LEGACY, first.record.generation, "finalized");
    expect(admission.read("a")?.releasedAt).not.toBeNull();

    const second = admission.acquire(issueRequest({ dispatchId: "a" }));
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.record.releasedAt).toBeNull();
      expect(second.record.releaseReason).toBeNull();
      expect(second.record.generation).toBeGreaterThan(first.record.generation);
      expect(second.record.createdAt).toBeGreaterThanOrEqual(first.record.createdAt);
    }
    expect(admission.read("a")?.releasedAt).toBeNull();
    expect(admission.count("AII")).toBe(1);

    if (second.ok) {
      expect(admission.release("a", LEGACY, second.record.generation, "finalized")).toEqual({ status: "released" });
    }
  });

  it("reacquiring a released dispatchId re-evaluates occupancy and capacity rather than skipping the checks", () => {
    const a = admission.acquire(issueRequest({ dispatchId: "a", cap: 1 }));
    if (a.ok) admission.release("a", LEGACY, a.record.generation, "finalized");

    const blockerScope = { kind: "issue" as const, issueScope: "team-a", issueId: "AII-1" };
    const blocker = admission.acquire(issueRequest({ dispatchId: "blocker", scope: blockerScope, cap: 1 }));
    expect(blocker.ok).toBe(true);

    const reacquire = admission.acquire(issueRequest({ dispatchId: "a", scope: blockerScope, cap: 1 }));
    expect(reacquire).toEqual({ ok: false, reason: "occupied", count: 1, cap: 1 });
  });
});

describe("acquire — retry idempotency", () => {
  it("calling acquire twice with the same dispatchId returns the same reservation without spending two slots", () => {
    const first = admission.acquire(issueRequest({ dispatchId: "retry-1", cap: 1 }));
    const second = admission.acquire(issueRequest({ dispatchId: "retry-1", cap: 1 }));
    expect(first).toEqual(second);
    expect(admission.count("AII")).toBe(1);

    const blocked = admission.acquire(issueRequest({ dispatchId: "other", scope: { kind: "issue", issueScope: "team-a", issueId: "AII-99" }, cap: 1 }));
    expect(blocked).toEqual({ ok: false, reason: "at_capacity", count: 1, cap: 1 });
  });
});

describe("acquire — human override obeys capacity but bypasses parked/budget", () => {
  it("humanRequested still blocks on at_capacity", () => {
    admission.acquire(issueRequest({ dispatchId: "filler", cap: 1 }));
    const decision = admission.acquire(
      issueRequest({ dispatchId: "human-run", scope: { kind: "issue", issueScope: "team-a", issueId: "AII-human" }, cap: 1, humanRequested: true, parked: true }),
    );
    expect(decision).toEqual({ ok: false, reason: "at_capacity", count: 1, cap: 1 });
  });

  it("humanRequested bypasses parked", () => {
    const decision = admission.acquire(issueRequest({ dispatchId: "parked-human", parked: true, humanRequested: true }));
    expect(decision.ok).toBe(true);
  });

  it("non-human request is blocked while parked", () => {
    const decision = admission.acquire(issueRequest({ dispatchId: "parked-auto", parked: true }));
    expect(decision).toEqual({ ok: false, reason: "parked", count: 0, cap: 5 });
  });

  it("humanRequested=true still blocks on team_capacity even when also parked (mirrors dispatch-gate.test.ts's 'humanRequested=true still blocks on team_capacity')", () => {
    admission.acquire(issueRequest({ dispatchId: "other-1", scope: { kind: "issue", issueScope: "team-a", issueId: "AII-other-1" }, cap: 1 }));

    const decision = admission.acquire(
      issueRequest({
        dispatchId: "human-parked-over-capacity",
        scope: { kind: "issue", issueScope: "team-a", issueId: "AII-human-parked" },
        cap: 1,
        humanRequested: true,
        parked: true,
      }),
    );
    expect(decision).toEqual({ ok: false, reason: "at_capacity", count: 1, cap: 1 });
  });

  it("humanRequested bypasses pr budget but capacity and history are unaffected", () => {
    const PR = { kind: "pr" as const, issueId: "AII-b", installationId: "7", repository: "BuildDownAI/AI-Implement", prNumber: 42 };
    const one = admission.acquire(prRequest({ dispatchId: "b1", scope: PR, prDispatchBudget: 2 }));
    expect(one.ok).toBe(true);
    if (one.ok) admission.release("b1", LEGACY, one.record.generation, "finalized");
    const two = admission.acquire(prRequest({ dispatchId: "b2", scope: PR, prDispatchBudget: 2 }));
    expect(two.ok).toBe(true);
    if (two.ok) admission.release("b2", LEGACY, two.record.generation, "finalized");

    const blocked = admission.acquire(prRequest({ dispatchId: "b3", scope: PR, prDispatchBudget: 2 }));
    expect(blocked).toEqual({ ok: false, reason: "budget_exhausted", count: 0, cap: 5 });

    const human = admission.acquire(prRequest({ dispatchId: "b4", scope: PR, prDispatchBudget: 2, humanRequested: true }));
    expect(human.ok).toBe(true);
  });
});

describe("acquire — reacquiring a released PR-scoped dispatchId", () => {
  it("does not throw and does not double-spend the pr budget on the same identity", () => {
    const PR = { kind: "pr" as const, issueId: "AII-c", installationId: "7", repository: "BuildDownAI/AI-Implement", prNumber: 55 };

    const first = admission.acquire(prRequest({ dispatchId: "retry-pr", scope: PR, prDispatchBudget: 2 }));
    expect(first.ok).toBe(true);
    if (first.ok) admission.release("retry-pr", LEGACY, first.record.generation, "launch_rejected");

    expect(() => admission.acquire(prRequest({ dispatchId: "retry-pr", scope: PR, prDispatchBudget: 2 }))).not.toThrow();
    const second = admission.acquire(prRequest({ dispatchId: "retry-pr", scope: PR, prDispatchBudget: 2 }));
    expect(second.ok).toBe(true);
    if (second.ok) admission.release("retry-pr", LEGACY, second.record.generation, "finalized");

    const third = admission.acquire(prRequest({ dispatchId: "second-pr", scope: PR, prDispatchBudget: 2 }));
    expect(third.ok).toBe(true);
    if (third.ok) admission.release("second-pr", LEGACY, third.record.generation, "finalized");

    // Budget cap is 2. "retry-pr" recorded exactly one budget entry despite two
    // acquires (the second acquire's INSERT OR IGNORE kept the original), so this
    // third distinct PR dispatch is still within budget — it would be blocked if
    // the reacquire had recorded a second entry.
    const blocked = admission.acquire(prRequest({ dispatchId: "third-pr", scope: PR, prDispatchBudget: 2 }));
    expect(blocked).toEqual({ ok: false, reason: "budget_exhausted", count: 0, cap: 5 });
  });
});

describe("acquire — scope isolation", () => {
  it("different issueScope namespaces do not collide on the same issueId", () => {
    const a = admission.acquire(issueRequest({ dispatchId: "a", scope: { kind: "issue", issueScope: "team-a", issueId: "AII-1" } }));
    const b = admission.acquire(issueRequest({ dispatchId: "b", scope: { kind: "issue", issueScope: "team-b", issueId: "AII-1" } }));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it("the same issueScope/issueId pair is occupied while active", () => {
    const a = admission.acquire(issueRequest({ dispatchId: "a", scope: { kind: "issue", issueScope: "team-a", issueId: "AII-1" } }));
    const conflict = admission.acquire(issueRequest({ dispatchId: "a-retry-different-id", scope: { kind: "issue", issueScope: "team-a", issueId: "AII-1" } }));
    expect(a.ok).toBe(true);
    expect(conflict).toEqual({ ok: false, reason: "occupied", count: 1, cap: 5 });
  });

  it("different installationId does not collide on the same repository/prNumber", () => {
    const a = admission.acquire(prRequest({ dispatchId: "a", scope: { kind: "pr", issueId: "x", installationId: "7", repository: "BuildDownAI/AI-Implement", prNumber: 42 } }));
    const b = admission.acquire(prRequest({ dispatchId: "b", scope: { kind: "pr", issueId: "y", installationId: "8", repository: "BuildDownAI/AI-Implement", prNumber: 42 } }));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it("different repository does not collide on the same installationId/prNumber", () => {
    const a = admission.acquire(prRequest({ dispatchId: "a", scope: { kind: "pr", issueId: "x", installationId: "7", repository: "BuildDownAI/AI-Implement", prNumber: 42 } }));
    const b = admission.acquire(prRequest({ dispatchId: "b", scope: { kind: "pr", issueId: "y", installationId: "7", repository: "BuildDownAI/Sandbox", prNumber: 42 } }));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it("an issue-scope request whose issueScope literally equals the internal PR sentinel does not collide with an unrelated PR reservation sharing the same issueId", () => {
    const prOwner = admission.acquire(
      prRequest({ dispatchId: "pr-owner", scope: { kind: "pr", issueId: "shared-id", installationId: "7", repository: "BuildDownAI/AI-Implement", prNumber: 42 } }),
    );
    expect(prOwner.ok).toBe(true);

    const issueRequestWithPrSentinelScope = admission.acquire(
      issueRequest({ dispatchId: "issue-with-pr-sentinel", scope: { kind: "issue", issueScope: "pr", issueId: "shared-id" } }),
    );
    expect(issueRequestWithPrSentinelScope.ok).toBe(true);
  });

  it("the same PR scope is occupied while active, and different mappingKey capacity is independent", () => {
    const PR = { kind: "pr" as const, issueId: "x", installationId: "7", repository: "BuildDownAI/AI-Implement", prNumber: 42 };
    const a = admission.acquire(prRequest({ dispatchId: "a", scope: PR, mappingKey: "AII" }));
    const conflict = admission.acquire(prRequest({ dispatchId: "b", scope: PR, mappingKey: "OTHER" }));
    expect(a.ok).toBe(true);
    expect(conflict).toEqual({ ok: false, reason: "occupied", count: 0, cap: 5 });
    expect(admission.count("AII")).toBe(1);
    expect(admission.count("OTHER")).toBe(0);
  });
});

describe("acquire — kg-refresh exclusion", () => {
  it("kg-refresh reservations are excluded from team-capacity counts and never spend capacity themselves", () => {
    const kg1 = admission.acquire(issueRequest({ dispatchId: "kg-1", kind: "kg-refresh", cap: 1 }));
    expect(kg1).toMatchObject({ ok: true, count: 0, cap: 1 });
    admission.acquire(issueRequest({ dispatchId: "kg-2", kind: "kg-refresh", scope: { kind: "issue", issueScope: "s", issueId: "kg-2" }, cap: 1 }));
    expect(admission.count("AII")).toBe(0);

    const nonKg = admission.acquire(issueRequest({ dispatchId: "impl-1", scope: { kind: "issue", issueScope: "s", issueId: "impl-1" }, cap: 1 }));
    expect(nonKg.ok).toBe(true);
    expect(admission.count("AII")).toBe(1);

    const anotherKg = admission.acquire(issueRequest({ dispatchId: "kg-3", kind: "kg-refresh", scope: { kind: "issue", issueScope: "s", issueId: "kg-3" }, cap: 1 }));
    // The decision's own `count` must match the authoritative `count()` reader — a
    // kg-refresh acquire must not report count()+1 for a row that count() itself
    // never includes.
    expect(anotherKg).toMatchObject({ ok: true, count: 1, cap: 1 });
    expect(admission.count("AII")).toBe(1);
  });
});

describe("read — owner-aware", () => {
  it("distinguishes a Legacy row from a Restate-prepared active run", () => {
    admission.acquire(issueRequest({ dispatchId: "legacy-row", lifecycleOwner: LEGACY }));
    admission.acquire(issueRequest({ dispatchId: "restate-row", scope: { kind: "issue", issueScope: "s", issueId: "r" }, lifecycleOwner: RESTATE_A }));

    expect(admission.read("legacy-row")?.lifecycleOwner).toEqual({ kind: "legacy" });
    expect(admission.read("restate-row")?.lifecycleOwner).toEqual({ kind: "restate", attemptId: "attempt-a" });
    expect(admission.read("does-not-exist")).toBeNull();
  });
});

describe("acquire — synchronous prepare", () => {
  it("persists prepare's return value as executionId", () => {
    const decision = admission.acquire(issueRequest({ dispatchId: "prepared" }), () => "exec-123");
    expect(decision.ok).toBe(true);
    expect(admission.read("prepared")?.executionId).toBe("exec-123");
  });

  it("rejects a prepare call whose result looks like a thenable, rolling back the reservation", () => {
    const asyncLooking = () => ({ then: () => {} }) as unknown as string | undefined;
    expect(() => admission.acquire(issueRequest({ dispatchId: "async-prepare" }), asyncLooking)).toThrow(/synchronous/);
    expect(admission.read("async-prepare")).toBeNull();
    expect(admission.count("AII")).toBe(0);
  });
});

describe("acquire — prepare type contract", () => {
  it("rejects an async prepare callback at compile time (checked via tsconfig.dispatch-admission-tests.json)", () => {
    const callWithAsyncPrepare = () =>
      admission.acquire(
        issueRequest({ dispatchId: "type-check-only" }),
        // @ts-expect-error prepare must be `() => NotPromise<string | undefined>`, not async
        async () => "x",
      );
    expect(typeof callWithAsyncPrepare).toBe("function");
  });
});

describe("count", () => {
  it("returns the unreleased, non-kg-refresh count for a mapping key", () => {
    expect(admission.count("AII")).toBe(0);
    const a = admission.acquire(issueRequest({ dispatchId: "a" }));
    admission.acquire(issueRequest({ dispatchId: "b", scope: { kind: "issue", issueScope: "s", issueId: "b" } }));
    expect(admission.count("AII")).toBe(2);
    if (a.ok) admission.release("a", LEGACY, a.record.generation, "finalized");
    expect(admission.count("AII")).toBe(1);
  });
});
