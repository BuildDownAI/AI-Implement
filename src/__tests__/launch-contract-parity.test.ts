/**
 * Launch parity (AII-1317). Every run kind is launched on every backend through its real launch
 * path, with fakes at the outermost call, and three checks run on what reached the carrier:
 *
 *  - `envelope:<key>`    the decoded envelope equals the GitHub Actions cell of the same run kind
 *  - `token:<audience>`  the tokens that reach the carrier are the set the run kind expects
 *  - `image`             an image named by `.ai-implement/image.yml` that is not allowed makes no launch call
 *
 * Today's gaps are data (KNOWN_GAPS). A cell passes when its failing checks equal its rows, so a gap
 * that is fixed and a row that is left behind both fail the test. See docs/execution-backends.md,
 * "Launch parity test".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AppConfig } from "../index.js";
import type { RepoMapping } from "../config.js";
import type { TicketIssue, TicketingProvider } from "../providers/types.js";
import type { ProviderRegistry } from "../providers/index.js";
import type { DrainCommentGapfillsInput } from "../comment-gapfill-drain.js";
import type { KgRefreshSenderDeps } from "../restate/kg-refresh-senders.js";
import type { KeptMachineFly } from "../restate/kg-refresh-production.js";
import type { StartLocalContainerInput } from "../local-docker.js";
import type { CreateMachineOpts, Machine } from "../fly-machines.js";
import type { DispatchInputs, DispatchResult } from "../github.js";
import type { WorkflowCapabilities } from "../workflow-probe.js";
import type { ReviewFixWorkerTransport } from "../review-fix-worker.js";
import { buildLocalRunnerEnv } from "../local-docker.js";
import { decodeRunConfig, buildKgRefreshRunConfig, type RunConfigV1 } from "../run-config.js";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "../pipeline/retry-backoff.js";

// ---------------------------------------------------------------------------
// The cells, the expected tokens and the known gaps
// ---------------------------------------------------------------------------

type Backend = "github-actions" | "fly-machines" | "local-docker";
type Kind = "implementation" | "gap-fill" | "planning" | "review-fix-attempt" | "legacy-review-fix" | "kg-refresh";
type Audience = "result" | "progress" | "publication";

const BACKENDS: readonly Backend[] = ["github-actions", "fly-machines", "local-docker"];
const KINDS: readonly Kind[] = ["implementation", "gap-fill", "planning", "review-fix-attempt", "legacy-review-fix", "kg-refresh"];

/** The run kind sets the token set; the backend never does (AII-1311 decision, 2026-10-14).
 *  Planning never pushes, so it carries no publication token (src/publication-token-vending.ts:62-65). */
const EXPECTED_TOKENS: Record<Kind, readonly Audience[]> = {
  implementation: ["result", "progress", "publication"],
  "gap-fill": ["result", "progress", "publication"],
  planning: ["result", "progress"],
  "review-fix-attempt": ["result", "progress", "publication"],
  "legacy-review-fix": ["result", "progress", "publication"],
  "kg-refresh": ["result", "progress", "publication"],
};

/** Each row is a check that fails today. A later issue removes its rows when it closes the gap.
 *  A row whose check passes fails this test, so the list cannot go stale. */
const KNOWN_GAPS: ReadonlyArray<{ kind: string; backend: string; check: string }> = [
  // implementation
  { kind: "implementation", backend: "github-actions", check: "image" },
  { kind: "implementation", backend: "fly-machines", check: "image" },
  // gap-fill
  { kind: "gap-fill", backend: "github-actions", check: "image" },
  { kind: "gap-fill", backend: "fly-machines", check: "token:progress" },
  { kind: "gap-fill", backend: "fly-machines", check: "token:publication" },
  { kind: "gap-fill", backend: "fly-machines", check: "image" },
  { kind: "gap-fill", backend: "local-docker", check: "token:publication" },
  // planning
  { kind: "planning", backend: "github-actions", check: "image" },
  { kind: "planning", backend: "fly-machines", check: "image" },
  // review-fix-attempt
  { kind: "review-fix-attempt", backend: "github-actions", check: "image" },
  // legacy review-fix queue
  { kind: "legacy-review-fix", backend: "github-actions", check: "image" },
  { kind: "legacy-review-fix", backend: "local-docker", check: "token:publication" },
  // kg-refresh
  { kind: "kg-refresh", backend: "github-actions", check: "image" },
  { kind: "kg-refresh", backend: "fly-machines", check: "token:publication" },
  { kind: "kg-refresh", backend: "fly-machines", check: "image" },
  { kind: "kg-refresh", backend: "local-docker", check: "token:publication" },
];

