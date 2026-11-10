import { afterEach, describe, expect, it, vi } from "vitest";
import { testDb } from "./helpers/test-db.js";
import { makeAppConfig, makeMapping, makeProvider, makeRegistry } from "./helpers/builders.js";

afterEach(() => vi.restoreAllMocks());

describe("Restate budget park composition", () => {
  it.each(["tracker", "breaker_notified", "no_tracker"])("parks and claims one notice: %s", async (scenario) => {
    const { modules: { index, breaker, github, auth } } = await testDb({ modules: {
      index: () => import("../index.js"),
      breaker: () => import("../dispatch-breaker.js"),
      github: () => import("../github.js"),
      auth: () => import("../github-app-auth.js"),
    } });
    vi.spyOn(auth, "getInstallationToken").mockResolvedValue("token");
    vi.spyOn(github, "listPrComments").mockResolvedValue([]);
    const postPr = vi.spyOn(github, "postPrComment").mockResolvedValue(undefined);
    const postTracker = vi.fn();
    const registry = makeRegistry({ provider: makeProvider({ postComment: postTracker }) });
    const resolveProvider = vi.spyOn(registry, "forMapping");
    const issueId = scenario === "no_tracker" ? null : "tracker-123";
    const parkId = issueId ?? "acme/app#7";
    if (scenario === "breaker_notified") {
      breaker.parkIssue(parkId, "gap-analysis", "failed");
      breaker.markTripNotified(parkId, "gap-analysis");
    }
    for (let i = 0; i < 2; i++) {
      await index.parkRestatePrBudget(makeAppConfig(), registry, makeMapping(), issueId, "acme/app", 7, 2);
    }
    expect(breaker.isParked(parkId, "gap-analysis")).toBe(true);
    expect(postPr).toHaveBeenCalledTimes(1);
    expect(postPr.mock.calls[0]?.[4]).toContain("limit of 2 automatic fix runs");
    if (scenario === "tracker") expect(postTracker).toHaveBeenCalledExactlyOnceWith("tracker-123", expect.stringContaining("Needs Human"));
    else expect(postTracker).not.toHaveBeenCalled();
    if (scenario === "no_tracker") expect(resolveProvider).not.toHaveBeenCalled();
  });
  it.each(["pr_failure", "tracker_failure", "breaker_first"] as const)(
    "retries owed notices through real admission without launching: %s", async (scenario) => {
      const { modules: { index, breaker, github, auth, config, store, production, queue, pending, dedup, probe, managed } } = await testDb({ modules: {
        index: () => import("../index.js"),
        breaker: () => import("../dispatch-breaker.js"),
        github: () => import("../github.js"),
        auth: () => import("../github-app-auth.js"),
        config: () => import("../config.js"),
        store: () => import("../review-fix-attempt-store.js"),
        production: () => import("../restate/review-fix-production.js"),
        queue: () => import("../review-fix-queue.js"),
        pending: () => import("../review-fix-pending.js"),
        dedup: () => import("../dedup.js"),
        probe: () => import("../workflow-probe.js"),
        managed: () => import("../managed-dispatch-auth.js"),
      } });
      const mapping = makeMapping({ owner: "acme", repo: "app", reviewFixLifecycle: "restate", prDispatchBudget: 1 });
      config.upsertMapping("ENG", mapping);
      vi.spyOn(managed, "isManagedProject").mockReturnValue(false);
      vi.spyOn(auth, "getInstallationToken").mockResolvedValue("token");
      vi.spyOn(auth, "getInstallationId").mockResolvedValue(1);
      vi.spyOn(probe, "resolveWorkflowCapabilities").mockResolvedValue({
        contract: "envelope", supportsAttemptCorrelation: true, supportsRunPublicationToken: true,
      });
      vi.spyOn(github, "getPullRequestState").mockResolvedValue({ state: "open", merged: false, headRef: "fix", headSha: "a".repeat(40) });
      const comments: Awaited<ReturnType<typeof github.listPrComments>> = [];
      vi.spyOn(github, "listPrComments").mockImplementation(async () => comments);
      const postPr = vi.spyOn(github, "postPrComment").mockImplementation(async (_t, _o, _r, _n, body) => { comments.push({ id: comments.length + 1, body }); });
      const postTracker = vi.fn().mockResolvedValue(undefined);
      if (scenario === "pr_failure") postPr.mockRejectedValueOnce(new Error("temporary GitHub failure"));
      if (scenario === "tracker_failure") postTracker.mockRejectedValueOnce(new Error("temporary tracker failure"));
      const registry = makeRegistry({ provider: makeProvider({ postComment: postTracker }) });
      const scope = { repository: "acme/app", prNumber: 7, installationId: 1 };
      queue.enqueueReviewFix({ issueId: "tracker-123", issueIdentifier: "ENG-123", repo: scope.repository,
        prNumber: 7, reason: "changes_requested", sourceEventId: "review-1" });
      const feedback = pending.loadPendingReviewFixFeedback(scope, null)!;
      dedup.getDb().prepare(`INSERT INTO dispatch_budget_entries
        (dispatch_id, repository, pr_number, request_kind, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run("previous-run", scope.repository, 7, "automatic", Date.now());
      if (scenario === "breaker_first") {
        breaker.parkIssue("tracker-123", "gap-analysis", "failed");
        breaker.markTripNotified("tracker-123", "gap-analysis");
      }
      const attemptStore = new store.SqliteReviewFixAttemptStore();
      const appConfig = makeAppConfig({ runnerCallbackBaseUrl: "https://o", runnerTokenSecret: "s" });
      for (let i = 0; i < 3; i++) {
        expect(await production.admitReviewFix({ scope, feedback, jobTimeoutMinutes: 30 }, appConfig, attemptStore,
          undefined, (m, issueId, repo, pr, budget) => index.parkRestatePrBudget(appConfig, registry, m, issueId, repo, pr, budget)))
          .toEqual({ status: "deferred", reason: "budget_exhausted" });
        expect(breaker.isParked("tracker-123", "gap-analysis")).toBe(true);
      }
      expect(comments).toHaveLength(1);
      expect(postPr).toHaveBeenCalledTimes(scenario === "pr_failure" ? 2 : 1);
      expect(postTracker).toHaveBeenCalledTimes(scenario === "breaker_first" ? 0 : scenario === "tracker_failure" ? 2 : 1);
      expect(dedup.getDb().prepare("SELECT COUNT(*) AS n FROM dispatch_admissions").get()).toEqual({ n: 0 });
      expect(dedup.getDb().prepare("SELECT COUNT(*) AS n FROM review_fix_attempts").get()).toEqual({ n: 0 });
      expect(queue.getPendingReviewFixes()).toHaveLength(1);
    },
  );

  it("keeps an issueless PR parked when its rolling budget is available again", async () => {
    const { modules: { config, breaker, store } } = await testDb({ modules: {
      config: () => import("../config.js"),
      breaker: () => import("../dispatch-breaker.js"),
      store: () => import("../review-fix-attempt-store.js"),
    } });
    config.upsertMapping("ENG", makeMapping({ owner: "acme", repo: "app" }));
    breaker.parkIssue("acme/app#7", "gap-analysis", "pr_budget");
    expect(await new store.SqliteReviewFixAttemptStore().admit({
      scope: { repository: "acme/app", prNumber: 7, installationId: 1 },
      feedback: { taskText: "fix", findings: [] }, jobTimeoutMinutes: 30,
    })).toEqual({ status: "deferred", reason: "paused" });
  });

});
