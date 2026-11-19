import { beforeEach, expect, it, vi } from "vitest";
import type { LifecycleLabelsResult } from "../providers/types.js";
import { makeIssue } from "./helpers/builders.js";
import { recordRechecks } from "./helpers/fixtures/setup-checks.js";
import { testDb } from "./helpers/test-db.js";

const issue = makeIssue({ scopeKey: "AII" });
const refusal = { ok: false, permanent: true, label: "AI-Working", message: 'Linear refused to create label "AI-Working" on team AII: not allowed to take action' } as const;
// A refused label write names the lifecycle-labels check: plain in the log line, quoted as code in the tracker comment.
const LOG_POINTER = ". Setup check: tracker.linear.lifecycle-labels. Read it on the Setup page at /admin#setup";
const COMMENT = 'AI-Implement did not start this issue. Linear refused to create label "AI-Working" on team AII: not allowed to take action. Create the label "AI-Working" in the team by hand, or let the app create labels. Then unpark the issue at /admin#runners. Setup check: `tracker.linear.lifecycle-labels`. Read it on the Setup page at /admin#setup.';
let breaker: typeof import("../dispatch-breaker.js");
let checkTrackerWrites: typeof import("../tracker-write-gate.js").checkTrackerWrites;
beforeEach(async () => {
  // The gate is loaded after testDb's reset, so it reads the recheck module recordRechecks sets.
  let gate: typeof import("../tracker-write-gate.js");
  ({ modules: { breaker, gate } } = await testDb({ modules: { breaker: () => import("../dispatch-breaker.js"), gate: () => import("../tracker-write-gate.js") } }));
  ({ checkTrackerWrites } = gate);
});

function options() {
  return { issue, phase: "planning" as const, park: vi.fn(breaker.parkIssue), comment: vi.fn().mockResolvedValue(undefined), log: vi.fn() };
}

it("dispatches without effects when the verb is absent (Jira/filesystem)", async () => {
  const opts = options();
  expect(await checkTrackerWrites({ ...opts, provider: {} })).toBe("dispatch");
  for (const effect of [opts.park, opts.comment, opts.log]) expect(effect).not.toHaveBeenCalled();
});

it("dispatches after successful preparation without effects", async () => {
  const opts = options();
  const ensureLifecycleLabels = vi.fn().mockResolvedValue({ ok: true });
  expect(await checkTrackerWrites({ ...opts, provider: { ensureLifecycleLabels } })).toBe("dispatch");
  expect(ensureLifecycleLabels).toHaveBeenCalledWith("AII");
  for (const effect of [opts.park, opts.comment, opts.log]) expect(effect).not.toHaveBeenCalled();
});

it.each(["transient", "throw"])("skips and logs once without parking on %s", async (kind) => {
  const opts = options();
  const ensureLifecycleLabels = vi.fn<() => Promise<LifecycleLabelsResult>>();
  if (kind === "throw") ensureLifecycleLabels.mockRejectedValue(new Error("offline"));
  else ensureLifecycleLabels.mockResolvedValue({ ...refusal, permanent: false });
  expect(await checkTrackerWrites({ ...opts, provider: { ensureLifecycleLabels } })).toBe("skip");
  expect(opts.log).toHaveBeenCalledTimes(1);
  expect(opts.log).toHaveBeenCalledWith(`[poll] ${issue.identifier} tracker setup deferred: ${kind === "throw" ? "Error: offline" : refusal.message}`);
  expect(opts.park).not.toHaveBeenCalled();
  expect(opts.comment).not.toHaveBeenCalled();
});

it.each(["planning", "implementation"] as const)("parks %s and comments once across repeated refusals; unpark permits retry", async (phase) => {
  const opts = { ...options(), phase };
  const send = await recordRechecks();
  const ensureLifecycleLabels = vi.fn().mockResolvedValue(refusal);
  const check = () => checkTrackerWrites({ ...opts, provider: { ensureLifecycleLabels } });
  expect(await check()).toBe("skip");
  expect(await check()).toBe("skip");
  expect(opts.park).toHaveBeenCalledWith(issue.id, phase, "tracker_setup_refused", { project: "AII", identifier: issue.identifier });
  expect(breaker.listParked()).toEqual([expect.objectContaining({ issueId: issue.id, phase, lastConclusion: "tracker_setup_refused", project: "AII", identifier: issue.identifier })]);
  expect(opts.comment).toHaveBeenCalledExactlyOnceWith(issue.id, COMMENT);
  expect(opts.comment.mock.calls[0][1].match(/Linear refused/g)).toHaveLength(1);
  expect(opts.log).toHaveBeenNthCalledWith(1, `[poll] ${issue.identifier} tracker_setup_refused: ${refusal.message}${LOG_POINTER}`);
  expect(send).toHaveBeenCalledWith({ id: "tracker.linear.lifecycle-labels", project: "AII", cause: "tracker-write" });
  expect(opts.log).toHaveBeenCalledTimes(2);
  breaker.unpark(issue.id, phase);
  ensureLifecycleLabels.mockResolvedValue({ ok: true });
  expect(await check()).toBe("dispatch");
});

it("leaves the park intact when the comment fails, logging one additional line", async () => {
  const opts = options();
  opts.comment.mockRejectedValue(new Error("comment refused"));
  expect(await checkTrackerWrites({ ...opts, provider: { ensureLifecycleLabels: vi.fn().mockResolvedValue(refusal) } })).toBe("skip");
  expect(breaker.isParked(issue.id, opts.phase)).toBe(true);
  expect(opts.log).toHaveBeenCalledTimes(2);
});

it("does not double the refusal sentence's trailing period", async () => {
  const opts = options();
  await checkTrackerWrites({
    ...opts,
    provider: { ensureLifecycleLabels: vi.fn().mockResolvedValue({ ...refusal, message: refusal.message + "." }) },
  });
  expect(opts.comment).toHaveBeenCalledExactlyOnceWith(issue.id, COMMENT);
  expect(opts.log).toHaveBeenCalledWith(`[poll] ${issue.identifier} tracker_setup_refused: ${refusal.message}${LOG_POINTER}`);
});
