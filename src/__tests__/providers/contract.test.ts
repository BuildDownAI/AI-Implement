import { runProviderContract } from "./contract.js";
import { FakeProvider } from "./fake.js";
import type { TicketIssue } from "../../providers/types.js";

runProviderContract("FakeProvider", async ({ initialIssues }: { initialIssues: TicketIssue[] }) => {
  return new FakeProvider({ initialIssues });
});
