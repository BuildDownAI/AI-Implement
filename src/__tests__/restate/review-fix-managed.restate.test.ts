// Managed Codex review-fix on GHA (AII-1444), against the real `restate-server` binary and the *production*
// composition: `createProductionReviewFixServices` (PR coordinator, attempt workflow, SQLite store, finalizer, GitHub
// adapter, `GithubReviewFixWorker` with the protected managed preparation) and a real model-auth runtime. Only the
// external boundaries are synthetic: GitHub's HTTP surface. The dispatch helper is real. It proves the runtime wiring
// ReviewFixPR admission -> protected worker -> authenticated result -> current-head check -> finalizer, that a stale
// head, a cancelled attempt and a late result never approve, that occupancy is held until the run is confirmed
// terminal, and that no grant, bearer, run token or credential reaches a journal value.
//
// Engine evidence, not live-pilot evidence: the live TEST rollout is a separate step after merge.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DispatchInputs } from "../../github.js";
import { __clearWorkflowProbeCacheForTests } from "../../workflow-probe.js";
import { getDb } from "../../dedup.js";
import { getMappings, initMappingsTable, upsertMapping } from "../../config.js";
import { initDispatchBreakerTable } from "../../dispatch-breaker.js";
import { initSettingsTable } from "../../runner-mode.js";
import { initLogTable } from "../../log.js";
import * as profiles from "../../agent-config-store.js";
import { createModelAuthRuntime, type ModelAuthRuntime } from "../../model-auth-runtime.js";
import { createProductionReviewFixServices } from "../../restate/review-fix-production.js";
import { SqliteReviewFixAttemptStore } from "../../review-fix-attempt-store.js";
import { decodeTrustedRunConfig } from "../../run-config.js";
import { upsertReviewFinding } from "../../review-ledger-store.js";
import { enqueueReviewFix } from "../../review-fix-queue.js";
import { recordReviewFixCycleSummary } from "../../review-fix-evidence.js";
import { buildPublicationCycleSummary, readCycleSummaries, writeCycleSummary } from "../../pipeline/cycle-summary.js";
import { DISPOSITIONS_FILE, readFindingDispositions } from "../../pipeline/finding-dispositions.js";
import { handleRunnerCycleSummary, handleRunnerResult, ReviewFixIntakeUnavailableError } from "../../runner-callback.js";
import type { ResultIntakeOutcome, ReviewFixResultMetadataV1, ScopedPrIdentity } from "../../review-fix-contract.js";
import { createReviewFixIngressClient, reviewFixResultForwardKey, reviewFixResultIntakeFromForward } from "../../restate/review-fix-client.js";
import type { ReviewFixAttemptCompletion } from "../../restate/review-fix-attempt.js";
import { makeAppConfig, makeChatGptPlanRecord, makeMapping, makeRegistry, makeReviewFixResult, makeScopedPrIdentity } from "../helpers/builders.js";
import { testDir } from "../helpers/test-dir.js";
import type { RestateEnvironment } from "./harness.js";
import { attachWorkflow, callWorkflow, eventually, journalEntries, journalText, queryInvocations, startRetryEnabled } from "./harness.js";

const SECRET = "SYNTHETIC-managed-token-secret";
const ACCESS = "SYNTHETIC-managed-model-access";
const CONFIG = makeAppConfig({ runnerTokenSecret: SECRET, runnerCallbackBaseUrl: "https://orchestrator.example" });

const state = vi.hoisted(() => ({
  dispatched: [] as Array<Record<string, unknown>>,
  nextRunId: 9_500,
  workflow: "",
  omitRunId: false,
  listed: [] as Array<{ id: number; run_attempt: number; display_title: string; head_branch: string }>,
}));

vi.mock("../../github-app-auth.js", () => ({
  getInstallation: async () => ({ token: "SYNTHETIC-github-token", installationId: 7 }),
  getInstallationToken: async () => "SYNTHETIC-github-token",
  getInstallationId: async () => 7,
  getScopedInstallationToken: async () =>
    (await import("../helpers/builders.js")).makeScopedInstallationToken({ installationId: 7 }),
}));
vi.mock("../../github.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../github.js")>()),
  getDefaultBranchFileText: async (_t: string, _o: string, _r: string, file: string) =>
    file === ".github/workflows/claude-implement.yml" ? state.workflow : null,
  getPullRequestState: async () => ({ state: "open", merged: false }),
}));