/** Cells the test does not run, each with its reason. Every kind × backend pair is a cell or listed here. */
const OUT_OF_SCOPE_CELLS: ReadonlyArray<{ kind: Kind; backend: Backend; reason: string }> = [
  { kind: "review-fix-attempt", backend: "fly-machines", reason: "branch 3 of AII-1308 adds the review-fix launch on Fly" },
  { kind: "review-fix-attempt", backend: "local-docker", reason: "branch 3 of AII-1308 adds the review-fix launch on local Docker" },
  { kind: "legacy-review-fix", backend: "fly-machines", reason: "the legacy review-fix queue has no Fly branch" },
];

/** Cells whose `image` check is not run, each with its reason. */
const IMAGE_OUT_OF_SCOPE: ReadonlyArray<{ backend: Backend; reason: string }> = [
  {
    backend: "local-docker",
    reason: "the local image is the operator's LOCAL_RUNNER_IMAGE (config.localRunnerImage); no repository input reaches it (AII-1311 decision)",
  },
];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEAM = "AII";
const OWNER = "acme";
const REPO = "billing";
const PR_NUMBER = 42;
const BASE_BRANCH = "release/next";
const DEFAULT_IMAGE = "ghcr.io/builddownai/ai-implement-runner:latest";
const EVIL_IMAGE = "evil.example/runner:1";
const INSTALLATION_ID = 7;
const TOKEN_SECRET = "parity-token-secret-parity-token-secret";
const CALLBACK_URL = "https://orch.example";

/** A non-default policy: a path that sends DEFAULT_RETRY_POLICY instead of getRetryPolicy() fails. */
const STORED_RETRY_POLICY: RetryPolicy = { ...DEFAULT_RETRY_POLICY, requestRetries: 5, stageRetries: 3, reviewMaxTurns: 44 };

/** A full RepoMapping with every field the envelope reads set to a non-default value. */
const MAPPING: RepoMapping = {
  owner: OWNER,
  repo: REPO,
  workflowFile: "claude-implement.yml",
  defaultBranch: "main",
  maxInProgressAiIssues: 5,
  executionMode: "github-actions",
  sessionMode: "autonomous",
  machineCpus: 2,
  machineMemoryMb: 4096,
  planningEnabled: true,
  planningWorkflowFile: "claude-plan.yml",
  autoApprovePlans: true,
  autoMerge: false,
  extraEnv: {},
  provider: "anthropic",
  ticketingProvider: "linear",
  ticketingConfig: { kind: "linear" },
  awsRegion: null,
  paused: false,
  maxTurns: 37,
  maxIterations: 4,
  maxJobMinutes: 75,
  branchPrefix: "pr",
  skillsRepo: "acme/skills",
  referenceRepos: [{ repo: "https://github.com/acme/reference", path: "reference", ref: "main" }],
  sensitiveAddPatterns: ["secrets/**"],
  sensitiveAllowPatterns: ["secrets/example.txt"],
  dependencyTokenScope: "installation",
  reviewFixLifecycle: null,
  memoryProviderId: null,
  reviewers: [{ id: "code-review", gates: true, maxTurns: 20 }],
  prDispatchBudget: 9,
  trustedReviewAuthors: ["trusted-reviewer"],
  reviewProcess: "claude-code-review",
};

const ISSUE: TicketIssue = {
  id: "issue-parity-1",
  identifier: "AII-1317",
  title: "Parity fixture",
  description: "Parity fixture body",
  scopeKey: TEAM,
  nativeStatus: "Todo",
  profiles: ["frontend", "database"],
  assigneeName: "Sam Developer",
};

const CONFIG = {
  githubAppId: "1",
  githubAppPrivateKey: "key",
  notifyWebhookUrl: null,
  notifyType: "slack",
  healthPort: 8080,
  flySessionsToken: "fly-token",
  flySessionsApp: "fly-app",
  flySessionsRegion: "iad",
  flyOrchestratorApp: null,
  tenantId: null,
  sessionImage: DEFAULT_IMAGE,
  runnerImageExplicit: false,
  anthropicApiKey: "sk-test",
  claudeOAuthToken: null,
  runnerCallbackBaseUrl: CALLBACK_URL,
  runnerTokenSecret: TOKEN_SECRET,
  localRunnerImage: "local-runner:img",
  localRunnerOrchestratorUrl: "http://localhost:9000",
  kgSourceRepo: "acme/kg",
} as unknown as AppConfig;

const CAPABILITIES: WorkflowCapabilities = {
  contract: "envelope",
  supportsRunPublicationToken: true,
  supportsAttemptCorrelation: true,
};

