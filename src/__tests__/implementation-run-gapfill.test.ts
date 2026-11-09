import { beforeEach, expect, it, vi } from "vitest";
import { makeMapping, makeJob } from "./helpers/builders.js";
import type { ImplementationRunDependencies, ImplementationRunInput } from "../restate/implementation-run-workflow.js";
import type { ImplementationRunProductionInput } from "../restate/implementation-run-production.js";
vi.mock("../agent-run-preparation.js", async original => ({ ...await original<object>(), persistedPreparationState: vi.fn(() => "absent") }));
const intents = vi.hoisted(() => new Map<string, unknown>());
const captured = vi.hoisted(() => ({ deps: undefined as unknown }));
vi.mock("../restate/implementation-run-workflow.js", async original => ({ ...await original<object>(), createImplementationRunWorkflow: (d: unknown) => { captured.deps = d; return {}; } }));
vi.mock("../dispatch-admission.js", () => ({ acquire: vi.fn(), read: vi.fn(), release: vi.fn(), releaseByDispatchId: vi.fn() }));
vi.mock("../dispatch-gate.js", () => ({ acquireDispatch: vi.fn() }));
vi.mock("../dispatch-breaker.js", () => ({ isParked: vi.fn(() => false) }));
vi.mock("../comment-gapfill-queue.js", () => ({ getCommentGapfillLaunch: vi.fn((id: string) => intents.get(id) ?? null), stageCommentGapfillLaunch: vi.fn((id: string, value: unknown) => intents.set(id, value)), confirmCommentGapfillLaunch: vi.fn(), rejectCommentGapfillLaunch: vi.fn((id: string, status: number) => intents.set(id, { ...intents.get(id) as object, rejected: { status } })), CONFLICT_COMMENTER: "conflict", getCommentGapfillItem: vi.fn(), markCommentGapfillProcessed: vi.fn() }));
vi.mock("../comment-gapfill-drain.js", () => ({ buildCommentGapfillInstruction: vi.fn(() => "COMMENT-SENTINEL"), gapfillAccounting: vi.fn(async () => ({ trackerKind: "linear", issueUrl: "url" })), resolveManagedDecision: vi.fn() }));
vi.mock("../log.js", () => ({ appendLogIfAbsent: vi.fn(() => 7), getLatestDispatchForPr: vi.fn(), getLatestDispatchForIssueIdentifier: vi.fn(), getJobByDispatchId: vi.fn(), getClaimedRunIds: vi.fn(() => new Set([99])), updateJobPrUrl: vi.fn(), attachJobRunIdIfMissing: vi.fn(), suppressStaleNotifications: vi.fn(), updateJobStatus: vi.fn() }));
vi.mock("../github-app-auth.js", () => ({ getInstallationToken: vi.fn(async () => "TOKEN-SENTINEL"), getScopedInstallationToken: vi.fn() }));
vi.mock("../github.js", async original => ({ ...await original<object>(), dispatchWorkflow: vi.fn(), getWorkflowRunStatus: vi.fn(async () => null), cancelWorkflowRun: vi.fn(async () => true) }));
vi.mock("../workflow-probe.js", () => ({ resolveWorkflowCapabilities: vi.fn() }));
vi.mock("../gapfill-launch.js", () => ({ prepareGhaGapfillLaunch: vi.fn(), dispatchGhaGapfill: vi.fn() }));
vi.mock("../dispatch-failure.js", () => ({ surfaceDispatchFailure: vi.fn() }));
vi.mock("../review-ledger-store.js", () => ({ listOpenReviewFindings: vi.fn(() => []) }));
vi.mock("../model-auth-runtime.js", () => ({ getModelAuthRuntime: vi.fn(() => ({})) }));
vi.mock("../managed-dispatch-auth.js", () => ({ settleLaunch: vi.fn(), prepareManagedDispatch: vi.fn(), refusalText: vi.fn(() => "held"), isManagedProject: vi.fn(() => false) }));
vi.mock("../runner-tokens.js", () => ({ mintLaunchTokens: vi.fn(() => ({ runToken: "TOKEN-SENTINEL", runProgressToken: "NONCE-SENTINEL" })), implementationTtlSeconds: () => 100 }));
vi.mock("../base-branch.js", async original => ({ ...await original<object>(), postBranchComment: vi.fn() }));
vi.mock("../dedup.js", () => ({ markDispatched: vi.fn() }));
import { createProductionImplementationRunServices, createImplementationFindExistingRun } from "../restate/implementation-run-production.js";
import { acquire, read } from "../dispatch-admission.js";
import { acquireDispatch } from "../dispatch-gate.js";
import { getCommentGapfillItem, markCommentGapfillProcessed } from "../comment-gapfill-queue.js";
import { resolveManagedDecision, buildCommentGapfillInstruction } from "../comment-gapfill-drain.js";
import { prepareGhaGapfillLaunch, dispatchGhaGapfill } from "../gapfill-launch.js";
import { appendLogIfAbsent, getLatestDispatchForPr, getLatestDispatchForIssueIdentifier, getJobByDispatchId, updateJobPrUrl, attachJobRunIdIfMissing, suppressStaleNotifications } from "../log.js";
import { surfaceDispatchFailure } from "../dispatch-failure.js";
import { isParked } from "../dispatch-breaker.js";
import { getModelAuthRuntime } from "../model-auth-runtime.js";
import { settleLaunch, type ManagedDispatchDecision } from "../managed-dispatch-auth.js";
import { getWorkflowRunStatus, cancelWorkflowRun } from "../github.js";
import { getInstallationToken } from "../github-app-auth.js";
import { mintLaunchTokens } from "../runner-tokens.js";
import { postBranchComment } from "../base-branch.js";
import { markDispatched } from "../dedup.js";
import { listOpenReviewFindings } from "../review-ledger-store.js";
const mapping = makeMapping({ owner: "Org", repo: "repo" });
const run: ImplementationRunInput = { dispatchId: "dispatch", issueId: "issue", issueIdentifier: "ENG-1", teamKey: "ENG", backend: "github-actions", maxJobMinutes: 90, launchContext: {}, gapFill: { queueItemId: 1, repository: "Org/repo", installationId: "123", prNumber: 42, prDispatchBudget: 5, humanRequested: true } };
let d: ImplementationRunDependencies;
let input: ImplementationRunProductionInput;
beforeEach(() => {
  vi.clearAllMocks();
  intents.clear();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ workflow_runs: [] }) })));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(isParked).mockReturnValue(false);
  vi.mocked(acquire).mockReturnValue({ ok: true } as never);
  vi.mocked(read).mockReturnValue({ generation: 3, releasedAt: null } as never);
  vi.mocked(getCommentGapfillItem).mockReturnValue({ id: 1, instruction: "COMMENT-SENTINEL", owner: "Org", repo: "repo", prNumber: 42, commenter: "human", status: "pending" } as never);
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
  expect(attachJobRunIdIfMissing).toHaveBeenCalledWith(7, 88);
  expect(suppressStaleNotifications).toHaveBeenCalledExactlyOnceWith("issue", 7);
  expect(markDispatched).not.toHaveBeenCalled();
  expect(input.postDispatch).not.toHaveBeenCalled();
  expect(postBranchComment).not.toHaveBeenCalled();
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

