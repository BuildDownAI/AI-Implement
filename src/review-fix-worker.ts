/**
 * Production `ReviewFixWorkerPort` (AII-829) for the Restate review-fix pilot
 * (AII-769/AII-793): the only capability that calls out to GitHub Actions on
 * behalf of a durable attempt. This module has no SQLite access and no
 * production wiring — `src/restate/review-fix-attempt.ts`'s header notes it is
 * "not registered until AII-811 composes the production adapters," and this
 * class is exactly the adapter that later composition will supply.
 *
 * Two seams, both deliberately injectable and both untouched at import time or
 * construction:
 *  - `ReviewFixWorkerCredentialResolver` fetches a GitHub App installation
 *    token. `createGithubAppCredentialResolver` is the production
 *    implementation; every method below calls it fresh, never caching a token
 *    or a GitHub client as a field, so a test can construct this class and
 *    call `prepare()` (or exercise the "no route to a repo yet" branches of
 *    `inspectTerminal`/`cancel`) without a credential resolver ever being
 *    invoked.
 *  - `ReviewFixWorkerTransport` wraps the actual `fetch` calls (dispatch,
 *    list runs, get run, cancel run) so a test can inject a controllable
 *    double that, e.g., accepts a dispatch and then throws before its
 *    response reaches the caller — exactly the "GitHub accepted, the local
 *    process did not find out" crash window this issue exists to close.
 *
 * Reconciliation (`reconcile`) never falls back to `findWorkflowRunId`'s
 * (`src/github.ts:696` at issue-authoring time) title-prefix matching, which
 * this issue's task explicitly forbids ("Never use fuzzy issue-title
 * matching"). Instead it lists recent `workflow_dispatch` runs for the exact
 * workflow file and branch, then requires every one of installation, repo,
 * workflow, ref, and the AII-782 attempt marker (`run_attempt_token`, read
 * back from `display_title` via the synced template's `run-name:` — see
 * `workflows/claude-implement.yml`) plus GitHub's own `run_attempt` to agree
 * as one exact set. Zero or more than one candidate both resolve to
 * `"unknown"` — never `"not_found"` — because neither proves a launch did not
 * happen; the port's own doc comment states the same rule.
 *
 * `inspectTerminal(execution)` and `cancel(attemptId, execution)` take only an
 * execution identity or attempt id — no scope — so this adapter routes scope
 * lookups through an injectable `ReviewFixWorkerScopeStore`, populated by
 * `prepare`, `launch`, and `reconcile` (all of which see the full scope).
 * `inMemoryReviewFixWorkerScopeStore()` (the default when no store is injected)
 * is private to one adapter instance and cannot survive a reconstruction on its
 * own. `reviewFixAttemptStoreScopeStore()` is the concrete durable alternative:
 * it reads `attemptId`/execution -> scope from the attempt record itself
 * (`ReviewFixAttemptStorePort.getPreparedAttempt` and
 * `SqliteReviewFixAttemptStore.findPreparedAttemptByExecution`), which the
 * workflow already persists via `admit`/`bindExecution` before this adapter's
 * `cancel`/`inspectTerminal` would ever be called on a bound execution — so a
 * freshly constructed adapter, wired to that store, resolves scope with no
 * shared in-memory state at all. No production wiring composes it here (that
 * remains a later issue's job), but the store and its test coverage are part of
 * this slice. SQLite (`ReviewFixAttemptStorePort`) remains the sole authority on
 * occupancy, authority, and results; a store miss here still degrades to the
 * safe "not yet reached" / `"unknown"` outcome rather than guessing which repo
 * an execution belongs to.
 *
 * `succeeded` outcomes from `inspectTerminal` never use the workflow run's own
 * `head_sha`, which GitHub fixes at dispatch time to the ref's tip — for a
 * gap-fill attempt that checks out and pushes to the existing PR branch from
 * inside the job, that value is not the commit the runner produces. Instead,
 * once GitHub reports the run terminal with `conclusion: "success"`, this
 * adapter fetches the PR's *current* head SHA directly (`getPullRequestHeadSha`)
 * and reports that as `outputCommit`. `review-fix-attempt.ts` still cross-checks
 * this value against the PR's head at approval time before ever approving, so a
 * PR that moved again after this read can only withhold approval, never grant a
 * false one.
 */