const ACCEPTED: DispatchResult = { success: true, status: 200, outcome: "accepted", runId: 4242, runUrl: "https://github.com/acme/billing/actions/runs/4242" };

// ---------------------------------------------------------------------------
// Fakes at the outermost call
// ---------------------------------------------------------------------------

type Launch =
  | { carrier: "workflow-inputs"; inputs: DispatchInputs | Record<string, string | undefined> }
  | { carrier: "machine-env"; env: Record<string, string> }
  | { carrier: "local-input"; input: StartLocalContainerInput };

interface Recorder {
  launches: Launch[];
  unplannedFetch: string[];
  /** When set, `.ai-implement/image.yml` names EVIL_IMAGE. */
  evilImage: boolean;
}

const holder = vi.hoisted(() => ({ current: null as Recorder | null }));
const recorder = (): Recorder => {
  if (!holder.current) throw new Error("no recorder: the fakes were called outside a cell");
  return holder.current;
};

vi.mock("../github.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github.js")>()),
  postWorkflowDispatch: async (opts: { inputs: DispatchInputs }) => {
    recorder().launches.push({ carrier: "workflow-inputs", inputs: opts.inputs });
    return { success: true, status: 200, outcome: "accepted", runId: 4242, runUrl: "https://github.com/acme/billing/actions/runs/4242" };
  },
  dispatchWorkflow: async (_token: string, _mapping: unknown, inputs: DispatchInputs) => {
    recorder().launches.push({ carrier: "workflow-inputs", inputs });
    return { success: true, status: 200, outcome: "accepted", runId: 4242, runUrl: "https://github.com/acme/billing/actions/runs/4242" };
  },
  findWorkflowRunId: async () => null,
}));

vi.mock("../fly-machines.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fly-machines.js")>()),
  listAppSecrets: async () => [],
  createMachine: async (_token: string, _app: string, machineConfig: CreateMachineOpts) => {
    recorder().launches.push({ carrier: "machine-env", env: { ...machineConfig.config.env } as Record<string, string> });
    return { id: "m-1", name: "m-1" };
  },
}));

vi.mock("../local-docker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../local-docker.js")>()),
  startLocalRunnerContainer: async (input: StartLocalContainerInput) => {
    recorder().launches.push({ carrier: "local-input", input });
    return { containerId: "c-1", containerName: "c-1" };
  },
}));

vi.mock("../github-app-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github-app-auth.js")>()),
  getInstallationToken: async () => "gh-token",
  getInstallationId: async () => 7,
}));

vi.mock("../workflow-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../workflow-probe.js")>()),
  resolveWorkflowCapabilities: async () => ({ contract: "envelope", supportsRunPublicationToken: true, supportsAttemptCorrelation: true }),
  resolveWorkflowContract: async () => "envelope",
}));

/** The global fetch fake. It serves only the two reads the cells plan for and records any other call. */
function installFetchFake(rec: Recorder): void {
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url: string }).url;
    if (url.endsWith("/contents/.ai-implement/image.yml")) {
      if (!rec.evilImage) return new Response("not found", { status: 404 });
      const content = Buffer.from(`image: ${EVIL_IMAGE}\n`).toString("base64");
      return new Response(JSON.stringify({ type: "file", encoding: "base64", content }), { status: 200 });
    }
    if (/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(url)) {
      return new Response(JSON.stringify({ merged: false, state: "open", head: { ref: "ai-implement/aii-1317", sha: "a".repeat(40) } }), { status: 200 });
    }
    rec.unplannedFetch.push(url);
    throw new Error(`launch-contract-parity: unplanned fetch ${url}`);
  });
}

function provider(): TicketingProvider {
  const noop = async () => undefined;
  return {
    id: "jira",
    issueUrl: () => "https://example.test/AII-1317",
    markImplementing: noop,
    markImplementationFailed: noop,
    markPlanningStarted: noop,
    markPlanningFailed: noop,
    postComment: noop,
    findByKey: async () => null,
  } as unknown as TicketingProvider;
}

// ---------------------------------------------------------------------------
// The world: one fresh module graph, SQLite file and recorder per run
// ---------------------------------------------------------------------------