it("recovers accepted dispatch after insert failure using reconstructed production deps", async () => {
  vi.mocked(getLatestDispatchForPr).mockReturnValue(makeJob({ issueId: run.issueId, issueTitle: "Original title" }));
  vi.mocked(appendLogIfAbsent).mockImplementationOnce(() => { throw new Error("process lost before insert"); });
  await expect(d.launch(run)).rejects.toThrow("process lost");
  createProductionImplementationRunServices(input);
  d = captured.deps as ImplementationRunDependencies;
  runs([88]);
  expect(await d.findExistingRun(run, 1000)).toBe("88");
  expect(appendLogIfAbsent).toHaveBeenLastCalledWith(expect.objectContaining({ issueTitle: "Original title", phase: "gap-analysis", trigger: "comment", admissionGeneration: 3, trackerKind: "linear" }));
  expect(attachJobRunIdIfMissing).toHaveBeenCalledWith(7, 88);
  vi.mocked(getJobByDispatchId).mockReturnValue(makeJob({ id: 7, runId: 88, status: "completed" }));
  expect(await d.findExistingRun(run, 1000)).toBe("88");
  expect(appendLogIfAbsent).toHaveBeenCalledTimes(2);
  expect(dispatchGhaGapfill).toHaveBeenCalledTimes(1);
  expect(prepareGhaGapfillLaunch).toHaveBeenCalledTimes(1);
});
it("reconstructs bookkeeping for a reconciled run without staging", async () => {
  runs([88]);
  expect(await d.findExistingRun(run, 1000)).toBe("88");
  expect(appendLogIfAbsent).toHaveBeenCalledWith(expect.objectContaining({ dispatchId: "dispatch", contract: undefined }));
});

it("a crash before dispatch leaves no durable intent and retry dispatches", async () => {
  vi.mocked(read).mockReturnValueOnce({ generation: 3, releasedAt: null } as never).mockImplementationOnce(() => { throw new Error("process interrupted before dispatch"); });
  expect(await d.launch(run)).toEqual({ outcome: "rejected" });
  expect(dispatchGhaGapfill).not.toHaveBeenCalled();
  expect(appendLogIfAbsent).not.toHaveBeenCalled();
  createProductionImplementationRunServices(input);
  d = captured.deps as ImplementationRunDependencies;
  expect(await d.findExistingRun(run, 1000)).toBeNull();
  vi.mocked(dispatchGhaGapfill).mockImplementationOnce(async () => {
    expect(appendLogIfAbsent).not.toHaveBeenCalled();
    return { success: true, status: 200, runId: 88 };
  });
  expect(await d.launch(run)).toEqual({ outcome: "accepted", jobId: "88" });
  expect(dispatchGhaGapfill).toHaveBeenCalledTimes(1);
});
it.each(["http", "unreadable"])("lookup remains fail-closed on %s failure", async kind => {
  vi.mocked(fetch).mockResolvedValueOnce(kind === "http" ? { ok: false, status: 503 } as Response : { ok: true, json: async () => { throw new Error("unreadable"); } } as unknown as Response);
  await expect(d.findExistingRun(run, 1000)).rejects.toThrow();
  expect(appendLogIfAbsent).not.toHaveBeenCalled();
});