const realFetch = globalThis.fetch;
const heads = new Map<number, string>();
const comments = new Map<number, string[]>();
const runs = new Map<number, { status: string; conclusion: string | null }>();
const cancelled: number[] = [];

function sha(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 40);
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** GitHub's HTTP surface for acme/app; everything else (Restate ingress and admin) uses the real fetch. */
const githubFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input as never, init);
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.pathname;
  let m: RegExpExecArray | null;
  if ((m = /\/pulls\/(\d+)$/.exec(path))) {
    const pr = Number(m[1]);
    return json({ state: "open", draft: false, merged: false, mergeable: true, mergeable_state: "clean", head: { sha: heads.get(pr) } });
  }
  if ((m = /\/issues\/(\d+)\/comments$/.exec(path))) {
    const pr = Number(m[1]);
    if (method === "POST") {
      comments.set(pr, [...(comments.get(pr) ?? []), (JSON.parse(String(init?.body ?? "{}")) as { body: string }).body]);
      return json({}, 201);
    }
    return json((comments.get(pr) ?? []).map((body) => ({ body })));
  }
  if (/\/pulls\/\d+\/reviews$/.test(path)) return json([]);
  if (/\/check-runs$/.test(path)) return json({ total_count: 0, check_runs: [] });
  if (/\/commits\/[0-9a-f]{40}\/status$/.test(path)) return json({ state: "success", total_count: 0 });
  if ((m = /\/actions\/runs\/(\d+)\/cancel$/.exec(path))) { cancelled.push(Number(m[1])); return json({}, 202); }
  if ((m = /\/actions\/runs\/(\d+)$/.exec(path))) {
    const run = runs.get(Number(m[1])) ?? { status: "in_progress", conclusion: null };
    return json({ ...run, run_attempt: 1 });
  }
  if (/\/actions\/workflows\//.test(path)) {
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)) as { inputs: DispatchInputs };
      state.dispatched.push(body.inputs as unknown as Record<string, unknown>);
      const runId = state.nextRunId++;
      return state.omitRunId ? new Response(null, { status: 204 }) : json({
        workflow_run_id: runId,
        run_url: `https://api.github.com/repos/acme/app/actions/runs/${runId}`,
        html_url: `https://github.com/acme/app/actions/runs/${runId}`,
      });
    }
    return json({ workflow_runs: state.listed });
  }
  if (path.includes("/contents/.github/workflows/")) {
    return json({ type: "file", encoding: "base64", content: Buffer.from(state.workflow).toString("base64") });
  }
  if (path.includes("/contents/.ai-implement/image.yml")) return new Response(null, { status: 404 });
  return json({ visibility: "private" });
};

function scope(prNumber: number): ScopedPrIdentity {
  return makeScopedPrIdentity({ installationId: 7, repository: "acme/app", prNumber });
}

