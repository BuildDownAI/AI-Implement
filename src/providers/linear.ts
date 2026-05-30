import type {
  AIImplementSnapshot,
  IssueLifecycleState,
  TicketIssue,
  TicketingProvider,
  ProviderConfig,
} from "./types.js";
import { MissingProviderConfigError } from "./types.js";

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
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
            parent {
              id
              identifier
              title
              # first:50 caps childCount; harmless for the >=2 grouping threshold
              children(first: 50) { nodes { id } }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    type LinearIssueResponse = {
      id: string;
      identifier: string;
      title: string;
      description: string | null;
      team: { id: string; key: string };
      state: { id: string; name: string; type: string };
      labels: { nodes: Array<{ id: string; name: string }> };
      inverseRelations: { nodes: Array<{ type: string; issue: { state: { type: string } } }> };
      parent: {
        id: string;
        identifier: string;
        title: string;
        children: { nodes: Array<{ id: string }> };
      } | null;
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

      const ticketIssue: TicketIssue = {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        scopeKey: issue.team.key,
        nativeStatus: `${issue.state.name} (${issue.state.type})`,
        ...(issue.parent
          ? {
              parentRef: {
                id: issue.parent.id,
                identifier: issue.parent.identifier,
                title: issue.parent.title,
                childCount: issue.parent.children?.nodes?.length ?? 0,
              },
            }
          : {}),
      };

      if (labelNames.has("Plan-Complete")) {
        readyForImplementation.push(ticketIssue);
      } else {
        needsPlanning.push(ticketIssue);
      }
    }

    return { needsPlanning, readyForImplementation, inProgressCountsByScope };
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
    // as conflicting with a team-level label of the same name. A strict
    // case-sensitive, team-scoped search misses both cases and the create then
    // fails with "duplicate label name". Prefer the team-scoped match if one
    // exists, otherwise fall back to any workspace label with the same name.
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
    const anyMatch = teamMatch ?? searchData.issueLabels.nodes[0];
    if (anyMatch) {
      cache.set(teamKey, anyMatch.id);
      return anyMatch.id;
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

  async markPlanningStarted(issueId: string, scopeKey: string): Promise<void> {
    const labelId = await this.ensureTeamLabel(
      scopeKey,
      "AI-Planning",
      "#8B5CF6",
      this.aiPlanningLabelCache,
    );
    await this.addLabelToIssue(issueId, labelId);
    await this.transitionToInProgressIfMovable(issueId, scopeKey);
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

  async markImplementing(issueId: string, scopeKey: string): Promise<void> {
    const labelId = await this.ensureTeamLabel(
      scopeKey,
      "AI-Working",
      "#F59E0B",
      this.aiWorkingLabelCache,
    );
    await this.addLabelToIssue(issueId, labelId);
    await this.transitionToInProgressIfMovable(issueId, scopeKey);
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

  async markImplementationFailed(issueId: string, reason: string): Promise<void> {
    await this.removeLabelByName(issueId, "AI-Working");
    await this.postComment(issueId, `⚠️ Implementation failed: ${reason}`);
  }

  async clearWorkingState(issueId: string): Promise<void> {
    await this.removeLabelByName(issueId, "AI-Working");
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