import { testDb } from "./helpers/test-db.js";
it("durably recovers accepted launch and shares terminal bookkeeping without duplicate jobs", async () => {
  vi.doUnmock("../agent-run-preparation.js");
  vi.doUnmock("../dedup.js");
  vi.doUnmock("../dispatch-admission.js");
  vi.doUnmock("../log.js");
  vi.doUnmock("../comment-gapfill-queue.js");
  const database = await testDb({ modules: {
    production: () => import("../restate/implementation-run-production.js"), queue: () => import("../comment-gapfill-queue.js"),
    ownership: () => import("../model-session-ownership.js"), store: () => import("../model-session-store.js"), keys: () => import("../model-session-keys.js"),
    log: () => import("../log.js"), dedup: () => import("../dedup.js"), admission: () => import("../dispatch-admission.js"),
  } });
  const { production, queue, log, dedup } = database.modules;
  const { createProductionImplementationRunServices } = production;
  const { enqueueCommentGapfill, getCommentGapfillItem } = queue;
  const { appendLog, getJobByDispatchId } = log;
  const { getDb } = dedup;
  const db = getDb();
  const grant = (id: string) => db.prepare("INSERT INTO model_credential_grants (grant_id, dispatch_id, snapshot_id, project_key, backend, audience, bearer_hash, scope_json, expires_at) VALUES (?, ?, 'snapshot', 'ENG', 'gha', 'runner', 'hash', '{}', 9999999999999)").run(id, id);
  const queueItemId = enqueueCommentGapfill({ owner: "Org", repo: "repo", prNumber: 42, commentId: 1234, commenter: "human", instruction: "COMMENT-SENTINEL" });
  const recoveryRun = { ...run, gapFill: { ...run.gapFill!, queueItemId } };
  appendLog({ issueId: "issue", issueIdentifier: "ENG-1", issueTitle: "Original title", repo: "Org/repo", status: "completed" });
  const reserve = (dispatchId: string, prNumber: number) => database.modules.admission.acquire({
    dispatchId, mappingKey: "ENG", scope: { kind: "pr", issueId: "issue", installationId: "123", repository: "Org/repo", prNumber },
    kind: "gap-fill", backend: "github-actions", lifecycleOwner: { kind: "restate", attemptId: dispatchId }, cap: 10,
  });
  expect(reserve("dispatch", 42).ok).toBe(true);
  const generation = database.modules.admission.read("dispatch")!.generation;
  vi.mocked(resolveManagedDecision).mockResolvedValue({ kind: "legacy" });
  vi.mocked(prepareGhaGapfillLaunch).mockResolvedValue({ contract: "envelope", runnerImage: undefined, inputs: { token: "TOKEN-SENTINEL" } });
  vi.mocked(dispatchGhaGapfill).mockImplementation(async () => {
    db.exec("CREATE TRIGGER fail_job BEFORE INSERT ON dispatch_log BEGIN SELECT RAISE(FAIL, 'crash before insert'); END");
    return { success: true, status: 200, runId: 88 };
  });
  vi.mocked(prepareGhaGapfillLaunch).mockImplementationOnce(async () => {
    grant("dispatch");
    return { contract: "envelope", runnerImage: undefined, inputs: { token: "TOKEN-SENTINEL" } };
  });
  const input = { config: { githubAppId: "app", githubAppPrivateKey: "key", runnerCallbackBaseUrl: "callback", runnerTokenSecret: "secret" }, getMapping: () => mapping,
    resolveProvider: vi.fn(async () => ({})), resolveRunnerImage: vi.fn(), postDispatch: vi.fn(), finalizeImplementation: vi.fn(), remediateStuckJob: vi.fn(), reportTerminalJob: vi.fn() } as unknown as ImplementationRunProductionInput;
  createProductionImplementationRunServices(input);
  await expect((captured.deps as ImplementationRunDependencies).launch(recoveryRun)).rejects.toThrow("crash before insert");
  expect(getJobByDispatchId("dispatch")).toBeNull();
  expect(db.prepare("SELECT recovery_json FROM comment_gapfill_launch").get()).toBeDefined();
  db.exec("DROP TRIGGER fail_job");
  input.getMapping = () => ({ ...mapping, owner: "Changed", repo: "different", workflowFile: "changed.yml" });

  createProductionImplementationRunServices(input);
  const deps = captured.deps as ImplementationRunDependencies;
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ workflow_runs: [{ id: 88, display_title: "Claude AI Implementation — ENG-1", created_at: new Date(1000).toISOString() }] }) })));
  vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ workflow_runs: [] }) } as Response);
  expect(await deps.findExistingRun(recoveryRun, 1999)).toBeNull();
  expect(await deps.launch(recoveryRun)).toEqual({ outcome: "unknown" });
  expect(dispatchGhaGapfill).toHaveBeenCalledTimes(1);
  expect(prepareGhaGapfillLaunch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(db.prepare("SELECT recovery_json FROM comment_gapfill_launch").all())).not.toMatch(/TOKEN-SENTINEL|NONCE-SENTINEL|COMMENT-SENTINEL/);
  expect(await deps.findExistingRun(recoveryRun, 1999)).toBe("88");
  const job = getJobByDispatchId("dispatch")!;
  expect(job).toMatchObject({ issueTitle: "Original title", phase: "gap-analysis", admissionGeneration: generation, runId: 88, prUrl: "https://github.com/Org/repo/pull/42", status: "running" });
  expect(db.prepare("SELECT trigger, tracker_kind FROM dispatch_log WHERE id = ?").get(job.id)).toEqual({ trigger: "comment", tracker_kind: "linear" });
  expect(getCommentGapfillItem(queueItemId)?.status).toBe("dispatched");
  expect(db.prepare("SELECT revoked_at FROM model_credential_grants WHERE dispatch_id = 'dispatch'").get()).toEqual({ revoked_at: null });
  for (const current of [undefined, { ...mapping, owner: "Changed", repo: "different" }]) {
    input.getMapping = () => current;
    createProductionImplementationRunServices(input);
    const lifecycle = captured.deps as ImplementationRunDependencies;
    await lifecycle.readStatus(recoveryRun, "88");
    expect(getWorkflowRunStatus).toHaveBeenLastCalledWith("TOKEN-SENTINEL", "Org", "repo", 88);
    expect(getInstallationToken).toHaveBeenLastCalledWith("app", "key", "Org");
    expect(await lifecycle.stop(recoveryRun, "88")).toBe(true);
    expect(cancelWorkflowRun).toHaveBeenLastCalledWith("TOKEN-SENTINEL", "Org", "repo", 88);
    expect(getInstallationToken).toHaveBeenLastCalledWith("app", "key", "Org");
  }
  input.getMapping = () => mapping;
  // Recover the intermediate state where insert/PR link committed but run binding did not.
  db.prepare("UPDATE dispatch_log SET run_id = NULL, status = 'dispatched' WHERE id = ?").run(job.id);
  expect(await deps.findExistingRun(recoveryRun, 1999)).toBe("88");
  await deps.finishJob!("dispatch", { kind: "run_ended" });
  expect(input.finalizeImplementation).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.objectContaining({ id: job.id, phase: "gap-analysis" }), { ownerCall: true });
  expect(getCommentGapfillItem(queueItemId)?.status).toBe("failed");
  expect(await deps.findExistingRun(recoveryRun, 1999)).toBe("88");
  expect(getJobByDispatchId("dispatch")?.status).toBe("failed");
  expect(getCommentGapfillItem(queueItemId)?.status).toBe("failed");
  expect(db.prepare("SELECT COUNT(*) AS n FROM dispatch_log WHERE dispatch_id = 'dispatch'").get()).toEqual({ n: 1 });
  expect(dispatchGhaGapfill).toHaveBeenCalledTimes(1);
  expect(prepareGhaGapfillLaunch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toContain("Org/repo/actions/workflows/");

  // Persist an intent without calling dispatch, then close SQLite and reconstruct modules.
  const preCall = { ...recoveryRun, dispatchId: "pre-call" };
  expect(reserve("pre-call", 43).ok).toBe(true);
  const preCallAdmission = database.modules.admission.read("pre-call");
  queue.stageCommentGapfillLaunch(preCall.dispatchId, {
    record: { issueId: "issue", issueIdentifier: "ENG-1", issueTitle: "Frozen title", dispatchId: "pre-call", teamKey: "ENG", repo: "Org/repo", admissionGeneration: 3, phase: "gap-analysis", trigger: "comment", contract: "envelope" },
    target: { owner: "Org", repo: "repo", workflowFile: mapping.workflowFile }, accepted: false,
  });
  grant("pre-call");
  const ownershipFor = (modules: typeof database.modules) => modules.ownership.createModelSessionOwnership({
    store: modules.store.createModelSessionStore({ keys: modules.keys.createModelSessionKeyProvider({ RUNNER_TOKEN_SECRET: "synthetic-test-key" }), verifyOwner: modules.ownership.sessionOwnerVerifier, authorizeOperator: () => false }),
    probe: () => "unknown",
  });
  const reserved = ownershipFor(database.modules).reserve({ dispatchId: "pre-call", profiles: [{ profileId: "managed-profile", authMode: "subscription" }] });
  if (reserved.status !== "reserved") throw new Error("reservation failed");
  const ownerGeneration = reserved.reservations[0]!.generation;
  for (const stage of ["implementation", "review"]) db.prepare("INSERT INTO model_credential_grant_profiles VALUES ('pre-call', ?, 'managed-profile', 1, ?)").run(stage, ownerGeneration);
  const reopened = await database.reopen();
  const recoveredOwnership = ownershipFor(reopened);
  const releaseOwner = vi.spyOn(recoveredOwnership, "releaseLaunchRejected");
  releaseOwner.mockReturnValueOnce({ status: "rejected", reason: "invalid_state" });
  vi.mocked(getModelAuthRuntime).mockReturnValue({ ownership: recoveredOwnership } as never);
  reopened.production.createProductionImplementationRunServices(input);
  const recovered = captured.deps as ImplementationRunDependencies;
  vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ workflow_runs: [] }) } as Response);
  expect(await recovered.findExistingRun(preCall, 1999)).toBeNull();
  await expect(recovered.launch(preCall)).rejects.toThrow("settlement incomplete");
  expect(reopened.dedup.getDb().prepare("SELECT revoked_at FROM model_credential_grants WHERE grant_id = 'pre-call'").get()).toEqual({ revoked_at: null });
  expect(reopened.log.getJobByDispatchId("pre-call")).toBeNull();
  expect(JSON.stringify(await recovered.launch(preCall))).not.toMatch(/TOKEN-SENTINEL|NONCE-SENTINEL|COMMENT-SENTINEL/);
  expect(await recovered.launch(preCall)).toEqual({ outcome: "unknown" });
  expect(reopened.dedup.getDb().prepare("SELECT revoked_at FROM model_credential_grants WHERE grant_id = 'pre-call'").get()).toEqual({ revoked_at: expect.any(Number) });
  expect(reopened.dedup.getDb().prepare("SELECT recovery_status FROM model_profile_reservations WHERE dispatch_id = 'pre-call'").get()).toEqual({ recovery_status: "released" });
  expect(reopened.admission.read("pre-call")).toEqual(preCallAdmission);
  expect(reopened.log.getJobByDispatchId("pre-call")).toMatchObject({ issueTitle: "Frozen title", repo: "Org/repo", admissionGeneration: 3, contract: "envelope" });
  expect(dispatchGhaGapfill).toHaveBeenCalledTimes(1);
  expect(resolveManagedDecision).toHaveBeenCalledTimes(1);

  // Definite rejection retains its terminal disposition without creating a ghost job.
  const rejectedQueue = reopened.queue.enqueueCommentGapfill({ owner: "Org", repo: "repo", prNumber: 44, commentId: 5678, commenter: "human", instruction: "COMMENT-SENTINEL" });
  const rejectedRun = { ...recoveryRun, dispatchId: "rejected", gapFill: { ...recoveryRun.gapFill!, prNumber: 44, queueItemId: rejectedQueue } };
  expect(reopened.admission.acquire({ dispatchId: "rejected", mappingKey: "ENG", scope: { kind: "pr", issueId: "issue", installationId: "123", repository: "Org/repo", prNumber: 44 }, kind: "gap-fill", backend: "github-actions", lifecycleOwner: { kind: "restate", attemptId: "rejected" }, cap: 10 }).ok).toBe(true);
  vi.mocked(dispatchGhaGapfill).mockResolvedValueOnce({ success: false, status: 422, outcome: "rejected" });
  expect(await recovered.launch(rejectedRun)).toEqual({ outcome: "rejected" });
  expect(reopened.queue.getCommentGapfillLaunch("rejected")).toMatchObject({ rejected: { status: 422 } });
  expect(reopened.queue.getCommentGapfillLaunch("pre-call")).not.toBeNull();
  expect(reopened.log.getJobByDispatchId("rejected")).toBeNull();

  // A process died after grant persistence but before intent staging. Use the real
  // shared decision/release path against reopened SQLite, with preparation's replay result.
  const managed = await import("../managed-dispatch-auth.js");
  const shared = await vi.importActual<typeof import("../comment-gapfill-drain.js")>("../comment-gapfill-drain.js");
  vi.mocked(managed.isManagedProject).mockReturnValue(true);
  vi.mocked(managed.prepareManagedDispatch).mockResolvedValue({ kind: "hold", code: "bootstrap_consumed" });
  vi.mocked(resolveManagedDecision).mockImplementation(shared.resolveManagedDecision);
  const noIntentId = reopened.queue.enqueueCommentGapfill({ owner: "Org", repo: "repo", prNumber: 45, commentId: 9999, commenter: "human", instruction: "recover" });
  const noIntent = { ...recoveryRun, dispatchId: "no-intent", gapFill: { ...recoveryRun.gapFill!, prNumber: 45, queueItemId: noIntentId } };
  expect(reopened.admission.acquire({ dispatchId: noIntent.dispatchId, mappingKey: "ENG", scope: { kind: "pr", issueId: "issue", installationId: "123", repository: "Org/repo", prNumber: 45 }, kind: "gap-fill", backend: "github-actions", lifecycleOwner: { kind: "restate", attemptId: noIntent.dispatchId }, cap: 10 }).ok).toBe(true);
  const recoveryDb = reopened.dedup.getDb();
  recoveryDb.prepare("INSERT INTO model_credential_grants (grant_id, dispatch_id, snapshot_id, project_key, backend, audience, bearer_hash, scope_json, expires_at) VALUES ('no-intent-grant', 'no-intent', 'snapshot', 'ENG', 'gha', 'runner', 'hash', '{}', 9999999999999)").run();
  const noIntentOwner = recoveredOwnership.reserve({ dispatchId: noIntent.dispatchId, profiles: [{ profileId: "recovery-profile", authMode: "subscription" }] });
  if (noIntentOwner.status !== "reserved") throw new Error("reservation failed");
  recoveryDb.prepare("INSERT INTO model_credential_grant_profiles VALUES ('no-intent-grant', 'implementation', 'recovery-profile', 1, ?)").run(noIntentOwner.reservations[0]!.generation);
  // Recreate production dependencies only after persistence, as on process restart.
  reopened.production.createProductionImplementationRunServices(input);
  const noIntentDeps = captured.deps as ImplementationRunDependencies;
  const beforeDispatch = vi.mocked(dispatchGhaGapfill).mock.calls.length;
  const beforePrepare = vi.mocked(prepareGhaGapfillLaunch).mock.calls.length;
  // An adopted run without an intent is never a cleanup authorization.
  const adoptedJob = reopened.log.appendLog({ issueId: "issue", issueIdentifier: "ENG-1", repo: "Org/repo", dispatchId: noIntent.dispatchId, status: "running" });
  reopened.log.attachJobRunIdIfMissing(adoptedJob, 999);
  const ownerReleaseCount = releaseOwner.mock.calls.length;
  await expect(noIntentDeps.launch(noIntent)).rejects.toThrow("settlement incomplete");
  expect(releaseOwner).toHaveBeenCalledTimes(ownerReleaseCount);
  expect(reopened.admission.read(noIntent.dispatchId)?.releasedAt).toBeNull();
  expect(recoveryDb.prepare("SELECT revoked_at FROM model_credential_grants WHERE grant_id = 'no-intent-grant'").get()).toEqual({ revoked_at: null });
  recoveryDb.prepare("DELETE FROM dispatch_log WHERE id = ?").run(adoptedJob);
  releaseOwner.mockReturnValueOnce({ status: "rejected", reason: "invalid_state" });
  await expect(noIntentDeps.launch(noIntent)).rejects.toThrow("settlement incomplete");
  expect(reopened.admission.read(noIntent.dispatchId)?.releasedAt).toBeNull();
  expect(recoveryDb.prepare("SELECT revoked_at FROM model_credential_grants WHERE grant_id = 'no-intent-grant'").get()).toEqual({ revoked_at: null });
  expect(reopened.queue.getCommentGapfillLaunch(noIntent.dispatchId)).toBeNull();
  expect(await noIntentDeps.launch(noIntent)).toEqual({ outcome: "rejected" });
  expect(reopened.admission.read(noIntent.dispatchId)?.releasedAt).toBeNull();
  expect(recoveryDb.prepare("SELECT revoked_at FROM model_credential_grants WHERE grant_id = 'no-intent-grant'").get()).toEqual({ revoked_at: expect.any(Number) });
  expect(reopened.queue.getCommentGapfillItem(noIntentId)?.status).toBe("pending");
  expect(dispatchGhaGapfill).toHaveBeenCalledTimes(beforeDispatch);
  expect(prepareGhaGapfillLaunch).toHaveBeenCalledTimes(beforePrepare);
  expect(recoveryDb.prepare("SELECT COUNT(*) AS n FROM model_credential_grants WHERE dispatch_id = 'no-intent'").get()).toEqual({ n: 1 });
  // Accepted/adopted recovery above retained its exact grant despite shared recovery.
  expect(recoveryDb.prepare("SELECT revoked_at FROM model_credential_grants WHERE dispatch_id = 'dispatch'").get()).toEqual({ revoked_at: null });

});

