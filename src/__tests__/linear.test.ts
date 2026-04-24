import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchAIImplementIssueSnapshot,
  fetchAIImplementIssues,
  fetchIssueStates,
  getInProgressStateId,
  updateIssueState,
  postIssueComment,
  ensureReadyForReviewLabel,
  markIssueReadyForReview,
  ensureAIPlanningLabel,
  ensurePlanCompleteLabel,
  removeLabelFromIssue,
} from "../linear.js";

describe("linear", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("fetchAIImplementIssues returns dispatchable issues and skips AI-Working ones", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          issues: {
            nodes: [
              { id: "1", identifier: "T-1", title: "Issue 1", description: "desc", team: { id: "t1", key: "T" }, state: { id: "s1", name: "Todo", type: "unstarted" }, labels: { nodes: [] }, inverseRelations: { nodes: [] } },
              { id: "2", identifier: "T-2", title: "Issue 2", description: null, team: { id: "t1", key: "T" }, state: { id: "s2", name: "In Progress", type: "started" }, labels: { nodes: [{ id: "l1", name: "AI-Working" }] }, inverseRelations: { nodes: [] } },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    } as Response);

    const issues = await fetchAIImplementIssues("test-key");
    expect(issues).toHaveLength(1);
    expect(issues[0].identifier).toBe("T-1");
  });

  it("fetchAIImplementIssues skips issues with Ready for Review label", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          issues: {
            nodes: [
              { id: "1", identifier: "T-1", title: "Ready", description: "desc", team: { id: "t1", key: "T" }, state: { id: "s1", name: "In Progress", type: "started" }, labels: { nodes: [{ id: "l1", name: "Ready for Review" }] }, inverseRelations: { nodes: [] } },
              { id: "2", identifier: "T-2", title: "New", description: "desc", team: { id: "t1", key: "T" }, state: { id: "s2", name: "Todo", type: "unstarted" }, labels: { nodes: [] }, inverseRelations: { nodes: [] } },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    } as Response);

    const issues = await fetchAIImplementIssues("test-key");
    expect(issues).toHaveLength(1);
    expect(issues[0].identifier).toBe("T-2");
  });

  it("fetchAIImplementIssues excludes issues blocked by an incomplete issue", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          issues: {
            nodes: [
              { id: "1", identifier: "T-1", title: "Unblocked", description: "desc", team: { id: "t1", key: "T" }, state: { id: "s1", name: "Todo", type: "unstarted" }, labels: { nodes: [] }, inverseRelations: { nodes: [] } },
              { id: "2", identifier: "T-2", title: "Blocked", description: null, team: { id: "t1", key: "T" }, state: { id: "s2", name: "Todo", type: "unstarted" }, labels: { nodes: [] }, inverseRelations: { nodes: [{ type: "blocks", issue: { state: { type: "unstarted" } } }] } },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    } as Response);

    const issues = await fetchAIImplementIssues("test-key");
    expect(issues).toHaveLength(1);
    expect(issues[0].identifier).toBe("T-1");
  });

  it("fetchAIImplementIssues does not skip issues blocked only by completed/cancelled blockers", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          issues: {
            nodes: [
              { id: "1", identifier: "T-1", title: "Blocker done", description: "desc", team: { id: "t1", key: "T" }, state: { id: "s1", name: "Todo", type: "unstarted" }, labels: { nodes: [] }, inverseRelations: { nodes: [{ type: "blocks", issue: { state: { type: "completed" } } }] } },
              { id: "2", identifier: "T-2", title: "Blocker cancelled", description: "desc", team: { id: "t1", key: "T" }, state: { id: "s1", name: "Todo", type: "unstarted" }, labels: { nodes: [] }, inverseRelations: { nodes: [{ type: "blocks", issue: { state: { type: "canceled" } } }] } },
              { id: "3", identifier: "T-3", title: "Still blocked", description: "desc", team: { id: "t1", key: "T" }, state: { id: "s1", name: "Todo", type: "unstarted" }, labels: { nodes: [] }, inverseRelations: { nodes: [{ type: "blocks", issue: { state: { type: "unstarted" } } }] } },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    } as Response);

    const issues = await fetchAIImplementIssues("test-key");
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.identifier)).toEqual(["T-1", "T-2"]);
  });

  it("fetchAIImplementIssueSnapshot returns per-team in-progress counts and categorised issues", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          issues: {
            nodes: [
              { id: "1", identifier: "T-1", title: "Working", description: null, team: { id: "team-1", key: "T" }, state: { id: "s1", name: "In Progress", type: "started" }, labels: { nodes: [{ id: "l1", name: "AI-Working" }] }, inverseRelations: { nodes: [] } },
              { id: "2", identifier: "T-2", title: "Todo", description: "desc", team: { id: "team-1", key: "T" }, state: { id: "s2", name: "Todo", type: "unstarted" }, labels: { nodes: [] }, inverseRelations: { nodes: [] } },
              { id: "3", identifier: "O-1", title: "Other working", description: null, team: { id: "team-2", key: "O" }, state: { id: "s3", name: "In Progress", type: "started" }, labels: { nodes: [{ id: "l1", name: "AI-Working" }] }, inverseRelations: { nodes: [] } },
              { id: "4", identifier: "O-2", title: "Blocked", description: null, team: { id: "team-2", key: "O" }, state: { id: "s4", name: "Todo", type: "unstarted" }, labels: { nodes: [] }, inverseRelations: { nodes: [{ type: "blocks", issue: { state: { type: "unstarted" } } }] } },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    } as Response);

    const snapshot = await fetchAIImplementIssueSnapshot("test-key");
    expect(snapshot.inProgressCountsByTeam).toEqual({ T: 1, O: 1 });
    // T-2 has no planning labels → needs planning
    expect(snapshot.needsPlanning).toHaveLength(1);
    expect(snapshot.needsPlanning[0].identifier).toBe("T-2");
    expect(snapshot.readyForImplementation).toHaveLength(0);
  });

  it("fetchAIImplementIssueSnapshot categorises Plan-Complete issues as readyForImplementation", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          issues: {
            nodes: [
              { id: "1", identifier: "T-1", title: "No labels", description: "desc", team: { id: "t1", key: "T" }, state: { id: "s1", name: "Todo", type: "unstarted" }, labels: { nodes: [] }, inverseRelations: { nodes: [] } },
              { id: "2", identifier: "T-2", title: "Plan done", description: "desc", team: { id: "t1", key: "T" }, state: { id: "s2", name: "Todo", type: "unstarted" }, labels: { nodes: [{ id: "lpc", name: "Plan-Complete" }] }, inverseRelations: { nodes: [] } },
              { id: "3", identifier: "T-3", title: "Planning", description: "desc", team: { id: "t1", key: "T" }, state: { id: "s3", name: "In Progress", type: "started" }, labels: { nodes: [{ id: "lap", name: "AI-Planning" }] }, inverseRelations: { nodes: [] } },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    } as Response);

    const snapshot = await fetchAIImplementIssueSnapshot("test-key");
    // AI-Planning counts as in-progress
    expect(snapshot.inProgressCountsByTeam).toEqual({ T: 1 });
    expect(snapshot.needsPlanning.map((i) => i.identifier)).toEqual(["T-1"]);
    expect(snapshot.readyForImplementation.map((i) => i.identifier)).toEqual(["T-2"]);
  });

  it("fetchAIImplementIssueSnapshot skips AI-Planning issues (planning in progress)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          issues: {
            nodes: [
              { id: "1", identifier: "T-1", title: "Planning", description: null, team: { id: "t1", key: "T" }, state: { id: "s1", name: "In Progress", type: "started" }, labels: { nodes: [{ id: "l1", name: "AI-Planning" }] }, inverseRelations: { nodes: [] } },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    } as Response);

    const snapshot = await fetchAIImplementIssueSnapshot("test-key");
    expect(snapshot.inProgressCountsByTeam).toEqual({ T: 1 });
    expect(snapshot.needsPlanning).toHaveLength(0);
    expect(snapshot.readyForImplementation).toHaveLength(0);
  });

  it("fetchAIImplementIssueSnapshot treats AI-Planning+Plan-Complete as in-progress (AI-Planning wins)", async () => {
    // An issue with both labels is counted as in-progress (AI-Planning supersedes Plan-Complete)
    // and does NOT appear in readyForImplementation. This prevents a duplicate implementation
    // dispatch while the planning workflow is still running.
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          issues: {
            nodes: [
              {
                id: "1",
                identifier: "T-1",
                title: "Both labels",
                description: null,
                team: { id: "t1", key: "T" },
                state: { id: "s1", name: "In Progress", type: "started" },
                labels: { nodes: [{ id: "l1", name: "AI-Planning" }, { id: "l2", name: "Plan-Complete" }] },
                inverseRelations: { nodes: [] },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    } as Response);

    const snapshot = await fetchAIImplementIssueSnapshot("test-key");
    expect(snapshot.inProgressCountsByTeam).toEqual({ T: 1 });
    expect(snapshot.needsPlanning).toHaveLength(0);
    expect(snapshot.readyForImplementation).toHaveLength(0);
  });

  it("fetchAIImplementIssues throws on HTTP error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false, status: 401, statusText: "Unauthorized", text: async () => "Bad auth",
    } as Response);
    await expect(fetchAIImplementIssues("bad-key")).rejects.toThrow("Linear API error: 401");
  });

  it("fetchAIImplementIssues throws on GraphQL error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, json: async () => ({ errors: [{ message: "Field not found" }] }),
    } as Response);
    await expect(fetchAIImplementIssues("test-key")).rejects.toThrow("Linear GraphQL error: Field not found");
  });

  it("getInProgressStateId prefers a state named 'In Progress'", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { workflowStates: { nodes: [{ id: "state-2", name: "In Development", type: "started" }, { id: "state-1", name: "In Progress", type: "started" }] } },
      }),
    } as Response);
    expect(await getInProgressStateId("test-key", "team-1")).toBe("state-1");
  });

  it("getInProgressStateId falls back to first started state", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { workflowStates: { nodes: [{ id: "state-1", name: "In Dev", type: "started" }] } },
      }),
    } as Response);
    expect(await getInProgressStateId("test-key", "team-1")).toBe("state-1");
  });

  it("getInProgressStateId throws when no started state found", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { workflowStates: { nodes: [] } } }),
    } as Response);
    await expect(getInProgressStateId("test-key", "team-1")).rejects.toThrow('No "started" workflow state found');
  });

  it("fetchIssueStates returns a map of id → state type", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          issues: {
            nodes: [{ id: "id-1", state: { type: "started" } }, { id: "id-2", state: { type: "completed" } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    } as unknown as Response);
    const result = await fetchIssueStates("test-key", ["id-1", "id-2"]);
    expect(result.get("id-1")).toBe("started");
    expect(result.get("id-2")).toBe("completed");
    expect(result.size).toBe(2);
  });

  it("fetchIssueStates returns empty map for empty input without fetching", async () => {
    const result = await fetchIssueStates("test-key", []);
    expect(result.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("updateIssueState calls the mutation with correct variables", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, json: async () => ({ data: { issueUpdate: { success: true } } }),
    } as Response);
    await updateIssueState("test-key", "issue-1", "state-1");
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.variables).toEqual({ issueId: "issue-1", stateId: "state-1" });
  });

  it("postIssueComment sends commentCreate mutation", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, json: async () => ({ data: { commentCreate: { success: true } } }),
    } as Response);
    await postIssueComment("test-key", "issue-1", "PR: https://example.com/pr/1");
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.variables).toEqual({ issueId: "issue-1", body: "PR: https://example.com/pr/1" });
    expect(body.query).toContain("commentCreate");
  });

  it("ensureReadyForReviewLabel returns existing label id when found", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, json: async () => ({ data: { issueLabels: { nodes: [{ id: "label-xyz" }] } } }),
    } as Response);
    const id = await ensureReadyForReviewLabel("test-key");
    expect(id).toBe("label-xyz");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("ensureReadyForReviewLabel creates label when not found", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true, json: async () => ({ data: { issueLabels: { nodes: [] } } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true, json: async () => ({ data: { issueLabelCreate: { issueLabel: { id: "new-label" } } } }),
      } as Response);
    const id = await ensureReadyForReviewLabel("test-key");
    expect(id).toBe("new-label");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("ensureAIPlanningLabel returns existing label id when found", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, json: async () => ({ data: { issueLabels: { nodes: [{ id: "plan-label" }] } } }),
    } as Response);
    const id = await ensureAIPlanningLabel("test-key", "team-1");
    expect(id).toBe("plan-label");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("ensureAIPlanningLabel creates label with purple color when not found", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true, json: async () => ({ data: { issueLabels: { nodes: [] } } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true, json: async () => ({ data: { issueLabelCreate: { issueLabel: { id: "new-plan-label" } } } }),
      } as Response);
    const id = await ensureAIPlanningLabel("test-key", "team-1");
    expect(id).toBe("new-plan-label");
    const createBody = JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string);
    expect(createBody.variables.name).toBe("AI-Planning");
    expect(createBody.variables.color).toBe("#8B5CF6");
  });

  it("ensurePlanCompleteLabel creates label with green color when not found", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true, json: async () => ({ data: { issueLabels: { nodes: [] } } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true, json: async () => ({ data: { issueLabelCreate: { issueLabel: { id: "plan-complete-label" } } } }),
      } as Response);
    const id = await ensurePlanCompleteLabel("test-key", "team-1");
    expect(id).toBe("plan-complete-label");
    const createBody = JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string);
    expect(createBody.variables.name).toBe("Plan-Complete");
    expect(createBody.variables.color).toBe("#10B981");
  });

  it("removeLabelFromIssue removes the specified label", async () => {
    vi.mocked(fetch)
      // 1. Get current labels
      .mockResolvedValueOnce({
        ok: true, json: async () => ({
          data: { issue: { labels: { nodes: [{ id: "keep-id" }, { id: "remove-id" }] } } },
        }),
      } as Response)
      // 2. Update labels
      .mockResolvedValueOnce({
        ok: true, json: async () => ({ data: { issueUpdate: { success: true } } }),
      } as Response);

    await removeLabelFromIssue("test-key", "issue-1", "remove-id");
    const updateBody = JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string);
    expect(updateBody.variables.labelIds).toEqual(["keep-id"]);
    expect(updateBody.variables.labelIds).not.toContain("remove-id");
  });

  it("removeLabelFromIssue no-ops when label is not present", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, json: async () => ({
        data: { issue: { labels: { nodes: [{ id: "other-id" }] } } },
      }),
    } as Response);

    await removeLabelFromIssue("test-key", "issue-1", "missing-id");
    // Only one fetch call (get labels); no update call
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("markIssueReadyForReview swaps AI-Working for Ready for Review and posts PR comment", async () => {
    vi.mocked(fetch)
      // 1. ensureReadyForReviewLabel: found existing
      .mockResolvedValueOnce({
        ok: true, json: async () => ({ data: { issueLabels: { nodes: [{ id: "ready-id" }] } } }),
      } as Response)
      // 2. Get current labels on the issue
      .mockResolvedValueOnce({
        ok: true, json: async () => ({
          data: {
            issue: {
              labels: {
                nodes: [
                  { id: "other-id", name: "bug" },
                  { id: "ai-working-id", name: "AI-Working" },
                ],
              },
            },
          },
        }),
      } as Response)
      // 3. Update labels
      .mockResolvedValueOnce({
        ok: true, json: async () => ({ data: { issueUpdate: { success: true } } }),
      } as Response)
      // 4. Post comment
      .mockResolvedValueOnce({
        ok: true, json: async () => ({ data: { commentCreate: { success: true } } }),
      } as Response);

    await markIssueReadyForReview("test-key", "issue-1", "https://example.com/pr/42");

    // Verify the update labels call swapped AI-Working for Ready for Review
    const updateBody = JSON.parse(vi.mocked(fetch).mock.calls[2][1]!.body as string);
    expect(updateBody.variables.labelIds).toEqual(["other-id", "ready-id"]);
    expect(updateBody.variables.labelIds).not.toContain("ai-working-id");

    // Verify the comment was posted with the PR URL
    const commentBody = JSON.parse(vi.mocked(fetch).mock.calls[3][1]!.body as string);
    expect(commentBody.variables.body).toContain("https://example.com/pr/42");
  });
});
