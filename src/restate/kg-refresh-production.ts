/** Production composition for the `KgRepo` / `KgRefresh` services (AII-895), plus the
 * ingress client the runner callback and the admin cancel path use to reach the
 * `KgRefresh` workflow from outside a Restate handler. Sibling of
 * `review-fix-production.ts` and `review-fix-client.ts`. `src/index.ts` composes and registers
 * the services; this file is the allowed SDK boundary where the orchestrator's existing
 * kg-refresh closures become Restate services. */
import * as restateClients from "@restatedev/restate-sdk-clients";
import { getMappings } from "../config.js";
import { getDb } from "../dedup.js";
import type { AppConfig } from "../index.js";
import {
  CANARY_DEADLINE_MS,
  CANARY_RETRY_MS,
  DATA_ROOT,
  SIDECAR_MCP_URL,
  defaultFreeBytes,
  defaultLoadSnapshotSha,
  defaultPersistSnapshotSha,
  type PreflightCheckResult,
  type RefreshOutcome,
} from "../kg-refresh.js";
import type { KgRailDeps } from "../kg-refresh-rail.js";
import { KG_DIR } from "../kg-sidecar.js";
import { parseKgSourceRepo } from "../deploy.js";
import { buildKgRefreshGhaDispatchBody, postWorkflowDispatch } from "../github.js";
import { resolveWorkflowCapabilities } from "../workflow-probe.js";
import { resolveRunnerImageForDispatch } from "../repo-image.js";
import { encodeRunConfig, type RunConfigV1 } from "../run-config.js";
import { getRunnerMode, resolveExecutionPath } from "../runner-mode.js";
import { mintRunToken } from "../runner-tokens.js";
import type { JobStatus } from "../log.js";
import { appendLogIfAbsent, findLogIdByDispatchId, updateJobMachineDetails, updateJobPrUrl, updateJobRunId } from "../log.js";
import type { RestateService } from "./endpoint.js";
import {
  createKgRefreshWorkflow,
  type KgDispatchInput,
  type KgDispatchResult,
  type KgRefreshReportBody,
  type KgRefreshStatusResult,
  type KgRefreshWorkflowDependencies,
} from "./kg-refresh-workflow.js";
import { createKgRepo, type KgRepoEnqueueInput, type KgRepoEnqueueResult, type KgRepoPrInput, type KgRepoTriggerResult, type StoredDryRunOutcome } from "./kg-repo.js";
import type { KgRefreshDefinition, KgRepoDefinition } from "./kg-refresh-types.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";

/** Workflow file dispatched in the KG source repo (same value as `KG_REFRESH_WORKFLOW_FILE` in `src/index.ts`). */
const KG_REFRESH_WORKFLOW_FILE = "claude-implement.yml";
const GHA_EXECUTION_MODE = "github-actions";

type LegacyDispatch = (opts: {
  runToken: string;
  runProgressToken: string;
  dispatchId: string;
  runConfig: string;
  executionPath?: string;
}) => Promise<{ machineId?: string; machineNonce?: string; logsUrl?: string; workflowRunId?: number }>;

export interface KgDispatchDetails {
  machineId?: string;
  machineNonce?: string;
  logsUrl?: string;
  workflowRunId?: number;
}

/**
 * Writes a kg-refresh dispatch's machine and run details onto its job row (legacy `updateJobMachine`):
 * the machine nonce wins, else the logs URL, plus the run id. A dispatch id with no row is a no-op.
 */
export function recordKgDispatchDetails(dispatchId: string, d: KgDispatchDetails): void {
  const jobId = findLogIdByDispatchId(dispatchId);
  if (jobId === undefined) return;
  if (d.machineNonce) updateJobMachineDetails(jobId, { machineNonce: d.machineNonce, machineId: d.machineId, logsUrl: d.logsUrl });
  else if (d.logsUrl) updateJobPrUrl(jobId, d.logsUrl);
  if (d.workflowRunId !== undefined) updateJobRunId(jobId, d.workflowRunId);
}

