/** A ticket issue, normalized across providers. */
export interface TicketIssue {
  /** Provider-internal ID (Linear UUID, Jira issue ID). */
  id: string;
  /** Human-readable key (Linear "ENG-123", Jira "PROJ-456"). */
  identifier: string;
  title: string;
  description: string | null;
  /**
   * Capacity bucket. The provider chooses what this means:
   * Linear → team key, Jira → mapping ID. The orchestrator buckets
   * counts by this string when applying maxInProgressAiIssues.
   */
  scopeKey: string;
  /** Free-form, for logging only. Never branched on. */
  nativeStatus: string;
  /**
   * Immediate parent identifier, when this issue has a parent. Logging/informational only.
   * Populated by the Linear provider; undefined for other providers.
   */
  parentRef?: { identifier: string };
  /**
   * Feature-branch grouping chain, set by the Linear provider for dispatchable issues.
   *
   * An ordered list of branch names (base-most first). Each branch must exist before this
   * issue dispatches; each branch is cut from the previous entry's branch (or
   * mapping.defaultBranch for the first). This issue's PR targets the LAST entry's branch.
   * Absent/empty → PR targets mapping.defaultBranch.
   *
   * For a leaf under a multi-issue grouping parent (≥2 AI-Implement siblings), the chain
   * contains the parent's `ai-implement/multi-issue/<sorted child keys>` branch name.
   * Grouping ancestors with only one AI-Implement child are dropped (lone child PRs to base).
   * See src/feature-branch.ts.
   */
  featureBranchChain?: string[];
}

export interface AIImplementSnapshot {
  needsPlanning: TicketIssue[];
  readyForImplementation: TicketIssue[];
  inProgressCountsByScope: Record<string, number>;
}

/**
 * An active grouping-container issue whose feature branch should be rolled up into its
 * parent (see src/merge-up.ts). Produced by the provider when an AI-Implement issue with
 * ≥2 AI-Implement children has all those children in a terminal state.
 */
export interface FeatureNodeRollUp {
  /** Provider-internal ID (Linear UUID) — passed to markMerged when the top-of-tree PR is detected as merged. */
  issueId: string;
  /** The feature node's human-readable identifier. For logging only. */
  identifier: string;
  /** Capacity/scope bucket (team key) — used to resolve the repo mapping. */
  scopeKey: string;
  /**
   * Parent identifier when the parent is itself a feature node (has the AI-Implement label).
   * null when there is no feature-node parent (top of tree). Used for logging and internal-vs-top-of-tree
   * distinction; branch names are carried by `branch` and `target`.
   */
  parentIdentifier: string | null;
  /** Pre-computed branch name for this roll-up (e.g., "ai-implement/multi-issue/aii-100-aii-200"). */
  branch: string;
  /**
   * Pre-computed target branch name when the parent is itself a grouping container.
   * null → roll into mapping.defaultBranch via a human-reviewed PR (top of tree, never auto-merged).
   */
  target: string | null;
}

export type IssueLifecycleState = "active" | "completed" | "cancelled";

export type ProviderId = "linear" | "jira" | (string & {});

export interface TicketingProvider {
  readonly id: string;

  // Discovery
  fetchAIImplementSnapshot(): Promise<AIImplementSnapshot>;
  fetchLifecycleStates(issueIds: string[]): Promise<Map<string, IssueLifecycleState>>;
  /** Recently-completed feature-node issues whose branch should roll up into its
   *  parent (feature-branch grouping merge-up). Linear-only; others return []. */
  fetchFeatureNodeRollUps(): Promise<FeatureNodeRollUp[]>;

  // Lifecycle verbs
  markPlanningStarted(issueId: string, scopeKey: string): Promise<void>;
  markPlanComplete(issueId: string): Promise<void>;
  markPlanningFailed(issueId: string, reason: string): Promise<void>;
  markImplementing(issueId: string, scopeKey: string): Promise<void>;
  markPrReady(issueId: string, prUrl: string): Promise<void>;
  markImplementationFailed(issueId: string, reason: string): Promise<void>;
  clearWorkingState(issueId: string): Promise<void>;
  /** Move the issue to a completed state after its PR merged. Idempotent:
   *  no-op when the issue is already completed/cancelled. */
  markMerged(issueId: string): Promise<void>;

  // Communication
  postComment(issueId: string, body: string): Promise<void>;

  /** Planning context produced during the planning phase, formatted for injection
   *  into the implementation prompt. Returns "" when there is none (or on any
   *  fetch error — this is best-effort context, never a hard dependency). */
  fetchPlanningContext(issueId: string): Promise<string>;

  /** Stable user-facing URL for the issue. */
  issueUrl(issue: TicketIssue): string;

  /** Look up an issue by its human-readable identifier (e.g. "ENG-123", "PROJ-456").
   *  Returns null if not found. */
  findByKey(key: string): Promise<TicketIssue | null>;
}

/** Configuration handed to provider factories. */
export interface ProviderConfig {
  linearApiKey?: string;
  linearWorkspaceUrl?: string;
  jiraToken?: string;
  jiraCloudId?: string;
  jiraSiteUrl?: string;
}

/** Factory shape for provider modules (used by resolveProvider). */
export type ProviderFactory = (config: ProviderConfig) => TicketingProvider;

export class UnknownProviderError extends Error {
  constructor(id: string) {
    super(`Unknown ticketing provider: ${id}`);
    this.name = "UnknownProviderError";
  }
}

export class MissingProviderConfigError extends Error {
  constructor(provider: string, key: string) {
    super(`Provider "${provider}" requires config field "${key}"`);
    this.name = "MissingProviderConfigError";
  }
}
