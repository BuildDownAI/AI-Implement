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
