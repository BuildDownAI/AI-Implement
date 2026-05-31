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
   * Parent issue, when this issue is a child of a parent that has children.
   * Populated by the Linear provider only; undefined for other providers.
   * Drives feature-branch grouping (see src/feature-branch.ts). `identifier` names the
   * shared branch; `childCount` is the parent's child count (capped at the query's page size).
   */
  parentRef?: { identifier: string; childCount: number };
}

export interface AIImplementSnapshot {
  needsPlanning: TicketIssue[];
  readyForImplementation: TicketIssue[];
  inProgressCountsByScope: Record<string, number>;
}

export type IssueLifecycleState = "active" | "completed" | "cancelled";

export type ProviderId = "linear" | "jira" | (string & {});

export interface TicketingProvider {
  readonly id: string;

  // Discovery
  fetchAIImplementSnapshot(): Promise<AIImplementSnapshot>;
  fetchLifecycleStates(issueIds: string[]): Promise<Map<string, IssueLifecycleState>>;

  // Lifecycle verbs
  markPlanningStarted(issueId: string, scopeKey: string): Promise<void>;
  markPlanComplete(issueId: string): Promise<void>;
  markPlanningFailed(issueId: string, reason: string): Promise<void>;
  markImplementing(issueId: string, scopeKey: string): Promise<void>;
  markPrReady(issueId: string, prUrl: string): Promise<void>;
  markImplementationFailed(issueId: string, reason: string): Promise<void>;
  clearWorkingState(issueId: string): Promise<void>;

  // Communication
  postComment(issueId: string, body: string): Promise<void>;

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