export interface KgRefreshProductionInput {
  kgSourceRepo: string;
  config: Pick<AppConfig,
    "githubAppId" | "githubAppPrivateKey" | "sessionImage" | "runnerImageExplicit"
    | "runnerCallbackBaseUrl" | "runnerTokenSecret">;
  mintToken: KgRailDeps["mintToken"];
  fetchTarball: KgRailDeps["fetchTarball"];
  fetchDefaultBranch: KgRailDeps["fetchDefaultBranch"];
  fetchSnapshotCommitSha: KgRailDeps["fetchSnapshotCommitSha"];
  materialize: KgRailDeps["materialize"];
  mcpToolCall: KgRailDeps["mcpToolCall"];
  sidecar: KgRailDeps["sidecar"];
  postPrCommentFn: KgRailDeps["postPrCommentFn"];
  postOrUpdateStickyCommentFn: KgRailDeps["postOrUpdateStickyCommentFn"];
  setCommitStatusFn: KgRailDeps["setCommitStatusFn"];
  mergePullRequestFn: KgRailDeps["mergePullRequestFn"];
  closePullRequestFn: KgRailDeps["closePullRequestFn"];
  deleteBranchFn: KgRailDeps["deleteBranchFn"];
  /** The legacy dispatcher (`dispatchKgRefreshRun` in `src/index.ts`). Used only when the
   *  resolved execution path is not GitHub Actions; the GHA path is dispatched by this
   *  module so it can request `return_run_details`. */
  dispatchKgRefreshRun: LegacyDispatch;
  /** Probes the KG source repo's dispatch workflow for `run_publication_token` support. Defaults to `resolveWorkflowCapabilities`. */
  resolveWorkflowCapabilities?: typeof resolveWorkflowCapabilities;
  updateJobStatus: (jobId: number, status: JobStatus, conclusion?: string | null) => void;
  /** Writes the backend's machine and run details onto the job row for `dispatchId` (a missing row is a no-op).
   *  Called inside the dispatch closure so `machineNonce` reaches SQLite and never the journal. */
  recordDispatch: (dispatchId: string, details: KgDispatchDetails) => void;
  /** Recovers the dispatch_log id after a restart (journaled `reserve` does not re-run).
   *  Defaults to a `dispatch_log.dispatch_id` lookup. */
  findJobId?: (dispatchId: string) => number | undefined;
  /** Already bound to the KG source repo (the workflow only knows a run id). */
  getWorkflowRunStatus: KgRefreshWorkflowDependencies["getWorkflowRunStatus"];
  findRunByTitle: KgRefreshWorkflowDependencies["findRunByTitle"];
  /** Defaults to a `settings` row per run id (`runWatchKey`). */
  registerRunWatch?: KgRefreshWorkflowDependencies["registerRunWatch"];
  forgetRunWatch?: KgRefreshWorkflowDependencies["forgetRunWatch"];
  cancelWorkflowRun: KgRefreshWorkflowDependencies["cancelWorkflowRun"];
  persistLastRefresh: (outcome: RefreshOutcome) => void;
  /** `handleKgRefreshOutcome` with `config` and the provider registry already applied. */
  handleKgRefreshOutcome: (
    outcome: "success" | "no-new-data" | "failure",
    data: { failureCode?: string; failureReason?: string; dispatchId?: string; timedOut?: boolean },
  ) => void | Promise<void>;
  isDeployHeld: () => boolean;
  readStatusRecord: () => RefreshOutcome | null;
  runPreflight: () => Promise<PreflightCheckResult>;
}

/** What the two tool handlers in `src/restate/tools.ts` read once AII-683 lands. */
export interface KgRefreshToolDeps {
  kgSourceRepo: string;
  isDeployHeld: () => boolean;
  /** True when both the runner callback URL and the token secret are set. */
  callbackConfigured: () => boolean;
  /** True when a project mapping exists for the KG source repo. */
  mappingExists: () => boolean;
  /** Free bytes on the KG data volume. */
  freeBytes: () => number;
  runPreflight: () => Promise<PreflightCheckResult>;
  /** Records a failed preflight as the last refresh, as `trigger()` does today. */
  persistPreflightFailure: (result: PreflightCheckResult) => void;
  readStatusRecord: () => RefreshOutcome | null;
}

function findKgMapping(kgSourceRepo: string) {
  return Object.entries(getMappings()).find(([, m]) => `${m.owner}/${m.repo}` === kgSourceRepo);
}

