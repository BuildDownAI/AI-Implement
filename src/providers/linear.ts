import type {
  AIImplementSnapshot,
  FeatureNodeRollUp,
  IssueLifecycleState,
  TicketIssue,
  TicketingProvider,
  ProviderConfig,
} from "./types.js";
import { MissingProviderConfigError } from "./types.js";
import { fetchPlanningContext as fetchLinearPlanningContext } from "../linear-planning-fetch.js";

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

const AI_IMPLEMENT_LABEL = "AI-Implement";

/** How far back to scan completed feature nodes for roll-up (bounds the query). */
const ROLLUP_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

/** A node in the ancestor chain: identifier + labels, with a nullable parent. */
type AncestorNode = {
  identifier: string;
  labels?: { nodes: Array<{ name: string }> };
  parent?: AncestorNode | null;
} | null;

/**
 * Walks up the ancestor chain from `parent` while each ancestor carries the AI-Implement
 * label, returning the contiguous run of labeled-ancestor identifiers base-most first.
 *
 * Because this issue is itself an AI-Implement child, any labeled ancestor in this run is a
 * feature node (it has >=1 AI-Implement child), so the run is exactly the nest of feature
 * branches this issue's PR should cascade through. The walk stops at the first unlabeled
 * ancestor (its child cuts from the base branch, not a feature branch).
 */
function labeledAncestorChain(parent: AncestorNode): string[] {
  const collected: string[] = [];
  let node = parent;
  while (node) {
    const hasLabel = (node.labels?.nodes ?? []).some((l) => l.name === AI_IMPLEMENT_LABEL);
    if (!hasLabel) break;
    collected.push(node.identifier);
    node = node.parent ?? null;
  }
  return collected.reverse();
}

export class LinearProvider implements TicketingProvider {
  readonly id = "linear";
  private static readonly MOVABLE_STATE_TYPES = new Set(["triage", "backlog", "unstarted"]);
  private readonly apiKey: string;
  private readonly workspaceUrl: string;

  // Caches keyed by team key (the scopeKey passed through the interface).
  private aiPlanningLabelCache = new Map<string, string>();
  private aiWorkingLabelCache = new Map<string, string>();
  private planCompleteLabelCache = new Map<string, string>();
  private readyForReviewLabelId: string | null = null;
  private teamIdByKey = new Map<string, string>();
  private inProgressStateByTeamKey = new Map<string, string>();
  private completedStateByTeamKey = new Map<string, string>();

  constructor(config: ProviderConfig) {
    if (!config.linearApiKey) {
      throw new MissingProviderConfigError("linear", "linearApiKey");
    }
    this.apiKey = config.linearApiKey;
    this.workspaceUrl = config.linearWorkspaceUrl ?? "https://linear.app";
  }

  issueUrl(issue: TicketIssue): string {
    return `${this.workspaceUrl}/issue/${issue.identifier}`;
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
    return fetchLinearPlanningContext({ issueId, linearApiKey: this.apiKey });
  }