it.each(["unchanged", "missing", "opted-out", "snapshot-before-grant"])("replays real managed preparation after SQLite restart with %s config", async configuration => {
  for (const path of ["../dedup.js", "../dispatch-admission.js", "../log.js", "../comment-gapfill-queue.js", "../agent-run-preparation.js"]) vi.doUnmock(path);
  const database = await testDb({ modules: {
    production: () => import("../restate/implementation-run-production.js"),
    queue: () => import("../comment-gapfill-queue.js"), admission: () => import("../dispatch-admission.js"),
    dedup: () => import("../dedup.js"), config: () => import("../agent-config-store.js"),
    sessions: () => import("../model-session-store.js"), keys: () => import("../model-session-keys.js"),
    ownership: () => import("../model-session-ownership.js"), prep: () => import("../agent-run-preparation.js"),
  } });
  const makeRuntime = (m: typeof database.modules) => {
    const sessionStore = m.sessions.createModelSessionStore({ keys: m.keys.createModelSessionKeyProvider({ RUNNER_TOKEN_SECRET: "synthetic-key" }), verifyOwner: m.ownership.sessionOwnerVerifier, authorizeOperator: () => false });
    const ownership = m.ownership.createModelSessionOwnership({ store: sessionStore, probe: () => "unknown" });
    const credentials = { sessionStore, resolveProtectedSecret: () => "synthetic-api-key" };
    return { sessionStore, ownership, credentials, preparationDeps: () => ({ ownership, credentials,
      readDefaultBranchWorkflows: async () => ({ ".github/workflows/comment-trigger.yml": null, ".github/workflows/claude-kg-refresh.yml": null, ".github/workflows/claude-implement.yml": "# ai-implement-capability: stage-agent-config-v1\n# ai-implement-capability: stage-agent-launch-context-v1" }),
      checkRunnerCapability: async () => true,
    }) };
  };
  const m = database.modules;
  m.config.saveAccountProfileRevision({ profileId: "api", identity: "API", revision: 1, agent: "claude", provider: "anthropic", authMode: "anthropic-api-key", metadata: { credentialRef: "model-account:api" } });
  const stage = { agent: "claude" as const, provider: "anthropic" as const, model: "m", accountProfileId: "api", invocationTimeoutMs: 60000 };
  m.config.setOrchestratorDefaults({ version: 1, mode: "configured", stages: { planning: stage, implementation: stage, review: stage } });
  m.config.setProjectOptIn("ENG", true);
  const actual = await vi.importActual<typeof import("../managed-dispatch-auth.js")>("../managed-dispatch-auth.js");
  const req = { dispatchId: "before-intent", projectKey: "ENG", backend: "github-actions" as const, owner: "Org", repo: "repo", workflowFile: "claude-implement.yml" };
  const initialRuntime = makeRuntime(m);
  if (configuration === "snapshot-before-grant") initialRuntime.credentials.resolveProtectedSecret = () => "";
  const initial = await actual.prepareManagedDispatch(req, initialRuntime);
  if (configuration === "snapshot-before-grant") {
    expect(initial.kind).toBe("refuse");
    const frozen = m.prep.loadStoredSnapshot(req.dispatchId);
    expect(frozen).not.toBeNull();
    expect(m.dedup.getDb().prepare("SELECT * FROM model_credential_grants").all()).toEqual([]);
    m.config.setProjectOptIn("ENG", false);
    const reopened = await database.reopen();
    const managed = await import("../managed-dispatch-auth.js");
    const replay = await vi.importActual<typeof import("../managed-dispatch-auth.js")>("../managed-dispatch-auth.js");
    vi.mocked(managed.isManagedProject).mockImplementation(replay.isManagedProject);
    vi.mocked(managed.prepareManagedDispatch).mockImplementation(replay.prepareManagedDispatch);
    const shared = await vi.importActual<typeof import("../comment-gapfill-drain.js")>("../comment-gapfill-drain.js");
    const runtime = makeRuntime(reopened);
    const admission = reopened.admission.acquire({ dispatchId: req.dispatchId, mappingKey: "ENG", scope: { kind: "pr", issueId: "issue", installationId: "123", repository: "Org/repo", prNumber: 42 }, kind: "gap-fill", backend: "github-actions", lifecycleOwner: { kind: "restate", attemptId: req.dispatchId }, cap: 10 });
    if (!admission.ok) throw new Error("expected admission");
    // A fresh opted-out dispatch still uses legacy credentials, without persisting a snapshot.
    expect(await shared.resolveManagedDecision({ modelAuthRuntime: runtime }, { id: 1 },
      { ...req, dispatchId: "fresh-opted-out" }, admission, "ENG-1")).toEqual({ kind: "legacy" });
    expect(reopened.prep.loadStoredSnapshot("fresh-opted-out")).toBeNull();
    const decision = await shared.resolveManagedDecision({ modelAuthRuntime: runtime }, { id: 1 },
      req, admission, "ENG-1");
    expect(decision?.kind).toBe("launch");
    if (decision?.kind !== "launch") throw new Error("frozen dispatch lost managed selection");
    expect(decision.snapshot).toEqual(frozen);
    expect(decision.takeBootstrap()).toBeDefined();
    expect(reopened.dedup.getDb().prepare("SELECT dispatch_id FROM model_credential_grants").all()).toEqual([{ dispatch_id: req.dispatchId }]);
    expect(prepareGhaGapfillLaunch).not.toHaveBeenCalled();
    expect(dispatchGhaGapfill).not.toHaveBeenCalled();
    return;
  }
  if (initial.kind !== "launch") throw new Error(JSON.stringify(initial));
  expect(initial.takeBootstrap()).toBeDefined();
  expect(initial.takeBootstrap()).toBeUndefined();
  const grantId = initial.grant.grantId;
  const queueItemId = m.queue.enqueueCommentGapfill({ owner: "Org", repo: "repo", prNumber: 42, commentId: 8888, commenter: "human", instruction: "recover" });
  const recoveryRun = { ...run, dispatchId: req.dispatchId, gapFill: { ...run.gapFill!, queueItemId } };
  const reservation = m.admission.acquire({ dispatchId: req.dispatchId, mappingKey: "ENG", scope: { kind: "pr", issueId: "issue", installationId: "123", repository: "Org/repo", prNumber: 42 }, kind: "gap-fill", backend: "github-actions", lifecycleOwner: { kind: "restate", attemptId: req.dispatchId }, cap: 10 });
  expect(reservation.ok).toBe(true);
  expect(m.queue.getCommentGapfillLaunch(req.dispatchId)).toBeNull();
  const reopened = await database.reopen();
  const runtime = makeRuntime(reopened);
  vi.mocked(getModelAuthRuntime).mockReturnValue(runtime);
  const managed = await import("../managed-dispatch-auth.js");
  const replay = await vi.importActual<typeof import("../managed-dispatch-auth.js")>("../managed-dispatch-auth.js");
  vi.mocked(managed.isManagedProject).mockImplementation(replay.isManagedProject);
  vi.mocked(managed.prepareManagedDispatch).mockImplementation(replay.prepareManagedDispatch);
  const shared = await vi.importActual<typeof import("../comment-gapfill-drain.js")>("../comment-gapfill-drain.js");
  vi.mocked(resolveManagedDecision).mockImplementation(shared.resolveManagedDecision);
  // Prove the actual retry returns no credential and cannot create another grant.
  expect(await replay.prepareManagedDispatch(req, runtime)).toEqual({ kind: "hold", code: "bootstrap_consumed" });
  if (configuration === "missing") input.getMapping = () => undefined;
  if (configuration === "opted-out") reopened.config.setProjectOptIn("ENG", false);
  reopened.production.createProductionImplementationRunServices(input);
  const deps = captured.deps as ImplementationRunDependencies;
  const db = reopened.dedup.getDb();
  expect(await deps.findExistingRun(recoveryRun, 1999)).toBeNull();
  db.prepare("UPDATE model_credential_grants SET consumed_at = 1 WHERE grant_id = ?").run(grantId);
  await expect(deps.launch(recoveryRun)).rejects.toThrow("settlement incomplete");
  expect(db.prepare("SELECT revoked_at FROM model_credential_grants WHERE grant_id = ?").get(grantId)).toEqual({ revoked_at: null });
  db.prepare("UPDATE model_credential_grants SET consumed_at = NULL WHERE grant_id = ?").run(grantId);
  db.exec("CREATE TRIGGER fail_revoke BEFORE UPDATE OF revoked_at ON model_credential_grants BEGIN SELECT RAISE(FAIL, 'settlement unavailable'); END");
  await expect(deps.launch(recoveryRun)).rejects.toThrow("settlement unavailable");
  expect(reopened.admission.read(req.dispatchId)?.releasedAt).toBeNull();
  expect(db.prepare("SELECT revoked_at FROM model_credential_grants WHERE grant_id = ?").get(grantId)).toEqual({ revoked_at: null });
  expect(reopened.queue.getCommentGapfillLaunch(req.dispatchId)).toBeNull();
  db.exec("DROP TRIGGER fail_revoke");
  expect(await deps.launch(recoveryRun)).toEqual({ outcome: "rejected" });
  expect(reopened.dedup.getDb().prepare("SELECT grant_id, revoked_at FROM model_credential_grants WHERE dispatch_id = ?").all(req.dispatchId)).toEqual([{ grant_id: grantId, revoked_at: expect.any(Number) }]);
  expect(reopened.admission.read(req.dispatchId)?.releasedAt).toBeNull();
  expect(reopened.queue.getCommentGapfillItem(queueItemId)?.status).toBe("pending");
  expect(reopened.queue.getCommentGapfillLaunch(req.dispatchId)).toBeNull();
  expect(prepareGhaGapfillLaunch).not.toHaveBeenCalled();
  expect(dispatchGhaGapfill).not.toHaveBeenCalled();
});


