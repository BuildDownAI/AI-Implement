// Shared builders for the fixture objects tests construct most often (AII-924).
// Each returns its type without a cast, so a field added to the type fails the type check here, once,
// instead of passing silently through a per-file copy. Overrides are spread last.
// Defaults are neutral literals, not the production DEFAULT_* constants, so a changed product default
// never quietly changes every test that builds a mapping.
import { vi } from "vitest";
import type { RepoMapping } from "../../config.js";
import type { ChatGptPlanRecordV1 } from "../../chatgpt-plan-token.js";
import type { AppConfig } from "../../index.js";
import type { Job, appendLog } from "../../log.js";
import { DefaultPipelineContext } from "../../pipeline/context.js";
import type { FeedbackLoopOutputs } from "../../pipeline/feedback-loop-core.js";
import type { FailureRecord } from "../../pipeline/failure-classification.js";
import type { LLMExecutor, LLMResult, PipelineContextData } from "../../pipeline/types.js";
import { ProviderRegistry } from "../../providers/registry.js";
import type { ProviderId, TicketIssue, TicketingProvider } from "../../providers/types.js";
import type { ReviewFixMetadataV1, ReviewFixResultMetadataV1, ScopedPrIdentity } from "../../review-fix-contract.js";
import type { RunConfigV1 } from "../../run-config.js";

// Matches what getMappings reads back from a stored mapping: an empty planning workflow file returns as
// "claude-plan.yml", and prDispatchBudget is always present.
export function makeMapping(overrides: Partial<RepoMapping> = {}): RepoMapping {
  return {
    owner: "test-org",
    repo: "test-repo",
    workflowFile: "claude-implement.yml",
    defaultBranch: "main",
    maxInProgressAiIssues: 3,
    executionMode: "github-actions",
    sessionMode: "autonomous",
    machineCpus: 2,
    machineMemoryMb: 4096,
    planningEnabled: false,
    planningWorkflowFile: "claude-plan.yml",
    autoApprovePlans: true,
    autoMerge: false,
    extraEnv: {},
    provider: "anthropic",
    ticketingProvider: "linear",
    ticketingConfig: { kind: "linear" },
    awsRegion: null,
    paused: false,
    maxTurns: null,
    maxIterations: null,
    maxJobMinutes: null,
    branchPrefix: null,
    skillsRepo: null,
    referenceRepos: null,
    sensitiveAddPatterns: null,
    sensitiveAllowPatterns: null,
    dependencyTokenScope: null,
    reviewFixLifecycle: null,
    memoryProviderId: null,
    reviewers: null,
    prDispatchBudget: null,
    trustedReviewAuthors: null,
    reviewProcess: null,
    ...overrides,
  };
}

export function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 1,
    issueId: "issue-1",
    issueIdentifier: "ENG-1",
    issueTitle: "Test",
    teamKey: "ENG",
    repo: "test-org/test-repo",
    dispatchedAt: Date.now(),
    dispatchId: null,
    admissionGeneration: null,
    dispatchNumber: 1,
    issueState: null,
    runId: null,
    status: "dispatched",
    conclusion: null,
    prUrl: null,
    completedAt: null,
    notifiedAt: null,
    machineNonce: null,
    executionMode: "github-actions",
    machineId: null,
    runnerMode: null,
    sessionImage: null,
    phase: "implementation",
    contract: null,
    groupingParent: false,
    approved: false,
    failure: null,
    failureCommentedAt: null,
    ...overrides,
  };
}

type AppendLogEntry = Parameters<typeof appendLog>[0];

// The row a GitHub Actions implementation dispatch writes for makeIssue's issue, under its first admission.
// Each build gets its own dispatch id, as each dispatch does; dispatchNumber is left for appendLog to count.
export function makeAppendLogEntry(overrides: Partial<AppendLogEntry> = {}): AppendLogEntry {
  return {
    issueId: "issue-1",
    issueIdentifier: "ENG-1",
    issueTitle: "Test",
    teamKey: "ENG",
    repo: "test-org/test-repo",
    issueState: "Todo (unstarted)",
    dispatchId: crypto.randomUUID(),
    admissionGeneration: 0,
    executionMode: "github-actions",
    runnerMode: "default",
    phase: "implementation",
    contract: "envelope",
    ...overrides,
  };
}