  private async linearMutation<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Linear API error: ${res.status} ${res.statusText} — ${body}`);
    }

    const json = (await res.json()) as GraphQLResponse<T>;
    if (json.errors?.length) {
      throw new Error(`Linear GraphQL error: ${json.errors[0].message}`);
    }
    if (!json.data) {
      throw new Error("Linear API returned no data");
    }
    return json.data;
  }

  async fetchAIImplementSnapshot(): Promise<AIImplementSnapshot> {
    const PAGE_SIZE = 100;
    const query = `
      query($first: Int!, $after: String) {
        issues(
          first: $first
          after: $after
          filter: {
            labels: { name: { eq: "AI-Implement" } }
            state: {
              type: { nin: ["completed", "canceled"] }
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
            # Ancestor chain (labels only) — used to build the cascading feature-branch
            # chain. Nested to a fixed depth; deeper ancestries cut from the base branch.
            parent {
              identifier
              labels { nodes { name } }
              parent {
                identifier
                labels { nodes { name } }
                parent {
                  identifier
                  labels { nodes { name } }
                  parent {
                    identifier
                    labels { nodes { name } }
                    parent {
                      identifier
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

    const inProgressCountsByScope: Record<string, number> = {};
    const needsPlanning: AIImplementSnapshot["needsPlanning"] = [];
    const readyForImplementation: AIImplementSnapshot["readyForImplementation"] = [];

    for (const issue of allNodes) {
      const labelNames = new Set(issue.labels?.nodes?.map((l) => l.name) ?? []);

      // AI-Working or AI-Planning = slot is occupied; count against capacity
      if (labelNames.has("AI-Working") || labelNames.has("AI-Planning")) {
        inProgressCountsByScope[issue.team.key] = (inProgressCountsByScope[issue.team.key] ?? 0) + 1;
        continue;
      }

      if (labelNames.has("Ready for Review")) {
        continue;
      }

      const isBlocked =
        issue.inverseRelations?.nodes?.some(
          (r) =>
            r.type === "blocks" &&
            r.issue?.state?.type !== "completed" &&
            r.issue?.state?.type !== "canceled",
        ) ?? false;
      if (isBlocked) {
        console.log(`[linear] Skipping ${issue.identifier}: blocked by an incomplete issue`);
        continue;
      }

      // Feature-branch grouping (see src/feature-branch.ts). An AI-Implement issue is one of:
      //   - leaf (no children)            → implement now; PR targets nearest feature-node
      //                                      ancestor branch (or base).
      //   - feature-node (>=1 AI child)   → its own work waits until ALL its AI-Implement
      //                                      children reach a terminal state, then implements
      //                                      onto its OWN feature branch. While children are in
      //                                      flight the parent is skipped (its branch is cut
      //                                      lazily when the first child dispatches).
      //   - waiting parent (children but  → skipped (race guard: the parent was labeled before
      //     none AI-Implement yet)          its children were, so let it sit).
      const children = issue.children?.nodes ?? [];
      const aiChildren = children.filter((c) => (c.labels?.nodes ?? []).some((l) => l.name === AI_IMPLEMENT_LABEL));
      const ancestorChain = labeledAncestorChain(issue.parent);

      let featureBranchChain: string[] | undefined;
      if (children.length === 0) {
        // Leaf.
        featureBranchChain = ancestorChain.length > 0 ? ancestorChain : undefined;
      } else if (aiChildren.length > 0) {
        const allAIChildrenTerminal = aiChildren.every(
          (c) => c.state?.type === "completed" || c.state?.type === "canceled",
        );
        if (!allAIChildrenTerminal) {
          console.log(`[linear] Skipping ${issue.identifier}: feature-node parent waiting on in-flight AI-Implement children`);
          continue;
        }
        // All AI-Implement children done — implement the parent's closing work onto its own branch.
        featureBranchChain = [...ancestorChain, issue.identifier];
      } else {
        console.log(`[linear] Skipping ${issue.identifier}: parent labeled but no child has AI-Implement set yet`);
        continue;
      }

      const ticketIssue: TicketIssue = {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        scopeKey: issue.team.key,
        nativeStatus: `${issue.state.name} (${issue.state.type})`,
        ...(issue.parent ? { parentRef: { identifier: issue.parent.identifier } } : {}),
        ...(featureBranchChain ? { featureBranchChain } : {}),
      };

      if (labelNames.has("Plan-Complete")) {
        readyForImplementation.push(ticketIssue);
      } else {
        needsPlanning.push(ticketIssue);
      }
    }

    return { needsPlanning, readyForImplementation, inProgressCountsByScope };
  }

  async fetchFeatureNodeRollUps(): Promise<FeatureNodeRollUp[]> {
    // Recently-completed AI-Implement issues that are feature nodes (>=1 AI-Implement
    // child) need their feature branch rolled up into the parent. Bound the scan to a
    // recent window so the set stays small; the merge-up step skips already-merged
    // branches cheaply via a branch comparison. A completed feature node implies its
    // own closing work merged and all its children done.
    const since = new Date(Date.now() - ROLLUP_LOOKBACK_MS).toISOString();
    const data = await this.linearMutation<{
      issues: {
        nodes: Array<{
          id: string;
          identifier: string;
          team: { key: string };
          children: { nodes: Array<{ labels: { nodes: Array<{ name: string }> } }> };
          parent: { identifier: string; labels: { nodes: Array<{ name: string }> } } | null;
        }>;
      };
    }>(
      `query($since: DateTimeOrDuration!) {
        issues(
          first: 100
          filter: {
            labels: { name: { eq: "AI-Implement" } }
            state: { type: { eq: "completed" } }
            updatedAt: { gt: $since }
          }
        ) {
          nodes {
            id
            identifier
            team { key }
            children(first: 50) { nodes { labels { nodes { name } } } }
            parent { identifier labels { nodes { name } } }
          }
        }
      }`,
      { since },
    );

    const rollUps: FeatureNodeRollUp[] = [];
    for (const node of data.issues?.nodes ?? []) {
      const isFeatureNode = (node.children?.nodes ?? []).some((c) =>
        (c.labels?.nodes ?? []).some((l) => l.name === AI_IMPLEMENT_LABEL),
      );
      if (!isFeatureNode) continue;
      const parentIsFeatureNode =
        !!node.parent && (node.parent.labels?.nodes ?? []).some((l) => l.name === AI_IMPLEMENT_LABEL);
      rollUps.push({
        issueId: node.id,
        identifier: node.identifier,
        scopeKey: node.team.key,
        parentIdentifier: parentIsFeatureNode ? node.parent!.identifier : null,
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
      else if (node.state.type === "canceled") lifecycle = "cancelled";
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

  private async ensureTeamLabel(
    teamKey: string,
    name: string,
    color: string,
    cache: Map<string, string>,
  ): Promise<string> {
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
      { name },
    );
    const teamMatch = searchData.issueLabels.nodes.find(
      (n) => n.team?.id === teamId,
    );
    const workspaceMatch = searchData.issueLabels.nodes.find((n) => n.team === null || n.team === undefined);
    const reusableMatch = teamMatch ?? workspaceMatch;
    if (reusableMatch) {
      cache.set(teamKey, reusableMatch.id);
      return reusableMatch.id;
    }

    const createData = await this.linearMutation<{
      issueLabelCreate: { issueLabel: { id: string } };
    }>(
      `mutation($teamId: String!, $name: String!, $color: String!) {
        issueLabelCreate(input: { teamId: $teamId, name: $name, color: $color }) {
          issueLabel { id }
        }
      }`,
      { teamId, name, color },
    );
    console.log(`[linear] Created '${name}' label for team ${teamId}`);
    const id = createData.issueLabelCreate.issueLabel.id;
    cache.set(teamKey, id);
    return id;
  }

  private async ensureWorkspaceReadyForReviewLabel(): Promise<string> {
    if (this.readyForReviewLabelId !== null) return this.readyForReviewLabelId;

    const searchData = await this.linearMutation<{
      issueLabels: { nodes: Array<{ id: string }> };
    }>(
      `query {
        issueLabels(filter: { name: { eqIgnoreCase: "Ready for Review" } }) {
          nodes { id }
        }
      }`,
      {},
    );
    if (searchData.issueLabels.nodes[0]) {
      this.readyForReviewLabelId = searchData.issueLabels.nodes[0].id;
      return this.readyForReviewLabelId;
    }

    const createData = await this.linearMutation<{
      issueLabelCreate: { issueLabel: { id: string } };
    }>(
      `mutation {
        issueLabelCreate(input: { name: "Ready for Review", color: "#4ecdc4" }) {
          issueLabel { id }
        }
      }`,
      {},
    );
    this.readyForReviewLabelId = createData.issueLabelCreate.issueLabel.id;
    return this.readyForReviewLabelId;
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

  private async updateIssueState(issueId: string, stateId: string): Promise<void> {
    await this.linearMutation<{ issueUpdate: { success: boolean } }>(
      `mutation($issueId: String!, $stateId: String!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId }) {
          success
        }
      }`,
      { issueId, stateId },
    );
  }

  private async addLabelToIssue(issueId: string, labelId: string): Promise<void> {
    const getData = await this.linearMutation<{
      issue: { labels: { nodes: Array<{ id: string }> } };
    }>(
      `query($issueId: String!) {
        issue(id: $issueId) {
          labels { nodes { id } }
        }
      }`,
      { issueId },
    );
    const currentIds = getData.issue.labels.nodes.map((l) => l.id);
    if (currentIds.includes(labelId)) return;

    await this.linearMutation<{ issueUpdate: { success: boolean } }>(
      `mutation($issueId: String!, $labelIds: [String!]!) {
        issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
          success
        }
      }`,
      { issueId, labelIds: [...currentIds, labelId] },
    );
  }

  private async removeLabelByName(issueId: string, name: string): Promise<void> {
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
    const remaining = getData.issue.labels.nodes.filter((l) => l.name !== name);
    if (remaining.length === getData.issue.labels.nodes.length) return;

    await this.linearMutation<{ issueUpdate: { success: boolean } }>(
      `mutation($issueId: String!, $labelIds: [String!]!) {
        issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
          success
        }
      }`,
      { issueId, labelIds: remaining.map((l) => l.id) },
    );
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

  async markPlanningStarted(issueId: string, _scopeKey: string): Promise<void> {
    const teamKey = await this.getTeamKeyForIssue(issueId);
    const labelId = await this.ensureTeamLabel(
      teamKey,
      "AI-Planning",
      "#8B5CF6",
      this.aiPlanningLabelCache,
    );
    await this.addLabelToIssue(issueId, labelId);
    await this.transitionToInProgressIfMovable(issueId, teamKey);
  }

  async markPlanComplete(issueId: string): Promise<void> {
    await this.removeLabelByName(issueId, "AI-Planning");
    const teamKey = await this.getTeamKeyForIssue(issueId);
    const labelId = await this.ensureTeamLabel(
      teamKey,
      "Plan-Complete",
      "#10B981",
      this.planCompleteLabelCache,
    );
    await this.addLabelToIssue(issueId, labelId);
  }

  async markPlanningFailed(issueId: string, reason: string): Promise<void> {
    await this.removeLabelByName(issueId, "AI-Planning");
    await this.postComment(issueId, `⚠️ Planning failed: ${reason}`);
  }

  async markImplementing(issueId: string, _scopeKey: string): Promise<void> {
    const teamKey = await this.getTeamKeyForIssue(issueId);
    const labelId = await this.ensureTeamLabel(
      teamKey,
      "AI-Working",
      "#F59E0B",
      this.aiWorkingLabelCache,
    );
    await this.addLabelToIssue(issueId, labelId);
    await this.transitionToInProgressIfMovable(issueId, teamKey);
  }

  async markPrReady(issueId: string, prUrl: string): Promise<void> {
    const readyLabelId = await this.ensureWorkspaceReadyForReviewLabel();

    // Atomic label swap: remove AI-Working, add Ready for Review in a single
    // issueUpdate (matches legacy markIssueReadyForReview behaviour).
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
    const currentLabels = getData.issue.labels.nodes;
    const newLabelIds = currentLabels
      .filter((l) => l.name !== "AI-Working")
      .map((l) => l.id);
    if (!newLabelIds.includes(readyLabelId)) {
      newLabelIds.push(readyLabelId);
    }

    await this.linearMutation<{ issueUpdate: { success: boolean } }>(
      `mutation($issueId: String!, $labelIds: [String!]!) {
        issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
          success
        }
      }`,
      { issueId, labelIds: newLabelIds },
    );

    await this.postComment(issueId, `AI implementation PR: ${prUrl}`);
  }

  async markMerged(issueId: string): Promise<void> {
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
    if (issue.state.type === "completed" || issue.state.type === "canceled") return;
    const stateId = await this.getCompletedStateId(issue.team.key);
    const labelIds = issue.labels.nodes
      .filter((l) => l.name !== "Ready for Review")
      .map((l) => l.id);
    await this.linearMutation<{ issueUpdate: { success: boolean } }>(
      `mutation($issueId: String!, $stateId: String!, $labelIds: [String!]!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId, labelIds: $labelIds }) {
          success
        }
      }`,
      { issueId, stateId, labelIds },
    );
  }

  async markImplementationFailed(issueId: string, reason: string): Promise<void> {
    await this.removeLabelByName(issueId, "AI-Working");
    await this.postComment(issueId, `⚠️ Implementation failed: ${reason}`);
  }

  async clearWorkingState(issueId: string): Promise<void> {
    await this.removeLabelByName(issueId, "AI-Working");
    await this.removeLabelByName(issueId, "AI-Planning");
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
    });
  }
}
