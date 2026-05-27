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
});
