import { describe, it, expect } from "vitest";
import { testDb } from "./helpers/test-db.js";
import { makeMapping, makeScopedPrIdentity } from "./helpers/builders.js";
import { parseStoredVerdict } from "../review-fix-admin-facade.js";

describe("parseStoredVerdict", () => {
  it("projects the structured verdict", () => {
    expect(parseStoredVerdict(JSON.stringify({ approved: true, reason: "approved", summary: "x" }))).toEqual({ approved: true, reason: "approved" });
    expect(parseStoredVerdict(JSON.stringify({ approved: false, reason: "rejected" }))).toEqual({ approved: false, reason: "rejected" });
    expect(parseStoredVerdict(JSON.stringify({ approved: null, reason: "fix_failed" }))).toEqual({ approved: null, reason: "fix_failed" });
  });
  it("falls back to the raw text for legacy and malformed values", () => {
    expect(parseStoredVerdict("passed")).toEqual({ approved: null, reason: "passed" });
    expect(parseStoredVerdict("{not json")).toEqual({ approved: null, reason: "{not json" });
    const odd = JSON.stringify({ approved: "yes", reason: 3 });
    expect(parseStoredVerdict(odd)).toEqual({ approved: null, reason: odd });
  });
});


describe("attempt execution projection", () => {
  it.each([
    { backend: "github-actions", runRef: null, runId: 9001, runAttempt: 2,
      expected: { backend: "github-actions", githubRunId: "9001", githubRunAttempt: 2 } },
    { backend: "fly-machines", runRef: "machine-123", runId: null, runAttempt: null,
      expected: { backend: "fly-machines", runRef: "machine-123" } },
    { backend: "local-docker", runRef: "container-123", runId: null, runAttempt: null,
      expected: { backend: "local-docker", runRef: "container-123" } },
    { backend: "github-actions", runRef: null, runId: null, runAttempt: null, expected: null },
    { backend: "github-actions", runRef: null, runId: null, runAttempt: 2, expected: null },
    { backend: "github-actions", runRef: null, runId: 9001, runAttempt: null, expected: null },
    { backend: "fly-machines", runRef: null, runId: null, runAttempt: null, expected: null },
    { backend: "local-docker", runRef: null, runId: null, runAttempt: null, expected: null },
  ] as const)("projects $backend with ref=$runRef and GitHub identity=$runId/$runAttempt", async (row) => {
    const { modules: { config, dedup, storeModule, facadeModule } } = await testDb({ modules: {
      config: () => import("../config.js"),
      dedup: () => import("../dedup.js"),
      storeModule: () => import("../review-fix-attempt-store.js"),
      facadeModule: () => import("../review-fix-admin-facade.js"),
    } });
    config.upsertMapping("AII", makeMapping());
    const store = new storeModule.SqliteReviewFixAttemptStore();
    const admitted = await store.admit({
      scope: makeScopedPrIdentity(),
      feedback: { taskText: "address findings", findings: [{ findingKey: "f1", version: 1 }] },
      jobTimeoutMinutes: 90,
    });
    if (admitted.status !== "prepared") throw new Error("expected prepared attempt");
    // Exercise stored bindings and unbound rows for each backend.
    const db = dedup.getDb();
    // Partial GitHub identities violate the storage constraint, but the read
    // projection must still handle them defensively.
    db.pragma("ignore_check_constraints = ON");
    try {
      db.prepare(`UPDATE review_fix_attempts
        SET execution_backend = ?, execution_ref = ?, github_run_id = ?, github_run_attempt = ?
        WHERE attempt_id = ?`).run(row.backend, row.runRef, row.runId, row.runAttempt, admitted.attempt.attemptId);
    } finally {
      db.pragma("ignore_check_constraints = OFF");
    }
    const facade = facadeModule.createReviewFixAdminFacade(store,
      { reconcile: async () => ({ status: "not_found" }) },
      { cancel: async () => ({ status: "accepted" }) });
    const result = await facade.getAttempt(admitted.attempt.attemptId, { role: "admin", email: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected attempt detail");
    expect(result.attempt.execution).toEqual(row.expected);
  });
});
