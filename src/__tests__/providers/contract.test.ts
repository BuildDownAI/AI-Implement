import { expect } from "vitest";
import { runProviderContract, runChildIssueContract, runPrClosedUnmergedContract } from "./contract.js";
import { FakeProvider } from "./fake.js";
import type { TicketIssue } from "../../providers/types.js";

runProviderContract("FakeProvider", async ({ initialIssues }: { initialIssues: TicketIssue[] }) => {
  return new FakeProvider({ initialIssues });
});

runChildIssueContract("FakeProvider", async () => {
  const parent = { id: "parent", identifier: "TEST-1", title: "Parent", description: "", scopeKey: "TEAM", nativeStatus: "Ready" };
  const provider = new FakeProvider({ initialIssues: [parent] });
  return { provider, parentId: parent.id, scopeKey: "TEAM", inspect: async (identity) => {
    const issue = (await provider.findByKey(identity.identifier))!;
    const snapshot = await provider.fetchAIImplementSnapshot();
    return { title: issue.title, body: issue.description!, parentId: issue.parentRef?.identifier === parent.identifier ? parent.id : "",
      scopeKey: issue.scopeKey, pickupReady: snapshot.needsPlanning.some((i) => i.id === identity.id) };
  } };
});

runPrClosedUnmergedContract("FakeProvider", async (terminal) => {
  const provider = new FakeProvider({ initialIssues: [{ id: "a", identifier: "A-1", title: "Test", description: "", scopeKey: "TEAM", nativeStatus: "Ready" }] });
  if (terminal) provider.setLifecycle("a", "completed");
  return { provider, issueId: "a", scopeKey: "TEAM", restartSentence: "To run it again, set the task status to its pickup value.",
    verify: async (terminal, comment) => { expect(provider.commentsFor("a")).toEqual(terminal ? [] : [comment]); } };
});
