/** Issue as returned from the API; includes relation data for filtering. */
export interface LinearIssueResponse {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  team: { id: string; key: string };
  state: { id: string; name: string; type: string };
  labels: { nodes: Array<{ id: string; name: string }> };
  /** Inverse relations: other issues that reference this one (e.g. "blocks" = this issue is blocked by another). */
  inverseRelations: { nodes: Array<{ type: string; issue: { state: { type: string } } }> };
}

/** Issue shape used by the rest of the app (no relation payload). */
export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  team: { id: string; key: string };
  state: { id: string; name: string; type: string };
}

export interface AIImplementIssueSnapshot {
  /** Issues with AI-Implement only (no AI-Planning, Plan-Complete, AI-Working, Ready for Review). */
  needsPlanning: LinearIssue[];
  /** Issues with AI-Implement + Plan-Complete (planning done, ready for implementation). */
  readyForImplementation: LinearIssue[];
  /** Per-team count of in-progress issues (AI-Working or AI-Planning label). */
  inProgressCountsByTeam: Record<string, number>;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function linearQuery<T>(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
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

export async function fetchAIImplementIssues(apiKey: string): Promise<LinearIssue[]> {
  const snapshot = await fetchAIImplementIssueSnapshot(apiKey);
  return [...snapshot.readyForImplementation, ...snapshot.needsPlanning];
}

export async function fetchAIImplementIssueSnapshot(apiKey: string): Promise<AIImplementIssueSnapshot> {
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
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

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
    const data: IssuePage = await linearQuery<IssuePage>(apiKey, query, { first: PAGE_SIZE, after: cursor });
    allNodes.push(...data.issues.nodes);
    cursor = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null;
    if (++page >= MAX_PAGES) {
      console.warn(
        `[linear] fetchAIImplementIssueSnapshot hit max pages (${MAX_PAGES}), ${allNodes.length} issues fetched`,
      );
      break;
    }
  } while (cursor !== null);

  const inProgressCountsByTeam: Record<string, number> = {};
  const needsPlanning: LinearIssue[] = [];
  const readyForImplementation: LinearIssue[] = [];

  for (const issue of allNodes) {
    const labelNames = new Set(issue.labels?.nodes?.map((l) => l.name) ?? []);

    // AI-Working or AI-Planning = slot is occupied; count against capacity
    if (labelNames.has("AI-Working") || labelNames.has("AI-Planning")) {
      inProgressCountsByTeam[issue.team.key] = (inProgressCountsByTeam[issue.team.key] ?? 0) + 1;
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
      console.log(`[poll] Skipping ${issue.identifier}: blocked by an incomplete issue`);
      continue;
    }

    const issueData: LinearIssue = {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      team: issue.team,
      state: issue.state,
    };

    if (labelNames.has("Plan-Complete")) {
      // Planning done — ready for implementation dispatch
      readyForImplementation.push(issueData);
    } else {
      // No planning labels at all — needs planning first
      needsPlanning.push(issueData);
    }
  }

  return { needsPlanning, readyForImplementation, inProgressCountsByTeam };
}

export async function getInProgressStateId(apiKey: string, teamId: string): Promise<string> {
  const query = `
    query($teamId: ID!) {
      workflowStates(filter: { team: { id: { eq: $teamId } }, type: { eq: "started" } }) {
        nodes { id name type }
      }
    }
  `;

  const data = await linearQuery<{ workflowStates: { nodes: Array<{ id: string; name: string; type: string }> } }>(
    apiKey,
    query,
    { teamId },
  );

  const state =
    data.workflowStates.nodes.find((s) => s.name === "In Progress") ??
    data.workflowStates.nodes[0];
  if (!state) {
    throw new Error(`No "started" workflow state found for team ${teamId}`);
  }
  return state.id;
}

export async function updateIssueState(apiKey: string, issueId: string, stateId: string): Promise<void> {
  const query = `
    mutation($issueId: String!, $stateId: String!) {
      issueUpdate(id: $issueId, input: { stateId: $stateId }) {
        success
      }
    }
  `;

  await linearQuery<{ issueUpdate: { success: boolean } }>(apiKey, query, { issueId, stateId });
}

async function ensureTeamLabel(apiKey: string, teamId: string, name: string, color: string): Promise<string> {
  const searchQuery = `
    query($teamId: ID!, $name: String!) {
      issueLabels(filter: { team: { id: { eq: $teamId } }, name: { eq: $name } }) {
        nodes { id }
      }
    }
  `;
  const searchData = await linearQuery<{ issueLabels: { nodes: Array<{ id: string }> } }>(
    apiKey, searchQuery, { teamId, name },
  );
  if (searchData.issueLabels.nodes.length > 0) {
    return searchData.issueLabels.nodes[0].id;
  }

  const createQuery = `
    mutation($teamId: String!, $name: String!, $color: String!) {
      issueLabelCreate(input: { teamId: $teamId, name: $name, color: $color }) {
        issueLabel { id }
      }
    }
  `;
  const createData = await linearQuery<{ issueLabelCreate: { issueLabel: { id: string } } }>(
    apiKey, createQuery, { teamId, name, color },
  );
  console.log(`[linear] Created '${name}' label for team ${teamId}`);
  return createData.issueLabelCreate.issueLabel.id;
}

export async function ensureAIWorkingLabel(apiKey: string, teamId: string): Promise<string> {
  return ensureTeamLabel(apiKey, teamId, "AI-Working", "#F59E0B");
}

export async function ensureAIPlanningLabel(apiKey: string, teamId: string): Promise<string> {
  return ensureTeamLabel(apiKey, teamId, "AI-Planning", "#8B5CF6");
}

export async function ensurePlanCompleteLabel(apiKey: string, teamId: string): Promise<string> {
  return ensureTeamLabel(apiKey, teamId, "Plan-Complete", "#10B981");
}

/**
 * Remove a specific label from an issue by label ID.
 * No-ops if the label is not present.
 */
export async function removeLabelFromIssue(apiKey: string, issueId: string, labelId: string): Promise<void> {
  const getQuery = `
    query($issueId: String!) {
      issue(id: $issueId) {
        labels { nodes { id } }
      }
    }
  `;
  const getData = await linearQuery<{ issue: { labels: { nodes: Array<{ id: string }> } } }>(
    apiKey, getQuery, { issueId },
  );
  const remaining = getData.issue.labels.nodes.filter((l) => l.id !== labelId);

  // No-op if label wasn't present
  if (remaining.length === getData.issue.labels.nodes.length) return;

  const updateQuery = `
    mutation($issueId: String!, $labelIds: [String!]!) {
      issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
        success
      }
    }
  `;
  await linearQuery<{ issueUpdate: { success: boolean } }>(
    apiKey, updateQuery, { issueId, labelIds: remaining.map((l) => l.id) },
  );
}

/**
 * Fetches the current state for a list of issue IDs.
 * Returns a map of issueId → state type.
 * Paginates through all results using cursor-based pagination (250 per page).
 */
export async function fetchIssueStates(
  apiKey: string,
  issueIds: string[]
): Promise<Map<string, string>> {
  if (issueIds.length === 0) return new Map();

  const PAGE_SIZE = 250;
  const query = `
    query IssueStates($ids: [ID!]!, $first: Int!, $after: String) {
      issues(filter: { id: { in: $ids } }, first: $first, after: $after) {
        nodes {
          id
          state {
            type
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  type IssueStatesPage = {
    issues: {
      nodes: Array<{ id: string; state: { type: string } }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };

  const MAX_PAGES = 20;
  const result = new Map<string, string>();
  let cursor: string | null = null;
  let page = 0;

  do {
    const data: IssueStatesPage = await linearQuery<IssueStatesPage>(
      apiKey, query, { ids: issueIds, first: PAGE_SIZE, after: cursor },
    );

    for (const node of data.issues.nodes) {
      result.set(node.id, node.state.type);
    }

    cursor = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null;
    if (++page >= MAX_PAGES) {
      console.warn(`[linear] fetchIssueStates hit max pages (${MAX_PAGES}), ${result.size} states fetched`);
      break;
    }
  } while (cursor !== null);

  return result;
}

export async function getUnstartedStateId(apiKey: string, teamId: string): Promise<string> {
  const query = `
    query($teamId: ID!) {
      workflowStates(filter: { team: { id: { eq: $teamId } }, type: { eq: "unstarted" } }) {
        nodes { id name type }
      }
    }
  `;
  const data = await linearQuery<{ workflowStates: { nodes: Array<{ id: string; name: string; type: string }> } }>(
    apiKey, query, { teamId },
  );
  const state = data.workflowStates.nodes[0];
  if (!state) {
    throw new Error(`No "unstarted" workflow state found for team ${teamId}`);
  }
  return state.id;
}

export async function removeAIWorkingLabel(apiKey: string, issueId: string): Promise<void> {
  const getQuery = `
    query($issueId: String!) {
      issue(id: $issueId) {
        labels { nodes { id name } }
      }
    }
  `;
  const getData = await linearQuery<{ issue: { labels: { nodes: Array<{ id: string; name: string }> } } }>(
    apiKey, getQuery, { issueId },
  );
  const remaining = getData.issue.labels.nodes.filter((l) => l.name !== "AI-Working");
  const remainingIds = remaining.map((l) => l.id);

  // Only update if the label was actually present
  if (remainingIds.length === getData.issue.labels.nodes.length) return;

  const updateQuery = `
    mutation($issueId: String!, $labelIds: [String!]!) {
      issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
        success
      }
    }
  `;
  await linearQuery<{ issueUpdate: { success: boolean } }>(
    apiKey, updateQuery, { issueId, labelIds: remainingIds },
  );
}

export async function addLabelToIssue(apiKey: string, issueId: string, labelId: string): Promise<void> {
  const getQuery = `
    query($issueId: String!) {
      issue(id: $issueId) {
        labels { nodes { id } }
      }
    }
  `;
  const getData = await linearQuery<{ issue: { labels: { nodes: Array<{ id: string }> } } }>(
    apiKey, getQuery, { issueId },
  );
  const currentIds = getData.issue.labels.nodes.map((l) => l.id);
  if (currentIds.includes(labelId)) return;

  const updateQuery = `
    mutation($issueId: String!, $labelIds: [String!]!) {
      issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
        success
      }
    }
  `;
  await linearQuery<{ issueUpdate: { success: boolean } }>(
    apiKey, updateQuery, { issueId, labelIds: [...currentIds, labelId] },
  );
}

/** Post a comment on a Linear issue. */
export async function postIssueComment(apiKey: string, issueId: string, body: string): Promise<void> {
  const query = `
    mutation($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
      }
    }
  `;
  await linearQuery<{ commentCreate: { success: boolean } }>(apiKey, query, { issueId, body });
}

/** Find or create the workspace-level "Ready for Review" label. */
export async function ensureReadyForReviewLabel(apiKey: string): Promise<string> {
  const searchQuery = `
    query {
      issueLabels(filter: { name: { eq: "Ready for Review" } }) {
        nodes { id }
      }
    }
  `;
  const searchData = await linearQuery<{ issueLabels: { nodes: Array<{ id: string }> } }>(
    apiKey, searchQuery,
  );
  if (searchData.issueLabels.nodes[0]) {
    return searchData.issueLabels.nodes[0].id;
  }

  const createQuery = `
    mutation {
      issueLabelCreate(input: { name: "Ready for Review", color: "#4ecdc4" }) {
        issueLabel { id }
      }
    }
  `;
  const createData = await linearQuery<{ issueLabelCreate: { issueLabel: { id: string } } }>(
    apiKey, createQuery,
  );
  return createData.issueLabelCreate.issueLabel.id;
}

/**
 * Mark an issue as ready for review: add "Ready for Review" label, remove
 * "AI-Working" label, and post a comment with the PR URL. All label changes
 * happen in a single issueUpdate call to avoid races.
 */
export async function markIssueReadyForReview(
  apiKey: string,
  issueId: string,
  prUrl: string,
): Promise<void> {
  const readyLabelId = await ensureReadyForReviewLabel(apiKey);

  // Get current labels so we can swap AI-Working for Ready for Review
  const getQuery = `
    query($issueId: String!) {
      issue(id: $issueId) {
        labels { nodes { id name } }
      }
    }
  `;
  const getData = await linearQuery<{ issue: { labels: { nodes: Array<{ id: string; name: string }> } } }>(
    apiKey, getQuery, { issueId },
  );
  const currentLabels = getData.issue.labels.nodes;

  const newLabelIds = currentLabels
    .filter((l) => l.name !== "AI-Working")
    .map((l) => l.id);
  if (!newLabelIds.includes(readyLabelId)) {
    newLabelIds.push(readyLabelId);
  }

  const updateQuery = `
    mutation($issueId: String!, $labelIds: [String!]!) {
      issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
        success
      }
    }
  `;
  await linearQuery<{ issueUpdate: { success: boolean } }>(
    apiKey, updateQuery, { issueId, labelIds: newLabelIds },
  );

  // Post a comment with the PR link (separate call; non-atomic but acceptable)
  await postIssueComment(apiKey, issueId, `AI implementation PR: ${prUrl}`);
}
