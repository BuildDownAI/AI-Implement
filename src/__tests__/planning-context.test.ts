import { describe, it, expect, vi } from "vitest";
import { buildPlanningContextInputs } from "../planning-context.js";
import type { TicketIssue } from "../providers/types.js";

const ISSUE: TicketIssue = {
  id: "issue-123",
  identifier: "ENG-123",
  title: "Example issue",
  description: "Example description",
  scopeKey: "ENG",
  nativeStatus: "Todo",
};

describe("buildPlanningContextInputs", () => {
  it("returns None defaults for non-linear providers", async () => {
    const fetchImpl = vi.fn();
    const result = await buildPlanningContextInputs({
      issue: ISSUE,
      linearApiKey: "lin-key",
      ticketingProviderId: "jira",
      fetchImpl,
    });
    expect(result).toEqual({
      parent: "None",
      siblings: "None",
      dependencies: "None",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns formatted parent, sibling, and dependency context from Linear", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          issue: {
            parent: {
              id: "parent-1",
              identifier: "ENG-100",
              title: "Parent ticket",
              children: {
                nodes: [
                  { id: "issue-123", identifier: "ENG-123", title: "Current ticket" },
                  { id: "sibling-1", identifier: "ENG-124", title: "Sibling ticket" },
                ],
              },
            },
            relations: {
              nodes: [
                {
                  type: "blocks",
                  relatedIssue: { identifier: "ENG-200", title: "Dependency ticket" },
                },
              ],
            },
          },
        },
      }),
    });

    const result = await buildPlanningContextInputs({
      issue: ISSUE,
      linearApiKey: "lin-key",
      ticketingProviderId: "linear",
      fetchImpl,
    });

    expect(result).toEqual({
      parent: "- ENG-100: Parent ticket",
      siblings: "- ENG-124: Sibling ticket",
      dependencies: "- [blocks] ENG-200: Dependency ticket",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns None defaults when Linear request fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const result = await buildPlanningContextInputs({
      issue: ISSUE,
      linearApiKey: "lin-key",
      ticketingProviderId: "linear",
      fetchImpl,
    });
    expect(result).toEqual({
      parent: "None",
      siblings: "None",
      dependencies: "None",
    });
  });
});