async function loadModules() {
  return {
    index: await import("../index.js"),
    dedup: await import("../dedup.js"),
    log: await import("../log.js"),
    breaker: await import("../dispatch-breaker.js"),
    config: await import("../config.js"),
    settings: await import("../orchestrator-settings.js"),
    runnerMode: await import("../runner-mode.js"),
    queue: await import("../comment-gapfill-queue.js"),
    drain: await import("../comment-gapfill-drain.js"),
    reviewFixQueue: await import("../review-fix-queue.js"),
    worker: await import("../review-fix-worker.js"),
    runnerTokens: await import("../runner-tokens.js"),
    repoImage: await import("../repo-image.js"),
    kgSenders: await import("../restate/kg-refresh-senders.js"),
  };
}
type Modules = Awaited<ReturnType<typeof loadModules>>;

interface World extends Modules {
  rec: Recorder;
  dbPath: string;
}

const CLEARED_ENV = ["RUN_TOKEN", "RUNNER_CALLBACK_URL", "RUN_PROGRESS_TOKEN", "RUN_PUBLICATION_TOKEN", "ORCHESTRATOR_URL", "RUNNER_MODE"] as const;

async function boot(opts: { evilImage: boolean; runnerMode?: string }): Promise<World> {
  vi.resetModules();
  for (const key of CLEARED_ENV) delete process.env[key];
  const rec: Recorder = { launches: [], unplannedFetch: [], evilImage: opts.evilImage };
  holder.current = rec;
  installFetchFake(rec);
  const dbPath = path.join(os.tmpdir(), `launch-parity-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  if (opts.runnerMode) process.env.RUNNER_MODE = opts.runnerMode;
  const modules = await loadModules();
  modules.dedup.getDb();
  modules.log.initLogTable();
  modules.breaker.initDispatchBreakerTable();
  modules.config.initMappingsTable();
  modules.runnerMode.initSettingsTable();
  modules.settings.setRetryPolicy(STORED_RETRY_POLICY);
  modules.config.upsertMapping(TEAM, MAPPING);
  return { ...modules, rec, dbPath };
}

function teardown(world: World | null): void {
  world?.dedup.closeDb();
  if (world) {
    try { fs.unlinkSync(world.dbPath); } catch { /* ignore */ }
  }
  holder.current = null;
  vi.unstubAllGlobals();
  for (const key of CLEARED_ENV) delete process.env[key];
}

// ---------------------------------------------------------------------------
// What each launch carried
// ---------------------------------------------------------------------------

interface Captured {
  envelope: RunConfigV1;
  tokens: ReadonlySet<Audience>;
}

const nonEmpty = (value: unknown): boolean => typeof value === "string" && value !== "";

function capture(launch: Launch): Captured {
  if (launch.carrier === "workflow-inputs") {
    const inputs = launch.inputs as Record<string, string | undefined>;
    const tokens = new Set<Audience>();
    if (nonEmpty(inputs.run_token)) tokens.add("result");
    if (nonEmpty(inputs.run_progress_token)) tokens.add("progress");
    if (nonEmpty(inputs.run_publication_token)) tokens.add("publication");
    if (!inputs.run_config) throw new Error("the GitHub Actions launch carried no run_config");
    return { envelope: decodeRunConfig(inputs.run_config), tokens };
  }
  const env = launch.carrier === "machine-env" ? launch.env : buildLocalRunnerEnv(launch.input);
  const tokens = new Set<Audience>();
  if (nonEmpty(env.RUN_TOKEN)) tokens.add("result");
  if (nonEmpty(env.RUN_PROGRESS_TOKEN)) tokens.add("progress");
  if (nonEmpty(env.RUN_PUBLICATION_TOKEN)) tokens.add("publication");
  if (!env.AI_IMPLEMENT_RUN_CONFIG) throw new Error("the machine launch carried no AI_IMPLEMENT_RUN_CONFIG");
  return { envelope: decodeRunConfig(env.AI_IMPLEMENT_RUN_CONFIG), tokens };
}

// ---------------------------------------------------------------------------
// The launch paths
// ---------------------------------------------------------------------------

interface RunOptions {
  /** kg-refresh · fly-machines only: claim a kept machine instead of creating one. */
  claim?: boolean;
}
type LaunchPath = (world: World, options: RunOptions) => Promise<void>;

const PRIOR = { count: 0, lastDispatchedAt: null };

const implementation: Record<Backend, LaunchPath> = {
  "github-actions": (w) => w.index.dispatchGitHubActions(CONFIG, provider(), ISSUE, MAPPING, PRIOR, "default", BASE_BRANCH, null),
  "fly-machines": (w) => w.index.dispatchFlyMachine(CONFIG, provider(), ISSUE, MAPPING, PRIOR, "default", BASE_BRANCH, null),
  "local-docker": (w) => w.index.dispatchLocalDocker(CONFIG, provider(), ISSUE, MAPPING, PRIOR, "default", BASE_BRANCH, null),
};

const planning = (execPath: Backend): LaunchPath => (w) =>
  w.index.dispatchPlanning(CONFIG, provider(), ISSUE, MAPPING, {
    execPath,
    runnerMode: "default",
    resolvedPlanningBranch: BASE_BRANCH,
    planningFieldValue: null,
  });

const gapFill = (runnerMode: "gha" | "fly" | "local"): LaunchPath => async (w) => {
  w.queue.enqueueCommentGapfill({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER, commentId: 9001, commenter: "sam", instruction: "please address the review" });
  const jobId = w.log.appendLog({
    issueId: ISSUE.id, issueIdentifier: ISSUE.identifier, issueTitle: ISSUE.title, teamKey: TEAM,
    repo: `${OWNER}/${REPO}`, phase: "implementation", status: "completed",
  });
  w.log.updateJobPrUrl(jobId, `https://github.com/${OWNER}/${REPO}/pull/${PR_NUMBER}`);
  const opts: DrainCommentGapfillsInput = {
    getMappings: () => ({ [TEAM]: MAPPING }),
    runnerMode,
    notifyType: "slack",
    notifyWebhookUrl: null,
    runnerCallbackBaseUrl: CALLBACK_URL,
    runnerTokenSecret: TOKEN_SECRET,
    getInstallationToken: async () => "gh-token",
    getInstallationId: async () => INSTALLATION_ID,
    resolveRunnerImage: (mapping, token) => w.repoImage.resolveRunnerImageForDispatch({
      owner: mapping.owner, repo: mapping.repo, token,
      defaultImage: CONFIG.sessionImage, runnerImageExplicit: CONFIG.runnerImageExplicit,
    }),
    checkContract: async () => CAPABILITIES,
    dispatch: async (_token, _mapping, inputs) => {
      w.rec.launches.push({ carrier: "workflow-inputs", inputs });
      return ACCEPTED;
    },
    postComment: async () => undefined,
    postTrackerComment: async () => undefined,
    onDispatchFailure: async () => undefined,
    flySessionsToken: CONFIG.flySessionsToken,
    flySessionsApp: CONFIG.flySessionsApp,
    flySessionsRegion: CONFIG.flySessionsRegion,
    flyOrchestratorApp: null,
    tenantId: null,
    anthropicApiKey: CONFIG.anthropicApiKey,
    claudeOAuthToken: null,
    sessionImage: CONFIG.sessionImage,
    localRunnerImage: CONFIG.localRunnerImage,
    localRunnerOrchestratorUrl: CONFIG.localRunnerOrchestratorUrl,
  };
  await w.drain.drainCommentGapfillQueue(opts);
};

/** Seeds the prepared attempt `mintPreparedReviewFixToken` reads, as the Restate admission does. */
function seedPreparedAttempt(w: World, attemptId: string): void {
  const db = w.dedup.getDb();
  db.prepare(`
    INSERT INTO dispatch_admissions
      (dispatch_id, mapping_key, issue_scope, issue_id, installation_id,
       repository, pr_number, lifecycle_owner, phase, backend, created_at)
    VALUES (?, ?, 'pr', ?, ?, ?, ?, ?, 'implementation', 'github-actions', ?)
  `).run(attemptId, TEAM, `${OWNER}/${REPO}#${PR_NUMBER}`, String(INSTALLATION_ID), `${OWNER}/${REPO}`, PR_NUMBER, `restate:${attemptId}`, Date.now());
  db.prepare(`
    INSERT INTO review_fix_attempts
      (attempt_id, dispatch_id, mapping_key, installation_id, repository,
       pr_number, issue_scope, issue_id, owner, state, created_at, deadline_at,
       task_snapshot_json, finding_versions_json)
    VALUES (?, ?, ?, ?, ?, ?, 'pr', ?, ?, 'prepared', ?, ?, '{}', '[]')
  `).run(attemptId, attemptId, TEAM, String(INSTALLATION_ID), `${OWNER}/${REPO}`, PR_NUMBER, `${OWNER}/${REPO}#${PR_NUMBER}`, attemptId, Date.now(), Date.now() + 60 * 60_000);
}

const reviewFixAttempt: LaunchPath = async (w) => {
  const attemptId = "parity-attempt-1";
  seedPreparedAttempt(w, attemptId);
  const unplanned = async (): Promise<never> => { throw new Error("launch-contract-parity: unplanned review-fix transport call"); };
  const transport: ReviewFixWorkerTransport = {
    dispatch: async (input) => {
      w.rec.launches.push({ carrier: "workflow-inputs", inputs: input.inputs });
      return ACCEPTED;
    },
    listRuns: unplanned,
    getRun: unplanned,
    cancelRun: unplanned,
    getPullRequestHeadSha: unplanned,
  };
  const scope = { installationId: INSTALLATION_ID, repository: `${OWNER}/${REPO}`, prNumber: PR_NUMBER };
  const reviewFixWorker = new w.worker.GithubReviewFixWorker({
    credentials: { resolve: async () => ({ token: "gh-token", installationId: INSTALLATION_ID }) },
    transport,
    runnerCallbackUrl: CALLBACK_URL,
    retryPolicy: () => STORED_RETRY_POLICY,
    runnerImage: (target) => w.repoImage.resolveRunnerImageForDispatch({
      ...target, defaultImage: CONFIG.sessionImage, runnerImageExplicit: CONFIG.runnerImageExplicit,
    }),
    // Copies src/restate/review-fix-production.ts:177-185.
    callbackInputs: async (id) => ({
      run_token: w.runnerTokens.mintPreparedReviewFixToken({ attemptId: id, audience: "result", secret: TOKEN_SECRET }).token,
      run_progress_token: w.runnerTokens.mintPreparedReviewFixToken({ attemptId: id, audience: "progress", secret: TOKEN_SECRET }).token,
      run_publication_token: w.runnerTokens.mintPreparedReviewFixToken({ attemptId: id, audience: "publication", secret: TOKEN_SECRET }).token,
      runner_callback_url: CALLBACK_URL,
    }),
  });
  await reviewFixWorker.launch({ attemptId, scope, taskText: "Address the reported findings", deadlineAt: Date.now() + 60 * 60_000 });
};

const legacyReviewFix: Partial<Record<Backend, LaunchPath>> = {
  "github-actions": async (w) => runLegacyReviewFixQueue(w),
  "local-docker": async (w) => runLegacyReviewFixQueue(w),
};

async function runLegacyReviewFixQueue(w: World): Promise<void> {
  w.reviewFixQueue.enqueueReviewFix({
    issueId: ISSUE.id, issueIdentifier: ISSUE.identifier, repo: `${OWNER}/${REPO}`, prNumber: PR_NUMBER,
    reason: "review_feedback", sourceEventId: "parity-event-1",
  });
  const registry = { forMapping: async () => provider() } as unknown as ProviderRegistry;
  await w.index.processReviewFixQueue(CONFIG, registry);
}

function kgDeps(w: World, claim: boolean): KgRefreshSenderDeps {
  const fly: KeptMachineFly = {
    getMachine: async (id: string) => ({ id, state: "stopped" }) as unknown as Machine,
    listMachines: async () => [] as Machine[],
    createMachine: async (machineConfig: CreateMachineOpts) => {
      w.rec.launches.push({ carrier: "machine-env", env: { ...machineConfig.config.env } as Record<string, string> });
      return { id: "m-new" } as unknown as Machine;
    },
    updateMachine: async (_id: string, machineConfig: CreateMachineOpts["config"]) => {
      w.rec.launches.push({ carrier: "machine-env", env: { ...machineConfig.env } as Record<string, string> });
      return {};
    },
    startMachine: async () => {},
    waitSettled: async (id: string) => ({ id, state: "stopped" }) as unknown as Machine,
    waitForStopped: async () => {},
  };
  void claim;
  return {
    config: {
      githubAppId: "1", githubAppPrivateKey: "key", flySessionsToken: "fly-token", flySessionsApp: "fly-app",
      flySessionsRegion: "iad", localRunnerImage: "local-runner:img", localRunnerOrchestratorUrl: null,
      runnerCallbackBaseUrl: CALLBACK_URL, healthPort: 8080, sessionImage: DEFAULT_IMAGE, runnerImageExplicit: false,
      anthropicApiKey: "sk-test", claudeOAuthToken: null, kgSourceRepo: "acme/kg",
    },
    getInstallationToken: async () => "gh-token",
    mintToken: async () => ({ token: "gh-token", expiresAt: "" }),
    fetchDefaultBranch: async () => "trunk",
    // The real image resolution, as production injects it.
    resolveRunnerImage: w.repoImage.resolveRunnerImageForDispatch,
    resolveWorkflowCapabilities: async () => CAPABILITIES,
    postWorkflowDispatch: async (opts: { inputs: DispatchInputs }) => {
      w.rec.launches.push({ carrier: "workflow-inputs", inputs: opts.inputs });
      return ACCEPTED;
    },
    keptMachineFly: () => fly,
    startLocalRunnerContainer: async (input: StartLocalContainerInput) => {
      w.rec.launches.push({ carrier: "local-input", input });
      return { containerId: "c-1", containerName: "c-1" };
    },
  } as unknown as KgRefreshSenderDeps;
}

const kgRefresh = (backend: Backend): LaunchPath => async (w, options) => {
  const envelope = buildKgRefreshRunConfig({ kgSourceRepo: "acme/kg", issueIdentifier: "KG-REFRESH · parity", runnerCallbackUrl: CALLBACK_URL });
  const machine = backend === "fly-machines";
  await w.kgSenders.createKgRefreshSenders(kgDeps(w, options.claim === true))[backend]({
    envelope,
    tokens: { runToken: "result-token", progressToken: "progress-token", publicationToken: "publication-token" },
    dispatchId: "kg-dispatch-1",
    machine: { cpuKind: "performance", cpus: 4, memoryMb: 16384, idleTimeoutMs: 1000 },
    jobTimeoutMinutes: backend === "github-actions" ? 240 : null,
    machineId: machine && options.claim ? "m-kept" : null,
    machineNonce: backend === "github-actions" ? null : "kg-nonce-1",
  });
};

interface Cell {
  kind: Kind;
  backend: Backend;
  runnerMode?: string;
  run: LaunchPath;
  /** The GitHub Actions cell whose envelope this cell is compared with, and the keys it is not compared on. */
  reference: { kind: Kind; ignore: readonly string[] };
  /** Each entry is one run of the `image` check. */
  imageRuns: readonly RunOptions[];
}

const sameKind = (kind: Kind) => ({ kind, ignore: [] as readonly string[] });
const CELLS: readonly Cell[] = [
  ...BACKENDS.map((backend): Cell => ({ kind: "implementation", backend, run: implementation[backend], reference: sameKind("implementation"), imageRuns: [{}] })),
  ...([["github-actions", "gha"], ["fly-machines", "fly"], ["local-docker", "local"]] as const).map(([backend, mode]): Cell => (
    { kind: "gap-fill", backend, run: gapFill(mode), reference: sameKind("gap-fill"), imageRuns: [{}] })),
  ...BACKENDS.map((backend): Cell => ({ kind: "planning", backend, run: planning(backend), reference: sameKind("planning"), imageRuns: [{}] })),
  {
    kind: "review-fix-attempt", backend: "github-actions", run: reviewFixAttempt, imageRuns: [{}],
    // The attempt has no peer on another backend: it is compared with the legacy queue's GitHub Actions launch.
    reference: { kind: "legacy-review-fix", ignore: ["issue", "commentInstruction", "reviewFix"] },
  },
  { kind: "legacy-review-fix", backend: "github-actions", runnerMode: "gha", run: legacyReviewFix["github-actions"]!, reference: sameKind("legacy-review-fix"), imageRuns: [{}] },
  { kind: "legacy-review-fix", backend: "local-docker", runnerMode: "local", run: legacyReviewFix["local-docker"]!, reference: sameKind("legacy-review-fix"), imageRuns: [{}] },
  ...BACKENDS.map((backend): Cell => ({
    kind: "kg-refresh", backend, run: kgRefresh(backend), reference: sameKind("kg-refresh"),
    // The kept Fly machine re-resolves its image at every claim, so the claim path is checked as well as the create.
    imageRuns: backend === "fly-machines" ? [{}, { claim: true }] : [{}],
  })),
];

const cellOf = (kind: Kind, backend: Backend): Cell => {
  const cell = CELLS.find((c) => c.kind === kind && c.backend === backend);
  if (!cell) throw new Error(`no cell for ${kind} · ${backend}`);
  return cell;
};

// ---------------------------------------------------------------------------
// The three checks
// ---------------------------------------------------------------------------

/** Runs a cell once and returns what its single launch call carried. */
async function launchOnce(cell: Cell, options: RunOptions = {}): Promise<Captured> {
  let world: World | null = null;
  try {
    world = await boot({ evilImage: false, runnerMode: cell.runnerMode });
    await cell.run(world, options);
    expect(world.rec.unplannedFetch, `${cell.kind} · ${cell.backend} made an unplanned fetch`).toEqual([]);
    expect(world.rec.launches, `${cell.kind} · ${cell.backend} should make exactly one launch call`).toHaveLength(1);
    return capture(world.rec.launches[0]!);
  } finally {
    teardown(world);
  }
}

/** Whether a launch call was made with `.ai-implement/image.yml` naming an image that is not allowed. */
async function launchesWithEvilImage(cell: Cell, options: RunOptions): Promise<boolean> {
  let world: World | null = null;
  try {
    world = await boot({ evilImage: true, runnerMode: cell.runnerMode });
    try {
      await cell.run(world, options);
    } catch {
      // A path that refuses by throwing before the launch call has also made no launch call.
    }
    expect(world.rec.unplannedFetch, `${cell.kind} · ${cell.backend} made an unplanned fetch`).toEqual([]);
    return world.rec.launches.length > 0;
  } finally {
    teardown(world);
  }
}

const referenceEnvelopes = new Map<Kind, Promise<RunConfigV1>>();
function referenceEnvelope(kind: Kind): Promise<RunConfigV1> {
  let cached = referenceEnvelopes.get(kind);
  if (!cached) {
    cached = launchOnce(cellOf(kind, "github-actions")).then((captured) => captured.envelope);
    referenceEnvelopes.set(kind, cached);
  }
  return cached;
}

function envelopeFailures(reference: RunConfigV1, actual: RunConfigV1, ignore: readonly string[]): string[] {
  const left = reference as unknown as Record<string, unknown>;
  const right = actual as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].filter((key) => !ignore.includes(key) && !isDeepStrictEqual(left[key], right[key])).map((key) => `envelope:${key}`);
}

