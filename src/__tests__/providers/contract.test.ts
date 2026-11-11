import { runProviderContract } from "./contract.js";
import { FakeProvider } from "./fake.js";
import type { TicketIssue } from "../../providers/types.js";

runProviderContract("FakeProvider", async ({ initialIssues }: { initialIssues: TicketIssue[] }) => {
  return new FakeProvider({ initialIssues });
});

import { runChildIssueContract } from "./contract.js";

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
