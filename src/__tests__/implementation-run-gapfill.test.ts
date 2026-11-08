import { beforeEach, expect, it, vi } from "vitest";
import { makeMapping, makeJob } from "./helpers/builders.js";
import type { ImplementationRunDependencies, ImplementationRunInput } from "../restate/implementation-run-workflow.js";
import type { ImplementationRunProductionInput } from "../restate/implementation-run-production.js";
const captured = vi.hoisted(() => ({ deps: undefined as unknown }));
vi.mock("../restate/implementation-run-workflow.js", async original => ({ ...await original<object>(), createImplementationRunWorkflow: (d: unknown) => { captured.deps = d; return {}; } }));
vi.mock("../dispatch-admission.js", () => ({ acquire: vi.fn(), read: vi.fn(), release: vi.fn(), releaseByDispatchId: vi.fn() }));
vi.mock("../dispatch-gate.js", () => ({ acquireDispatch: vi.fn() }));
vi.mock("../dispatch-breaker.js", () => ({ isParked: vi.fn(() => false) }));
vi.mock("../comment-gapfill-queue.js", () => ({ CONFLICT_COMMENTER: "conflict", getCommentGapfillItem: vi.fn(), markCommentGapfillProcessed: vi.fn() }));
vi.mock("../comment-gapfill-drain.js", () => ({ buildCommentGapfillInstruction: vi.fn(() => "COMMENT-SENTINEL"), gapfillAccounting: vi.fn(async () => ({ trackerKind: "linear", issueUrl: "url" })), resolveManagedDecision: vi.fn() }));
vi.mock("../log.js", () => ({ appendLogIfAbsent: vi.fn(() => 7), getLatestDispatchForPr: vi.fn(), getLatestDispatchForIssueIdentifier: vi.fn(), getJobByDispatchId: vi.fn(), getClaimedRunIds: vi.fn(() => new Set([99])), updateJobPrUrl: vi.fn(), updateJobRunId: vi.fn(), suppressStaleNotifications: vi.fn(), updateJobStatus: vi.fn() }));
vi.mock("../github-app-auth.js", () => ({ getInstallationToken: vi.fn(async () => "TOKEN-SENTINEL"), getScopedInstallationToken: vi.fn() }));
vi.mock("../github.js", async original => ({ ...await original<object>(), dispatchWorkflow: vi.fn(), getWorkflowRunStatus: vi.fn(async () => null), cancelWorkflowRun: vi.fn(async () => true) }));
vi.mock("../workflow-probe.js", () => ({ resolveWorkflowCapabilities: vi.fn() }));
vi.mock("../gapfill-launch.js", () => ({ prepareGhaGapfillLaunch: vi.fn(), dispatchGhaGapfill: vi.fn() }));
vi.mock("../dispatch-failure.js", () => ({ surfaceDispatchFailure: vi.fn() }));
vi.mock("../review-ledger-store.js", () => ({ listOpenReviewFindings: vi.fn(() => []) }));
vi.mock("../model-auth-runtime.js", () => ({ getModelAuthRuntime: vi.fn(() => ({})) }));
vi.mock("../managed-dispatch-auth.js", () => ({ settleLaunch: vi.fn(), isManagedProject: vi.fn(() => false) }));
vi.mock("../runner-tokens.js", () => ({ mintLaunchTokens: vi.fn(() => ({ runToken: "TOKEN-SENTINEL", runProgressToken: "NONCE-SENTINEL" })), implementationTtlSeconds: () => 100 }));
vi.mock("../dedup.js", () => ({ markDispatched: vi.fn() }));
import { createProductionImplementationRunServices, createImplementationFindExistingRun } from "../restate/implementation-run-production.js";
import { acquire, read } from "../dispatch-admission.js";
import { acquireDispatch } from "../dispatch-gate.js";
import { getCommentGapfillItem, markCommentGapfillProcessed } from "../comment-gapfill-queue.js";
import { resolveManagedDecision, buildCommentGapfillInstruction } from "../comment-gapfill-drain.js";
import { prepareGhaGapfillLaunch, dispatchGhaGapfill } from "../gapfill-launch.js";
import { appendLogIfAbsent, getLatestDispatchForPr, getLatestDispatchForIssueIdentifier, getJobByDispatchId, updateJobPrUrl, updateJobRunId, suppressStaleNotifications } from "../log.js";
import { surfaceDispatchFailure } from "../dispatch-failure.js";
import { isParked } from "../dispatch-breaker.js";
import { getModelAuthRuntime } from "../model-auth-runtime.js";
import { settleLaunch, type ManagedDispatchDecision } from "../managed-dispatch-auth.js";
import { getInstallationToken } from "../github-app-auth.js";
import { mintLaunchTokens } from "../runner-tokens.js";
import { markDispatched } from "../dedup.js";
import { listOpenReviewFindings } from "../review-ledger-store.js";
const mapping = makeMapping({ owner: "Org", repo: "repo" });
const run: ImplementationRunInput = { dispatchId: "dispatch", issueId: "issue", issueIdentifier: "ENG-1", teamKey: "ENG", backend: "github-actions", maxJobMinutes: 90, launchContext: {}, gapFill: { queueItemId: 1, repository: "Org/repo", installationId: "123", prNumber: 42, prDispatchBudget: 5, humanRequested: true } };
let d: ImplementationRunDependencies;
let input: ImplementationRunProductionInput;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ workflow_runs: [] }) })));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(isParked).mockReturnValue(false);
  vi.mocked(acquire).mockReturnValue({ ok: true } as never);
  vi.mocked(read).mockReturnValue({ generation: 3, releasedAt: null } as never);
  vi.mocked(getCommentGapfillItem).mockReturnValue({ id: 1, instruction: "COMMENT-SENTINEL", owner: "Org", repo: "repo", prNumber: 42, commenter: "human", status: "dispatched" } as never);
  vi.mocked(resolveManagedDecision).mockResolvedValue({ kind: "legacy" });
  vi.mocked(prepareGhaGapfillLaunch).mockResolvedValue({ contract: "envelope", runnerImage: undefined, inputs: { token: "TOKEN-SENTINEL" } });
  vi.mocked(dispatchGhaGapfill).mockResolvedValue({ success: true, status: 200, runId: 88 });
  vi.mocked(getJobByDispatchId).mockReturnValue(null);
  vi.mocked(getLatestDispatchForPr).mockReturnValue(null);
  vi.mocked(getLatestDispatchForIssueIdentifier).mockReturnValue(null);
  input = { config: { githubAppId: "app", githubAppPrivateKey: "key", runnerCallbackBaseUrl: "callback", runnerTokenSecret: "secret" }, getMapping: () => mapping,
    resolveProvider: vi.fn(async () => ({})), resolveRunnerImage: vi.fn(), postDispatch: vi.fn(), finalizeImplementation: vi.fn(), remediateStuckJob: vi.fn(), reportTerminalJob: vi.fn() } as unknown as ImplementationRunProductionInput;
  createProductionImplementationRunServices(input);
  d = captured.deps as ImplementationRunDependencies;
});
it("reserve admits with PR budget and Restate ownership", async () => {
  expect(await d.reserve(run)).toBe(true);
  expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ kind: "gap-fill", scope: { kind: "pr", issueId: "issue", installationId: "123", repository: "Org/repo", prNumber: 42 }, lifecycleOwner: { kind: "restate", attemptId: "dispatch" }, prDispatchBudget: 5, humanRequested: true, parked: false, cap: mapping.maxInProgressAiIssues }));
});
it.each(["parked", "budget_exhausted", "occupied", "at_capacity"])("reserve refusal %s restores pending", async reason => {
  vi.mocked(acquire).mockReturnValue({ ok: false, reason } as never);
  expect(await d.reserve(run)).toBe(false);
  expect(markCommentGapfillProcessed).toHaveBeenCalledWith(1, "pending");
});
it.each(["probe", "token", "managed"])("prep %s failure fails the queue and settles rejected", async source => {
  if (source === "probe") vi.mocked(prepareGhaGapfillLaunch).mockRejectedValueOnce(new Error("probe"));
  if (source === "token") vi.mocked(getInstallationToken).mockRejectedValueOnce(new Error("token"));
  if (source === "managed") vi.mocked(resolveManagedDecision).mockRejectedValueOnce(new Error("managed"));
  expect(await d.launch(run)).toEqual({ outcome: "rejected" });
  expect(markCommentGapfillProcessed).toHaveBeenCalledWith(1, "failed");
  expect(settleLaunch).toHaveBeenCalledWith({ kind: "legacy" }, "rejected", expect.anything());
});
it("managed hold restores pending", async () => {
  vi.mocked(resolveManagedDecision).mockResolvedValueOnce(null);
  expect(await d.launch(run)).toEqual({ outcome: "rejected" });
  expect(markCommentGapfillProcessed).toHaveBeenCalledWith(1, "pending");
  expect(dispatchGhaGapfill).not.toHaveBeenCalled();
});
it("dispatch success records only gap-analysis comment bookkeeping", async () => {
  expect(await d.launch(run)).toEqual({ outcome: "accepted", jobId: "88" });
  expect(appendLogIfAbsent).toHaveBeenCalledWith(expect.objectContaining({ phase: "gap-analysis", trigger: "comment", dispatchId: "dispatch", admissionGeneration: 3, contract: "envelope", executionMode: "github-actions", runnerMode: "default", trackerKind: "linear" }));
  expect(updateJobPrUrl).toHaveBeenCalledWith(7, "https://github.com/Org/repo/pull/42");
  expect(updateJobRunId).toHaveBeenCalledWith(7, 88);
  expect(suppressStaleNotifications).toHaveBeenCalledExactlyOnceWith("issue", 7);
  expect(markDispatched).not.toHaveBeenCalled();
  expect(input.postDispatch).not.toHaveBeenCalled();
  expect(markCommentGapfillProcessed).toHaveBeenCalledWith(1, "dispatched");
  expect(mintLaunchTokens).toHaveBeenCalledWith(expect.objectContaining({ phase: "gap-analysis" }));
});
it("definite rejection surfaces failure and fails queue", async () => {
  vi.mocked(dispatchGhaGapfill).mockResolvedValueOnce({ success: false, status: 422, outcome: "rejected" });
  expect(await d.launch(run)).toEqual({ outcome: "rejected" });
  expect(surfaceDispatchFailure).toHaveBeenCalled();
  expect(markCommentGapfillProcessed).toHaveBeenCalledWith(1, "failed");
  expect(appendLogIfAbsent).not.toHaveBeenCalled();
});
it("ambiguous dispatch retains dispatched queue and records row", async () => {
  vi.mocked(dispatchGhaGapfill).mockResolvedValueOnce({ success: false, status: 503, outcome: "unknown" });
  expect(await d.launch(run)).toEqual({ outcome: "unknown" });
  expect(markCommentGapfillProcessed).toHaveBeenCalledWith(1, "dispatched");
  expect(appendLogIfAbsent).toHaveBeenCalled();
});
it("recorded run id wins", async () => {
  vi.mocked(getJobByDispatchId).mockReturnValueOnce(makeJob({ runId: 77 }));
  expect(await d.findExistingRun(run, 1000)).toBe("77");
  expect(fetch).not.toHaveBeenCalled();
});
function runs(ids: number[]) {
  vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ workflow_runs: ids.map(id => ({ id, display_title: "Claude AI Implementation — ENG-1", created_at: new Date(1000).toISOString() })) }) } as Response);
}
it("one unclaimed title match after floored time wins", async () => { runs([99, 88]); expect(await d.findExistingRun(run, 1999)).toBe("88"); });
it("no matching run returns null", async () => { runs([]); expect(await d.findExistingRun(run, 1000)).toBeNull(); });
it("multiple unclaimed matches throw", async () => { runs([88, 87]); await expect(d.findExistingRun(run, 1000)).rejects.toThrow("multiple"); });
it("absent gapFill preserves existing reserve calls", async () => {
  vi.mocked(acquireDispatch).mockReturnValueOnce({ ok: true } as never);
  expect(await d.reserve({ ...run, gapFill: undefined })).toBe(true);
  expect(acquire).not.toHaveBeenCalled();
  expect(acquireDispatch).toHaveBeenCalledWith({ dispatchId: "dispatch", issueId: "issue", issueIdentifier: "ENG-1", kind: "implementation", teamKey: "ENG", maxInProgressAiIssues: mapping.maxInProgressAiIssues, backend: "github-actions", lifecycleOwner: { kind: "restate", attemptId: "dispatch" } });
});
it("no deps result exposes token, nonce or comment text", async () => {
  const values = [await d.reserve(run), await d.findExistingRun(run, 1000), await d.launch(run), await d.readStatus(run, "88"), await d.stop(run, "88"), await d.finishJob!("dispatch", { kind: "run_ended" }), await d.readModelPrices!(), await d.cleanup(run, "88"), await d.onOutcome("dispatch"), await d.release("dispatch", "finalized")];
  expect(JSON.stringify(values)).not.toMatch(/TOKEN-SENTINEL|NONCE-SENTINEL|COMMENT-SENTINEL/);
});
it("conflict commenter receives no review findings", async () => {
  vi.mocked(getCommentGapfillItem).mockReturnValue({ id: 1, commenter: "conflict", instruction: "merge" } as never);
  await d.launch(run);
  expect(listOpenReviewFindings).not.toHaveBeenCalled();
  expect(buildCommentGapfillInstruction).toHaveBeenCalledWith("merge", []);
});
it("gap-analysis rows use shared finish and finalize with ownerCall", async () => {
  const job = makeJob({ phase: "gap-analysis", teamKey: "ENG", status: "running", prUrl: null });
  vi.mocked(getJobByDispatchId).mockReturnValueOnce(job);
  await d.finishJob!("dispatch", { kind: "run_ended" });
  expect(input.finalizeImplementation).toHaveBeenCalledWith(expect.objectContaining({ kind: "failed" }), expect.anything(), expect.anything(), job, { ownerCall: true });
});
it("managed refusal preserves failed state from the shared decision helper", async () => {
  vi.mocked(resolveManagedDecision).mockResolvedValueOnce(null);
  vi.mocked(getCommentGapfillItem).mockReturnValue({ id: 1, status: "failed" } as never);
  expect(await d.launch(run)).toEqual({ outcome: "rejected" });
  expect(markCommentGapfillProcessed).not.toHaveBeenCalledWith(1, "pending");
  expect(dispatchGhaGapfill).not.toHaveBeenCalled();
});
it("a thrown dispatch is ambiguous and retains its job row", async () => {
  vi.mocked(dispatchGhaGapfill).mockRejectedValueOnce(new Error("transport"));
  expect(await d.launch(run)).toEqual({ outcome: "unknown" });
  expect(appendLogIfAbsent).toHaveBeenCalled();
  expect(markCommentGapfillProcessed).toHaveBeenCalledWith(1, "dispatched");
  expect(settleLaunch).toHaveBeenCalledTimes(1);
});
it("normal comments rebuild open review findings", async () => {
  const finding = { findingKey: "key", source: "human", severity: "high", path: "file", line: 5, body: "fix", url: "url" };
  vi.mocked(listOpenReviewFindings).mockReturnValueOnce([finding] as never);
  await d.launch(run);
  expect(listOpenReviewFindings).toHaveBeenCalledWith("Org/repo", 42);
  expect(buildCommentGapfillInstruction).toHaveBeenCalledWith("COMMENT-SENTINEL", [{ finding_key: "key", source: "human", severity: "high", path: "file", line: 5, body: "fix", url: "url" }]);
});
it("lookup excludes old runs and other titles", async () => {
  vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ workflow_runs: [
    { id: 1, display_title: "Claude AI Implementation — ENG-1", created_at: new Date(0).toISOString() },
    { id: 2, display_title: "Claude AI Implementation — ENG-2", created_at: new Date(2000).toISOString() },
  ] }) } as Response);
  expect(await d.findExistingRun(run, 1999)).toBeNull();
});
it("first-time launch still calls existing launch helpers with the same arguments", async () => {
  const first = { ...run, gapFill: undefined, launchContext: { runnerMode: "default" } };
  const issue = { id: "issue", identifier: "ENG-1", title: "Title", scopeKey: "ENG" };
  const provider = { findByKey: vi.fn(async () => issue) };
  const prepared = { ghToken: "TOKEN-SENTINEL", runnerImage: "image", contract: "envelope", dispatchInputs: {} };
  input.resolveProvider = vi.fn(async () => provider) as never;
  input.prepareImplementationLaunch = vi.fn(async () => prepared) as never;
  input.launchImplementationRun = vi.fn(async () => ({ outcome: "rejected" })) as never;
  createProductionImplementationRunServices(input);
  const deps = captured.deps as ImplementationRunDependencies;
  expect(await deps.launch(first)).toEqual({ outcome: "rejected" });
  const runtime = vi.mocked(getModelAuthRuntime).mock.results.at(-1)!.value;
  expect(input.resolveProvider).toHaveBeenCalledExactlyOnceWith(mapping);
  expect(provider.findByKey).toHaveBeenCalledExactlyOnceWith("ENG-1", "ENG");
  expect(input.prepareImplementationLaunch).toHaveBeenCalledExactlyOnceWith({
    modelPrices: undefined, config: input.config, issue, mapping, dispatchId: "dispatch",
    baseBranch: mapping.defaultBranch, managedDecision: { kind: "legacy" }, managedRuntime: runtime,
    resolveRunnerImage: input.resolveRunnerImage, isGroupingParentDispatch: input.isGroupingParentDispatch,
  });
  expect(input.launchImplementationRun).toHaveBeenCalledExactlyOnceWith({
    config: input.config, provider, issue, mapping, launch: prepared, implSentBaseBranch: false,
    managedDecision: { kind: "legacy" }, managedRuntime: runtime, fireBreakerTrip: input.fireBreakerTrip,
  });
  expect(prepareGhaGapfillLaunch).not.toHaveBeenCalled();
});