/** The execution mode a kg-refresh dispatch resolves to under the current runner mode.
 *  `createKgRefreshDispatch` acts on it and `appendJobLog` records it, so both read one answer. */
export function resolveKgExecutionMode(): string {
  const { mode } = getRunnerMode();
  const resolved = resolveExecutionPath(mode, GHA_EXECUTION_MODE);
  return resolved === "both" ? GHA_EXECUTION_MODE : resolved;
}

/** Builds the GHA-first dispatch the workflow calls inside `ctx.run`. */
export function createKgRefreshDispatch(input: KgRefreshProductionInput): (dispatch: KgDispatchInput) => Promise<KgDispatchResult> {
  const { config } = input;
  const repo = parseKgSourceRepo(input.kgSourceRepo);
  return async ({ runConfig, tokens, issueIdentifier, dispatchId }) => {
    const executionMode = resolveKgExecutionMode();
    const mapping = findKgMapping(input.kgSourceRepo)?.[1];
    const envelope: RunConfigV1 = {
      v: 1,
      issue: { id: "kg-refresh", identifier: issueIdentifier, title: "KG ingest", description: "" },
      runnerPhase: "kg-refresh",
      kgSourceRepo: input.kgSourceRepo,
      ...(config.runnerCallbackBaseUrl ? { runnerCallbackUrl: config.runnerCallbackBaseUrl } : {}),
      ...(mapping?.dependencyTokenScope != null ? { dependencyTokenScope: mapping.dependencyTokenScope } : {}),
      ...(runConfig.dryRun ? { kgDryRun: true as const } : {}),
      ...(runConfig.kgSourceRef ? { kgSourceRef: runConfig.kgSourceRef } : {}),
      ...(runConfig.acceptNewBaseline ? { kgAcceptNewBaseline: true as const } : {}),
      ...(runConfig.actorEmail ? { kgBaselineActor: runConfig.actorEmail } : {}),
    };
    const encoded = encodeRunConfig(envelope);

    if (executionMode !== GHA_EXECUTION_MODE) {
      const legacy = await input.dispatchKgRefreshRun({
        runToken: tokens.runToken, runProgressToken: tokens.progressToken,
        dispatchId, runConfig: encoded, executionPath: executionMode,
      });
      input.recordDispatch(dispatchId, {
        machineId: legacy.machineId, machineNonce: legacy.machineNonce,
        logsUrl: legacy.logsUrl, workflowRunId: legacy.workflowRunId,
      });
      // The nonce authenticates the machine to /api/token: it goes to the row above, never into the journaled result.
      return { outcome: "accepted", runId: legacy.workflowRunId, runUrl: legacy.logsUrl,
        jobId: legacy.machineId ?? null, executionMode };
    }

    const { token } = await input.mintToken(config.githubAppId, config.githubAppPrivateKey, repo.owner);
    const defaultBranch = await input.fetchDefaultBranch(token, repo.owner, repo.repo).catch(() => "main");
    const runnerImage = await resolveRunnerImageForDispatch({
      owner: repo.owner, repo: repo.repo, token,
      defaultImage: config.sessionImage, runnerImageExplicit: config.runnerImageExplicit,
    });
    const ref = runConfig.kgSourceRef ?? defaultBranch;
    const { supportsRunPublicationToken } = await (input.resolveWorkflowCapabilities ?? resolveWorkflowCapabilities)({
      owner: repo.owner, repo: repo.repo, workflowFile: KG_REFRESH_WORKFLOW_FILE, token, ref,
    });
    const inputs = buildKgRefreshGhaDispatchBody({
      runConfig: encoded, runToken: tokens.runToken, runProgressToken: tokens.progressToken,
      ...(supportsRunPublicationToken ? { runPublicationToken: tokens.publicationToken } : {}),
      runnerImage, runnerCallbackUrl: config.runnerCallbackBaseUrl ?? undefined,
      runnerPhase: "kg-refresh", jobTimeoutMinutes: "240", issueIdentifier,
    });
    const result = await postWorkflowDispatch({
      token, owner: repo.owner, repo: repo.repo, workflowFile: KG_REFRESH_WORKFLOW_FILE,
      ref, inputs, returnRunDetails: true,
    });
    if (result.runId !== undefined) {
      input.recordDispatch(dispatchId, { workflowRunId: result.runId, logsUrl: result.runUrl });
    }
    return {
      outcome: result.outcome ?? (result.success ? "accepted" : "unknown"),
      runId: result.runId,
      runUrl: result.runUrl,
      // The GitHub run id once known; the workflow keys its own job row by dispatch id.
      jobId: result.runId !== undefined ? String(result.runId) : null,
      executionMode,
    };
  };
}