export function makeIssue(overrides: Partial<TicketIssue> = {}): TicketIssue {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Test",
    description: null,
    scopeKey: "ENG",
    nativeStatus: "Todo (unstarted)",
    ...overrides,
  };
}

export function makeScopedPrIdentity(overrides: Partial<ScopedPrIdentity> = {}): ScopedPrIdentity {
  return {
    installationId: 1,
    repository: "test-org/test-repo",
    prNumber: 42,
    ...overrides,
  };
}

// The deadline is an hour ahead of when the result is built, so a default attempt has not expired.
export function makeReviewFixResult(overrides: Partial<ReviewFixResultMetadataV1> = {}): ReviewFixResultMetadataV1 {
  return {
    version: 1,
    attemptId: "attempt-1",
    ...makeScopedPrIdentity(),
    deadlineAt: Date.now() + 60 * 60_000,
    githubRunId: 555,
    githubRunAttempt: 1,
    outputCommit: "a".repeat(40),
    ...overrides,
  };
}

// The envelope the review-fix worker launches a pilot attempt with (buildLaunchInputs, src/review-fix-worker.ts) for a mapping
// with no optional settings: a gap-fill on the attempt's PR, whose issue and PR number derive from the attempt, carrying
// the orchestrator's retry policy as every non-planning envelope does (here the values of a never-edited Settings policy).
export function makeReviewFixRunConfig(
  reviewFix: Partial<ReviewFixMetadataV1> = {},
  overrides: Partial<RunConfigV1> = {},
): RunConfigV1 {
  const attempt: ReviewFixMetadataV1 = {
    version: 1,
    attemptId: "attempt-1",
    ...makeScopedPrIdentity(),
    deadlineAt: Date.now() + 60 * 60_000,
    ...reviewFix,
  };
  const taskText = "Address the review findings on this PR.";
  return {
    v: 1,
    issue: {
      id: `review-fix:${attempt.attemptId}`,
      identifier: `review-fix-${attempt.prNumber}`,
      title: `Review-fix for ${attempt.repository}#${attempt.prNumber}`,
      description: taskText,
    },
    runnerPhase: "gap-analysis",
    runnerCallbackUrl: "https://orchestrator.example",
    prNumber: String(attempt.prNumber),
    commentInstruction: taskText,
    retryPolicy: { requestRetries: 2, stageRetries: 1, pushRetries: 2, backoffInitialMs: 30_000, backoffMaxMs: 300_000, backoffJitter: 0.2, reviewMaxTurns: 30 },
    reviewFix: attempt,
    ...overrides,
  };
}

// A feedback-loop run whose passes, feedback and termination agree with `approved`, `iterations` and
// `terminationReason`, as the step's own outputs do: one pass per iteration, every earlier pass reviewed and
// rejected, and the last one ending the way its termination says (feedback-loop.ts). A `provider_unavailable` run is
// the implement-stage outage. Override `passes` or `finalFeedback` too to describe a run they do not cover.
export function makeFeedbackLoopOutputs(overrides: Partial<FeedbackLoopOutputs> = {}): FeedbackLoopOutputs {
  const terminationReason = overrides.terminationReason ?? (overrides.approved === false ? "iterations_exhausted" : "approved");
  const approved = overrides.approved ?? terminationReason === "approved";
  const iterations = overrides.iterations ?? 1;
  const reviewed = (approvedPass: boolean) => ({
    implementTurns: 1, implementOutcome: "success", costUsd: null, reviewCostUsd: null,
    reviewApproved: approvedPass, attempts: 1, reviewAttempts: 1,
  });
  const lastPass = {
    approved: reviewed(true),
    iterations_exhausted: reviewed(false),
    max_turns: { implementTurns: 50, implementOutcome: "max_turns", costUsd: null, reviewCostUsd: null, reviewApproved: null, attempts: 1 },
    review_error: { ...reviewed(false), reviewApproved: null },
    provider_unavailable: { implementTurns: null, implementOutcome: "error", costUsd: null, reviewCostUsd: null, reviewApproved: null, attempts: 2 },
  }[terminationReason];
  // The default retry policy gives the implement stage two attempts; the terminal record is restamped for the stage.
  const outage: FailureRecord = {
    category: "transient", code: "PROVIDER_UNAVAILABLE", stage: "implement", attempt: 1,
    retryable: false, message: "Provider overloaded (529)", evidence: { truncated: false },
  };
  const finalFeedback = {
    approved: "",
    iterations_exhausted: "Changes requested.",
    max_turns: "Implementation hit the 50-turn cap before completing (50 turns used).",
    review_error: "Review step failed and was skipped: Error: review failed",
    provider_unavailable: `Model provider was unavailable during implementation after 2 attempt(s); partial changes were preserved. ${outage.message}`,
  }[terminationReason];
  return {
    approved,
    iterations,
    finalFeedback,
    terminationReason,
    passes: Array.from({ length: iterations }, (_, i) => ({ iteration: i + 1, ...(i === iterations - 1 ? lastPass : reviewed(false)) })),
    extraCostUsd: null,
    ...(terminationReason === "provider_unavailable" ? { failure: outage } : {}),
    ...overrides,
  };
}