it("parked gap-analysis admission passes the parked flag", async () => {
  vi.mocked(isParked).mockReturnValueOnce(true);
  await d.reserve(run);
  expect(isParked).toHaveBeenCalledExactlyOnceWith("issue", "gap-analysis");
  expect(acquire).toHaveBeenCalledExactlyOnceWith({
    dispatchId: "dispatch", mappingKey: "ENG",
    scope: { kind: "pr", issueId: "issue", installationId: "123", repository: "Org/repo", prNumber: 42 },
    kind: "gap-fill", backend: "github-actions", lifecycleOwner: { kind: "restate", attemptId: "dispatch" },
    cap: mapping.maxInProgressAiIssues, prDispatchBudget: 5, humanRequested: true, parked: true,
  });
});
it("absent gapFill preserves existing lookup calls and result", async () => {
  const first = { ...run, gapFill: undefined };
  const existing = createImplementationFindExistingRun({ getMapping: input.getMapping!,
    getToken: owner => getInstallationToken(input.config.githubAppId, input.config.githubAppPrivateKey, owner) });
  runs([88, 87]);
  expect(await existing(first, 1999)).toBe("88");
  const expectedFetch = vi.mocked(fetch).mock.calls[0];
  const expectedToken = vi.mocked(getInstallationToken).mock.calls[0];
  const expectedRow = vi.mocked(getJobByDispatchId).mock.calls[0];
  vi.mocked(fetch).mockClear();
  vi.mocked(getInstallationToken).mockClear();
  vi.mocked(getJobByDispatchId).mockClear();
  runs([88, 87]);
  expect(await d.findExistingRun(first, 1999)).toBe("88");
  // Each invocation creates its own timeout signal; compare its type separately.
  expect(fetch).toHaveBeenCalledExactlyOnceWith(expectedFetch[0], { ...expectedFetch[1], signal: expect.any(AbortSignal) });
  expect(getInstallationToken).toHaveBeenCalledExactlyOnceWith(...expectedToken);
  expect(getJobByDispatchId).toHaveBeenCalledExactlyOnceWith(...expectedRow);
});
function managedDecision(): Extract<ManagedDispatchDecision, { kind: "launch" }> {
  return { kind: "launch", dispatchId: "dispatch", projectKey: "ENG", backend: "github-actions",
    snapshot: {} as never, fallbackModels: {}, grant: {} as never, takeBootstrap: vi.fn() };
}
it.each(["probe", "token"])("managed grant settles rejected after %s preparation failure", async source => {
  const decision = managedDecision();
  vi.mocked(resolveManagedDecision).mockResolvedValueOnce(decision);
  if (source === "probe") vi.mocked(prepareGhaGapfillLaunch).mockRejectedValueOnce(new Error("probe"));
  else vi.mocked(getInstallationToken).mockRejectedValueOnce(new Error("token"));
  expect(await d.launch(run)).toEqual({ outcome: "rejected" });
  const runtime = vi.mocked(getModelAuthRuntime).mock.results.at(-1)!.value;
  expect(settleLaunch).toHaveBeenCalledExactlyOnceWith(decision, "rejected", runtime);
  expect(vi.mocked(settleLaunch).mock.calls[0][0]).toBe(decision);
  expect(vi.mocked(settleLaunch).mock.calls[0][2]).toBe(runtime);
  expect(markCommentGapfillProcessed).toHaveBeenCalledWith(1, "failed");
});
it.each(["rejected", "unknown", "throw"] as const)("managed grant settles after dispatch %s", async outcome => {
  const decision = managedDecision();
  vi.mocked(resolveManagedDecision).mockResolvedValueOnce(decision);
  if (outcome === "throw") vi.mocked(dispatchGhaGapfill).mockRejectedValueOnce(new Error("transport"));
  else vi.mocked(dispatchGhaGapfill).mockResolvedValueOnce({ success: false, status: outcome === "rejected" ? 422 : 503, outcome });
  const expected = outcome === "throw" ? "unknown" : outcome;
  expect(await d.launch(run)).toEqual({ outcome: expected });
  const runtime = vi.mocked(getModelAuthRuntime).mock.results.at(-1)!.value;
  expect(settleLaunch).toHaveBeenCalledExactlyOnceWith(decision, expected, runtime);
  expect(vi.mocked(settleLaunch).mock.calls[0][0]).toBe(decision);
  expect(vi.mocked(settleLaunch).mock.calls[0][2]).toBe(runtime);
});
it("successful managed launch retains the grant", async () => {
  const decision = managedDecision();
  vi.mocked(resolveManagedDecision).mockResolvedValueOnce(decision);
  expect(await d.launch(run)).toEqual({ outcome: "accepted", jobId: "88" });
  expect(vi.mocked(prepareGhaGapfillLaunch).mock.calls[0][0].decision).toBe(decision);
  expect(settleLaunch).not.toHaveBeenCalled();
});

