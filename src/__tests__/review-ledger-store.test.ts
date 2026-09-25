import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as DedupModule from "../dedup.js";
import type * as ReviewLedgerStoreModule from "../review-ledger-store.js";

let dbPath: string;
let dedup: typeof DedupModule;
let store: typeof ReviewLedgerStoreModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `review-ledger-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  store = await import("../review-ledger-store.js");
  dedup.getDb();
});

afterEach(() => {
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});

describe("review ledger store", () => {
  it("upserts findings by stable key and lists open findings for a PR", () => {
    const first = store.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 42,
      source: "github-review",
      severity: "blocking",
      body: "Fix the validation.",
      url: "https://github.com/org/repo/pull/42#review",
    });
    const second = store.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 42,
      source: "github-review",
      severity: "blocking",
      body: "Fix the validation.",
      url: "https://github.com/org/repo/pull/42#review-updated",
    });

    expect(second).toBe(first);
    expect(store.listOpenReviewFindings("org/repo", 42)).toMatchObject([
      {
        id: first,
        repo: "org/repo",
        prNumber: 42,
        source: "github-review",
        severity: "blocking",
        body: "Fix the validation.",
        url: "https://github.com/org/repo/pull/42#review-updated",
        status: "open",
      },
    ]);
  });

  it("re-exports stableReviewFindingKey unchanged after the move to finding-dispositions.ts", () => {
    expect(
      store.stableReviewFindingKey({ source: "github-review", severity: "blocking", body: "Fix the validation." }),
    ).toBe("ec9106e87e088d48b108fee8fd1359ee9b71f51818b77106c502fce245a3687a");
  });

  it("resolves open findings for a PR", () => {
    store.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 42,
      source: "github-review-thread",
      severity: "blocking",
      body: "Fix line comment.",
      path: "src/app.ts",
      line: 12,
    });
    store.markReviewFindingsResolvedForPr("org/repo", 42);

    expect(store.listOpenReviewFindings("org/repo", 42)).toEqual([]);
  });

  it("defers only open findings matching the given keys, and excludes deferred rows from the open list", () => {
    const deferredId = store.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 42,
      source: "github-review",
      severity: "blocking",
      body: "Add a config flag for this.",
    });
    const openId = store.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 42,
      source: "github-review",
      severity: "blocking",
      body: "Fix the null check.",
    });

    const deferredRow = store.listOpenReviewFindings("org/repo", 42).find((f) => f.id === deferredId)!;

    const changed = store.markReviewFindingsDeferredByKeys("org/repo", 42, [deferredRow.findingKey]);

    expect(changed).toBe(1);
    expect(store.listOpenReviewFindings("org/repo", 42)).toMatchObject([{ id: openId, status: "open" }]);
  });

  it("keeps a deferred finding deferred across a re-report (upsert), including resolved_at", () => {
    store.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 42,
      source: "github-review",
      severity: "blocking",
      body: "Add a config flag for this.",
    });
    const finding = store.listOpenReviewFindings("org/repo", 42)[0];
    store.markReviewFindingsDeferredByKeys("org/repo", 42, [finding.findingKey]);

    store.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 42,
      source: "github-review",
      severity: "blocking",
      body: "Add a config flag for this.",
      url: "https://github.com/org/repo/pull/42#review-updated",
    });

    const [row] = store.getReviewFindingsByKeys("org/repo", 42, [finding.findingKey]);
    expect(row.status).toBe("deferred");
    expect(row.resolvedAt).toBeNull();
    expect(row.revision).toBe(2);
    expect(store.listOpenReviewFindings("org/repo", 42)).toEqual([]);
  });

  it("starts a new finding at revision 1 and increments by exactly 1 on every accepted re-report, including a byte-identical repeat", () => {
    const id = store.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 42,
      source: "github-review",
      severity: "blocking",
      body: "Fix the validation.",
    });
    expect(store.getReviewFindingById(id)?.revision).toBe(1);

    const repeatId = store.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 42,
      source: "github-review",
      severity: "blocking",
      body: "Fix the validation.",
    });
    expect(repeatId).toBe(id);
    expect(store.getReviewFindingById(id)?.revision).toBe(2);
  });

  it("a post-snapshot re-report stays open after a stale conditional resolve", () => {
    const id = store.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 42,
      source: "github-review",
      severity: "blocking",
      body: "Fix the validation.",
    });
    const snapshot = store.getReviewFindingById(id)!;
    expect(snapshot.revision).toBe(1);

    // Re-report bumps the revision past the caller's snapshot.
    store.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 42,
      source: "github-review",
      severity: "blocking",
      body: "Fix the validation.",
    });

    const changed = store.markReviewFindingResolvedIfRevision(id, snapshot.revision);
    expect(changed).toBe(0);
    expect(store.listOpenReviewFindings("org/repo", 42)).toMatchObject([{ id, status: "open" }]);
  });

  it("a conditional resolve at the current revision succeeds and removes the finding from the open list", () => {
    const id = store.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 42,
      source: "github-review",
      severity: "blocking",
      body: "Fix the validation.",
    });
    const snapshot = store.getReviewFindingById(id)!;

    const changed = store.markReviewFindingResolvedIfRevision(id, snapshot.revision);
    expect(changed).toBe(1);
    expect(store.listOpenReviewFindings("org/repo", 42)).toEqual([]);
    expect(store.getReviewFindingById(id)?.status).toBe("resolved");
  });

  it("a conditional defer at the current revision succeeds and preserves the deferred/fixed/invalid policy on re-report", () => {
    const id = store.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 42,
      source: "github-review",
      severity: "blocking",
      body: "Add a config flag for this.",
    });
    const snapshot = store.getReviewFindingById(id)!;

    const changed = store.markReviewFindingDeferredIfRevision(id, snapshot.revision);
    expect(changed).toBe(1);
    expect(store.getReviewFindingById(id)?.status).toBe("deferred");

    store.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 42,
      source: "github-review",
      severity: "blocking",
      body: "Add a config flag for this.",
    });
    expect(store.getReviewFindingById(id)?.status).toBe("deferred");
  });

  it("a post-snapshot re-report stays open after a stale conditional defer", () => {
    const id = store.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 42,
      source: "github-review",
      severity: "blocking",
      body: "Add a config flag for this.",
    });
    const snapshot = store.getReviewFindingById(id)!;
    expect(snapshot.revision).toBe(1);

    // Re-report bumps the revision past the caller's snapshot.
    store.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 42,
      source: "github-review",
      severity: "blocking",
      body: "Add a config flag for this.",
    });

    const changed = store.markReviewFindingDeferredIfRevision(id, snapshot.revision);
    expect(changed).toBe(0);
    expect(store.listOpenReviewFindings("org/repo", 42)).toMatchObject([{ id, status: "open" }]);
  });

  it("conditional dispositions are scoped to a single id: resolving a subset of more than 30 findings leaves the rest open", () => {
    const ids = Array.from({ length: 31 }, (_, i) =>
      store.upsertReviewFinding({
        repo: "org/repo",
        prNumber: 42,
        source: "github-review",
        severity: "blocking",
        body: `Finding number ${i}`,
      }),
    );

    const dispatched = ids.slice(0, 30);
    for (const id of dispatched) {
      const snapshot = store.getReviewFindingById(id)!;
      const changed = store.markReviewFindingResolvedIfRevision(id, snapshot.revision);
      expect(changed).toBe(1);
    }

    const stillOpen = store.listOpenReviewFindings("org/repo", 42);
    expect(stillOpen).toHaveLength(1);
    expect(stillOpen[0]!.id).toBe(ids[30]);
  });

  it("getReviewFindingById returns undefined for a nonexistent id", () => {
    expect(store.getReviewFindingById(999999)).toBeUndefined();
  });

  it("getReviewFindingsByKeys returns rows for the given keys regardless of status", () => {
    store.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 42,
      source: "github-review",
      severity: "blocking",
      body: "Finding A",
    });
    store.upsertReviewFinding({
      repo: "org/repo",
      prNumber: 42,
      source: "github-review",
      severity: "blocking",
      body: "Finding B",
    });
    const [a, b] = store.listOpenReviewFindings("org/repo", 42);
    store.markReviewFindingsDeferredByKeys("org/repo", 42, [a.findingKey]);

    const rows = store.getReviewFindingsByKeys("org/repo", 42, [a.findingKey, b.findingKey, "nonexistent-key"]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.findingKey === a.findingKey)?.status).toBe("deferred");
    expect(rows.find((r) => r.findingKey === b.findingKey)?.status).toBe("open");
  });
});