function tokenFailures(expected: readonly Audience[], actual: ReadonlySet<Audience>): string[] {
  const all = new Set<Audience>([...expected, ...actual]);
  return [...all].filter((audience) => expected.includes(audience) !== actual.has(audience)).map((audience) => `token:${audience}`);
}

async function failingChecks(cell: Cell): Promise<string[]> {
  const failures: string[] = [];
  const captured = await launchOnce(cell);
  // The reference cell is compared with itself only when it is a different cell of the same kind: review-fix-attempt has a legacy peer.
  const isReference = cell.reference.kind === cell.kind && cell.backend === "github-actions";
  if (!isReference) failures.push(...envelopeFailures(await referenceEnvelope(cell.reference.kind), captured.envelope, cell.reference.ignore));
  failures.push(...tokenFailures(EXPECTED_TOKENS[cell.kind], captured.tokens));
  if (!IMAGE_OUT_OF_SCOPE.some((entry) => entry.backend === cell.backend)) {
    for (const options of cell.imageRuns) {
      if (await launchesWithEvilImage(cell, options)) {
        failures.push("image");
        break;
      }
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  referenceEnvelopes.clear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("launch contract parity", () => {
  it("covers every run kind on every backend, or lists the cell as out of scope with a reason", () => {
    const listed = [...CELLS.map((c) => `${c.kind} · ${c.backend}`), ...OUT_OF_SCOPE_CELLS.map((c) => `${c.kind} · ${c.backend}`)].sort();
    const all = KINDS.flatMap((kind) => BACKENDS.map((backend) => `${kind} · ${backend}`)).sort();
    expect(listed).toEqual(all);
    for (const cell of OUT_OF_SCOPE_CELLS) expect(cell.reason).not.toBe("");
    for (const entry of IMAGE_OUT_OF_SCOPE) expect(entry.reason).not.toBe("");
  });

  it("KNOWN_GAPS names only cells that run and checks that exist", () => {
    const cells = new Set(CELLS.map((c) => `${c.kind} · ${c.backend}`));
    for (const row of KNOWN_GAPS) {
      expect(cells.has(`${row.kind} · ${row.backend}`), `${row.kind} · ${row.backend} is not an in-scope cell`).toBe(true);
      expect(row.check).toMatch(/^(envelope:\w+|token:(result|progress|publication)|image)$/);
      if (row.check === "image") {
        expect(IMAGE_OUT_OF_SCOPE.some((entry) => entry.backend === row.backend), `${row.kind} · ${row.backend} has no image check`).toBe(false);
      }
    }
    const keys = KNOWN_GAPS.map((row) => `${row.kind} · ${row.backend} · ${row.check}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  describe.each(CELLS.map((cell) => [`${cell.kind} · ${cell.backend}`, cell] as const))("%s", (_name, cell) => {
    it("fails exactly the checks listed in KNOWN_GAPS", { timeout: 60_000 }, async () => {
      const actual = (await failingChecks(cell)).sort();
      const known = KNOWN_GAPS
        .filter((row) => row.kind === cell.kind && row.backend === cell.backend)
        .map((row) => row.check)
        .sort();
      expect({
        "fails but is not in KNOWN_GAPS": actual.filter((check) => !known.includes(check)),
        "is in KNOWN_GAPS but passes (remove the row)": known.filter((check) => !actual.includes(check)),
      }).toEqual({ "fails but is not in KNOWN_GAPS": [], "is in KNOWN_GAPS but passes (remove the row)": [] });
    });
  });
});
