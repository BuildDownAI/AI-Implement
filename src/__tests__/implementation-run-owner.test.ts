import { expect, it } from "vitest";
import { testDb } from "./helpers/test-db.js";
import type { ImplementationRunInput } from "../restate/implementation-run-workflow.js";

const input: ImplementationRunInput = { dispatchId: "owner-1", teamKey: "ENG", issueId: "issue-1", issueIdentifier: "ENG-1", backend: "github-actions", launchContext: {}, maxJobMinutes: 90 };
const request = { dispatchId: input.dispatchId, mappingKey: input.teamKey,
  scope: { kind: "issue" as const, issueScope: "ENG", issueId: input.issueId },
  kind: "implementation" as const, backend: input.backend,
  lifecycleOwner: { kind: "restate" as const, attemptId: input.dispatchId }, cap: 1 };
const modules = { admission: () => import("../dispatch-admission.js"), owner: () => import("../restate/implementation-run-owner.js"), intent: () => import("../restate/implementation-launch-intent.js") };

it("keeps a charged cleanup receipt across stale owner writes and fences replacement generations", async () => {
  const { modules: m } = await testDb({ modules });
  m.admission.acquire(request);
  const before = m.owner.requireImplementationRunOwner(input);
  expect(m.owner.claimImplementationStuckAttempt(input)).toEqual({ attempts: 1, complete: false });
  m.owner.completeImplementationStuckCleanup(input);
  m.owner.updateImplementationRunOwner({ ...before, finalized: true });
  expect(m.owner.claimImplementationStuckAttempt(input)).toEqual({ attempts: 1, complete: true });
  m.owner.releaseImplementationRunOwner(input.dispatchId, "finalized");
  m.admission.acquire(request);
  expect(() => m.owner.claimImplementationStuckAttempt(input)).toThrow("stale implementation owner");
  expect((await import("../log.js")).getStuckAttempts(input.issueId)).toBe(1);
});

it("rolls back the counter if writing its durable owner receipt fails", async () => {
  const { modules: m } = await testDb({ modules });
  m.admission.acquire(request);
  m.owner.requireImplementationRunOwner(input);
  const db = (await import("../dedup.js")).getDb();
  db.exec("CREATE TEMP TRIGGER fail_owner_receipt BEFORE UPDATE ON implementation_launch_intent BEGIN SELECT RAISE(ABORT, 'receipt write failed'); END");
  expect(() => m.owner.claimImplementationStuckAttempt(input)).toThrow("receipt write failed");
  expect((await import("../log.js")).getStuckAttempts(input.issueId)).toBe(0);
  db.exec("DROP TRIGGER fail_owner_receipt");
  expect(m.owner.claimImplementationStuckAttempt(input)).toEqual({ attempts: 1, complete: false });
});

it("reconstructs a historical reserve outcome without metadata and preserves it across restart", async () => {
  const db = await testDb({ modules });
  expect(db.modules.admission.acquire(request).ok).toBe(true);
  const owner = db.modules.owner.requireImplementationRunOwner(input);
  expect(owner.state).toBe("launching"); // historical absence is uncertainty
  const reopened = await db.reopen();
  expect(reopened.owner.readImplementationRunOwner(input.dispatchId)).toEqual(owner);
  reopened.owner.releaseImplementationRunOwner(input.dispatchId, "launch_rejected");
  expect(reopened.admission.count("ENG")).toBe(0);
  expect(() => reopened.owner.releaseImplementationRunOwner(input.dispatchId, "launch_rejected")).not.toThrow();
});

it("never reconstructs or releases a replacement generation from an old owner", async () => {
  const { modules: m } = await testDb({ modules });
  m.admission.acquire(request);
  const original = m.owner.requireImplementationRunOwner(input);
  m.owner.releaseImplementationRunOwner(input.dispatchId, "finalized");
  m.admission.acquire(request);
  expect(() => m.owner.requireImplementationRunOwner(input)).toThrow("stale implementation owner");
  m.owner.releaseImplementationRunOwner(input.dispatchId, "finalized");
  expect(m.admission.count("ENG")).toBe(1);
  m.intent.implementationIntentStore().remove(`owner:${input.dispatchId}`);
  expect(() => m.owner.requireImplementationRunOwner(input)).toThrow("missing original implementation owner");
  expect(m.admission.read(input.dispatchId)!.generation).toBe(original.generation + 1);
});

it("allows exact historical preparation authority but rejects a different generation", async () => {
  const { modules: m } = await testDb({ modules });
  m.admission.acquire(request);
  m.admission.release(input.dispatchId, request.lifecycleOwner, 0, "launch_rejected");
  m.admission.acquire(request);
  m.intent.implementationIntentStore().write(input.dispatchId, { context: { generation: 1 } });
  expect(m.owner.requireImplementationRunOwner(input).generation).toBe(1);
  expect(() => m.owner.requireImplementationRunOwner({ ...input, issueId: "other" })).toThrow("scope mismatch");
});

it("fences the optional gap-fill PR scope without activating a caller cutover", async () => {
  const { modules: m } = await testDb({ modules });
  const gapFill = { queueItemId: 1, repository: "Org/repo", installationId: "1", prNumber: 7, prDispatchBudget: 3, humanRequested: false };
  m.admission.acquire({ ...request, kind: "gap-fill", scope: { kind: "pr", issueId: input.issueId, repository: gapFill.repository, installationId: gapFill.installationId, prNumber: gapFill.prNumber } });
  expect(m.owner.requireImplementationRunOwner({ ...input, gapFill }).generation).toBe(0);
  expect(() => m.owner.requireImplementationRunOwner({ ...input, gapFill: { ...gapFill, prNumber: 8 } })).toThrow("PR scope mismatch");
  expect(m.admission.count("ENG")).toBe(1);
});

it("freezes an execution ID once bound", async () => {
  const { modules: m } = await testDb({ modules });
  m.admission.acquire(request);
  const owner = m.owner.requireImplementationRunOwner(input);
  m.owner.updateImplementationRunOwner({ ...owner, jobId: "run-1" });
  expect(() => m.owner.updateImplementationRunOwner({ ...owner, jobId: "run-2" })).toThrow("execution identity is frozen");
  expect(m.owner.readImplementationRunOwner(input.dispatchId)!.jobId).toBe("run-1");
  expect(m.admission.count("ENG")).toBe(1);
});