// ---------------------------------------------------------------------------
// Run watch: GitHub run id -> awakeable id, for the `workflow_run` webhook
// ---------------------------------------------------------------------------

const runWatchKey = (runId: number) => `kg-refresh-run-watch:${runId}`;

/** Idempotent upsert — the workflow journals the call, but a retry may repeat it. */
export function registerRunWatch({ runId, awakeableId }: { runId: number; awakeableId: string }): void {
  getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(runWatchKey(runId), awakeableId);
}

export function lookupRunWatch(runId: number): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(runWatchKey(runId)) as { value: string } | undefined;
  return row?.value ?? null;
}

export function forgetRunWatch(runId: number): void {
  getDb().prepare("DELETE FROM settings WHERE key = ?").run(runWatchKey(runId));
}

/** Resolves the awakeable over the loopback ingress; the delivery id is the idempotency key. Never throws. */
export async function resolveRunWatchAwakeable(
  awakeableId: string,
  conclusion: string | null,
  idempotencyKey?: string,
  deps: { baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<"resolved" | "gone" | "failed"> {
  try {
    const res = await (deps.fetchImpl ?? fetch)(
      `${deps.baseUrl ?? RESTATE_INGRESS_BASE_URL}/restate/awakeables/${encodeURIComponent(awakeableId)}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
        body: JSON.stringify({ conclusion }),
        signal: AbortSignal.timeout(deps.timeoutMs ?? INGRESS_TIMEOUT_MS),
      },
    );
    if (res.ok) return "resolved";
    return res.status === 404 || res.status === 409 ? "gone" : "failed";
  } catch {
    return "failed";
  }
}

export function createProductionKgRefreshServices(
  input: KgRefreshProductionInput,
): { services: RestateService[]; toolDeps: KgRefreshToolDeps } {
  const { config } = input;
  const freeBytes = () => defaultFreeBytes(DATA_ROOT);

  const rail: KgRailDeps = {
    sidecar: input.sidecar,
    githubAppId: config.githubAppId,
    githubAppPrivateKey: config.githubAppPrivateKey,
    kgSourceRepo: input.kgSourceRepo,
    dataRoot: DATA_ROOT,
    kgDir: KG_DIR,
    sidecarMcpUrl: SIDECAR_MCP_URL,
    canaryDeadlineMs: CANARY_DEADLINE_MS,
    canaryRetryMs: CANARY_RETRY_MS,
    mintToken: input.mintToken,
    fetchTarball: input.fetchTarball,
    fetchDefaultBranch: input.fetchDefaultBranch,
    fetchSnapshotCommitSha: input.fetchSnapshotCommitSha,
    materialize: input.materialize,
    mcpToolCall: input.mcpToolCall,
    persistSnapshotSha: defaultPersistSnapshotSha,
    loadSnapshotSha: defaultLoadSnapshotSha,
    mergePullRequestFn: input.mergePullRequestFn,
    closePullRequestFn: input.closePullRequestFn,
    deleteBranchFn: input.deleteBranchFn,
    postPrCommentFn: input.postPrCommentFn,
    postOrUpdateStickyCommentFn: input.postOrUpdateStickyCommentFn,
    setCommitStatusFn: input.setCommitStatusFn,
  };

  // dispatch_log ids are numeric; the workflow keys its row by dispatch id string.
  const jobIds = new Map<string, number>();
  const findJobId = input.findJobId ?? findLogIdByDispatchId;

  const deps: KgRefreshWorkflowDependencies = {
    rail,
    kgSourceRepo: input.kgSourceRepo,
    mintRunTokens: ({ dispatchId, ttlSeconds }) => {
      if (!config.runnerTokenSecret) throw new Error("RUNNER_TOKEN_SECRET is not configured");
      const mappingTeamKey = findKgMapping(input.kgSourceRepo)?.[0];
      if (mappingTeamKey === undefined) throw new Error(`no project mapping found for kgSourceRepo=${input.kgSourceRepo}`);
      // Idempotent across processes: a replay after a crash before the dispatch step journaled re-mints for the same
      // dispatch id, so clear any unconsumed rows first (the primary key is (dispatch_id, audience)).
      getDb().prepare("DELETE FROM runner_tokens WHERE dispatch_id = ? AND consumed_at IS NULL").run(dispatchId);
      const base = { issueId: "kg-refresh", mappingTeamKey, phase: "kg-refresh" as const, dispatchId, ttlSeconds, secret: config.runnerTokenSecret };
      return {
        runToken: mintRunToken({ ...base, audience: "result" }).token,
        progressToken: mintRunToken({ ...base, audience: "progress" }).token,
        publicationToken: mintRunToken({ ...base, audience: "publication", repository: input.kgSourceRepo }).token,
      };
    },
    dispatch: createKgRefreshDispatch(input),
    // Idempotent on dispatch_id: a replay after a crash between the insert and the journal write reuses the row.
    appendJobLog: ({ dispatchId }) => {
      const id = appendLogIfAbsent({
        issueId: "kg-refresh", phase: "kg-refresh", dispatchId, executionMode: resolveKgExecutionMode(),
        repo: parseKgSourceRepo(input.kgSourceRepo).fullName,
      });
      jobIds.set(dispatchId, id);
      return id;
    },
    closeJobLog: (jobId, status, conclusion) => {
      const id = jobIds.get(jobId) ?? findJobId(jobId);
      if (id === undefined) return;
      jobIds.delete(jobId);
      input.updateJobStatus(id, status, conclusion);
    },
    getWorkflowRunStatus: input.getWorkflowRunStatus,
    findRunByTitle: input.findRunByTitle,
    registerRunWatch: input.registerRunWatch ?? registerRunWatch,
    forgetRunWatch: input.forgetRunWatch ?? forgetRunWatch,
    cancelWorkflowRun: input.cancelWorkflowRun,
    persistLastRefresh: input.persistLastRefresh,
    onOutcome: (kind, outcome) => {
      // The workflow reports "graph is current" as a success; the notifier distinguishes it.
      const mapped = kind === "success" && /^Graph is current/i.test(outcome.detail) ? "no-new-data" : kind;
      // Returned so the workflow's `outcome` step awaits (and retries) the notification.
      return Promise.resolve(input.handleKgRefreshOutcome(mapped, kind === "failure" ? { failureReason: outcome.detail } : {}));
    },
  };

  const toolDeps: KgRefreshToolDeps = {
    kgSourceRepo: input.kgSourceRepo,
    isDeployHeld: input.isDeployHeld,
    callbackConfigured: () => Boolean(config.runnerCallbackBaseUrl && config.runnerTokenSecret),
    mappingExists: () => findKgMapping(input.kgSourceRepo) !== undefined,
    freeBytes,
    runPreflight: input.runPreflight,
    persistPreflightFailure: (result) => {
      input.persistLastRefresh({
        ok: false,
        at: result.checkedAt,
        gate: "preflight",
        detail: result.results
          .filter((r) => !r.ok)
          .map((r) => `${r.repo} — ${r.grant} — HTTP ${r.status}${r.hint ? ` — ${r.hint}` : ""}`)
          .join("\n"),
        stampBefore: null,
        stampAfter: null,
      });
    },
    readStatusRecord: input.readStatusRecord,
  };

  return {
    services: [createKgRepo({ workflowName: "KgRefresh" }), createKgRefreshWorkflow(deps)],
    toolDeps,
  };
}

// ---------------------------------------------------------------------------
// Ingress client
// ---------------------------------------------------------------------------

/** `accepted` carries the handler's JSON result when it returned one (an empty 2xx body has none). */
export type KgIngressResult<T = undefined> =
  | { readonly status: "accepted"; readonly value?: T }
  | { readonly status: "conflict" }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

export interface KgRefreshIngressClient {
  report(triggerId: string, body: KgRefreshReportBody, opts?: { idempotencyKey?: string }): Promise<KgIngressResult<{ status: "accepted" | "duplicate" }>>;
  progress(triggerId: string): Promise<KgIngressResult>;
  cancel(triggerId: string, reason: string): Promise<KgIngressResult>;
  status(triggerId: string): Promise<KgIngressResult<KgRefreshStatusResult>>;
  repoStatus(slug: string): Promise<KgIngressResult<{ triggerId: string; startedAt: number } | null>>;
  /** Hands a PR-check dry-run to the `KgRepo` object: it runs now (`{ triggerId }`) or is held (`{ queued }`). */
  enqueueDryRun(
    slug: string,
    entry: KgRepoEnqueueInput,
    opts?: { idempotencyKey?: string },
  ): Promise<Exclude<KgIngressResult<KgRepoEnqueueResult>, { readonly status: "not-found" }>>;
  /** The stored dry-run verdict for a PR; `accepted` with `value: null` when none is held. */
  dryRunOutcome(slug: string, pr: KgRepoPrInput): Promise<KgIngressResult<StoredDryRunOutcome | null>>;
  /** Drops a closed PR's verdict and held dry-run head. */
  forgetPr(slug: string, pr: KgRepoPrInput): Promise<KgIngressResult>;
}

export interface KgRefreshIngressClientDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const INGRESS_TIMEOUT_MS = 10_000;

/** Real client for the Restate ingress, on the SDK's typed client. Never throws: a connection error or timeout resolves `unavailable`. */
export function createKgRefreshIngressClient(
  baseUrl: string = RESTATE_INGRESS_BASE_URL,
  deps: KgRefreshIngressClientDeps = {},
): KgRefreshIngressClient {
  const ingress = restateClients.connect({ url: baseUrl, ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}) });
  const timeout = deps.timeoutMs ?? INGRESS_TIMEOUT_MS;
  const callOpts = <I, O>(idempotencyKey?: string) => restateClients.rpc.opts<I, O>({ timeout, ...(idempotencyKey ? { idempotencyKey } : {}) });

  const refresh = (triggerId: string) => ingress.workflowClient<KgRefreshDefinition>({ name: "KgRefresh" }, triggerId);
  const repo = (slug: string) => ingress.objectClient<KgRepoDefinition>({ name: "KgRepo" }, slug);

  /** 404 is `not-found` for the workflow only; 409 is `conflict` where the caller asked for it. */
  async function invoke<T = undefined>(
    call: () => PromiseLike<unknown>,
    statuses: { notFound?: boolean; conflict?: boolean } = {},
  ): Promise<KgIngressResult<T>> {
    try {
      const value = await call();
      // `T` is the caller's declared result; a handler returning nothing yields no `value`.
      return value === undefined ? { status: "accepted" } : { status: "accepted", value: value as T };
    } catch (err) {
      if (err instanceof restateClients.HttpCallError) {
        if (statuses.notFound && err.status === 404) return { status: "not-found" };
        if (statuses.conflict && err.status === 409) return { status: "conflict" };
      }
      return { status: "unavailable" };
    }
  }

  return {
    report: (triggerId, body, opts) =>
      invoke<{ status: "accepted" | "duplicate" }>(() => refresh(triggerId).report(body, callOpts(opts?.idempotencyKey)), { notFound: true, conflict: true }),
    progress: (triggerId) => invoke(() => refresh(triggerId).progress(callOpts()), { notFound: true }),
    cancel: (triggerId, reason) => invoke(() => refresh(triggerId).cancel({ reason }, callOpts()), { notFound: true }),
    status: (triggerId) => invoke<KgRefreshStatusResult>(() => refresh(triggerId).status(callOpts()), { notFound: true }),
    repoStatus: (slug) => invoke<{ triggerId: string; startedAt: number } | null>(() => repo(slug).status(callOpts())),
    enqueueDryRun: (slug, entry, opts) =>
      invoke<KgRepoEnqueueResult>(() => repo(slug).enqueueDryRun(entry, callOpts(opts?.idempotencyKey))) as ReturnType<KgRefreshIngressClient["enqueueDryRun"]>,
    dryRunOutcome: (slug, pr) => invoke<StoredDryRunOutcome | null>(() => repo(slug).dryRunOutcome(pr, callOpts())),
    forgetPr: (slug, pr) => invoke(() => repo(slug).forgetPr(pr, callOpts())),
  };
}

export type { KgRepoTriggerResult };
