import { beforeEach, expect, it, vi } from "vitest";
import { checkTrackerWrites } from "../tracker-write-gate.js";
import type { LifecycleLabelsResult } from "../providers/types.js";
import { makeIssue } from "./helpers/builders.js";
import { testDb } from "./helpers/test-db.js";

const issue = makeIssue({ scopeKey: "AII" });
const refusal = { ok: false, permanent: true, label: "AI-Planning", message: "Permission denied" } as const;
let breaker: typeof import("../dispatch-breaker.js");
beforeEach(async () => {
  ({ modules: { breaker } } = await testDb({ modules: { breaker: () => import("../dispatch-breaker.js") } }));
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
  expect(opts.park).not.toHaveBeenCalled();
  expect(opts.comment).not.toHaveBeenCalled();
});

it.each(["planning", "implementation"] as const)("parks %s and comments once across repeated refusals; unpark permits retry", async (phase) => {
  const opts = { ...options(), phase };
  const ensureLifecycleLabels = vi.fn().mockResolvedValue(refusal);
  const check = () => checkTrackerWrites({ ...opts, provider: { ensureLifecycleLabels } });
  expect(await check()).toBe("skip");
  expect(await check()).toBe("skip");
  expect(opts.park).toHaveBeenCalledWith(issue.id, phase, "tracker_setup_refused");
  expect(breaker.listParked()).toEqual([expect.objectContaining({ issueId: issue.id, phase, lastConclusion: "tracker_setup_refused" })]);
  expect(opts.comment).toHaveBeenCalledExactlyOnceWith(issue.id, 'AI-Implement did not start this issue. Linear refused to create the label "AI-Planning" in team AII: Permission denied. Create the label in the team by hand, or let the app create labels. Then unpark the issue at /admin#runners.');
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
