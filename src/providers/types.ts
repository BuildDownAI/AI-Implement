import type { FeatureBranchMode } from "../pipeline/branch-name.js";

/** One rung of a feature-branch grouping chain → branch `ai-implement/<mode>/<identifier>`. */
export interface FeatureBranchChainEntry {
  identifier: string;
  mode: FeatureBranchMode;
}

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
   * Populated by the Linear and Jira providers; undefined for others.
   */
  parentRef?: { identifier: string };
  /**
   * Feature-branch grouping chain, set by the Linear and Jira providers for dispatchable issues.
   *
   * Ordered base-most first. Each entry names a grouping branch `ai-implement/<mode>/<identifier>`
   * that must exist before this issue dispatches; each branch is cut from the previous entry's
   * branch (or mapping.defaultBranch for the first). This issue's PR targets the LAST entry's
   * branch. Absent/empty → PR targets mapping.defaultBranch.
   *
   * Entries carry `mode` because a branch name is NOT derivable from an identifier alone —
   * an ancestor's mode comes from its own ai-implement.yml, which only the provider can read.
   *
   * For a leaf the chain ends at its nearest grouping ancestor; for a grouping parent whose
   * AI-Implement children are all terminal, the chain ends at the parent itself (its closing
   * work lands on its own branch). See src/feature-branch.ts.
   */
  featureBranchChain?: FeatureBranchChainEntry[];
  /** AI-Implement Profiles selections from the Jira multi-select field. Jira-only; absent for
   *  Linear issues and for Jira issues without the field or with an empty selection. */
  profiles?: string[];
}

export interface AIImplementSnapshot {
  needsPlanning: TicketIssue[];
  readyForImplementation: TicketIssue[];
  inProgressCountsByScope: Record<string, number>;
}

/**
 * A grouping issue whose branch should be rolled up (see src/merge-up.ts). Produced by the
 * provider from recently-completed AI-Implement issues that have at least one AI-Implement child.
 */
export interface FeatureNodeRollUp {
  /** Provider-internal ID (Linear UUID) — passed to markMerged when the top-of-tree PR is detected as merged. */
  issueId: string;
  /** The grouping node's identifier. */
  identifier: string;
  /** Capacity/scope bucket (team key) — used to resolve the repo mapping. */
  scopeKey: string;
  /** This node's grouping mode → its branch is `ai-implement/<mode>/<identifier>`. */
  mode: FeatureBranchMode;
  /**
   * The grouping parent, when this node has one → roll into the parent's branch via a direct
   * auto-merge. null when there is no grouping parent (top of the tree) → roll into the
   * mapping's base branch via a human-reviewed PR (never auto-merged).
   */
  parent: { identifier: string; mode: FeatureBranchMode } | null;
  /** Identifiers of the grouped AI-Implement children — enumerated in the top-of-tree PR body. */
  childIdentifiers: string[];
}

export type IssueLifecycleState = "active" | "completed" | "cancelled";

export type ProviderId = "linear" | "jira" | (string & {});

export interface TicketingProvider {
  readonly id: string;

  // Discovery
  fetchAIImplementSnapshot(): Promise<AIImplementSnapshot>;
  fetchLifecycleStates(issueIds: string[]): Promise<Map<string, IssueLifecycleState>>;
  /** Recently-completed feature-node issues whose branch should roll up into its
   *  parent (feature-branch grouping merge-up). */
  fetchFeatureNodeRollUps(): Promise<FeatureNodeRollUp[]>;

  // Lifecycle verbs.
  //
  // scopeKey is the authoritative capacity-bucket key the orchestrator chose
  // when it discovered the issue (Linear → team key, Jira → mapping ID). It is
  // carried end-to-end — minted into the run token at dispatch and read back at
  // the callback — so every verb receives it rather than re-deriving it. Linear
  // ignores it (it resolves the team from the issue itself); Jira needs it to
  // pick the right mapping without a fragile repo-field read-back.
  markPlanningStarted(issueId: string, scopeKey: string): Promise<void>;
  markPlanComplete(issueId: string, scopeKey: string): Promise<void>;
  markPlanningFailed(issueId: string, scopeKey: string, reason: string): Promise<void>;
  markImplementing(issueId: string, scopeKey: string): Promise<void>;
  markPrReady(issueId: string, scopeKey: string, prUrl: string): Promise<void>;
  markImplementationFailed(issueId: string, scopeKey: string, reason: string): Promise<void>;
  clearWorkingState(issueId: string, scopeKey: string): Promise<void>;
  /** Move the issue to a completed state after its PR merged. Idempotent:
   *  no-op when the issue is already completed/cancelled. */
  markMerged(issueId: string, scopeKey: string): Promise<void>;

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