// The overrides apply to the result every invoke resolves with; the default is a clean, empty run.
export function makeExecutor(result: Partial<LLMResult> = {}): LLMExecutor {
  return {
    invoke: vi.fn<LLMExecutor["invoke"]>(async () => ({ stdout: "", exitCode: 0, tokensUsed: 0, ...result })),
  };
}

// The executor is the constructor's second argument, not part of the data, so it stays separate here too.
// Preset a step's outputs on the returned context with setOutputs.
export function makeContext(
  overrides: Partial<PipelineContextData> = {},
  llmExecutor?: LLMExecutor,
): DefaultPipelineContext {
  return new DefaultPipelineContext(
    {
      jobId: 1,
      issueId: "issue-1",
      issueIdentifier: "ENG-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      nonce: "nonce",
      orchestratorUrl: "http://localhost:8080",
      ...overrides,
    },
    llmExecutor,
  );
}

// Every method is a spy typed by its own signature, so a default of the wrong shape fails the type check.
// Each default is passed as the spy's implementation rather than set with mockResolvedValue,
// because mockReset restores an implementation passed to vi.fn but clears a mocked return value.
export function makeProvider(overrides: Partial<TicketingProvider> = {}): TicketingProvider {
  return {
    id: "linear",
    fetchAIImplementSnapshot: vi.fn<TicketingProvider["fetchAIImplementSnapshot"]>(async () => ({
      needsPlanning: [],
      readyForImplementation: [],
      inProgressCountsByScope: {},
      parentsToFinalize: [],
    })),
    fetchLifecycleStates: vi.fn<TicketingProvider["fetchLifecycleStates"]>(async () => new Map()),
    fetchFeatureNodeRollUps: vi.fn<TicketingProvider["fetchFeatureNodeRollUps"]>(async () => []),
    markPlanningStarted: vi.fn<TicketingProvider["markPlanningStarted"]>(async () => {}),
    markPlanComplete: vi.fn<TicketingProvider["markPlanComplete"]>(async () => {}),
    markPlanningFailed: vi.fn<TicketingProvider["markPlanningFailed"]>(async () => true),
    markImplementing: vi.fn<TicketingProvider["markImplementing"]>(async () => {}),
    markPrReady: vi.fn<TicketingProvider["markPrReady"]>(async () => true),
    markImplementationFailed: vi.fn<TicketingProvider["markImplementationFailed"]>(async () => true),
    clearWorkingState: vi.fn<TicketingProvider["clearWorkingState"]>(async () => true),
    markMerged: vi.fn<TicketingProvider["markMerged"]>(async () => {}),
    postComment: vi.fn<TicketingProvider["postComment"]>(async () => {}),
    fetchPlanningContext: vi.fn<TicketingProvider["fetchPlanningContext"]>(async () => ""),
    issueUrl: vi.fn<TicketingProvider["issueUrl"]>((issue) => `https://linear.app/issue/${issue.identifier}`),
    findByKey: vi.fn<TicketingProvider["findByKey"]>(async () => null),
    ...overrides,
  };
}

