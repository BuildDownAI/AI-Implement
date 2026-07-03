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
   * issue dispatches; each is cut from the previous entry's branch (or mapping.defaultBranch
   * for the first). This issue's PR targets the LAST entry. Absent/empty → PR targets
   * mapping.defaultBranch.
   *
   * Branch names are pre-computed by the provider (feature/<key> or multi-issue/<slugs>)
   * so consumers never need to derive them. See src/feature-branch.ts.
   */
  featureBranchChain?: string[];
}

export interface AIImplementSnapshot {
  needsPlanning: TicketIssue[];
  readyForImplementation: TicketIssue[];
  inProgressCountsByScope: Record<string, number>;
}

/**
 * A feature-node or multi-issue-grouping issue whose branch should be rolled up
 * (see src/merge-up.ts). Produced by the provider.
 */
export interface FeatureNodeRollUp {
  /** Provider-internal ID (Linear UUID) — passed to markMerged when the top-of-tree PR is detected as merged. */
  issueId: string;
  /** The issue's human-readable identifier (for logging). */
  identifier: string;
  /** Capacity/scope bucket (team key) — used to resolve the repo mapping. */
  scopeKey: string;
  /**
   * Parent identifier when the parent is itself a grouping node → auto-merge.
   * null when there is no grouping parent → open human-reviewed PR into the base branch.
   */
  parentIdentifier: string | null;
  /** The branch to roll up (e.g. `ai-implement/feature/<key>` or `ai-implement/multi-issue/<slugs>`). */
  branch: string;
  /** The target branch to merge/PR into, or null → mapping.defaultBranch. */
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