it("retains definite rejection across process loss before journaling and never resurrects the queue", async () => {
  for (const module of ["../agent-run-preparation.js", "../dedup.js", "../dispatch-admission.js", "../log.js", "../comment-gapfill-queue.js"]) vi.doUnmock(module);
  const database = await testDb({ modules: {
    production: () => import("../restate/implementation-run-production.js"),
    queue: () => import("../comment-gapfill-queue.js"),
    admission: () => import("../dispatch-admission.js"),
    log: () => import("../log.js"),
    dedup: () => import("../dedup.js"),
  } });
  const m = database.modules;
  const queueItemId = m.queue.enqueueCommentGapfill({ owner: "Org", repo: "repo", prNumber: 42, commentId: 1234, commenter: "human", instruction: "COMMENT-SENTINEL" });
  const request = { ...run, gapFill: { ...run.gapFill!, queueItemId } };
  expect(m.admission.acquire({ dispatchId: run.dispatchId, mappingKey: "ENG", scope: { kind: "pr", issueId: "issue", installationId: "123", repository: "Org/repo", prNumber: 42 }, kind: "gap-fill", backend: "github-actions", lifecycleOwner: { kind: "restate", attemptId: run.dispatchId }, cap: 10 }).ok).toBe(true);
  vi.mocked(dispatchGhaGapfill).mockResolvedValueOnce({ success: false, status: 422, outcome: "rejected" });
  vi.mocked(prepareGhaGapfillLaunch).mockImplementationOnce(async () => {
    m.dedup.getDb().prepare("INSERT INTO model_credential_grants (grant_id, dispatch_id, snapshot_id, project_key, backend, audience, bearer_hash, scope_json, expires_at) VALUES ('rejected-grant', ?, 'snapshot', 'ENG', 'gha', 'runner', 'hash', '{}', 9999999999999)").run(run.dispatchId);
    return { contract: "envelope", runnerImage: undefined, inputs: { token: "TOKEN-SENTINEL" } };
  });
  // Settlement fails after the definite response, before a Restate result can be journaled.
  vi.mocked(settleLaunch).mockImplementationOnce(() => { throw new Error("process lost before journal"); });
  m.production.createProductionImplementationRunServices(input);
  await expect((captured.deps as ImplementationRunDependencies).launch(request)).rejects.toThrow("process lost before journal");
  const original = m.queue.getCommentGapfillLaunch(run.dispatchId);
  expect(original).toMatchObject({ rejected: { status: 422 }, target: { owner: "Org", repo: "repo" } });
  const reopened = await database.reopen();
  input.getMapping = () => undefined;
  reopened.production.createProductionImplementationRunServices(input);
  const recovered = captured.deps as ImplementationRunDependencies;
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await recovered.findExistingRun(request, 1000)).toBeNull();
    expect(await recovered.launch(request)).toEqual({ outcome: "rejected" });
    expect(reopened.queue.getCommentGapfillItem(queueItemId)?.status).toBe("failed");
  }
  expect(reopened.dedup.getDb().prepare("SELECT revoked_at FROM model_credential_grants WHERE grant_id = 'rejected-grant'").get()).toEqual({ revoked_at: expect.any(Number) });
  expect(reopened.queue.getCommentGapfillLaunch(run.dispatchId)).toEqual(original);
  expect(reopened.log.getJobByDispatchId(run.dispatchId)).toBeNull();
  expect(prepareGhaGapfillLaunch).toHaveBeenCalledTimes(1);
  expect(resolveManagedDecision).toHaveBeenCalledTimes(1);
  expect(dispatchGhaGapfill).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
  expect(JSON.stringify(reopened.dedup.getDb().prepare("SELECT recovery_json FROM comment_gapfill_launch").all())).not.toMatch(/TOKEN-SENTINEL|NONCE-SENTINEL|COMMENT-SENTINEL/);
});