import { getInstallation } from "./github-app-auth.js";
import {
  cancelWorkflowRun,
  defaultFetchSignal,
  postWorkflowDispatch,
  providerDispatchFields,
  type DispatchInputs,
  type DispatchResult,
} from "./github.js";
import { encodeRunConfig, type RunConfigV1 } from "./run-config.js";
import { getMappings, type RepoMapping } from "./config.js";
import type {
  AttemptId,
  ScopedPrIdentity,
  WorkerCancelOutcome,
  WorkerExecutionIdentity,
  WorkerLaunchOutcome,
  WorkerLookupOutcome,
} from "./review-fix-contract.js";
import type {
  PreparedReviewFixAttempt,
  ReviewFixWorkerPort,
  WorkerLaunchPlan,
  WorkerTerminalInspection,
} from "./review-fix-ports.js";

// ---------------------------------------------------------------------------
// Credential seam
// ---------------------------------------------------------------------------

/** A GitHub App installation token, plus the installation id GitHub actually resolved it
 *  for — carries no App id or private key. */
export interface ReviewFixWorkerCredential {
  readonly token: string;
  readonly installationId: number;
}

export interface ReviewFixWorkerCredentialResolver {
  resolve(scope: ScopedPrIdentity): Promise<ReviewFixWorkerCredential>;
}

function ownerOf(repository: string): string {
  const separator = repository.indexOf("/");
  return separator < 0 ? repository : repository.slice(0, separator);
}

/**
 * Production credential resolver: mints a fresh GitHub App installation token for the
 * scope's repository owner. `appId`/`privateKey` are held only as closure state and are
 * never read at module scope or returned from `resolve` — every fetch happens inside this
 * call, triggered only when a worker method actually needs to reach GitHub.
 */
export function createGithubAppCredentialResolver(appId: string, privateKey: string): ReviewFixWorkerCredentialResolver {
  return {
    async resolve(scope: ScopedPrIdentity): Promise<ReviewFixWorkerCredential> {
      const installation = await getInstallation(appId, privateKey, ownerOf(scope.repository));
      return { token: installation.token, installationId: installation.installationId };
    },
  };
}

// ---------------------------------------------------------------------------
// Transport seam (the controllable GitHub double the issue's tests require)
// ---------------------------------------------------------------------------

export interface ReviewFixWorkerCandidateRun {
  readonly runId: number;
  /** `null` when GitHub's run object omitted `run_attempt` or reported a non-positive-integer
   *  value — never fabricated as `1`. A candidate with `null` cannot be verified against the
   *  required identity set and is excluded from matching (see `reconcile`). */
  readonly runAttempt: number | null;
  readonly displayTitle: string;
  readonly headBranch: string;
}

export interface ReviewFixWorkerRunDetail {
  readonly status: string;
  readonly conclusion: string | null;
  /** `null` under the same missing/invalid condition as `ReviewFixWorkerCandidateRun.runAttempt` —
   *  never fabricated as `1`. `inspectTerminal` treats `null` as "not verifiably reached". */
  readonly runAttempt: number | null;
}

export interface ReviewFixWorkerTransport {
  dispatch(input: {
    readonly token: string;
    readonly owner: string;
    readonly repo: string;
    readonly workflowFile: string;
    readonly ref: string;
    readonly inputs: DispatchInputs;
  }): Promise<DispatchResult>;

  listRuns(input: {
    readonly token: string;
    readonly owner: string;
    readonly repo: string;
    readonly workflowFile: string;
    readonly branch: string;
  }): Promise<readonly ReviewFixWorkerCandidateRun[]>;

  getRun(input: {
    readonly token: string;
    readonly owner: string;
    readonly repo: string;
    readonly runId: number;
  }): Promise<ReviewFixWorkerRunDetail | null>;

  cancelRun(input: {
    readonly token: string;
    readonly owner: string;
    readonly repo: string;
    readonly runId: number;
  }): Promise<boolean>;