describe("Restate managed Codex review-fix on GHA: production composition", () => {
  let env: RestateEnvironment;
  let runtime: ModelAuthRuntime;
  let store: SqliteReviewFixAttemptStore;

  beforeAll(async () => {
    vi.stubEnv("RUNNER_TOKEN_SECRET", SECRET);
    vi.stubEnv("RUNNER_MODE", "gha");
    vi.stubGlobal("fetch", githubFetch);
    state.workflow = fs.readFileSync("workflows/claude-implement.yml", "utf8");
    getDb();
    initMappingsTable();
    initDispatchBreakerTable();
    initLogTable();
    initSettingsTable();
    runtime = createModelAuthRuntime({ config: CONFIG, env: { RUNNER_TOKEN_SECRET: SECRET }, fetchImpl: githubFetch });
    profiles.saveAccountProfileRevision({ profileId: "cdx", identity: "cdx", revision: 1, agent: "codex", provider: "openai",
      authMode: "codex-subscription", });
    expect(runtime.sessionStore.writePlanRecord({ profileId: "cdx", expectedSequence: null,
      sessionData: JSON.stringify(makeChatGptPlanRecord({ accessToken: ACCESS })) }).ok).toBe(true);
    const stage = { agent: "codex" as const, provider: "openai" as const, model: "gpt-6-luna", accountProfileId: "cdx", invocationTimeoutMs: 60_000 };
    profiles.setOrchestratorDefaults({ version: 1, mode: "configured", stages: { planning: stage, implementation: stage, review: stage } });
    profiles.setProjectOptIn("AII", true);
    upsertMapping("AII", makeMapping({ owner: "acme", repo: "app", reviewFixLifecycle: "restate" }));
    expect(getMappings().AII?.reviewFixLifecycle).toBe("restate");
    store = new SqliteReviewFixAttemptStore();
    const services = createProductionReviewFixServices(CONFIG, makeRegistry(), store, undefined, runtime);
    env = await startRetryEnabled(services);
  }, 60_000);

  afterAll(async () => {
    await env?.stop();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  /** Seeds one real open finding plus its queue event, then delivers feedback through the real ingress client. */
  async function admit(prNumber: number, findingCount = 1): Promise<{ attemptId: string; prepared: NonNullable<Awaited<ReturnType<typeof store.getPreparedAttempt>>> }> {
    heads.set(prNumber, sha(`head-${prNumber}`));
    const findingIds = Array.from({ length: findingCount }, (_, i) =>
      upsertReviewFinding({ repo: "acme/app", prNumber, source: "review-contract", severity: "medium", body: `finding ${i} for ${prNumber}` }));
    enqueueReviewFix({ issueId: `acme/app#${prNumber}`, issueIdentifier: null, repo: "acme/app", prNumber, reason: "changes_requested",
      findingIds, sourceEventId: `managed-${prNumber}` });
    const out = await createReviewFixIngressClient(env.baseUrl()).feedback(scope(prNumber), undefined, { idempotencyKey: `managed-feedback-${prNumber}` });
    expect(out.status).toBe("accepted");
    const attemptId = await eventually(
      () => (getDb().prepare("SELECT attempt_id AS id FROM review_fix_attempts WHERE repository = ? AND pr_number = ?")
        .get("acme/app", prNumber) as { id: string } | undefined)?.id,
      (id) => id !== undefined, { timeoutMs: 20_000, label: "managed attempt admitted" }) as string;
    const prepared = (await store.getPreparedAttempt(attemptId))!;
    return { attemptId, prepared };
  }

  async function launched(count: number): Promise<{ bearer: string; tokens: string[]; runId: number; config: ReturnType<typeof decodeTrustedRunConfig> }> {
    await eventually(() => state.dispatched.length, (n) => n >= count, { timeoutMs: 20_000, label: "managed dispatch" });
    const inputs = state.dispatched[count - 1];
    const config = decodeTrustedRunConfig(String(inputs.run_config));
    const grant = config.credentials?.modelAuthGrant;
    if (!grant || !("bearer" in grant)) throw new Error("expected a plain GHA model-auth bootstrap");
    const tokens = [config.credentials?.resultToken, config.credentials?.progressToken, config.credentials?.publicationToken]
      .filter((t): t is string => typeof t === "string" && t.length > 0);
    return { bearer: grant.bearer, tokens, runId: state.nextRunId - 1, config };
  }

  function resultFor(prepared: { attemptId: string; scope: ScopedPrIdentity; deadlineAt: number }, runId: number, outputCommit: string): ReviewFixResultMetadataV1 {
    return makeReviewFixResult({ attemptId: prepared.attemptId as ReviewFixResultMetadataV1["attemptId"], ...prepared.scope,
      deadlineAt: prepared.deadlineAt, githubRunId: runId, outputCommit });
  }

  /** The authenticated runner result callback, forwarded over the ingress exactly as `onReviewFixResult` does. */
  async function deliver(resultToken: string, result: ReviewFixResultMetadataV1) {
    const ingress = createReviewFixIngressClient(env.baseUrl());
    return handleRunnerResult({
      authorization: `Bearer ${resultToken}`, secret: SECRET,
      body: { phase: "gap-analysis", outcome: "success", comments: [], reviewFix: result },
      resolveProvider: async () => null,
      onReviewFixResult: async (validated): Promise<ResultIntakeOutcome> => {
        const out = await ingress.result(validated.attemptId, validated, { idempotencyKey: reviewFixResultForwardKey(validated) });
        const outcome = reviewFixResultIntakeFromForward(validated.attemptId, out);
        if (!outcome) throw new ReviewFixIntakeUnavailableError();
        return outcome;
      },
    });
  }

  function recordCycle(prepared: { attemptId: string; findings: ReadonlyArray<{ findingKey: string }> }, commit: string): void {
    expect(recordReviewFixCycleSummary({
      attemptId: prepared.attemptId, cycle: 1, inputCommit: sha("input"), outputCommit: commit,
      dispositions: prepared.findings.map((f) => ({ findingKey: f.findingKey, disposition: "addressed" as const })),
      tests: { passed: 1 }, verdict: "passed", usage: { tokens: 10 }, completedAt: Date.now(),
    }).status).toBe("recorded");
  }

  /** Real producers and callbacks: the feedback-loop summary writer (pre-push, `pending_push`), the validated
   *  dispositions file, the publication builder, then the authenticated `/runner/cycle-summary` intake.
   *  Returns the status of every delivery in order. */
  function streamRunnerEvidence(prepared: { findings: ReadonlyArray<{ findingKey: string }> }, progressToken: string, commit: string,
    opts: { dispositions: "all" | "partial" | "invalid" | "none"; publish?: boolean; deliveries?: number; conflictingPublication?: boolean;
      sourceApproved?: boolean | null; resultOutcome?: "success" | "failure" }): number[] {
    const dir = testDir("rf-evidence");
    writeCycleSummary(dir, { id: "feedback-loop.1", stage: "feedback-loop", cycle: 1, inputCommit: sha("input"), outputCommit: null,
      outputCommitStatus: "pending_push", dispositions: [], tests: [{ name: "test execution", status: "missing" }],
      verdict: { approved: opts.sourceApproved === undefined ? true : opts.sourceApproved, reason: "approved" },
      usage: { tokensIn: 120, tokensOut: 30, costUsd: 0.05 } });
    const keys = prepared.findings.map((f) => f.findingKey);
    const entries = opts.dispositions === "all" ? keys.map((k) => ({ findingKey: k, disposition: "fixed", reason: "done" }))
      : opts.dispositions === "partial" ? keys.slice(0, 1).map((k) => ({ findingKey: k, disposition: "fixed", reason: "done" }))
      : opts.dispositions === "invalid" ? keys.map((k) => ({ findingKey: k, disposition: "bogus", reason: "done" }))
      : null;
    if (entries) {
      fs.mkdirSync(path.join(dir, "ai-output"), { recursive: true });
      fs.writeFileSync(path.join(dir, DISPOSITIONS_FILE), JSON.stringify(entries));
    }
    const pending = readCycleSummaries(dir);
    const publication = opts.publish === false ? null : buildPublicationCycleSummary(pending, commit,
      readFindingDispositions(dir).valid.map((d) => ({ key: d.findingKey, disposition: d.disposition })), opts.resultOutcome ?? "success");
    const batch = [...pending, ...(publication ? [publication] : [])];
    const post = (summary: unknown) => handleRunnerCycleSummary({ authorization: `Bearer ${progressToken}`, secret: SECRET, body: { summary } }).status;
    const statuses = Array.from({ length: opts.deliveries ?? 1 }, () => batch).flat().map(post);
    if (opts.conflictingPublication) {
      // Same immutable identity, different (complete) payload: must be rejected, never merged over the first.
      statuses.push(post(buildPublicationCycleSummary(pending, commit, keys.map((k) => ({ key: k, disposition: "fixed" })), "success")));
    }
    return statuses;
  }

  /** Delivers the authenticated result, marks the run terminal and returns the attempt's completion. */
  async function finish(attemptId: string, prepared: Parameters<typeof resultFor>[0], launch: Awaited<ReturnType<typeof launched>>, commit: string,
    conclusion = "success") {
    await deliver(launch.config.credentials!.resultToken!, resultFor(prepared, launch.runId, commit));
    runs.set(launch.runId, { status: "completed", conclusion });
    return attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", attemptId);
  }

  async function runCase(pr: number, opts: Parameters<typeof streamRunnerEvidence>[3], findingCount = 1) {
    const before = state.dispatched.length;
    const { attemptId, prepared } = await admit(pr, findingCount);
    const launch = await launched(before + 1);
    const commit = heads.get(pr)!;
    const statuses = streamRunnerEvidence(prepared, launch.config.credentials!.progressToken!, commit, opts);
    return { attemptId, prepared, launch, commit, statuses };
  }

  async function journalsOf(attemptId: string, prNumber: number): Promise<string> {
    const admin = env.adminAPIBaseUrl();
    const rows = [
      ...await queryInvocations(admin, `target_service_name = 'ReviewFixAttempt' AND target_service_key = '${attemptId}'`),
      ...await queryInvocations(admin, `target_service_name = 'ReviewFixPR' AND target_service_key LIKE '%${prNumber}%'`),
    ];
    const text: string[] = [];
    for (const row of rows) text.push(journalText(await journalEntries(admin, row.id as string)));
    return text.join("\n");
  }

  const occupancy = (attemptId: string) => (getDb().prepare("SELECT released_at FROM dispatch_admissions WHERE dispatch_id = ?")
    .get(attemptId) as { released_at: number | null } | undefined)?.released_at ?? null;
  const grants = (attemptId: string) => (getDb().prepare("SELECT count(*) AS n FROM model_credential_grants WHERE dispatch_id = ?")
    .get(attemptId) as { n: number }).n;

  it("admits through the PR coordinator, launches the protected worker once, approves only the exact current head, and journals no credential", async () => {
    const before = state.dispatched.length;
    const { attemptId, prepared } = await admit(42);
    const launch = await launched(before + 1);
    expect(state.dispatched).toHaveLength(before + 1);
    // The frozen snapshot is the selected Codex account; the attempt, not a top-level input, carries the run identity.
    expect(launch.config.agentConfig?.stages.implementation.accountProfileId).toBe("cdx");
    expect(launch.config.credentials?.modelAuthContext).toMatchObject({ dispatchId: attemptId, projectKey: "AII", backend: "gha" });
    expect(launch.tokens).toHaveLength(3);
    for (const key of ["run_token", "run_progress_token", "run_publication_token"]) expect(state.dispatched[before][key] ?? "").toBe("");
    expect(grants(attemptId)).toBe(1);
    expect(occupancy(attemptId)).toBeNull();

    // Journals are read while the attempt waits for its result: the launch step is the one that held the bearer.
    const waiting = await journalsOf(attemptId, 42);
    for (const secret of [launch.bearer, ...launch.tokens, ACCESS, SECRET]) expect(waiting).not.toContain(secret);

    const commit = heads.get(42)!;
    recordCycle(prepared, commit);
    expect(await deliver(launch.config.credentials!.resultToken!, resultFor(prepared, launch.runId, commit)))
      .toMatchObject({ status: 200, body: { outcome: "stored" } });
    // The result alone neither approves nor frees the slot: the run must be confirmed terminal first.
    expect(comments.get(42) ?? []).toHaveLength(0);
    expect(occupancy(attemptId)).toBeNull();
    runs.set(launch.runId, { status: "completed", conclusion: "success" });
    const done = await attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", attemptId);
    expect(done).toMatchObject({ status: "finalized", approval: "applied" });
    expect(comments.get(42) ?? []).toHaveLength(1);
    expect(occupancy(attemptId)).not.toBeNull();
    expect(state.dispatched).toHaveLength(before + 1);

    // A result arriving after the final outcome is stale and approves nothing further.
    const late = await callWorkflow<ResultIntakeOutcome>(env.baseUrl(), "ReviewFixAttempt", attemptId, "result",
      resultFor(prepared, launch.runId, sha("late-commit")));
    expect(late.status).toBe("stale");
    expect(comments.get(42) ?? []).toHaveLength(1);

    const finalText = await journalsOf(attemptId, 42);
    for (const secret of [launch.bearer, ...launch.tokens, ACCESS, SECRET]) expect(finalText).not.toContain(secret);
  }, 90_000);

  it("approves the exact pushed head from the real runner evidence adapter, leaves pre-push cycles immutable, and withholds approval on incomplete coverage", async () => {
    const before = state.dispatched.length;
    const { attemptId, prepared } = await admit(50);
    const launch = await launched(before + 1);
    const commit = heads.get(50)!;
    streamRunnerEvidence(prepared, launch.config.credentials!.progressToken!, commit, { dispositions: "all", deliveries: 2 }); // second delivery is idempotent
    const cycles = getDb().prepare("SELECT cycle, output_commit FROM review_fix_cycles WHERE attempt_id = ? ORDER BY cycle").all(attemptId);
    expect(cycles).toEqual([{ cycle: 1, output_commit: null }, { cycle: 50_001, output_commit: commit }]);
    expect(await deliver(launch.config.credentials!.resultToken!, resultFor(prepared, launch.runId, commit)))
      .toMatchObject({ status: 200, body: { outcome: "stored" } });
    runs.set(launch.runId, { status: "completed", conclusion: "success" });
    const done = await attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", attemptId);
    expect(done).toMatchObject({ status: "finalized", approval: "applied" });
    expect(comments.get(50) ?? []).toHaveLength(1);
  }, 90_000);

  const withheld = { status: "finalized", approval: "withheld" };

  it("reproduces TEST-5: pre-push feedback-loop summaries alone leave no output commit or dispositions, and approval is withheld", async () => {
    const c = await runCase(52, { dispositions: "all", publish: false });
    expect(getDb().prepare("SELECT cycle, output_commit FROM review_fix_cycles WHERE attempt_id = ?").all(c.attemptId))
      .toEqual([{ cycle: 1, output_commit: null }]);
    expect(await finish(c.attemptId, c.prepared, c.launch, c.commit)).toMatchObject(withheld);
    expect(comments.get(52) ?? []).toHaveLength(0);
  }, 90_000);

  it("withholds approval when the runner evidence has no dispositions file", async () => {
    const c = await runCase(51, { dispositions: "none" });
    expect(await finish(c.attemptId, c.prepared, c.launch, c.commit)).toMatchObject(withheld);
    expect(comments.get(51) ?? []).toHaveLength(0);
  }, 90_000);

  it("withholds approval when the dispositions cover only part of the admitted findings", async () => {
    const c = await runCase(53, { dispositions: "partial" }, 2);
    expect(c.prepared.findings).toHaveLength(2);
    expect(c.statuses).toEqual([200, 200]);
    expect(await finish(c.attemptId, c.prepared, c.launch, c.commit)).toMatchObject(withheld);
    expect(comments.get(53) ?? []).toHaveLength(0);
  }, 90_000);

  it("withholds approval when every disposition is invalid and dropped by the validator", async () => {
    const c = await runCase(54, { dispositions: "invalid" });
    expect(getDb().prepare("SELECT cycle, output_commit FROM review_fix_cycles WHERE attempt_id = ? ORDER BY cycle").all(c.attemptId))
      .toEqual([{ cycle: 1, output_commit: null }, { cycle: 50_001, output_commit: c.commit }]);
    expect(await finish(c.attemptId, c.prepared, c.launch, c.commit)).toMatchObject(withheld);
    expect(comments.get(54) ?? []).toHaveLength(0);
  }, 90_000);

  it("keeps the first-recorded publication when a conflicting same-identity record arrives, so approval stays withheld", async () => {
    const c = await runCase(55, { dispositions: "none", conflictingPublication: true });
    expect(c.statuses).toEqual([200, 200, 409]);
    expect(await finish(c.attemptId, c.prepared, c.launch, c.commit)).toMatchObject(withheld);
    expect(comments.get(55) ?? []).toHaveLength(0);
  }, 90_000);

  it("never approves after a push failure: no publication is built and a failed run is not a success", async () => {
    const before = state.dispatched.length;
    const { attemptId, prepared } = await admit(56);
    const launch = await launched(before + 1);
    expect(buildPublicationCycleSummary([], null, [], "success")).toBeNull();
    streamRunnerEvidence(prepared, launch.config.credentials!.progressToken!, heads.get(56)!, { dispositions: "all", publish: false });
    runs.set(launch.runId, { status: "completed", conclusion: "failure" });
    const done = await attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", attemptId);
    expect(done).toMatchObject({ status: "finalized", approval: "not_applicable" });
    expect(getDb().prepare("SELECT cycle, output_commit FROM review_fix_cycles WHERE attempt_id = ?").all(attemptId))
      .toEqual([{ cycle: 1, output_commit: null }]);
    expect(comments.get(56) ?? []).toHaveLength(0);
  }, 90_000);

  it("withholds approval when the native review rejected the change, even with fixed dispositions and a pushed commit", async () => {
    const c = await runCase(70, { dispositions: "all", sourceApproved: false });
    const done = await finish(c.attemptId, c.prepared, c.launch, c.commit);
    expect(done).toMatchObject({ status: "finalized" });
    expect(done).not.toMatchObject({ approval: "applied" });
    expect(comments.get(70) ?? []).toHaveLength(0);
    expect(getDb().prepare("SELECT count(*) AS n FROM review_fix_cycles WHERE attempt_id = ? AND output_commit IS NOT NULL").get(c.attemptId))
      .toEqual({ n: 0 });
  }, 90_000);

  it("withholds approval when the PR head moved after the evidence was published", async () => {
    const c = await runCase(57, { dispositions: "all" });
    heads.set(57, sha("someone-pushed"));
    // The observed head no longer equals the accepted result's commit, so the attempt is not a success to approve.
    expect(await finish(c.attemptId, c.prepared, c.launch, c.commit)).toMatchObject({ status: "finalized", approval: "not_applicable" });
    expect(comments.get(57) ?? []).toHaveLength(0);
  }, 90_000);

  it("withholds approval when the attempt's authority was revoked", async () => {
    const c = await runCase(58, { dispositions: "all" });
    await store.revokeAuthority(c.attemptId as never, Date.now());
    const done = await finish(c.attemptId, c.prepared, c.launch, c.commit);
    expect(done).toMatchObject({ status: "finalized" });
    expect((done as { approval: string }).approval).not.toBe("applied");
    expect(comments.get(58) ?? []).toHaveLength(0);
  }, 90_000);

  it("keeps the model-auth grant for an accepted 204 with no run id, reconciles the exact run, and finalizes", async () => {
    const before = state.dispatched.length;
    state.omitRunId = true;
    let attemptId: string; let prepared: Awaited<ReturnType<typeof admit>>["prepared"];
    try { ({ attemptId, prepared } = await admit(46)); await eventually(() => state.dispatched.length, (n) => n >= before + 1, { timeoutMs: 20_000, label: "managed dispatch" }); }
    finally { state.omitRunId = false; }
    const runId = state.nextRunId - 1;
    const launch = await launched(before + 1);
    // GitHub accepted the launch but returned no identity: the grant survives, nothing was dispatched twice.
    expect(grants(attemptId)).toBe(1);
    expect(getDb().prepare("SELECT count(*) AS n FROM model_credential_grants WHERE dispatch_id = ? AND revoked_at IS NOT NULL").get(attemptId)).toEqual({ n: 0 });
    expect(occupancy(attemptId)).toBeNull();
    // GitHub titles the run from the workflow's run-name: the dispatched identifier, then the attempt.
    state.listed = [{ id: runId, run_attempt: 1, head_branch: "main",
      display_title: `Claude AI Implementation — ${String(launch.config.issue.identifier)} · attempt ${attemptId}` }];

    const { createModelAuthRoutes } = await import("../../model-auth-routes.js");
    const routes = createModelAuthRoutes({ runtime, onFly: false, requestPlanRefresh: async () => {} });
    const http = await import("node:http");
    const server = http.createServer((req, res) => { void routes.handle(req, res); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const response = await realFetch(`http://127.0.0.1:${port}/runner/model-auth/checkout`, {
        method: "POST", headers: { authorization: `Bearer ${launch.bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ version: 1, profileId: "cdx" }),
      });
      expect(response.status).toBe(200);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }

    const commit = heads.get(46)!;
    recordCycle(prepared, commit);
    await eventually(async () => (await deliver(launch.config.credentials!.resultToken!, resultFor(prepared, runId, commit))).body,
      (body) => (body as { outcome?: string }).outcome === "stored", { timeoutMs: 30_000, label: "result stored after reconcile" });
    runs.set(runId, { status: "completed", conclusion: "success" });
    const done = await attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", attemptId);
    expect(done).toMatchObject({ status: "finalized", approval: "applied" });
    expect(occupancy(attemptId)).not.toBeNull();
    expect(state.dispatched).toHaveLength(before + 1);
    state.listed = [];
    const text = await journalsOf(attemptId, 46);
    for (const secret of [launch.bearer, ...launch.tokens, ACCESS, SECRET]) expect(text).not.toContain(secret);
  }, 120_000);

  it("withholds approval when the PR head moved after the accepted result", async () => {
    const before = state.dispatched.length;
    const { attemptId, prepared } = await admit(43);
    const launch = await launched(before + 1);
    const commit = heads.get(43)!;
    recordCycle(prepared, commit);
    expect(await deliver(launch.config.credentials!.resultToken!, resultFor(prepared, launch.runId, commit)))
      .toMatchObject({ status: 200, body: { outcome: "stored" } });
    heads.set(43, sha("moved-head"));
    runs.set(launch.runId, { status: "completed", conclusion: "success" });
    const done = await attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", attemptId);
    expect(done.status).toBe("finalized");
    expect(done).not.toMatchObject({ approval: "applied" });
    expect(comments.get(43) ?? []).toHaveLength(0);
    expect(occupancy(attemptId)).not.toBeNull();
  }, 90_000);

  it("a cancelled attempt revokes authority, holds occupancy until the run is terminal, and a late result never approves", async () => {
    const before = state.dispatched.length;
    const { attemptId, prepared } = await admit(44);
    const launch = await launched(before + 1);
    await callWorkflow(env.baseUrl(), "ReviewFixAttempt", attemptId, "cancel", { attemptId });
    await eventually(() => cancelled.includes(launch.runId), Boolean, { timeoutMs: 10_000, label: "run cancel requested" });
    const revoked = getDb().prepare("SELECT authority_revoked_at FROM review_fix_attempts WHERE attempt_id = ?").get(attemptId) as { authority_revoked_at: number | null };
    expect(revoked.authority_revoked_at).not.toBeNull();
    expect(occupancy(attemptId)).toBeNull(); // the backend has not confirmed the stop yet

    const commit = heads.get(44)!;
    recordCycle(prepared, commit);
    const late = await deliver(launch.config.credentials!.resultToken!, resultFor(prepared, launch.runId, commit));
    expect(late.body).not.toMatchObject({ outcome: "stored" });
    expect(occupancy(attemptId)).toBeNull();

    runs.set(launch.runId, { status: "completed", conclusion: "cancelled" });
    const done = await attachWorkflow<ReviewFixAttemptCompletion>(env.baseUrl(), "ReviewFixAttempt", attemptId);
    expect(done).toMatchObject({ status: "finalized", approval: "not_applicable" });
    expect(comments.get(44) ?? []).toHaveLength(0);
    expect(occupancy(attemptId)).not.toBeNull();
    expect(state.dispatched).toHaveLength(before + 1);
    const text = await journalsOf(attemptId, 44);
    for (const secret of [launch.bearer, ...launch.tokens, ACCESS]) expect(text).not.toContain(secret);
  }, 90_000);

  it("fails the queue row and dispatches nothing when the managed template lacks attempt transport", async () => {
    const dispatchedBefore = state.dispatched.length;
    const good = state.workflow;
    state.workflow = good.replace(/^(\s{2,})run_attempt_token:\s*$/m, "$1renamed_input:");
    expect(state.workflow).not.toBe(good);
    __clearWorkflowProbeCacheForTests(); // the probe caches a capable template for minutes
    try {
      heads.set(45, sha("head-45"));
      const findingId = upsertReviewFinding({ repo: "acme/app", prNumber: 45, source: "review-contract", severity: "medium", body: "finding for 45" });
      const queueId = enqueueReviewFix({ issueId: "acme/app#45", issueIdentifier: null, repo: "acme/app", prNumber: 45,
        reason: "changes_requested", findingIds: [findingId], sourceEventId: "managed-45" });
      expect((await createReviewFixIngressClient(env.baseUrl()).feedback(scope(45), undefined, { idempotencyKey: "managed-feedback-45" })).status).toBe("accepted");
      await eventually(
        () => (getDb().prepare("SELECT status FROM review_fix_queue WHERE id = ?").get(queueId) as { status: string }).status,
        (status) => status === "failed", { timeoutMs: 20_000, label: "queue row failed" });
      expect(getDb().prepare("SELECT count(*) AS n FROM review_fix_attempts WHERE pr_number = 45").get()).toEqual({ n: 0 });
      expect(state.dispatched).toHaveLength(dispatchedBefore);
    } finally { state.workflow = good; __clearWorkflowProbeCacheForTests(); }
  }, 60_000);
});
