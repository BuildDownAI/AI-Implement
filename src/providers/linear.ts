import { listParked } from "../dispatch-breaker.js";
import type {
  AIImplementSnapshot,
  FeatureBranchChainEntry,
  FeatureNodeRollUp,
  IssueLifecycleState,
  IssueStatusRecord,
  LinearSetupFacts,
  LifecycleLabelsResult,
  TicketIssue,
  TicketingProvider,
  ProviderConfig,
  TrackerIssuePage,
} from "./types.js";
import { getMappings, type RepoMapping } from "../config.js";
import { ISSUE_STATUS_RECENT_MS, MissingProviderConfigError, TrackerUnavailableError } from "./types.js";
import { fetchPlanningContext as fetchLinearPlanningContext } from "../linear-planning-fetch.js";
import { getLinearToken, isLinearAuthConfigured, LinearApiError, withLinearToken } from "../linear-app-auth.js";
import { defaultFetchSignal } from "../github.js";
import { parseIssueConfig } from "../issue-config.js";
import { hasCompatibleFeatureMapping, nonTerminalDesignatedChildren, type FeatureChildState } from "../feature-branch.js";
import { DEFAULT_LINEAR_PICKUP_LABEL, getLinearPickupLabel } from "../orchestrator-settings.js";

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: unknown }>;
}

/** A GraphQL refusal, retaining only the first error's message and structured type. */
export class LinearGraphQLError extends Error {
  constructor(
    readonly operation: string | undefined,
    readonly linearMessage: string,
    readonly extensionsType?: string,
    readonly permanent: boolean = false,
  ) {
    super(`Linear GraphQL error${operation ? ` (${operation})` : ""}: ${linearMessage}`);
    this.name = "LinearGraphQLError";
    // permanent is true when Linear reports a permission refusal (extensions.type forbidden, extensions.code FORBIDDEN, or extensions.statusCode 403), so a retry cannot help.
  }
}

/** A refused label creation, with the issue's actual team and requested label. */
export class LinearLabelWriteError extends LinearGraphQLError {
  readonly action = "create" as const;

  constructor(readonly label: string, readonly teamKey: string, error: LinearGraphQLError) {
    super(error.operation, error.linearMessage, error.extensionsType, error.permanent);
    this.name = "LinearLabelWriteError";
    this.message = `Linear refused to create label "${label}" on team ${teamKey}: ${error.linearMessage}`;
  }
}

/** How far back to scan completed feature nodes for roll-up (bounds the query). */
const ROLLUP_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

/** The labels the lifecycle verbs apply and remove by name, each created in the issue's team at first use unless the team or the workspace has it. */
export const LINEAR_LABELS = {
  planning: { name: "AI-Planning", color: "#8B5CF6" },
  planComplete: { name: "Plan-Complete", color: "#10B981" },
  working: { name: "AI-Working", color: "#F59E0B" },
  readyForReview: { name: "Ready for Review", color: "#4ecdc4" },
} as const;

type LinearLabel = (typeof LINEAR_LABELS)[keyof typeof LINEAR_LABELS];

/** The label `ensureTeamLabel` reuses among case-insensitive matches: the team's own, else a workspace label. */
export function reusableLabel<T>(matches: T[], teamOf: (label: T) => string | null, team: string): T | undefined {
  return matches.find((label) => teamOf(label) === team) ?? matches.find((label) => teamOf(label) === null);
}

/** Pickup label. Default shown here; the effective value is refreshed from the
 *  settings table (`linear_pickup_label`, /admin#settings) at the start of each poll. */
let AI_IMPLEMENT_LABEL = DEFAULT_LINEAR_PICKUP_LABEL;
function refreshPickupLabel(): void {
  AI_IMPLEMENT_LABEL = getLinearPickupLabel();
}

/** A node in the ancestor chain: identifier + description + labels, with a nullable parent. */
type AncestorNode = {
  identifier: string;
  team: { key: string };
  description?: string | null;
  labels?: { nodes: Array<{ name: string }> };
  parent?: AncestorNode | null;
} | null;

function isTerminalStateType(type: string | null | undefined): boolean {
  return type === "completed" || type === "canceled" || type === "duplicate";
}

/**
 * Walks up the ancestor chain from `parent` while each ancestor carries the AI-Implement
 * label, returning the contiguous run of labeled ancestors base-most first, each paired with
 * its grouping mode.
 *
 * Because this issue is itself an AI-Implement child, any labeled ancestor in this run is a
 * grouping node (it has >=1 AI-Implement child — the one below it), so the run is exactly the
 * nest of branches this issue's PR should cascade through, and every entry can name its own
 * branch from its identifier + mode. The walk stops at the first unlabeled ancestor (its child
 * cuts from the base branch, not a grouping branch).
 */
/** Maps a Linear children-query node list to the provider-agnostic child-readiness shape
 *  (see src/feature-branch.ts). Designated = carries the pickup label; terminal =
 *  tracker state is completed, cancelled or duplicate — never inferred from a job row. */
function childFeatureStates(
  children: Array<{ identifier: string; state?: { type: string } | null; labels?: { nodes: Array<{ name: string }> } }>,
): FeatureChildState[] {
  return children.map((c) => ({
    identifier: c.identifier,
    designated: (c.labels?.nodes ?? []).some((l) => l.name === AI_IMPLEMENT_LABEL),
    terminal: isTerminalStateType(c.state?.type),
  }));
}

function labeledAncestorChain(parent: AncestorNode): Array<FeatureBranchChainEntry & { scopeKey: string }> {
  const collected: Array<FeatureBranchChainEntry & { scopeKey: string }> = [];
  let node = parent;
  while (node) {
    const hasLabel = (node.labels?.nodes ?? []).some((l) => l.name === AI_IMPLEMENT_LABEL);
    if (!hasLabel) break;
    collected.push({
      identifier: node.identifier,
      scopeKey: node.team.key,
      mode: parseIssueConfig(node.description, node.identifier).config.featureBranch.mode,
    });
    node = node.parent ?? null;
  }
  return collected.reverse();
}