  /** The PR's current head SHA, read fresh at call time — the sole legitimate source for a
   *  successful terminal outcome's `outputCommit` (see the module doc comment on why the
   *  workflow run's own `head_sha` cannot be used for this). `null` when the PR cannot be read. */
  getPullRequestHeadSha(input: {
    readonly token: string;
    readonly owner: string;
    readonly repo: string;
    readonly prNumber: number;
  }): Promise<string | null>;
}

const GH_API_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "linear-dispatch-worker",
} as const;

function authHeaders(token: string): Record<string, string> {
  return { ...GH_API_HEADERS, Authorization: `Bearer ${token}` };
}

/** `null` for anything but a positive integer — never coerces a missing/invalid GitHub
 *  `run_attempt` field into a fabricated `1`. */
function parseRunAttempt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** Bound on one reconcile query. A genuinely old run beyond the most recent page on this
 *  workflow+branch would be missed — safely, since a miss resolves to "unknown", never to
 *  proof of absence (see the module doc comment). */
const RECONCILE_RUNS_PAGE_SIZE = 100;

/** Default production transport: thin wrappers over the GitHub REST API. `dispatch` reuses
 *  `postWorkflowDispatch` (AII-778's `returnRunDetails` opt-in) rather than re-implementing
 *  the strip-and-retry/identity-parsing it already owns. */
