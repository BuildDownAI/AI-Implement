// Shared builders for the fixture objects tests construct most often (AII-924).
// Each returns its type without a cast, so a field added to the type fails the type check here, once,
// instead of passing silently through a per-file copy. Overrides are spread last.
// Defaults are neutral literals, not the production DEFAULT_* constants, so a changed product default
// never quietly changes every test that builds a mapping.
import { vi } from "vitest";
import type { RepoMapping } from "../../config.js";
import type { AppConfig } from "../../index.js";
import type { Job } from "../../log.js";
import { DefaultPipelineContext } from "../../pipeline/context.js";
import type { LLMExecutor, LLMResult, PipelineContextData } from "../../pipeline/types.js";
import { ProviderRegistry } from "../../providers/registry.js";
import type { TicketIssue, TicketingProvider } from "../../providers/types.js";
import type { ReviewFixResultMetadataV1, ScopedPrIdentity } from "../../review-fix-contract.js";

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
// so overriding it alone routes every lookup to the given provider while the rest stays real.
class StubProviderRegistry extends ProviderRegistry {
  constructor(
    private readonly provider: TicketingProvider,
    mappings: Record<string, RepoMapping>,
  ) {
    super({}, () => mappings);
  }

  override async forMapping(): Promise<TicketingProvider> {
    return this.provider;
  }
}

export function makeRegistry(
  { provider = makeProvider(), mappings = {} }: { provider?: TicketingProvider; mappings?: Record<string, RepoMapping> } = {},
): ProviderRegistry {
  return new StubProviderRegistry(provider, mappings);
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