/** Linear's refusal of the app's token, as setup facts, or null while the app holds a token. */
async function tokenRefusal(): Promise<LinearSetupFacts | null> {
  try {
    await getLinearToken();
    return null;
  } catch (err) {
    return {
      kind: "linear",
      token: "refused",
      status: err instanceof LinearApiError ? err.status : null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export class LinearProvider implements TicketingProvider {
  readonly id = "linear";
  private static readonly MOVABLE_STATE_TYPES = new Set(["triage", "backlog", "unstarted"]);
  private readonly workspaceUrl: string;

  // Caches keyed by team key (the scopeKey passed through the interface).
  private aiPlanningLabelCache = new Map<string, string>();
  private aiWorkingLabelCache = new Map<string, string>();
  private planCompleteLabelCache = new Map<string, string>();
  private readyForReviewLabelCache = new Map<string, string>();
  private teamIdByKey = new Map<string, string>();
  private inProgressStateByTeamKey = new Map<string, string>();
  private canceledStateByTeamKey = new Map<string, string>();
  private completedStateByTeamKey = new Map<string, string>();

  constructor(config: ProviderConfig) {
    if (!isLinearAuthConfigured()) {
      throw new MissingProviderConfigError("linear", "linearClientId/linearClientSecret");
    }
    this.workspaceUrl = config.linearWorkspaceUrl ?? "https://linear.app";
  }

  issueUrl(issue: TicketIssue): string {
    return `${this.workspaceUrl}/issue/${issue.identifier}`;
  }

  async createChildIssue(parentId: string, _scopeKey: string, content: { title: string; body: string }): Promise<{ id: string; identifier: string }> {
    const { issue: parent } = await this.linearMutation<{ issue: { id: string; team: { id: string } } | null }>(
      `query($parentId: String!) { issue(id: $parentId) { id team { id } } }`, { parentId },
    );
    if (!parent) throw new Error("Linear parent issue not found");
    const name = getLinearPickupLabel();
    const labels = await this.linearMutation<{ issueLabels: { nodes: Array<{ id: string; name: string; team: { id: string } | null }> } }>(
      `query($name: String!) { issueLabels(filter: { name: { eq: $name } }) { nodes { id name team { id } } } }`, { name },
    );
    const label = reusableLabel(labels.issueLabels.nodes.filter((l) => l.name === name), (l) => l.team?.id ?? null, parent.team.id);
    if (!label) throw new Error(`Linear pickup label "${name}" is unavailable for the parent's team`);
    const result = await this.linearMutation<{ issueCreate: { success: boolean; issue: { id: string; identifier: string } | null } }>(
      `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }`,
      { input: { parentId: parent.id, teamId: parent.team.id, title: content.title, description: content.body, labelIds: [label.id] } },
    );
    if (!result.issueCreate.success || !result.issueCreate.issue) throw new Error("Linear child issue creation failed");
    return result.issueCreate.issue;
  }

  async findByKey(key: string): Promise<TicketIssue | null> {
    const match = /^([A-Z][A-Z0-9_]*)-(\d+)$/.exec(key);
    if (!match) return null;
    const [, teamKey, numberStr] = match;
    const number = parseInt(numberStr, 10);
    const data = await this.linearMutation<{ issues: { nodes: Array<{
      id: string; identifier: string; title: string; description: string | null;
      team: { key: string };
      state: { name: string; type: string };
    }> } }>(
      `query($teamKey: String!, $number: Float!) {
        issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 1) {
          nodes { id identifier title description team { key } state { name type } }
        }
      }`,
      { teamKey, number },
    );
    const node = data.issues.nodes[0];
    if (!node) return null;
    return {
      id: node.id,
      identifier: node.identifier,
      title: node.title,
      description: node.description,
      scopeKey: node.team.key,
      nativeStatus: `${node.state.name} (${node.state.type})`,
    };
  }

  async fetchPlanningContext(issueId: string): Promise<string> {
    return fetchLinearPlanningContext({ issueId });
  }

  async listIssuesPage(mapping: RepoMapping, cursor: string | null, filter?: { titlePrefix: string }): Promise<TrackerIssuePage> {
    if (!isLinearAuthConfigured()) throw new TrackerUnavailableError("Linear credential not configured");
    if (!mapping.teamKey) throw new TrackerUnavailableError("mapping carries no team key");
    const hasTitlePrefix = filter?.titlePrefix !== undefined;
    const data = await this.linearMutation<{ issues?: { nodes: TrackerIssuePage["issues"]; pageInfo: TrackerIssuePage["pageInfo"] } }>(
      `query($teamKey: String!, $first: Int!, $after: String${hasTitlePrefix ? ", $title: String" : ""}) {
        issues(filter: { team: { key: { eq: $teamKey } }${hasTitlePrefix ? ", title: { startsWith: $title }" : ""} }, first: $first, after: $after, orderBy: updatedAt) {
          nodes {
            id identifier title description branchName
            state { name type }
            labels { nodes { name } }
            project { name }
            parent { identifier }
            comments(first: 100) { nodes { body user { name } createdAt } }
            relations { nodes { type relatedIssue { identifier } } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { teamKey: mapping.teamKey, first: 50, after: cursor, ...(hasTitlePrefix ? { title: filter.titlePrefix } : {}) },
    );
    return {
      issues: data.issues?.nodes ?? [],
      pageInfo: data.issues?.pageInfo ?? { hasNextPage: false, endCursor: null },
    };
  }

  async listIssueStatuses(mapping: RepoMapping): Promise<IssueStatusRecord[]> {
    refreshPickupLabel();
    if (!isLinearAuthConfigured()) throw new TrackerUnavailableError("Linear credential not configured");
    if (!mapping.teamKey) throw new TrackerUnavailableError("mapping carries no team key");
    const label = AI_IMPLEMENT_LABEL;
    const since = new Date(Date.now() - ISSUE_STATUS_RECENT_MS).toISOString();
    type StatusNode = {
      id: string; identifier: string; title: string; updatedAt: string;
      state: { name: string; type: string };
      labels: { nodes: Array<{ name: string }> };
    };
    type StatusPage = { issues: {
      nodes: StatusNode[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    } };
    const nodes = new Map<string, StatusNode>();
    for (const recent of [false, true]) {
      const query = `query($teamKey: String!, $label: String!, $first: Int!, $after: String${recent ? ", $since: DateTimeOrDuration!" : ""}) {
        issues(first: $first, after: $after, filter: {
          team: { key: { eq: $teamKey } }
          labels: { name: { eq: $label } }
          ${recent ? "completedAt: { gte: $since }" : 'state: { type: { nin: ["completed", "canceled", "duplicate"] } }'}
        }) {
          nodes { id identifier title updatedAt state { name type } labels { nodes { name } } }
          pageInfo { hasNextPage endCursor }
        }
      }`;
      let after: string | null = null;
      for (let page = 1; ; page++) {
        const data: StatusPage = await this.linearMutation<StatusPage>(query, {
          teamKey: mapping.teamKey, label, first: 100, after, ...(recent ? { since } : {}),
        });
        for (const node of data.issues.nodes) nodes.set(node.id, node);
        const { hasNextPage, endCursor } = data.issues.pageInfo;
        if (!hasNextPage) break;
        if (page >= 20) throw new Error("Linear listIssueStatuses exceeded 20 pages");
        if (!endCursor || endCursor === after) throw new Error("Linear listIssueStatuses missing advancing cursor");
        after = endCursor;
      }
    }

    const precedence: Array<[string, IssueStatusRecord["state"]]> = [
      [LINEAR_LABELS.readyForReview.name, "pr-ready"],
      [LINEAR_LABELS.working.name, "implementing"],
      [LINEAR_LABELS.planComplete.name, "plan-approved"],
      [LINEAR_LABELS.planning.name, "planning"],
      [label, "ready"],
    ];
    const records: IssueStatusRecord[] = [];
    for (const node of nodes.values()) {
      if (node.state.type === "canceled" || node.state.type === "duplicate") continue;
      const labels = node.labels.nodes.map((l) => l.name);
      const deciding = precedence.find(([name]) => labels.includes(name)) ?? [label, "ready"];
      const completed = node.state.type === "completed";
      records.push({
        id: node.id, identifier: node.identifier, title: node.title,
        url: this.issueUrl({ id: node.id, identifier: node.identifier, title: node.title, description: null, scopeKey: mapping.teamKey, nativeStatus: node.state.name }),
        state: completed ? "merged" : deciding[1], phase: null,
        labels: completed ? [] : [deciding[0], ...labels.filter((name) => name !== deciding[0])],
        workflowState: node.state.name, updatedAt: Date.parse(node.updatedAt),
      });
    }
    return records;
  }

  async fetchSetupFacts(teamKeys: string[]): Promise<LinearSetupFacts> {
    const refused = await tokenRefusal();
    if (refused) return refused;
    try {
      return await this.querySetupFacts(teamKeys);
    } catch (err) {
      // A cached token revoked since it was minted, as a rotated client secret does, fails the query with a 401, and the re-mint after it is refused too.
      // That is the credentials' fault, so report it as the first mint's refusal is reported.
      if (err instanceof LinearApiError) {
        const refusedNow = await tokenRefusal();
        if (refusedNow) return refusedNow;
      }
      throw err;
    }
  }

  private async querySetupFacts(teamKeys: string[]): Promise<LinearSetupFacts> {
    const pickupLabel = getLinearPickupLabel();
    const names = [pickupLabel, ...Object.values(LINEAR_LABELS).map((label) => label.name)];
    const data = await this.linearMutation<{
      teams: { nodes: Array<{ key: string; started: { nodes: unknown[] }; completed: { nodes: unknown[] } }>; pageInfo: { hasNextPage: boolean } };
      issueLabels: { nodes: Array<{ name: string; team: { key: string } | null }>; pageInfo: { hasNextPage: boolean } };
    }>(
      // Linear refuses a query costing over 10,000 complexity points, and a connection with no `first` counts as 50 nodes.
      // One state of each type is all the checks need, so each team costs a few points instead of fifty states.
      `query($keys: [String!]!, $names: [IssueLabelFilter!]!) {
        teams(first: 250, filter: { key: { in: $keys } }) {
          nodes {
            key
            started: states(first: 1, filter: { type: { eq: "started" } }) { nodes { id } }
            completed: states(first: 1, filter: { type: { eq: "completed" } }) { nodes { id } }
          }
          pageInfo { hasNextPage }
        }
        issueLabels(first: 250, filter: { and: [{ or: $names }, { or: [{ team: { null: true } }, { team: { key: { in: $keys } } }] }] }) {
          nodes { name team { key } }
          pageInfo { hasNextPage }
        }
      }`,
      { keys: teamKeys, names: names.map((name) => ({ name: { eqIgnoreCase: name } })) },
    );
    // A cut-off list would read as a team the app cannot see or a missing label, so refuse it rather than let a check judge it.
    if (data.teams.pageInfo.hasNextPage) throw new Error("More teams match than one read returns.");
    if (data.issueLabels.pageInfo.hasNextPage) throw new Error("More labels match than one read returns.");
    return {
      kind: "linear",
      token: "minted",
      pickupLabel,
      teams: Object.fromEntries(data.teams.nodes.map((team) => [
        team.key,
        (["started", "completed"] as const).filter((type) => team[type].nodes.length > 0),
      ])),
      labels: Object.fromEntries(names.map((name) => [
        name,
        data.issueLabels.nodes
          .filter((label) => label.name.toLowerCase() === name.toLowerCase())
          .map((label) => ({ name: label.name, teamKey: label.team?.key ?? null })),
      ])),
    };
  }

  private async linearMutation<T>(
    query: string,
    variables: Record<string, unknown>,
    operation?: string,
  ): Promise<T> {
    const res = await withLinearToken((token) =>
      fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ query, variables }),
        signal: defaultFetchSignal(),
      }),
    );

    if (!res.ok) {
      const body = await res.text();
      throw new LinearApiError(res.status, body, `Linear API error: ${res.status} ${res.statusText} — ${body}`);
    }

    const json = (await res.json()) as GraphQLResponse<T>;
    if (json.errors?.length) {
      const error = json.errors[0];
      const extensions = error.extensions;
      let extensionsType: string | undefined;
      let permanent = false;
      if (extensions && typeof extensions === "object") {
        permanent = ("type" in extensions && extensions.type === "forbidden")
          || ("code" in extensions && extensions.code === "FORBIDDEN")
          || ("statusCode" in extensions && extensions.statusCode === 403);
        if ("type" in extensions && typeof extensions.type === "string") extensionsType = extensions.type;
        else if ("code" in extensions && typeof extensions.code === "string") extensionsType = extensions.code;
      }
      throw new LinearGraphQLError(operation, error.message, extensionsType, permanent);
    }
    if (!json.data) {
      throw new Error("Linear API returned no data");
    }
    return json.data;
  }

  async fetchAIImplementSnapshot(): Promise<AIImplementSnapshot> {
    refreshPickupLabel();
    const PAGE_SIZE = 100;
    const query = `
      query($first: Int!, $after: String, $label: String!) {
        issues(
          first: $first
          after: $after
          filter: {
            labels: { name: { eq: $label } }
            state: {
              type: { nin: ["completed", "canceled", "duplicate"] }
            }
          }
        ) {
          nodes {
            id
            identifier
            title
            description
            team { id key }
            state { id name type }
            labels { nodes { id name } }
            inverseRelations(first: 50) {
              nodes { type issue { state { type } } }
            }
            # This issue's direct children, with labels + state — drives feature-node vs.
            # leaf classification and the "parent waits for all AI children" gate.
            # first:50 caps the count; parents with >50 children degrade gracefully.
            children(first: 50) {
              nodes {
                identifier
                state { type }
                labels { nodes { name } }
              }
            }
            # Ancestor chain — used to build the cascading grouping-branch chain. Each level
            # carries description so its ai-implement.yml mode can be resolved. children are NOT
            # needed: a branch name is a function of the ancestor's identifier + mode only.
            # Nested to a fixed depth; deeper ancestries cut from the base branch.
            parent {
              identifier
              description
              team { key }
              labels { nodes { name } }
              parent {
                identifier
                description
                team { key }
                labels { nodes { name } }
                parent {
                  identifier
                  description
                  team { key }
                  labels { nodes { name } }
                  parent {
                    identifier
                    description
                    team { key }
                    labels { nodes { name } }
                    parent {
                      identifier
                      description
                      team { key }
                      labels { nodes { name } }
                    }
                  }
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    type LinearLabelNodes = { nodes: Array<{ name: string }> };
    type LinearAncestor = {
      identifier: string;
      team: { key: string };
      description: string | null;
      labels: LinearLabelNodes;
      parent: LinearAncestor | null;
    };

    type LinearIssueResponse = {
      id: string;
      identifier: string;
      title: string;
      description: string | null;
      team: { id: string; key: string };
      state: { id: string; name: string; type: string };
      labels: { nodes: Array<{ id: string; name: string }> };
      inverseRelations: { nodes: Array<{ type: string; issue: { state: { type: string } } }> };
      children: { nodes: Array<{ identifier: string; state: { type: string }; labels: LinearLabelNodes }> };
      parent: LinearAncestor | null;
    };

    type IssuePage = {
      issues: {
        nodes: LinearIssueResponse[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    };

    const MAX_PAGES = 20;
    const allNodes: LinearIssueResponse[] = [];
    let cursor: string | null = null;
    let page = 0;

    do {
      const data: IssuePage = await this.linearMutation<IssuePage>(query, {
        first: PAGE_SIZE,
        after: cursor,
        label: AI_IMPLEMENT_LABEL,
      });
      allNodes.push(...data.issues.nodes);
      cursor = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null;
      if (++page >= MAX_PAGES) {
        console.warn(
          `[linear] fetchAIImplementSnapshot hit max pages (${MAX_PAGES}), ${allNodes.length} issues fetched`,
        );
        break;
      }
    } while (cursor !== null);

    if (allNodes.length === 0) {
      console.log(`[linear] No open issues carry the pickup label "${AI_IMPLEMENT_LABEL}"`);
    }

    const inProgressCountsByScope: Record<string, number> = {};
    const needsPlanning: AIImplementSnapshot["needsPlanning"] = [];
    const readyForImplementation: AIImplementSnapshot["readyForImplementation"] = [];
    const parentsToFinalize: AIImplementSnapshot["parentsToFinalize"] = [];

    const parkedIds = new Set(listParked().map(row => row.issueId));
    let mappings: Record<string, RepoMapping> | undefined;
    for (const issue of allNodes) {
      const labelNames = new Set(issue.labels?.nodes?.map((l) => l.name) ?? []);

      // The park record holds the issue and releases its capacity slot.
      if (parkedIds.has(issue.id)) continue;

      // AI-Working or AI-Planning = slot is occupied; count against capacity
      if (labelNames.has(LINEAR_LABELS.working.name) || labelNames.has(LINEAR_LABELS.planning.name)) {
        inProgressCountsByScope[issue.team.key] = (inProgressCountsByScope[issue.team.key] ?? 0) + 1;
        continue;
      }

      if (labelNames.has(LINEAR_LABELS.readyForReview.name)) {
        continue;
      }

      const isBlocked =
        issue.inverseRelations?.nodes?.some(
          (r) =>
            r.type === "blocks" &&
            !isTerminalStateType(r.issue?.state?.type),
        ) ?? false;
      if (isBlocked) {
        console.log(`[linear] Skipping ${issue.identifier}: blocked by an incomplete issue`);
        continue;
      }

      // Feature-branch grouping (see src/feature-branch.ts). An AI-Implement issue is one of:
      //   - leaf (no children)            → implement now; PR targets nearest grouping-node
      //                                      ancestor branch (or base).
      //   - grouping node (>=1 AI child)  → its own work waits until ALL its AI-Implement
      //                                      children reach a terminal state, then implements
      //                                      onto its OWN branch (ai-implement/<mode>/<key>,
      //                                      mode from ai-implement.yml, default "feature").
      //                                      While children are in flight the parent is
      //                                      skipped (its branch is cut lazily when the first
      //                                      child dispatches).
      //   - waiting parent (children but  → skipped (race guard: the parent was labeled before
      //     none AI-Implement yet)          its children were, so let it sit).
      const children = issue.children?.nodes ?? [];
      const aiChildren = children.filter((c) => (c.labels?.nodes ?? []).some((l) => l.name === AI_IMPLEMENT_LABEL));
      const ancestors = labeledAncestorChain(issue.parent);
      if (ancestors.some((ancestor) => !hasCompatibleFeatureMapping(
        { identifier: issue.identifier, scopeKey: issue.team.key }, ancestor, mappings ??= getMappings(),
      ))) continue;
      const ancestorChain = ancestors.map(({ identifier, mode }) => ({ identifier, mode }));
      const parsed = parseIssueConfig(issue.description, issue.identifier);
      const mode = parsed.config.featureBranch.mode;

      let featureBranchChain: FeatureBranchChainEntry[] | undefined;
      if (children.length === 0) {
        // Leaf. Its own ai-implement.yml (if any) is irrelevant — it owns no branch.
        featureBranchChain = ancestorChain.length > 0 ? ancestorChain : undefined;
      } else if (aiChildren.length > 0) {
        const blockingChildren = nonTerminalDesignatedChildren(childFeatureStates(children));
        if (blockingChildren.length > 0) {
          console.log(
            `[linear] Skipping ${issue.identifier}: ${mode} grouping parent waiting on in-flight AI-Implement children: ${blockingChildren.map((c) => c.identifier).join(", ")}`,
          );
          continue;
        }
        // AII-349 race guard: if any child without the pickup label is still active, the
        // operator may be mid-way through labeling children. Wait until they are designated or
        // reach a terminal state — same guard the no-AI-children path already applies.
        const anyUndesignatedActive = children.some(
          (c) =>
            !(c.labels?.nodes ?? []).some((l) => l.name === AI_IMPLEMENT_LABEL) &&
            !isTerminalStateType(c.state?.type),
        );
        if (anyUndesignatedActive) {
          console.log(`[linear] Skipping ${issue.identifier}: ${mode} grouping parent has undesignated non-terminal children`);
          continue;
        }
        // All AI-Implement children done. If the spec is empty, finalize instead of dispatching.
        const isBlankSpec = !parsed.description || parsed.description.trim() === "";
        if (isBlankSpec) {
          console.log(`[linear] Finalizing empty grouping parent ${issue.identifier} (no own work)`);
          parentsToFinalize.push({ issueId: issue.id, identifier: issue.identifier, scopeKey: issue.team.key });
          continue;
        }
        featureBranchChain = [...ancestorChain, { identifier: issue.identifier, mode }];
      } else {
        console.log(`[linear] Skipping ${issue.identifier}: parent labeled but no child has "${AI_IMPLEMENT_LABEL}" set yet`);
        continue;
      }

      const ticketIssue: TicketIssue = {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: parsed.description,
        scopeKey: issue.team.key,
        nativeStatus: `${issue.state.name} (${issue.state.type})`,
        ...(issue.parent ? { parentRef: { identifier: issue.parent.identifier } } : {}),
        ...(featureBranchChain ? { featureBranchChain } : {}),
      };

      if (labelNames.has(LINEAR_LABELS.planComplete.name)) {
        readyForImplementation.push(ticketIssue);
      } else {
        needsPlanning.push(ticketIssue);
      }
    }

    return { needsPlanning, readyForImplementation, inProgressCountsByScope, parentsToFinalize };
  }

  async fetchFeatureNodeRollUps(): Promise<FeatureNodeRollUp[]> {
    // Recently-completed AI-Implement issues that are feature nodes (>=1 AI-Implement
    // child) need their feature branch rolled up into the parent. Bound the scan to a
    // recent window so the set stays small; the merge-up step skips already-merged
    // branches cheaply via a branch comparison. A completed feature node implies its
    // own closing work merged and all its children done.
    refreshPickupLabel();
    const since = new Date(Date.now() - ROLLUP_LOOKBACK_MS).toISOString();
    const PAGE_SIZE = 100;
    const MAX_PAGES = 20;
    const query = `query($first: Int!, $after: String, $since: DateTimeOrDuration!, $label: String!) {
        issues(
          first: $first
          after: $after
          filter: {
            labels: { name: { eq: $label } }
            state: { type: { eq: "completed" } }
            updatedAt: { gt: $since }
          }
        ) {
          nodes {
            id
            identifier
            description
            team { key }
            children(first: 50) { nodes { identifier state { type } labels { nodes { name } } } }
            parent { identifier description labels { nodes { name } } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`;
    type RollUpNode = {
      id: string;
      identifier: string;
      description: string | null;
      team: { key: string };
      children: { nodes: Array<{ identifier: string; state: { type: string }; labels: { nodes: Array<{ name: string }> } }> };
      parent: { identifier: string; description: string | null; labels: { nodes: Array<{ name: string }> } } | null;
    };
    type RollUpPage = {
      issues?: { nodes?: RollUpNode[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } };
    };

    const allNodes: RollUpNode[] = [];
    let cursor: string | null = null;
    let page = 0;
    do {
      const data: RollUpPage = await this.linearMutation<RollUpPage>(query, {
        first: PAGE_SIZE,
        after: cursor,
        since,
        label: AI_IMPLEMENT_LABEL,
      });
      allNodes.push(...(data.issues?.nodes ?? []));
      cursor = data.issues?.pageInfo?.hasNextPage ? (data.issues?.pageInfo?.endCursor ?? null) : null;
      if (++page >= MAX_PAGES && cursor !== null) {
        console.warn(
          `[linear] fetchFeatureNodeRollUps hit max pages (${MAX_PAGES}), ${allNodes.length} issues fetched`,
        );
        break;
      }
    } while (cursor !== null);

    const rollUps: FeatureNodeRollUp[] = [];
    for (const node of allNodes) {
      const childStates = childFeatureStates(node.children?.nodes ?? []);
      const aiChildren = childStates.filter((c) => c.designated);
      if (aiChildren.length === 0) continue;
      // A node's own tracker state reaching "completed" doesn't guarantee its children
      // have too — the dispatch gate and this roll-up gate run independently, so a node
      // can complete its own closing work while a child is still mid-implementation.
      // Re-check live rather than trusting "parent completed" as a proxy (AII-609).
      const blockingChildren = nonTerminalDesignatedChildren(childStates);
      if (blockingChildren.length > 0) {
        console.log(
          `[linear] Deferring roll-up for ${node.identifier}: waiting on in-flight AI-Implement children: ${blockingChildren.map((c) => c.identifier).join(", ")}`,
        );
        continue;
      }
      const parentIsFeatureNode =
        !!node.parent && (node.parent.labels?.nodes ?? []).some((l) => l.name === AI_IMPLEMENT_LABEL);
      rollUps.push({
        issueId: node.id,
        identifier: node.identifier,
        scopeKey: node.team.key,
        mode: parseIssueConfig(node.description, node.identifier).config.featureBranch.mode,
        parent: parentIsFeatureNode
          ? {
              identifier: node.parent!.identifier,
              mode: parseIssueConfig(node.parent!.description, node.parent!.identifier).config.featureBranch.mode,
            }
          : null,
        childIdentifiers: aiChildren.map((c) => c.identifier),
      });
    }
    return rollUps;
  }

  async fetchLifecycleStates(issueIds: string[]): Promise<Map<string, IssueLifecycleState>> {
    if (issueIds.length === 0) return new Map();
    const data = await this.linearMutation<{ issues: { nodes: Array<{ id: string; state: { type: string } }> } }>(
      `query($ids: [ID!]) {
        issues(filter: { id: { in: $ids } }, first: 250) {
          nodes { id state { type } }
        }
      }`,
      { ids: issueIds },
    );
    const result = new Map<string, IssueLifecycleState>();
    for (const node of data.issues.nodes) {
      let lifecycle: IssueLifecycleState;
      if (node.state.type === "completed") lifecycle = "completed";
      else if (isTerminalStateType(node.state.type)) lifecycle = "cancelled";
      else lifecycle = "active";
      result.set(node.id, lifecycle);
    }
    return result;
  }
  // ---------- private helpers ----------

  private async getTeamIdByKey(teamKey: string): Promise<string> {
    const cached = this.teamIdByKey.get(teamKey);
    if (cached) return cached;
    const data = await this.linearMutation<{
      teams: { nodes: Array<{ id: string; key: string }> };
    }>(
      `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key } } }`,
      { key: teamKey },
    );
    const team = data.teams.nodes[0];
    if (!team) throw new Error(`Linear team with key "${teamKey}" not found`);
    this.teamIdByKey.set(teamKey, team.id);
    return team.id;
  }

  private async ensureTeamLabel(teamKey: string, label: LinearLabel, cache: Map<string, string>): Promise<string> {
    const cached = cache.get(teamKey);
    if (cached) return cached;
    const teamId = await this.getTeamIdByKey(teamKey);

    // Search case-insensitively across the workspace: Linear's uniqueness check
    // on issueLabelCreate is case-insensitive and treats a workspace-level label
    // as conflicting with a team-level label of the same name. Prefer the
    // requested team's label, otherwise reuse only a workspace-level label. A
    // label scoped to a different team cannot be applied to this issue.
    const searchData = await this.linearMutation<{
      issueLabels: {
        nodes: Array<{ id: string; team: { id: string } | null }>;
      };
    }>(
      `query($name: String!) {
        issueLabels(filter: { name: { eqIgnoreCase: $name } }) {
          nodes { id team { id } }
        }
      }`,
      { name: label.name },
    );
    const reusableMatch = reusableLabel(searchData.issueLabels.nodes, (n) => n.team?.id ?? null, teamId);
    if (reusableMatch) {
      cache.set(teamKey, reusableMatch.id);
      return reusableMatch.id;
    }

    try {
      const createData = await this.linearMutation<{
        issueLabelCreate: { issueLabel: { id: string } };
      }>(
        `mutation($teamId: String!, $name: String!, $color: String!) {
          issueLabelCreate(input: { teamId: $teamId, name: $name, color: $color }) {
            issueLabel { id }
          }
        }`,
        { teamId, name: label.name, color: label.color },
        "issueLabelCreate",
      );
      console.log(`[linear] Created '${label.name}' label for team ${teamId}`);
      const id = createData.issueLabelCreate.issueLabel.id;
      cache.set(teamKey, id);
      return id;
    } catch (error) {
      if (error instanceof LinearGraphQLError) {
        throw new LinearLabelWriteError(label.name, teamKey, error);
      }
      throw error;
    }
  }

  private async getInProgressStateId(teamKey: string): Promise<string> {
    const cached = this.inProgressStateByTeamKey.get(teamKey);
    if (cached) return cached;
    const teamId = await this.getTeamIdByKey(teamKey);

    const data = await this.linearMutation<{
      workflowStates: { nodes: Array<{ id: string; name: string; type: string }> };
    }>(
      `query($teamId: ID!) {
        workflowStates(filter: { team: { id: { eq: $teamId } }, type: { eq: "started" } }) {
          nodes { id name type }
        }
      }`,
      { teamId },
    );

    const state =
      data.workflowStates.nodes.find((s) => s.name === "In Progress") ??
      data.workflowStates.nodes[0];
    if (!state) {
      throw new Error(`No "started" workflow state found for team ${teamId}`);
    }
    this.inProgressStateByTeamKey.set(teamKey, state.id);
    return state.id;
  }

  private async getCompletedStateId(teamKey: string): Promise<string> {
    const cached = this.completedStateByTeamKey.get(teamKey);
    if (cached) return cached;
    const teamId = await this.getTeamIdByKey(teamKey);
    const data = await this.linearMutation<{
      workflowStates: { nodes: Array<{ id: string; name: string; type: string }> };
    }>(
      `query($teamId: ID!) {
        workflowStates(filter: { team: { id: { eq: $teamId } }, type: { eq: "completed" } }) {
          nodes { id name type }
        }
      }`,
      { teamId },
    );
    const state =
      data.workflowStates.nodes.find((s) => s.name.toLowerCase() === "done") ??
      data.workflowStates.nodes[0];
    if (!state) {
      throw new Error(`No "completed" workflow state found for team ${teamId}`);
    }
    this.completedStateByTeamKey.set(teamKey, state.id);
    return state.id;
  }

  private async getCanceledStateId(teamKey: string): Promise<string> {
    const cached = this.canceledStateByTeamKey.get(teamKey);
    if (cached) return cached;
    const teamId = await this.getTeamIdByKey(teamKey);
    const data = await this.linearMutation<{
      workflowStates: { nodes: Array<{ id: string; name: string; type: string }> };
    }>(
      `query($teamId: ID!) {
        workflowStates(filter: { team: { id: { eq: $teamId } }, type: { eq: "canceled" } }) {
          nodes { id name type }
        }
      }`,
      { teamId },
    );
    const state =
      data.workflowStates.nodes.find((s) => ["canceled", "cancelled"].includes(s.name.toLowerCase())) ??
      data.workflowStates.nodes[0];
    if (!state) {
      throw new Error(`No "canceled" workflow state found for team ${teamId}`);
    }
    this.canceledStateByTeamKey.set(teamKey, state.id);
    return state.id;
  }

  private async updateIssueState(issueId: string, stateId: string): Promise<void> {
    await this.linearMutation<{ issueUpdate: { success: boolean } }>(
      `mutation($issueId: String!, $stateId: String!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId }) {
          success
        }
      }`,
      { issueId, stateId },
      "issueUpdate",
    );
  }

  /**
   * The one label writer. It sends only the labels that change (`addedLabelIds` /
   * `removedLabelIds`), never a full `labelIds` set, so a stale read can never restore a
   * label another writer removed (AII-889). Sends nothing when both lists are empty.
   */
  private async updateIssueLabels(
    issueId: string,
    change: { addedLabelIds?: string[]; removedLabelIds?: string[]; stateId?: string },
  ): Promise<void> {
    const input: { addedLabelIds?: string[]; removedLabelIds?: string[]; stateId?: string } = {};
    if (change.stateId) input.stateId = change.stateId;
    if (change.addedLabelIds?.length) input.addedLabelIds = change.addedLabelIds;
    if (change.removedLabelIds?.length) input.removedLabelIds = change.removedLabelIds;
    if (!input.stateId && !input.addedLabelIds && !input.removedLabelIds) return;

    await this.linearMutation<{ issueUpdate: { success: boolean } }>(
      `mutation($issueId: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $issueId, input: $input) {
          success
        }
      }`,
      { issueId, input },
      "issueUpdate",
    );
  }

  /** IDs of the named labels the issue carries now. The read is safe: the write it feeds only removes. */
  private async labelIdsByName(issueId: string, names: string[]): Promise<string[]> {
    const getData = await this.linearMutation<{
      issue: { labels: { nodes: Array<{ id: string; name: string }> } };
    }>(
      `query($issueId: String!) {
        issue(id: $issueId) {
          labels { nodes { id name } }
        }
      }`,
      { issueId },
    );
    return getData.issue.labels.nodes.filter((l) => names.includes(l.name)).map((l) => l.id);
  }

  private async addLabelToIssue(issueId: string, labelId: string): Promise<void> {
    await this.updateIssueLabels(issueId, { addedLabelIds: [labelId] });
  }

  private async removeLabelsByName(issueId: string, names: string[]): Promise<void> {
    await this.updateIssueLabels(issueId, { removedLabelIds: await this.labelIdsByName(issueId, names) });
  }

  private async transitionToInProgressIfMovable(issueId: string, scopeKey: string): Promise<void> {
    const data = await this.linearMutation<{ issue: { state: { type: string } } | null }>(
      `query($id: String!) { issue(id: $id) { state { type } } }`,
      { id: issueId },
    );
    const currentType = data.issue?.state?.type;
    if (!currentType || !LinearProvider.MOVABLE_STATE_TYPES.has(currentType)) {
      return;
    }
    const stateId = await this.getInProgressStateId(scopeKey);
    await this.updateIssueState(issueId, stateId);
  }

  private async getTeamKeyForIssue(issueId: string): Promise<string> {
    const data = await this.linearMutation<{ issue: { team: { key: string } } }>(
      `query($issueId: String!) {
        issue(id: $issueId) { team { key } }
      }`,
      { issueId },
    );
    return data.issue.team.key;
  }

  // ---------- lifecycle verbs ----------

  async ensureLifecycleLabels(scopeKey: string): Promise<LifecycleLabelsResult> {
    const caches: Record<keyof typeof LINEAR_LABELS, Map<string, string>> = {
      planning: this.aiPlanningLabelCache,
      planComplete: this.planCompleteLabelCache,
      working: this.aiWorkingLabelCache,
      readyForReview: this.readyForReviewLabelCache,
    };
    for (const key of Object.keys(LINEAR_LABELS) as Array<keyof typeof LINEAR_LABELS>) {
      const label = LINEAR_LABELS[key];
      try {
        await this.ensureTeamLabel(scopeKey, label, caches[key]);
      } catch (err) {
        if (err instanceof LinearLabelWriteError) {
          return { ok: false, permanent: err.permanent, label: err.label, message: err.message };
        }
        return {
          ok: false, permanent: false, label: label.name,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return { ok: true };
  }

  async markPlanningStarted(issueId: string, _scopeKey: string): Promise<void> {
    const teamKey = await this.getTeamKeyForIssue(issueId);
    const labelId = await this.ensureTeamLabel(teamKey, LINEAR_LABELS.planning, this.aiPlanningLabelCache);
    await this.addLabelToIssue(issueId, labelId);
    await this.transitionToInProgressIfMovable(issueId, teamKey);
  }

  async markPlanComplete(issueId: string, _scopeKey: string, _opts: { awaitApproval: boolean }): Promise<void> {
    const teamKey = await this.getTeamKeyForIssue(issueId);
    const labelId = await this.ensureTeamLabel(teamKey, LINEAR_LABELS.planComplete, this.planCompleteLabelCache);
    // One write for the swap, so nothing can interleave between the remove and the add.
    await this.updateIssueLabels(issueId, {
      removedLabelIds: await this.labelIdsByName(issueId, [LINEAR_LABELS.planning.name]),
      addedLabelIds: [labelId],
    });
  }

  async markPlanningFailed(issueId: string, _scopeKey: string, reason: string): Promise<boolean> {
    await this.removeLabelsByName(issueId, [LINEAR_LABELS.planning.name]);
    await this.postComment(issueId, `⚠️ Planning failed: ${reason}`);
    return true;
  }

  async markImplementing(issueId: string, _scopeKey: string): Promise<void> {
    const teamKey = await this.getTeamKeyForIssue(issueId);
    const labelId = await this.ensureTeamLabel(teamKey, LINEAR_LABELS.working, this.aiWorkingLabelCache);
    await this.addLabelToIssue(issueId, labelId);
    await this.transitionToInProgressIfMovable(issueId, teamKey);
  }

  async markPrReady(issueId: string, _scopeKey: string, prUrl: string): Promise<boolean> {
    const teamKey = await this.getTeamKeyForIssue(issueId);
    const readyLabelId = await this.ensureTeamLabel(teamKey, LINEAR_LABELS.readyForReview, this.readyForReviewLabelCache);

    // Atomic label swap: remove AI-Working, add Ready for Review in a single issueUpdate.
    await this.updateIssueLabels(issueId, {
      removedLabelIds: await this.labelIdsByName(issueId, [LINEAR_LABELS.working.name]),
      addedLabelIds: [readyLabelId],
    });

    await this.postComment(issueId, `AI implementation PR: ${prUrl}`);
    // Label swaps have no Merged-regression hazard (Done is a state, not a label),
    // so the transition is always applied here.
    return true;
  }

  async markMerged(issueId: string, _scopeKey: string): Promise<void> {
    const data = await this.linearMutation<{
      issue: {
        state: { type: string };
        team: { key: string };
        labels: { nodes: Array<{ id: string; name: string }> };
      } | null;
    }>(
      `query($id: String!) {
        issue(id: $id) {
          state { type }
          team { key }
          labels { nodes { id name } }
        }
      }`,
      { id: issueId },
    );
    const issue = data.issue;
    if (!issue) return;
    const removedLabelIds = issue.labels.nodes
      .filter((l) => l.name === LINEAR_LABELS.readyForReview.name || l.name === LINEAR_LABELS.planComplete.name)
      .map((l) => l.id);
    if (isTerminalStateType(issue.state.type)) {
      // Native integrations can close the issue before merge reconciliation runs.
      // Clean up labels without changing its terminal state or looking up Done.
      await this.updateIssueLabels(issueId, { removedLabelIds });
      return;
    }
    const stateId = await this.getCompletedStateId(issue.team.key);
    await this.updateIssueLabels(issueId, { stateId, removedLabelIds });
  }

  async markPrClosedUnmerged(issueId: string, _scopeKey: string, prUrl: string): Promise<boolean> {
    const data = await this.linearMutation<{
      issue: { state: { type: string }; team: { key: string }; labels: { nodes: Array<{ id: string; name: string }> } } | null;
    }>(
      `query($id: String!) { issue(id: $id) { state { type } team { key } labels { nodes { id name } } } }`,
      { id: issueId },
    );
    const issue = data.issue;
    if (!issue || isTerminalStateType(issue.state.type)) return false;
    const stateId = await this.getCanceledStateId(issue.team.key);
    const removedLabelIds = issue.labels.nodes.filter((l) => l.name === LINEAR_LABELS.readyForReview.name).map((l) => l.id);
    // Comment first: a failed comment must leave the issue active for the next retry.
    await this.postComment(issueId, `The pull request ${prUrl} was closed without a merge. AI-Implement cancelled this issue. To run it again, move the issue back to Todo.`);
    await this.updateIssueLabels(issueId, { stateId, removedLabelIds });
    return true;
  }

  async markImplementationFailed(issueId: string, _scopeKey: string, reason: string): Promise<boolean> {
    await this.removeLabelsByName(issueId, [LINEAR_LABELS.working.name]);
    await this.postComment(issueId, `⚠️ Implementation failed: ${reason}`);
    return true;
  }

  async clearWorkingState(issueId: string, _scopeKey: string, _phase: "planning" | "implementation"): Promise<boolean> {
    await this.removeLabelsByName(issueId, [LINEAR_LABELS.working.name, LINEAR_LABELS.planning.name]);
    return true;
  }
  async parkForHuman(issueId: string, _scopeKey: string, _phase: "planning" | "implementation"): Promise<boolean> {
    // Refuse a terminal issue: the caller must keep dedup (same as Jira's Merged guard).
    const data = await this.linearMutation<{ issue: { state: { type: string }; team: { key: string } } | null }>(
      `query($id: String!) { issue(id: $id) { state { type } team { key } } }`,
      { id: issueId },
    );
    const type = data.issue?.state?.type;
    if (!data.issue || isTerminalStateType(type)) return false;
    // Keep the pickup label for grouping identity; callers persist the park record.
    await this.removeLabelsByName(issueId, [LINEAR_LABELS.working.name, LINEAR_LABELS.planning.name]);
    return true;
  }
  async postComment(issueId: string, body: string): Promise<void> {
    const query = `
      mutation($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
        }
      }
    `;
    await this.linearMutation<{ commentCreate: { success: boolean } }>(query, {
      issueId,
      body,
    }, "commentCreate");
  }
}