export const githubActionsReviewFixWorkerTransport: ReviewFixWorkerTransport = {
  async dispatch(input) {
    return postWorkflowDispatch({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      workflowFile: input.workflowFile,
      ref: input.ref,
      inputs: input.inputs,
      returnRunDetails: true,
    });
  },

  async listRuns(input) {
    const url = `https://api.github.com/repos/${input.owner}/${input.repo}/actions/workflows/${input.workflowFile}/runs`
      + `?branch=${encodeURIComponent(input.branch)}&event=workflow_dispatch&per_page=${RECONCILE_RUNS_PAGE_SIZE}`;
    const res = await fetch(url, { headers: authHeaders(input.token), signal: defaultFetchSignal() });
    if (!res.ok) throw new Error(`listRuns failed: HTTP ${res.status}`);
    const data = (await res.json()) as {
      workflow_runs?: Array<{ id: number; run_attempt?: number; display_title?: string; head_branch?: string }>;
    };
    return (data.workflow_runs ?? []).map((run) => ({
      runId: run.id,
      runAttempt: parseRunAttempt(run.run_attempt),
      displayTitle: run.display_title ?? "",
      headBranch: run.head_branch ?? "",
    }));
  },

  async getRun(input) {
    const url = `https://api.github.com/repos/${input.owner}/${input.repo}/actions/runs/${input.runId}`;
    const res = await fetch(url, { headers: authHeaders(input.token), signal: defaultFetchSignal() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`getRun failed: HTTP ${res.status}`);
    const data = (await res.json()) as { status: string; conclusion: string | null; run_attempt?: number };
    return { status: data.status, conclusion: data.conclusion, runAttempt: parseRunAttempt(data.run_attempt) };
  },

  async cancelRun(input) {
    return cancelWorkflowRun(input.token, input.owner, input.repo, input.runId);
  },

  async getPullRequestHeadSha(input) {
    const url = `https://api.github.com/repos/${input.owner}/${input.repo}/pulls/${input.prNumber}`;
    const res = await fetch(url, { headers: authHeaders(input.token), signal: defaultFetchSignal() });
    if (!res.ok) return null;
    const data = (await res.json()) as { head?: { sha?: string } };
    return typeof data.head?.sha === "string" ? data.head.sha : null;
  },
};

// ---------------------------------------------------------------------------
// Mapping lookup (mirrors review-fix-attempt-store.ts's own resolution — this
// adapter needs workflowFile/defaultBranch, which ScopedPrIdentity does not carry)
// ---------------------------------------------------------------------------

function findMapping(repository: string): RepoMapping | null {
  const separator = repository.indexOf("/");
  if (separator < 0) return null;
  const owner = repository.slice(0, separator);
  const repo = repository.slice(separator + 1);
  for (const mapping of Object.values(getMappings())) {
    if (mapping.owner === owner && mapping.repo === repo) return mapping;
  }
  return null;
}

/** Exact-suffix match against the AII-782 run-name format
 *  (`... · attempt {run_attempt_token}`). Anchored on the literal separator plus the full
 *  attempt id so a shorter id can never match as a trailing substring of a longer one. */
function matchesAttemptMarker(displayTitle: string, attemptId: AttemptId): boolean {
  return displayTitle.endsWith(` · attempt ${attemptId}`);
}

function buildLaunchInputs(plan: WorkerLaunchPlan, mapping: RepoMapping): DispatchInputs {
  const identifier = `review-fix-${plan.scope.prNumber}`;
  const runConfig: RunConfigV1 = {
    v: 1,
    issue: {
      id: `review-fix:${plan.attemptId}`,
      identifier,
      title: `Review-fix for ${plan.scope.repository}#${plan.scope.prNumber}`,
      // WorkerLaunchPlan carries no separate issue description field — taskText is the
      // whole rendered task, so it doubles as both the envelope description and the
      // commentInstruction gap-fill dispatches already use for this purpose.
      description: plan.taskText,
    },
    runnerPhase: "gap-analysis",
    prNumber: String(plan.scope.prNumber),
    commentInstruction: plan.taskText,
    reviewFix: {
      version: 1,
      attemptId: plan.attemptId,
      installationId: plan.scope.installationId,
      repository: plan.scope.repository,
      prNumber: plan.scope.prNumber,
      deadlineAt: plan.deadlineAt,
    },
    ...(mapping.branchPrefix ? { branchPrefix: mapping.branchPrefix } : {}),
    ...(mapping.skillsRepo ? { skillsRepo: mapping.skillsRepo } : {}),
    ...(mapping.referenceRepos != null ? { referenceRepos: mapping.referenceRepos } : {}),
    ...(mapping.maxTurns != null ? { maxTurns: mapping.maxTurns } : {}),
    ...(mapping.maxIterations != null ? { maxIterations: mapping.maxIterations } : {}),
    ...(mapping.sensitiveAddPatterns != null || mapping.sensitiveAllowPatterns != null
      ? { sensitiveFiles: { add: mapping.sensitiveAddPatterns ?? undefined, allow: mapping.sensitiveAllowPatterns ?? undefined } }
      : {}),
    ...(mapping.reviewers != null ? { reviewers: mapping.reviewers } : {}),
    ...(mapping.dependencyTokenScope != null ? { dependencyTokenScope: mapping.dependencyTokenScope } : {}),
  };

  return {
    run_config: encodeRunConfig(runConfig),
    issue_identifier: identifier,
    run_attempt_token: plan.attemptId,
    // Production composition adds callback credentials inside launch(); they
    // deliberately never enter WorkerLaunchPlan or a journaled result.
    run_token: "",
    ...providerDispatchFields(mapping),
    ...(mapping.maxJobMinutes != null ? { job_timeout_minutes: String(mapping.maxJobMinutes) } : {}),
  };
}

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------
// Scope-routing seam (the durable lookup `cancel`/`inspectTerminal` need)
// ---------------------------------------------------------------------------

function executionKey(execution: WorkerExecutionIdentity): string {
  return `${execution.githubRunId}:${execution.githubRunAttempt}`;
}

/**
 * Routes `attemptId`/execution identity back to the `ScopedPrIdentity` needed to resolve a
 * mapping and mint credentials — the port's `cancel`/`inspectTerminal` methods carry neither.
 * Populated by `prepare`, `launch`, and `reconcile`. Injectable so a later issue can compose a
 * durable (e.g. SQLite-backed) implementation without this adapter gaining direct storage
 * access — see the module doc comment. The default is an in-memory map, matching this issue's
 * "no production wiring" boundary: without an injected durable store, a freshly constructed
 * adapter still degrades safely to "not yet reached" / `"unknown"` for an execution it never
 * itself saw `prepare`/`launch`/`reconcile` for.
 */
export interface ReviewFixWorkerScopeStore {
  rememberAttempt(attemptId: AttemptId, scope: ScopedPrIdentity): Promise<void>;
  rememberExecution(execution: WorkerExecutionIdentity, scope: ScopedPrIdentity): Promise<void>;
  scopeForAttempt(attemptId: AttemptId): Promise<ScopedPrIdentity | null>;
  scopeForExecution(execution: WorkerExecutionIdentity): Promise<ScopedPrIdentity | null>;
}

export function inMemoryReviewFixWorkerScopeStore(): ReviewFixWorkerScopeStore {
  const byAttempt = new Map<AttemptId, ScopedPrIdentity>();
  const byExecution = new Map<string, ScopedPrIdentity>();
  return {
    async rememberAttempt(attemptId, scope) {
      byAttempt.set(attemptId, scope);
    },
    async rememberExecution(execution, scope) {
      byExecution.set(executionKey(execution), scope);
    },
    async scopeForAttempt(attemptId) {
      return byAttempt.get(attemptId) ?? null;
    },
    async scopeForExecution(execution) {
      return byExecution.get(executionKey(execution)) ?? null;
    },
  };
}

/** The two read paths `reviewFixAttemptStoreScopeStore` needs from a durable attempt record —
 *  `ReviewFixAttemptStorePort.getPreparedAttempt` plus `SqliteReviewFixAttemptStore`'s extra
 *  `findPreparedAttemptByExecution` (not part of the port, since `bindExecution` only writes
 *  that direction). A `PreparedReviewFixAttempt`-shaped return is accepted so the production
 *  `SqliteReviewFixAttemptStore` satisfies this with no adapter needed. */
export interface ReviewFixWorkerAttemptScopeSource {
  getPreparedAttempt(attemptId: AttemptId): Promise<{ readonly scope: ScopedPrIdentity } | null>;
  findPreparedAttemptByExecution(execution: WorkerExecutionIdentity): Promise<{ readonly scope: ScopedPrIdentity } | null>;
}

/**
 * A `ReviewFixWorkerScopeStore` backed by the durable attempt record itself, rather than an
 * in-memory map private to one adapter instance. `attemptId` -> scope comes from `admit`'s
 * persisted snapshot; execution -> scope comes from `bindExecution`'s persisted
 * `github_run_id`/`github_run_attempt` columns — both already written by the workflow (not
 * this adapter) before it would ever call `cancel`/`inspectTerminal` on a bound execution.
 * `rememberAttempt`/`rememberExecution` are no-ops here: this store only reads, since the
 * durable write already happened through `source` itself. Composing this with
 * `SqliteReviewFixAttemptStore` (or, in production, whatever AII-811 wires) is what makes a
 * freshly constructed `GithubReviewFixWorker` — e.g. after a process restart, sharing no
 * in-memory state with whichever instance ran `prepare`/`launch`/`reconcile` — still resolve
 * scope for a previously bound execution instead of degrading to `unknown`/`reached: false`
 * forever, which is all `inMemoryReviewFixWorkerScopeStore()` alone can ever do.
 */
export function reviewFixAttemptStoreScopeStore(source: ReviewFixWorkerAttemptScopeSource): ReviewFixWorkerScopeStore {
  return {
    async rememberAttempt() {},
    async rememberExecution() {},
    async scopeForAttempt(attemptId) {
      const attempt = await source.getPreparedAttempt(attemptId);
      return attempt?.scope ?? null;
    },
    async scopeForExecution(execution) {
      const attempt = await source.findPreparedAttemptByExecution(execution);
      return attempt?.scope ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface GithubReviewFixWorkerDeps {
  credentials: ReviewFixWorkerCredentialResolver;
  /** Mint callback bearers inside the launch adapter, after preparation. The
   * returned values go only to the GitHub dispatch request, never to Restate. */
  callbackInputs?: (attemptId: AttemptId) => Promise<Pick<DispatchInputs, "run_token" | "run_progress_token" | "runner_callback_url">>;
  /** Defaults to `githubActionsReviewFixWorkerTransport`. Overridden by tests with a
   *  controllable double. */
  transport?: ReviewFixWorkerTransport;
  /** Defaults to a fresh, per-instance `inMemoryReviewFixWorkerScopeStore()`. Inject
   *  `reviewFixAttemptStoreScopeStore()` (or share one in-memory store across adapter
   *  instances, e.g. in a test) to route `cancel`/`inspectTerminal` without a preceding
   *  `prepare`/`reconcile` on that instance. */
  scopeStore?: ReviewFixWorkerScopeStore;
}

export class GithubReviewFixWorker implements ReviewFixWorkerPort {
  private readonly credentials: ReviewFixWorkerCredentialResolver;
  private readonly transport: ReviewFixWorkerTransport;
  private readonly scopeStore: ReviewFixWorkerScopeStore;
  private readonly callbackInputs?: GithubReviewFixWorkerDeps["callbackInputs"];

  constructor(deps: GithubReviewFixWorkerDeps) {
    this.credentials = deps.credentials;
    this.transport = deps.transport ?? githubActionsReviewFixWorkerTransport;
    this.scopeStore = deps.scopeStore ?? inMemoryReviewFixWorkerScopeStore();
    this.callbackInputs = deps.callbackInputs;
  }

  private async remember(attemptId: AttemptId, scope: ScopedPrIdentity, execution?: WorkerExecutionIdentity): Promise<void> {
    await this.scopeStore.rememberAttempt(attemptId, scope);
    if (execution) await this.scopeStore.rememberExecution(execution, scope);
  }

  async prepare(attempt: PreparedReviewFixAttempt): Promise<WorkerLaunchPlan> {
    // Non-authoritative routing store only, not a network call — see module doc comment.
    await this.scopeStore.rememberAttempt(attempt.attemptId, attempt.scope);
    return {
      attemptId: attempt.attemptId,
      scope: attempt.scope,
      taskText: attempt.taskText,
      deadlineAt: attempt.deadlineAt,
    };
  }

  async launch(plan: WorkerLaunchPlan): Promise<WorkerLaunchOutcome> {
    const mapping = findMapping(plan.scope.repository);
    if (!mapping) return { status: "unknown" };

    let credential: ReviewFixWorkerCredential;
    try {
      credential = await this.credentials.resolve(plan.scope);
    } catch {
      return { status: "unknown" };
    }
    // The App not being installed under the exact installation this attempt was admitted
    // under is not evidence the dispatch was rejected — it is unresolved identity.
    if (credential.installationId !== plan.scope.installationId) return { status: "unknown" };

    let inputs = buildLaunchInputs(plan, mapping);
    try {
      if (this.callbackInputs) inputs = { ...inputs, ...await this.callbackInputs(plan.attemptId) };
    } catch {
      // A missing/expired prepared credential is not proof that an earlier
      // dispatch did not happen. The workflow reconciles under its launch intent.
      return { status: "unknown" };
    }
    let result: DispatchResult;
    try {
      result = await this.transport.dispatch({
        token: credential.token,
        owner: mapping.owner,
        repo: mapping.repo,
        workflowFile: mapping.workflowFile,
        ref: mapping.defaultBranch,
        inputs,
      });
    } catch {
      return { status: "unknown" };
    }

    if (result.outcome === "rejected") {
      return { status: "rejected", reason: result.error ?? `GitHub rejected the dispatch (HTTP ${result.status})` };
    }
    if (result.outcome === "accepted" && result.runId !== undefined) {
      // A freshly dispatched run always starts at its first attempt; GitHub's dispatch
      // response carries no run_attempt field of its own to read this from.
      const execution: WorkerExecutionIdentity = { githubRunId: result.runId, githubRunAttempt: 1 };
      await this.remember(plan.attemptId, plan.scope, execution);
      return { status: "accepted", execution };
    }
    // A 204/"accepted" response with no resolvable run id cannot be bound to an execution
    // yet — the caller must reconcile rather than trust an unverified identity.
    return { status: "unknown" };
  }

  async reconcile(attemptId: AttemptId, scope: ScopedPrIdentity): Promise<WorkerLookupOutcome> {
    const mapping = findMapping(scope.repository);
    if (!mapping) return { status: "unknown" };

    let credential: ReviewFixWorkerCredential;
    try {
      credential = await this.credentials.resolve(scope);
    } catch {
      return { status: "unknown" };
    }
    if (credential.installationId !== scope.installationId) return { status: "unknown" };

    let candidates: readonly ReviewFixWorkerCandidateRun[];
    try {
      candidates = await this.transport.listRuns({
        token: credential.token,
        owner: mapping.owner,
        repo: mapping.repo,
        workflowFile: mapping.workflowFile,
        branch: mapping.defaultBranch,
      });
    } catch {
      return { status: "unknown" };
    }

    // A candidate with no verifiable run_attempt (GitHub omitted or reported an invalid value)
    // can never satisfy the required "installation/repo/workflow/ref/marker/run_attempt" set as
    // one exact match — excluded here rather than treated as attempt 1.
    const matches = candidates.filter((run) =>
      run.runAttempt !== null && run.headBranch === mapping.defaultBranch && matchesAttemptMarker(run.displayTitle, attemptId));

    // Exactly one verified match (installation via the credential check above, repo/workflow
    // via the queried endpoint, ref via headBranch, attempt marker via display_title, and
    // run_attempt from the run itself) is adopted. Zero candidates does not prove no launch
    // happened (listing lag, pagination) and multiple never resolves by picking a "first" or
    // "latest" one — both stay uncertain and retain occupancy, per the port's own contract.
    if (matches.length !== 1) return { status: "unknown" };

    const match = matches[0];
    const execution: WorkerExecutionIdentity = { githubRunId: match.runId, githubRunAttempt: match.runAttempt as number };
    await this.remember(attemptId, scope, execution);
    return { status: "found", execution };
  }

  async cancel(attemptId: AttemptId, execution: WorkerExecutionIdentity): Promise<WorkerCancelOutcome> {
    const scope = (await this.scopeStore.scopeForAttempt(attemptId)) ?? (await this.scopeStore.scopeForExecution(execution));
    if (!scope) return { status: "unknown" };
    const mapping = findMapping(scope.repository);
    if (!mapping) return { status: "unknown" };

    let credential: ReviewFixWorkerCredential;
    try {
      credential = await this.credentials.resolve(scope);
    } catch {
      return { status: "unknown" };
    }

    try {
      const requested = await this.transport.cancelRun({
        token: credential.token,
        owner: mapping.owner,
        repo: mapping.repo,
        runId: execution.githubRunId,
      });
      // A 202/409 acknowledgement only proves GitHub accepted (or could not honor) the stop
      // *request* — never that the run is actually terminal. Only inspectTerminal's own read
      // of the backend may report that.
      return requested ? { status: "cancelled" } : { status: "unknown" };
    } catch {
      return { status: "unknown" };
    }
  }

  async inspectTerminal(execution: WorkerExecutionIdentity): Promise<WorkerTerminalInspection> {
    const scope = await this.scopeStore.scopeForExecution(execution);
    if (!scope) return { reached: false };
    const mapping = findMapping(scope.repository);
    if (!mapping) return { reached: false };

    let credential: ReviewFixWorkerCredential;
    try {
      credential = await this.credentials.resolve(scope);
    } catch {
      return { reached: false };
    }

    let detail: ReviewFixWorkerRunDetail | null;
    try {
      detail = await this.transport.getRun({
        token: credential.token,
        owner: mapping.owner,
        repo: mapping.repo,
        runId: execution.githubRunId,
      });
    } catch {
      return { reached: false };
    }
    if (!detail || detail.status !== "completed") return { reached: false };
    // A later re-run (a distinct GitHub attempt) reaching terminal proves nothing about
    // this exact bound attempt — never conflate the two.
    if (detail.runAttempt !== execution.githubRunAttempt) return { reached: false };

    if (detail.conclusion === "cancelled") return { reached: true, outcome: { status: "cancelled" } };
    if (detail.conclusion === "success") {
      // The run's own head_sha is fixed at dispatch time and is never the commit a gap-fill
      // attempt pushes — the PR's current head, read fresh here, is the only legitimate source
      // for outputCommit. See the module doc comment.
      let prHeadSha: string | null;
      try {
        prHeadSha = await this.transport.getPullRequestHeadSha({
          token: credential.token,
          owner: mapping.owner,
          repo: mapping.repo,
          prNumber: scope.prNumber,
        });
      } catch {
        return { reached: false };
      }
      if (prHeadSha === null || !FULL_SHA_PATTERN.test(prHeadSha)) return { reached: false };
      return { reached: true, outcome: { status: "succeeded", outputCommit: prHeadSha } };
    }
    return { reached: true, outcome: { status: "failed", reason: detail.conclusion ?? "unknown conclusion" } };
  }
}
