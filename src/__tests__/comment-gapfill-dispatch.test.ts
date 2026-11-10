import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DrainModule from "../comment-gapfill-drain.js";
import type * as LogModule from "../log.js";
import type { RepoMapping } from "../config.js";
import type { ImplementationRunIngressClient } from "../restate/implementation-run-client.js";
import { makeAppendLogEntry, makeMapping } from "./helpers/builders.js";
import { fakeFetch, type FakeFetch, type Reply } from "./helpers/fake-fetch.js";
import { githubError } from "./helpers/replies/github.js";
import { testDb, type LoadedModules } from "./helpers/test-db.js";
import { EPHEMERAL_FULL_ACCESS_EXTRA_ENV, EPHEMERAL_FULL_ACCESS_ASSERTION } from "../model-auth-contract.js";

const launchSpies = vi.hoisted(() => ({ fly: vi.fn(), local: vi.fn() }));
vi.mock("../fly-machines.js", async (original) => ({
  ...await original<typeof import("../fly-machines.js")>(), createMachine: launchSpies.fly,
}));
vi.mock("../local-gapfill.js", async (original) => ({
  ...await original<typeof import("../local-gapfill.js")>(), dispatchLocalGapfill: launchSpies.local,
}));
const modules = {
  dedup: () => import("../dedup.js"), queue: () => import("../comment-gapfill-queue.js"),
  log: () => import("../log.js"), breaker: () => import("../dispatch-breaker.js"),
  drain: () => import("../comment-gapfill-drain.js"), admission: () => import("../dispatch-admission.js"),
  config: () => import("../config.js"), gapfill: () => import("../restate/implementation-run-gapfill.js"),
};
let queue: LoadedModules<typeof modules>["queue"];
let log: LoadedModules<typeof modules>["log"];
let breaker: LoadedModules<typeof modules>["breaker"];
let drain: LoadedModules<typeof modules>["drain"];
let admission: LoadedModules<typeof modules>["admission"];
let config: LoadedModules<typeof modules>["config"];
let gapfill: LoadedModules<typeof modules>["gapfill"];
type DrainInput = DrainModule.DrainCommentGapfillsInput;
const submit = vi.fn<ImplementationRunIngressClient["submit"]>();
let acquireSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  ({ queue, log, breaker, drain, admission, config, gapfill } = (await testDb({ modules })).modules);
  submit.mockReset().mockResolvedValue({ status: "accepted" });
  acquireSpy = vi.spyOn(admission, "acquire");
});
afterEach(() => {
  expect(launchSpies.fly).not.toHaveBeenCalled();
  expect(launchSpies.local).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function prLookup(prNumber: number, reply: Reply): FakeFetch {
  return fakeFetch({ [`GET /repos/acme/billing/pulls/${prNumber}`]: [reply] }).install();
}

/** Legacy launch spy result; the drain must never call it. */
const ACCEPTED_DISPATCH = { success: true, status: 204, outcome: "accepted" } as const;

function openPrWithHead(headRef: string): Reply {
  return { json: { merged: false, state: "open", head: { ref: headRef, sha: "c".repeat(40) } } };
}

function makeBaseDrainOpts(overrides: Partial<DrainInput> = {}): DrainInput {
  return {
    implementationRun: { submit },
    restateCanServe: () => true,
    getMappings: () => ({}),
    runnerMode: "default",
    notifyType: "slack",
    notifyWebhookUrl: null,
    runnerCallbackBaseUrl: null,
    runnerTokenSecret: null,
    getInstallationToken: vi.fn<DrainInput["getInstallationToken"]>(async () => "gh-token"),
    getTargetRepoToken: vi.fn<DrainInput["getTargetRepoToken"]>(async () => "scoped-token"),
    getInstallationId: vi.fn<DrainInput["getInstallationId"]>(async () => 778899),
    resolveRunnerImage: vi.fn<DrainInput["resolveRunnerImage"]>(async () => undefined),
    checkContract: vi.fn<DrainInput["checkContract"]>(async () => "envelope"),
    dispatch: vi.fn<DrainInput["dispatch"]>(async () => ACCEPTED_DISPATCH),
    postComment: vi.fn<DrainInput["postComment"]>(async () => undefined),
    listPrComments: vi.fn<DrainInput["listPrComments"]>(async () => []),
    postTrackerComment: vi.fn<DrainInput["postTrackerComment"]>(async () => undefined),
    onDispatchFailure: vi.fn<DrainInput["onDispatchFailure"]>(async () => undefined),
    flySessionsToken: null,
    flySessionsApp: null,
    flySessionsRegion: null,
    flyOrchestratorApp: null,
    tenantId: null,
    anthropicApiKey: null,
    claudeOAuthToken: null,
    sessionImage: "ghcr.io/builddownai/ai-implement-runner:latest",
    ...overrides,
  };
}

function seedDispatchLog(
  issueId: string,
  issueIdentifier: string,
  issueTitle: string,
  owner: string,
  repo: string,
  prNumber: number,
  status: LogModule.JobStatus = "completed",
): number {
  const jobId = log.appendLog(makeAppendLogEntry({
    issueId,
    issueIdentifier,
    issueTitle,
    teamKey: "AII",
    repo: `${owner}/${repo}`,
    status,
  }));
  log.updateJobPrUrl(jobId, `https://github.com/${owner}/${repo}/pull/${prNumber}`);
  return jobId;
}

/** Seeds a completed gap-analysis dispatch counted toward a PR's 24h budget, carrying the originating dispatch's
 *  identifier and title as the drain's rows do (comment-gapfill-drain.ts copies them from the PR's row).
 *  Terminal status keeps it out of the in_flight gate. */
function seedGapAnalysisDispatch(
  issueId: string,
  issueIdentifier: string,
  issueTitle: string,
  owner: string,
  repo: string,
  prNumber: number,
): void {
  const jobId = log.appendLog(makeAppendLogEntry({
    issueId,
    issueIdentifier,
    issueTitle,
    teamKey: "AII",
    repo: `${owner}/${repo}`,
    phase: "gap-analysis",
    trigger: "comment",
    status: "completed",
  }));
  log.updateJobPrUrl(jobId, `https://github.com/${owner}/${repo}/pull/${prNumber}`);
}


describe("drainCommentGapfillQueue — PR dispatch budget", () => {
  it("parks the PR and posts exactly one PR comment and one tracker comment when a synthetic row hits the budget", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", prDispatchBudget: 2 });

    seedDispatchLog("issue-20", "AII-200", "Budget test", "acme", "billing", 42);
    seedGapAnalysisDispatch("issue-20", "AII-200", "Budget test", "acme", "billing", 42);
    seedGapAnalysisDispatch("issue-20", "AII-200", "Budget test", "acme", "billing", 42);

    const queueId = queue.enqueueConflictResolution({
      owner: "acme", repo: "billing", prNumber: 42, featureBranch: "ai-implement/feature/foo",
    });

    const dispatchSpy = submit;
    const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);
    const postTrackerCommentSpy = vi.fn<DrainInput["postTrackerComment"]>(async () => undefined);
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      implementationRun: { submit: dispatchSpy },
      postComment: postCommentSpy,
      postTrackerComment: postTrackerCommentSpy,
    }));

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(
      consoleLogSpy.mock.calls.some(
        ([msg]) => typeof msg === "string" && msg.includes(`[comment-gapfill] Deferring item #${queueId} for PR #42: pr_budget`),
      ),
    ).toBe(true);

    expect(postCommentSpy).toHaveBeenCalledTimes(1);
    // orchestrator-internal comment duty keeps the broad token
    expect(postCommentSpy.mock.calls[0]![0]).toBe("gh-token");
    const [, owner, repo, prNumber, body] = postCommentSpy.mock.calls[0]!;
    expect(owner).toBe("acme");
    expect(repo).toBe("billing");
    expect(prNumber).toBe(42);
    expect(body).toMatch(/^<!-- ai-implement pr-budget park=\d+ -->\n/);
    expect(body).toContain("Needs Human");
    expect(body).toContain("limit of 2 automatic fix runs");

    expect(postTrackerCommentSpy).toHaveBeenCalledTimes(1);
    const [trackerMapping, trackerIssueId, trackerBody] = postTrackerCommentSpy.mock.calls[0]!;
    expect(trackerMapping.owner).toBe("acme");
    expect(trackerIssueId).toBe("issue-20");
    expect(trackerBody).toContain("Needs Human");

    // Left unprocessed so the next tick retries once unparked.
    const pending = queue.claimPendingCommentGapfills();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(queueId);

    consoleLogSpy.mockRestore();
  });

  it("posts no additional comments on a second drain tick in the same state", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", prDispatchBudget: 2 });

    seedDispatchLog("issue-20", "AII-200", "Budget test", "acme", "billing", 42);
    seedGapAnalysisDispatch("issue-20", "AII-200", "Budget test", "acme", "billing", 42);
    seedGapAnalysisDispatch("issue-20", "AII-200", "Budget test", "acme", "billing", 42);

    queue.enqueueConflictResolution({
      owner: "acme", repo: "billing", prNumber: 42, featureBranch: "ai-implement/feature/foo",
    });

    const dispatchSpy = submit;
    const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);
    const postTrackerCommentSpy = vi.fn<DrainInput["postTrackerComment"]>(async () => undefined);

    const opts = makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      implementationRun: { submit: dispatchSpy },
      postComment: postCommentSpy,
      postTrackerComment: postTrackerCommentSpy,
    });

    await drain.drainCommentGapfillQueue(opts);
    await drain.drainCommentGapfillQueue(opts);

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(postCommentSpy).toHaveBeenCalledTimes(1);
    expect(postTrackerCommentSpy).toHaveBeenCalledTimes(1);
  });

  it("dispatches a human /ai-implement row on an already-parked PR when nothing is in flight", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", prDispatchBudget: 2 });

    seedDispatchLog("issue-21", "AII-201", "Human bypass test", "acme", "billing", 42);
    seedGapAnalysisDispatch("issue-21", "AII-201", "Human bypass test", "acme", "billing", 42);
    seedGapAnalysisDispatch("issue-21", "AII-201", "Human bypass test", "acme", "billing", 42);
    // Simulate a PR already parked by an earlier tick.
    breaker.parkIssue("issue-21", "gap-analysis", "pr_budget");

    queue.enqueueCommentGapfill({
      owner: "acme", repo: "billing", prNumber: 42, commentId: 9401, commenter: "alice", instruction: "please retry",
    });

    const dispatchSpy = submit;

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      implementationRun: { submit: dispatchSpy },
    }));

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const pending = queue.claimPendingCommentGapfills();
    expect(pending).toHaveLength(0);
  });

  it("does not dispatch a synthetic conflict row on an already-parked PR", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", prDispatchBudget: 2 });

    seedDispatchLog("issue-22", "AII-202", "Synthetic no-bypass test", "acme", "billing", 42);
    seedGapAnalysisDispatch("issue-22", "AII-202", "Synthetic no-bypass test", "acme", "billing", 42);
    seedGapAnalysisDispatch("issue-22", "AII-202", "Synthetic no-bypass test", "acme", "billing", 42);
    // Simulate the dispatch breaker parking the row (and telling the tracker) before the budget gate refuses.
    breaker.parkIssue("issue-22", "gap-analysis", "breaker");
    breaker.markTripNotified("issue-22", "gap-analysis");

    const queueId = queue.enqueueConflictResolution({
      owner: "acme", repo: "billing", prNumber: 42, featureBranch: "ai-implement/feature/foo",
    });

    const dispatchSpy = submit;
    const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);
    const postTrackerCommentSpy = vi.fn<DrainInput["postTrackerComment"]>(async () => undefined);

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      implementationRun: { submit: dispatchSpy },
      postComment: postCommentSpy,
      postTrackerComment: postTrackerCommentSpy,
    }));

    expect(dispatchSpy).not.toHaveBeenCalled();
    // Parked first by the breaker, then refused by the PR budget gate: the PR still gets
    // its budget comment once; the tracker already has the breaker's trip comment.
    expect(postCommentSpy).toHaveBeenCalledTimes(1);
    expect(postCommentSpy.mock.calls[0]![4]).toMatch(/^<!-- ai-implement pr-budget park=\d+ -->/);
    expect(postTrackerCommentSpy).not.toHaveBeenCalled();

    // A later tick with the gate still refusing posts nothing more.
    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      implementationRun: { submit: dispatchSpy },
      postComment: postCommentSpy,
      postTrackerComment: postTrackerCommentSpy,
    }));
    expect(postCommentSpy).toHaveBeenCalledTimes(1);
    expect(postTrackerCommentSpy).not.toHaveBeenCalled();

    const pending = queue.claimPendingCommentGapfills();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(queueId);
  });

  const seedAtBudget = (issueId: string, identifier: string) => {
    seedDispatchLog(issueId, identifier, "Budget notice", "acme", "billing", 42);
    seedGapAnalysisDispatch(issueId, identifier, "Budget notice", "acme", "billing", 42);
    seedGapAnalysisDispatch(issueId, identifier, "Budget notice", "acme", "billing", 42);
    queue.enqueueConflictResolution({
      owner: "acme", repo: "billing", prNumber: 42, featureBranch: "ai-implement/feature/foo",
    });
  };
  /** A fake PR comment list that sees what `postComment` posted. */
  const fakePrComments = (onPost?: () => void) => {
    const posted: Array<{ body: string }> = [];
    const postComment = vi.fn<DrainInput["postComment"]>(async (_t, _o, _r, _n, body) => {
      posted.push({ body });
      onPost?.();
    });
    return { postComment, listPrComments: async () => [...posted] };
  };

  it("posts the tracker budget comment when a stuck fix run parked the row without a trip comment", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", prDispatchBudget: 2 });
    seedAtBudget("issue-23", "AII-203");
    breaker.parkIssue("issue-23", "gap-analysis", "stuck_giveup");

    const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);
    const postTrackerCommentSpy = vi.fn<DrainInput["postTrackerComment"]>(async () => undefined);
    const opts = makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      postComment: postCommentSpy,
      postTrackerComment: postTrackerCommentSpy,
    });

    await drain.drainCommentGapfillQueue(opts);
    await drain.drainCommentGapfillQueue(opts);

    expect(postCommentSpy).toHaveBeenCalledTimes(1);
    expect(postTrackerCommentSpy).toHaveBeenCalledTimes(1);
    expect(postTrackerCommentSpy.mock.calls[0]![2]).toContain("Needs Human");
  });

  it("keeps the breaker's last_conclusion when the budget gate refuses an already-parked row", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", prDispatchBudget: 2 });
    seedAtBudget("issue-25", "AII-205");
    for (let i = 0; i < 3; i++) breaker.recordDispatchFailure("issue-25", "gap-analysis", "crash");

    await drain.drainCommentGapfillQueue(makeBaseDrainOpts({ getMappings: () => ({ AII: mapping }) }));

    expect(breaker.listParked()[0]!.lastConclusion).toBe("crash");
  });

  it("retries a failed tracker post without posting the PR comment twice", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", prDispatchBudget: 2 });
    seedAtBudget("issue-26", "AII-206");
    const pr = fakePrComments();
    const postTrackerCommentSpy = vi
      .fn<DrainInput["postTrackerComment"]>()
      .mockRejectedValueOnce(new Error("tracker down"))
      .mockResolvedValue(undefined);
    const opts = makeBaseDrainOpts({ getMappings: () => ({ AII: mapping }), ...pr, postTrackerComment: postTrackerCommentSpy });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await drain.drainCommentGapfillQueue(opts);
    await drain.drainCommentGapfillQueue(opts);
    await drain.drainCommentGapfillQueue(opts);

    expect(pr.postComment).toHaveBeenCalledTimes(1);
    expect(postTrackerCommentSpy).toHaveBeenCalledTimes(2);
    errSpy.mockRestore();
  });

  it("does not post a second PR comment when the first reached GitHub but the client threw", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", prDispatchBudget: 2 });
    seedAtBudget("issue-27", "AII-207");
    let first = true;
    const pr = fakePrComments(() => {
      if (first) { first = false; throw new Error("timeout after send"); }
    });
    const opts = makeBaseDrainOpts({ getMappings: () => ({ AII: mapping }), ...pr });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await drain.drainCommentGapfillQueue(opts);
    await drain.drainCommentGapfillQueue(opts);

    expect(pr.postComment).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it("does not post when the PR comment list is unreadable, and retries on the next tick", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", prDispatchBudget: 2 });
    seedAtBudget("issue-29", "AII-209");
    const postCommentSpy = vi.fn<DrainInput["postComment"]>(async () => undefined);
    const listPrComments = vi.fn<DrainInput["listPrComments"]>()
      .mockRejectedValueOnce(new Error("HTTP 502"))
      .mockResolvedValue([]);
    const opts = makeBaseDrainOpts({ getMappings: () => ({ AII: mapping }), postComment: postCommentSpy, listPrComments });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await drain.drainCommentGapfillQueue(opts);
    expect(postCommentSpy).not.toHaveBeenCalled();
    await drain.drainCommentGapfillQueue(opts);
    expect(postCommentSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it("posts a new PR comment when the row is parked again after an unpark", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", prDispatchBudget: 2 });
    seedAtBudget("issue-28", "AII-208");
    const pr = fakePrComments();
    const opts = makeBaseDrainOpts({ getMappings: () => ({ AII: mapping }), ...pr });

    // Start the fake clock at the real time so the seeded dispatches stay inside the 24h window.
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(t0);
      await drain.drainCommentGapfillQueue(opts);
      expect(pr.postComment).toHaveBeenCalledTimes(1);

      breaker.unpark("issue-28");
      vi.setSystemTime(t0 + 5 * 60_000);
      await drain.drainCommentGapfillQueue(opts);
    } finally {
      vi.useRealTimers();
    }

    expect(pr.postComment).toHaveBeenCalledTimes(2);
  });

  it("retries the budget notice on the next tick when the PR comment post fails", async () => {
    const mapping = makeMapping({ owner: "acme", repo: "billing", prDispatchBudget: 2 });
    seedAtBudget("issue-24", "AII-204");
    const postCommentSpy = vi
      .fn<DrainInput["postComment"]>()
      .mockRejectedValueOnce(new Error("github down"))
      .mockResolvedValue(undefined);
    const postTrackerCommentSpy = vi.fn<DrainInput["postTrackerComment"]>(async () => undefined);
    const opts = makeBaseDrainOpts({
      getMappings: () => ({ AII: mapping }),
      postComment: postCommentSpy,
      postTrackerComment: postTrackerCommentSpy,
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await drain.drainCommentGapfillQueue(opts);
    expect(postCommentSpy).toHaveBeenCalledTimes(1);
    expect(postTrackerCommentSpy).not.toHaveBeenCalled();

    await drain.drainCommentGapfillQueue(opts);
    expect(postCommentSpy).toHaveBeenCalledTimes(2);
    expect(postTrackerCommentSpy).toHaveBeenCalledTimes(1);

    await drain.drainCommentGapfillQueue(opts);
    expect(postCommentSpy).toHaveBeenCalledTimes(2);
    errSpy.mockRestore();
  });
});

describe("parseGroupingBranchIdentifier", () => {
  it("parses feature and multi-issue grouping branches", () => {
    expect(drain.parseGroupingBranchIdentifier("ai-implement/feature/tsai-196")).toBe("tsai-196");
    expect(drain.parseGroupingBranchIdentifier("ai-implement/multi-issue/proj-5")).toBe("proj-5");
  });

  it("returns null for leaf branches, base branches, and null", () => {
    expect(drain.parseGroupingBranchIdentifier("ai-implement/tsai-197-add-thing")).toBe(null);
    expect(drain.parseGroupingBranchIdentifier("main")).toBe(null);
    expect(drain.parseGroupingBranchIdentifier(null)).toBe(null);
  });
});

describe("buildCommentGapfillInstruction", () => {
  const finding = (index: number, body = `Finding body ${index}.`) => ({
    finding_key: index.toString(16).padStart(64, "0"),
    source: "github-review-thread",
    severity: "medium",
    path: `src/file-${index}.ts`,
    line: index,
    body,
    url: null,
  });

  it("returns the instruction unchanged, or undefined when blank, with no findings", () => {
    expect(drain.buildCommentGapfillInstruction("fix the build", [])).toBe("fix the build");
    expect(drain.buildCommentGapfillInstruction("", [])).toBeUndefined();
    expect(drain.buildCommentGapfillInstruction("   ", [])).toBeUndefined();
  });

  it("lists findings after the instruction under their finding keys, quoting each body with its location", () => {
    const text = drain.buildCommentGapfillInstruction("fix the build", [finding(1), finding(2, "Line one\nLine two")])!;
    expect(text.indexOf("fix the build")).toBe(0);
    expect(text).toContain(`### ${finding(1).finding_key}\n\ngithub-review-thread · medium · src/file-1.ts:1`);
    expect(text).toContain("> Line one\n> Line two");
    expect(text).toContain("unless the instruction above says otherwise");
  });

  it("caps the number of findings and says how many were left out", () => {
    const findings = Array.from({ length: 35 }, (_, i) => finding(i + 1));
    const text = drain.buildCommentGapfillInstruction("", findings)!;
    expect(text.startsWith("## Open review findings on this PR")).toBe(true);
    expect(text).not.toContain("instruction above");
    expect(text).toContain(`### ${finding(30).finding_key}`);
    expect(text).not.toContain(`### ${finding(31).finding_key}`);
    expect(text).toContain("5 more open findings were left out of this run; they stay open for a later fix run.");
  });

  it("never clips a body: a finding that does not fit is left out whole and the block stays under its cap", () => {
    const findings = [finding(1, "x".repeat(5_000)), finding(2, "y".repeat(20_000)), finding(3, "z".repeat(5_000)), finding(4, "w".repeat(5_000))];
    const text = drain.buildCommentGapfillInstruction("", findings)!;
    expect(text).toContain("x".repeat(5_000));
    expect(text).not.toContain("yyyy");
    expect(text).toContain("z".repeat(5_000));
    expect(text).not.toContain(`### ${finding(4).finding_key}`);
    expect(text.length).toBeLessThanOrEqual(drain.MAX_COMMENT_FINDINGS_BLOCK_CHARS + 200);
    expect(text).toContain("2 more open findings were left out of this run");
  });
});

it("dispatchGhaGapfill forwards inputs and returns the dispatch result unchanged", async () => {
  const { dispatchGhaGapfill } = await import("../gapfill-launch.js");
  const mapping = makeMapping();
  const inputs = { run_config: "opaque-payload", run_token: "" };
  const result = { success: false as const, status: 422, outcome: "rejected" as const };
  const dispatch = vi.fn<DrainInput["dispatch"]>().mockResolvedValue(result);

  expect(await dispatchGhaGapfill({ ghToken: "github-token", mapping, inputs, dispatch })).toBe(result);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith("github-token", mapping, inputs, { returnRunDetails: true });
  expect(dispatch.mock.calls[0]![2]).toBe(inputs);
});

function seedItem(overrides: Partial<QueueItemInput> = {}): number {
  return queue.enqueueCommentGapfill({ owner: "acme", repo: "billing", prNumber: 42,
    commentId: 9001, commenter: "sam", instruction: "fix this", ...overrides });
}
type QueueItemInput = Parameters<typeof queue.enqueueCommentGapfill>[0];
function optsFor(mapping: RepoMapping = makeMapping({ owner: "acme", repo: "billing" }), overrides: Partial<DrainInput> = {}): DrainInput {
  return makeBaseDrainOpts({ getMappings: () => ({ AII: mapping }), ...overrides });
}
function seedOrigin(status: LogModule.JobStatus = "completed"): number {
  return seedDispatchLog("issue-1", "AII-1554", "Caller switch", "acme", "billing", 42, status);
}
async function checkNoSubmit(opts: DrainInput, id: number, status: string): Promise<void> {
  await drain.drainCommentGapfillQueue(opts);
  expect(submit).not.toHaveBeenCalled();
  expect(opts.dispatch).not.toHaveBeenCalled();
  expect(acquireSpy).not.toHaveBeenCalled();
  expect(queue.getCommentGapfillItem(id)?.status).toBe(status);
}

describe("ImplementationRun gap-fill ingress", () => {
  for (const lifecycle of [null, "legacy", "restate"] as const) {
    it.each([
      ["default", "github-actions", "github-actions"],
      ["default", "fly-machines", "fly-machines"],
      ["gha", "fly-machines", "github-actions"],
      ["fly", "github-actions", "fly-machines"],
      ["local", "github-actions", "local-docker"],
      ["shadow", "fly-machines", "github-actions"],
    ] as const)(`stored lifecycle ${lifecycle}, mode %s, mapping %s submits %s`, async (runnerMode, executionMode, backend) => {
      config.upsertMapping("AII", makeMapping({ owner: "acme", repo: "billing", reviewFixLifecycle: lifecycle,
        executionMode, maxJobMinutes: 123, prDispatchBudget: 7 }));
      seedOrigin();
      const id = seedItem();
      const opts = makeBaseDrainOpts({ getMappings: config.getMappings, runnerMode });
      await drain.drainCommentGapfillQueue(opts);
      expect(submit).toHaveBeenCalledTimes(1);
      const [key, input] = submit.mock.calls[0]!;
      expect(key).toMatch(/^[0-9a-f-]{36}$/);
      expect(input).toEqual({ dispatchId: key, teamKey: "AII", issueId: "issue-1", issueIdentifier: "AII-1554",
        launchContext: { runnerMode }, maxJobMinutes: 123, backend,
        gapFill: { queueItemId: id, repository: "acme/billing", installationId: "778899", prNumber: 42,
          prDispatchBudget: 7, humanRequested: true } });
      expect(queue.getCommentGapfillItem(id)?.status).toBe("dispatched");
      expect(opts.dispatch).not.toHaveBeenCalled();
      expect(opts.getInstallationToken).not.toHaveBeenCalled();
      expect(opts.getTargetRepoToken).not.toHaveBeenCalled();
      expect(acquireSpy).not.toHaveBeenCalled();
      // Acceptance transfers launch ownership; a second drain cannot launch or submit it again.
      await drain.drainCommentGapfillQueue(opts);
      expect(submit).toHaveBeenCalledTimes(1);
    });
  }

  it.each(["accepted", "conflict", "unavailable", "not-found"] as const)("submit %s applies the queue state and log", async (status) => {
    seedOrigin();
    const id = seedItem();
    submit.mockResolvedValue({ status });
    const lines = vi.spyOn(console, "log").mockImplementation(() => {});
    const opts = optsFor();
    await drain.drainCommentGapfillQueue(opts);
    expect(queue.getCommentGapfillItem(id)?.status).toBe(status === "accepted" || status === "conflict" ? "dispatched" : "pending");
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(opts.dispatch).not.toHaveBeenCalled();
    if (status === "unavailable") expect(lines).toHaveBeenCalledWith("[comment-gapfill] Gap-fill for PR #42 skipped: Restate unavailable");
    if (status === "not-found") expect(lines).toHaveBeenCalledWith("[comment-gapfill] Gap-fill for PR #42 skipped: the ImplementationRun service is not registered");
    if (status === "conflict") expect(lines).toHaveBeenCalledWith(`[comment-gapfill] Existing ImplementationRun owns dispatch=${submit.mock.calls[0]![0]}`);
  });

  it("Restate unavailable leaves pending with no reservation or installation lookup", async () => {
    seedOrigin();
    const id = seedItem();
    const lines = vi.spyOn(console, "log").mockImplementation(() => {});
    const opts = optsFor(undefined, { restateCanServe: () => false });
    await checkNoSubmit(opts, id, "pending");
    expect(opts.getInstallationId).not.toHaveBeenCalled();
    expect(lines).toHaveBeenCalledWith("[comment-gapfill] Gap-fill for PR #42 skipped: Restate unavailable");
  });

  it("no mapping skips", async () => {
    await checkNoSubmit(makeBaseDrainOpts(), seedItem(), "skipped");
  });
  it("unreadable PR without a dispatch fails and replies", async () => {
    prLookup(42, githubError(404, "Not Found"));
    const opts = optsFor();
    await checkNoSubmit(opts, seedItem(), "failed");
    expect(opts.postComment).toHaveBeenCalledWith("gh-token", "acme", "billing", 42, expect.stringContaining("could not read this PR"));
  });
  it("readable PR without an identity fails and replies", async () => {
    prLookup(42, openPrWithHead("unrelated"));
    const opts = optsFor();
    await checkNoSubmit(opts, seedItem(), "failed");
    expect(opts.postComment).toHaveBeenCalledWith("gh-token", "acme", "billing", 42, expect.stringContaining("no record"));
  });
  it("paused mapping skips", async () => {
    seedOrigin();
    await checkNoSubmit(optsFor(makeMapping({ owner: "acme", repo: "billing", paused: true })), seedItem(), "skipped");
  });
  it("filesystem outside local mode skips", async () => {
    seedOrigin();
    await checkNoSubmit(optsFor(makeMapping({ owner: "acme", repo: "billing", ticketingProvider: "filesystem" })), seedItem(), "skipped");
  });
  it("other canDispatch refusal defers", async () => {
    seedOrigin("running");
    await checkNoSubmit(optsFor(), seedItem(), "pending");
  });
  it("ephemeral full-access outside GHA defers", async () => {
    seedOrigin();
    await checkNoSubmit(optsFor(makeMapping({ owner: "acme", repo: "billing",
      extraEnv: { [EPHEMERAL_FULL_ACCESS_EXTRA_ENV]: EPHEMERAL_FULL_ACCESS_ASSERTION } }), { runnerMode: "local" }), seedItem(), "pending");
  });
  it("conflict re-queue submits through the same ingress with humanRequested false", async () => {
    seedOrigin();
    const id = queue.enqueueConflictResolution({ owner: "acme", repo: "billing", prNumber: 42, featureBranch: "ai-implement/feature/aii-1" });
    expect(queue.getCommentGapfillItem(id)?.commenter).toBe(queue.CONFLICT_COMMENTER);
    await drain.drainCommentGapfillQueue(optsFor());
    expect(submit.mock.calls[0]![1].gapFill).toEqual(expect.objectContaining({ queueItemId: id, humanRequested: false }));
    expect(acquireSpy).not.toHaveBeenCalled();
  });
  it("normalizes an unset timeout", async () => {
    seedOrigin(); seedItem();
    await drain.drainCommentGapfillQueue(optsFor(makeMapping({ owner: "acme", repo: "billing", maxJobMinutes: null })));
    expect(submit.mock.calls[0]![1].maxJobMinutes).toBe(90);
  });
  it("roll-up uses the parent's identity and the roll-up PR target", async () => {
    seedDispatchLog("parent-uuid", "TSAI-196", "Parent", "acme", "billing", 70);
    prLookup(89, openPrWithHead("ai-implement/feature/tsai-196"));
    seedItem({ prNumber: 89 });
    await drain.drainCommentGapfillQueue(optsFor());
    expect(submit.mock.calls[0]![1]).toEqual(expect.objectContaining({ issueId: "parent-uuid", issueIdentifier: "TSAI-196",
      gapFill: expect.objectContaining({ prNumber: 89 }) }));
  });
  it("in-flight branch fallback defers until pr_url is written", async () => {
    const jobId = log.appendLog(makeAppendLogEntry({ issueId: "issue-1", issueIdentifier: "AII-1554", teamKey: "AII", repo: "acme/billing", status: "running" }));
    prLookup(42, openPrWithHead("ai-implement/aii-1554-caller-switch"));
    const id = seedItem();
    await checkNoSubmit(optsFor(), id, "pending");
    log.updateJobPrUrl(jobId, "https://github.com/acme/billing/pull/42");
    log.updateJobStatus(jobId, "completed");
    await drain.drainCommentGapfillQueue(optsFor());
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it("preserves a real reservation refusal before ingress acceptance returns", async () => {
    seedOrigin();
    const id = seedItem();
    const mapping = makeMapping({ owner: "acme", repo: "billing", maxInProgressAiIssues: 1 });
    // Start with an already-deferred row and hold time constant to exercise
    // multiple transitions within the same millisecond.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    queue.markCommentGapfillProcessed(id, "pending");
    const deps = gapfill.createImplementationGapfillDependencies({} as Parameters<typeof gapfill.createImplementationGapfillDependencies>[0], () => mapping);
    submit.mockImplementation(async (_key, input) => {
      expect(admission.acquire({ dispatchId: "competing-run", mappingKey: "AII",
        scope: { kind: "issue", issueScope: "AII", issueId: "other" },
        kind: "implementation", backend: "github-actions", lifecycleOwner: { kind: "legacy" }, cap: 1 }).ok).toBe(true);
      expect(await deps.reserve(input)).toBe(false);
      return { status: "accepted" };
    });
    await drain.drainCommentGapfillQueue(optsFor(mapping));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(queue.getCommentGapfillItem(id)?.status).toBe("pending");
  });

  it.each(["accepted", "conflict"] as const)("preserves workflow queue transitions before %s returns", async (status) => {
    seedOrigin();
    for (const workflowStatus of ["pending", "failed", "completed", "dispatched"] as const) {
      const id = seedItem({ commentId: 9100 + ["pending", "failed", "completed", "dispatched"].indexOf(workflowStatus) });
      submit.mockImplementationOnce(async () => {
        queue.markCommentGapfillProcessed(id, workflowStatus);
        return { status };
      });
      await drain.drainCommentGapfillQueue(optsFor());
      expect(queue.getCommentGapfillItem(id)?.status).toBe(workflowStatus);
      // Keep a pending row out of subsequent drain iterations.
      queue.markCommentGapfillProcessed(id, "completed");
    }
  });

  it("workflow reservation refusal restores an accepted item to pending", async () => {
    seedOrigin();
    const id = seedItem();
    const mapping = makeMapping({ owner: "acme", repo: "billing", maxInProgressAiIssues: 1 });
    await drain.drainCommentGapfillQueue(optsFor(mapping));
    expect(queue.getCommentGapfillItem(id)?.status).toBe("dispatched");
    const held = admission.acquire({ dispatchId: "competing-run", mappingKey: "AII", scope: { kind: "issue", issueScope: "AII", issueId: "other" },
      kind: "implementation", backend: "github-actions", lifecycleOwner: { kind: "legacy" }, cap: 1 });
    expect(held.ok).toBe(true);
    const deps = gapfill.createImplementationGapfillDependencies({} as Parameters<typeof gapfill.createImplementationGapfillDependencies>[0], () => mapping);
    expect(await deps.reserve(submit.mock.calls[0]![1])).toBe(false);
    expect(queue.getCommentGapfillItem(id)?.status).toBe("pending");
  });
});
