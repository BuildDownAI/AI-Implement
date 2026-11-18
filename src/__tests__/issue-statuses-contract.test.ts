// Spotter copies these real-handler exchanges. Regenerate deliberately with:
// UPDATE_CONTRACT_FIXTURES=1 npx vitest run src/__tests__/issue-statuses-contract.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueStatusEntry } from "../issue-statuses.js";
import type { NormalizedIssueState, TicketingProvider } from "../providers/types.js";
import { TrackerUnavailableError } from "../providers/types.js";
import { testDb } from "./helpers/test-db.js";
import { makeMapping } from "./helpers/builders.js";
import { FakeProvider } from "./providers/fake.js";
import { checkExchange, recordExchange, type Exchange } from "./contract-recorder.js";

const T = 1_700_000_000_000;
const TOKEN = "issue-statuses-contract-token-sentinel";
const EXTRA_ENV = "issue-statuses-contract-extra-env-sentinel";
const STATES: NormalizedIssueState[] = [
  "ready", "planning", "awaiting-approval", "plan-approved", "implementing",
  "pr-ready", "merged", "failed", "unknown",
];
let tools: typeof import("../restate/tools.js");
let read: ReturnType<typeof vi.fn<NonNullable<TicketingProvider["listIssueStatuses"]>>>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T + 60_000);
  const { modules } = await testDb({ modules: {
    dedup: () => import("../dedup.js"),
    config: () => import("../config.js"),
    statuses: () => import("../issue-statuses.js"),
    registry: () => import("../providers/registry.js"),
    tools: () => import("../restate/tools.js"),
  } });
  tools = modules.tools;
  modules.dedup.getDb().prepare("DELETE FROM mappings").run();
  modules.config.upsertMapping("APP", makeMapping({ extraEnv: { SECRET: EXTRA_ENV } }));
  modules.statuses.clearIssueStatusesCache();
  read = vi.fn<NonNullable<TicketingProvider["listIssueStatuses"]>>().mockResolvedValue([]);
  const provider = Object.assign(new FakeProvider(), { listIssueStatuses: read });
  const registry = new modules.registry.ProviderRegistry({ jiraToken: TOKEN }, modules.config.getMappings);
  vi.spyOn(registry, "forMapping").mockResolvedValue(provider);
  tools.setProviderRegistry(registry);
});

afterEach(() => {
  tools.setProviderRegistry(null);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function entriesOf(recorded: Exchange): IssueStatusEntry[] {
  expect(recorded.response.status).toBe(200);
  expect(recorded.response.body.isError).toBeFalsy();
  const entries: IssueStatusEntry[] = JSON.parse(recorded.response.body.content[0].text);
  expect(Array.isArray(entries)).toBe(true);
  return entries;
}

function check(scenario: string, recorded: Exchange): void {
  expect(recorded.request).toEqual({ method: "POST", path: "/api/tools/list_issue_statuses", body: { args: {} } });
  const serialized = JSON.stringify(recorded);
  for (const secret of [TOKEN, EXTRA_ENV, "extraEnv"]) expect(serialized).not.toContain(secret);
  expect(read).toHaveBeenCalledTimes(1);
  checkExchange("list_issue_statuses", scenario, recorded);
}

describe("recorded list_issue_statuses exchanges", () => {
  it("every-state", async () => {
    read.mockResolvedValue(STATES.map((state, i) => ({
      id: `issue-${i + 1}`, identifier: `APP-${i + 1}`, title: `Issue in ${state}`,
      url: `https://linear.app/acme/issue/APP-${i + 1}`, state,
      phase: state === "failed" ? "planning" : null,
      labels: ["AI-Implement"], workflowState: "Todo", updatedAt: T + i * 1000,
    })));
    const recorded = await recordExchange("list_issue_statuses", { args: {} });
    const entries = entriesOf(recorded);
    expect(entries).toHaveLength(9);
    expect(entries.map((entry) => entry.state).sort()).toEqual([...STATES].sort());
    expect(entries.find((entry) => entry.state === "failed")?.phase).toBe("planning");
    check("every-state", recorded);
  });

  it("empty", async () => {
    const recorded = await recordExchange("list_issue_statuses", { args: {} });
    expect(entriesOf(recorded)).toEqual([]);
    check("empty", recorded);
  });

  it("tracker-unavailable", async () => {
    read.mockRejectedValue(new TrackerUnavailableError("Linear credential is unavailable"));
    const recorded = await recordExchange("list_issue_statuses", { args: {} });
    expect(recorded.response.status).toBe(200);
    expect(recorded.response.body.isError).toBe(true);
    expect(recorded.response.body.content[0].text).toContain("Linear credential is unavailable");
    check("tracker-unavailable", recorded);
  });
});