it.each(["PR", "issue identifier"])("gap-fill preserves the title recovered by %s", async source => {
  const job = makeJob({ issueId: run.issueId, issueIdentifier: run.issueIdentifier, issueTitle: "Run a GitHub Actions gap-fill inside ImplementationRun" });
  if (source === "PR") vi.mocked(getLatestDispatchForPr).mockReturnValueOnce(job);
  else vi.mocked(getLatestDispatchForIssueIdentifier).mockReturnValueOnce(job);
  await d.launch(run);
  const issue = { issueId: run.issueId, issueIdentifier: run.issueIdentifier, issueTitle: job.issueTitle };
  expect(prepareGhaGapfillLaunch).toHaveBeenCalledWith(expect.objectContaining({ issue }));
  expect(appendLogIfAbsent).toHaveBeenCalledWith(expect.objectContaining(issue));
  expect(getLatestDispatchForPr).toHaveBeenCalledExactlyOnceWith("Org", "repo", 42);
  if (source === "issue identifier") expect(getLatestDispatchForIssueIdentifier).toHaveBeenCalledExactlyOnceWith("Org", "repo", "ENG-1");
});
it("missing title retains the shared launch helper's issue-id fallback", async () => {
  await d.launch(run);
  expect(prepareGhaGapfillLaunch).toHaveBeenCalledWith(expect.objectContaining({ issue: { issueId: run.issueId, issueIdentifier: run.issueIdentifier } }));
});
it.each(["missing title", "different issue"])("recovers the input issue's title when the PR row has %s", async reason => {
  vi.mocked(getLatestDispatchForPr).mockReturnValueOnce(makeJob({
    issueId: reason === "different issue" ? "other-issue" : run.issueId,
    issueTitle: reason === "different issue" ? "Another issue's title" : null,
  }));
  const job = makeJob({ issueId: run.issueId, issueIdentifier: run.issueIdentifier, issueTitle: "Original tracked issue title" });
  vi.mocked(getLatestDispatchForIssueIdentifier).mockReturnValueOnce(job);
  await d.launch(run);
  expect(prepareGhaGapfillLaunch).toHaveBeenCalledWith(expect.objectContaining({
    issue: { issueId: run.issueId, issueIdentifier: run.issueIdentifier, issueTitle: job.issueTitle },
  }));
  expect(appendLogIfAbsent).toHaveBeenCalledWith(expect.objectContaining({ issueTitle: job.issueTitle }));
});