// ProviderRegistry has private members, so only an instance of it or of a subclass satisfies its type.
// forMapping is the one method that constructs a real provider, and the others reach providers through it,
// so overriding it alone routes every lookup to the given providers while the rest stays real.
class StubProviderRegistry extends ProviderRegistry {
  constructor(
    private readonly providerFor: (mapping: RepoMapping) => TicketingProvider,
    mappings: Record<string, RepoMapping>,
  ) {
    super({}, () => mappings);
  }

  override async forMapping(mapping: RepoMapping): Promise<TicketingProvider> {
    return this.providerFor(mapping);
  }
}

// One provider for every mapping, or one per tracker id; the `never` members make passing both a type error.
type RegistryOptions = { mappings?: Record<string, RepoMapping> } & (
  | { provider?: TicketingProvider; providers?: never }
  | { providers: Partial<Record<ProviderId, TicketingProvider>>; provider?: never }
);

// A tracker missing from `providers` throws, as an unconstructable provider does in production,
// so the real forAllMappings skips it with a warning.
export function makeRegistry(options: RegistryOptions = {}): ProviderRegistry {
  const mappings = options.mappings ?? {};
  if (options.providers) {
    const providers = options.providers;
    return new StubProviderRegistry((mapping) => {
      const provider = providers[mapping.ticketingProvider];
      if (!provider) throw new Error(`makeRegistry has no provider for tracker "${mapping.ticketingProvider}"`);
      return provider;
    }, mappings);
  }
  const provider = options.provider ?? makeProvider();
  return new StubProviderRegistry(() => provider, mappings);
}

// What loadConfig returns when only the two required variables are set: every optional integration off.
// loadConfig is not exported, so the type check is the only thing holding these defaults to the real shape.
export function makeAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    githubAppId: "id",
    githubAppPrivateKey: "key",
    notifyWebhookUrl: null,
    notifyType: "slack",
    adminAccessCode: null,
    oauthRedirectBaseUrl: null,
    pollIntervalMs: 60_000,
    pollCycleTimeoutMs: 10 * 60_000,
    healthPort: 8080,
    flySessionsToken: null,
    flySessionsApp: null,
    flySessionsRegion: null,
    flyOrchestratorApp: null,
    flyDeployToken: null,
    tenantId: null,
    sessionImage: "ghcr.io/builddownai/ai-implement-runner:latest",
    sessionImageStatus: "unused",
    runnerImageExplicit: false,
    anthropicApiKey: null,
    claudeOAuthToken: null,
    githubWebhookSecret: null,
    reaperDryRun: false,
    reaperAlertThreshold: 10,
    runnerCallbackBaseUrl: null,
    runnerTokenSecret: null,
    localRunnerImage: "ai-implement-runner:local",
    localRunnerOrchestratorUrl: null,
    kgSidecarUrl: null,
    kgSourceRepo: null,
    memoryProviderId: null,
    selfDeployTarget: null,
    ...overrides,
  };
}

// The record a ChatGPT plan sign-in saves (login, src/chatgpt-plan-login.ts), saved when it is built. As there, the
// access token's expiry follows savedAt: an hour later, the lifetime refreshChatGptPlanRecord assumes by default.
export function makeChatGptPlanRecord(overrides: Partial<ChatGptPlanRecordV1> = {}): ChatGptPlanRecordV1 {
  const savedAt = overrides.savedAt ?? Date.now();
  return {
    version: 1,
    email: "user@example.com",
    issuer: "https://auth.openai.com",
    subject: "user-1",
    clientId: "client-1",
    extAgentHostId: "urn:uuid:00000000-0000-4000-8000-000000000001",
    idToken: "id-token-1",
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    tokenType: "Bearer",
    scopes: ["chatgpt.tokens.use.direct"],
    accessTokenExpiresAt: savedAt + 60 * 60_000,
    earliestRefreshAt: null,
    savedAt,
    ...overrides,
  };
}
