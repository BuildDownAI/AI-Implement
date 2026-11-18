import { describe, it, expect, beforeEach } from "vitest";
import { buildPlanningContextInputs } from "../planning-context.js";
import { configureLinearAuth, __setLinearTokenForTest } from "../linear-app-auth.js";
import { makeIssue } from "./helpers/builders.js";
import { fakeFetch } from "./helpers/fake-fetch.js";

beforeEach(() => {
  configureLinearAuth("client-id", "client-secret");
  __setLinearTokenForTest("test-token");
});

// The id and identifier are the current ticket's entry among the parent's children below.
const ISSUE = makeIssue({ id: "issue-123", identifier: "ENG-123" });

describe("buildPlanningContextInputs", () => {
  it("returns None defaults for non-linear providers", async () => {
    const fake = fakeFetch({});
    const result = await buildPlanningContextInputs({
      issue: ISSUE,
      ticketingProviderId: "jira",
      fetchImpl: fake.fetch,
    });
    expect(result).toEqual({
      parent: "None",
      siblings: "None",
      dependencies: "None",
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("returns formatted parent, sibling, and dependency context from Linear", async () => {
    const fake = fakeFetch({
      "POST /graphql": {
        json: {
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
        },
      },
    });

    const result = await buildPlanningContextInputs({
      issue: ISSUE,
      ticketingProviderId: "linear",
      fetchImpl: fake.fetch,
    });

    expect(result).toEqual({
      parent: "- ENG-100: Parent ticket",
      siblings: "- ENG-124: Sibling ticket",
      dependencies: "- [blocks] ENG-200: Dependency ticket",
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("returns None defaults when Linear request fails", async () => {
    const fake = fakeFetch({
      "POST /graphql": () => {
        throw new Error("network down");
      },
    });
    const result = await buildPlanningContextInputs({
      issue: ISSUE,
      ticketingProviderId: "linear",
      fetchImpl: fake.fetch,
    });
    expect(result).toEqual({
      parent: "None",
      siblings: "None",
      dependencies: "None",
    });
  });
});
