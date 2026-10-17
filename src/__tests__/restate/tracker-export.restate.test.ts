// Real Restate coverage for the TrackerExport service (AII-1462). The provider is an in-process fake;
// the exported case table runs once per fake in FAKE_PROVIDERS, so a new provider (Jira, AII-605 step 3)
// is one more entry. Happy paths run on `alwaysReplay`, error paths on `disableRetries`, and the
// transient-error case on the retry-enabled environment.
//
// Run with `npm run test:restate`; excluded from `npm test`.
import type { RestateEnvironment } from "./harness.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RepoMapping } from "../../config.js";
import type { TicketingProvider, TrackerIssuePage, TrackerIssueRecord } from "../../providers/types.js";
import { TrackerUnavailableError } from "../../providers/types.js";
import { createTrackerExport, type TrackerExportInput } from "../../restate/tracker-export.js";
import { callService, startRetryEnabled, startVariants, stopAll } from "./harness.js";

export interface FakeScenario {
  pages: TrackerIssuePage[];
  /** Throw a plain error on the first N calls. */
  failFirst?: number;
  alwaysFail?: boolean;
  noCredential?: boolean;
  calls: Array<{ args: unknown[] }>;
}

export interface FakeProviderEntry {
  /** The provider `id` every record must be stamped with. */
  id: string;
}

/** One entry per provider under test. The Jira issue adds its fake here. */
export const FAKE_PROVIDERS: FakeProviderEntry[] = [{ id: "fake-linear" }];

const record = (n: number): TrackerIssueRecord => ({
  id: `id-${n}`, identifier: `T-${n}`, title: `Issue ${n}`, description: null,
  state: { name: "Todo", type: "unstarted" }, labels: { nodes: [] }, project: null, parent: null,
  comments: { nodes: [] }, relations: { nodes: [] },
});
const page = (nums: number[], endCursor: string | null): TrackerIssuePage => ({
  issues: nums.map(record), pageInfo: { hasNextPage: endCursor !== null, endCursor },
});

type Variant = "alwaysReplay" | "disableRetries" | "retry";

export interface TrackerExportCase {
  name: string;
  variant: Variant;
  scenario: () => Omit<FakeScenario, "calls">;
  run(call: (input: TrackerExportInput) => Promise<TrackerIssuePage>, sc: FakeScenario, entry: FakeProviderEntry, team: string): Promise<void>;
}

/** The terminal code reaches the caller in the ingress error body. */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const m = /tracker-(unavailable|failed)/.exec((err as Error).message);
    if (m) return m[0];
    throw err;
  }
  throw new Error("expected the call to fail");
}

function expectStamped(p: TrackerIssuePage, entry: FakeProviderEntry, team: string) {
  for (const issue of p.issues) {
    expect(issue.sourceSystem).toBe(entry.id);
    expect(issue.team).toBe(team);
  }
}

export const TRACKER_EXPORT_CASES: TrackerExportCase[] = [
  {
    name: "two pages then end",
    variant: "alwaysReplay",
    scenario: () => ({ pages: [page([1, 2], "c1"), page([3], null)] }),
    async run(call, sc, entry, team) {
      const first = await call({ team, cursor: null });
      expect(first.issues.map((i) => i.identifier)).toEqual(["T-1", "T-2"]);
      expect(first.pageInfo).toEqual({ hasNextPage: true, endCursor: "c1" });
      const second = await call({ team, cursor: first.pageInfo.endCursor });
      expect(second.issues.map((i) => i.identifier)).toEqual(["T-3"]);
      expect(second.pageInfo.hasNextPage).toBe(false);
      expectStamped(first, entry, team);
      expectStamped(second, entry, team);
      // The provider receives only the mapping and the cursor.
      expect(sc.calls.map((c) => c.args.length)).toEqual([2, 2]);
      expect(sc.calls.map((c) => c.args[1])).toEqual([null, "c1"]);
    },
  },
  {
    name: "an empty page is a normal answer",
    variant: "alwaysReplay",
    scenario: () => ({ pages: [page([], null)] }),
    async run(call, _sc, _entry, team) {
      expect(await call({ team, cursor: null })).toEqual({ issues: [], pageInfo: { hasNextPage: false, endCursor: null } });
    },
  },
  {
    name: "a transient error then success is retried",
    variant: "retry",
    scenario: () => ({ pages: [page([1], null)], failFirst: 2 }),
    async run(call, sc, entry, team) {
      const result = await call({ team, cursor: null });
      expect(result.issues).toHaveLength(1);
      expectStamped(result, entry, team);
      expect(sc.calls.length).toBeGreaterThan(1);
    },
  },
  {
    name: "no credential is tracker-unavailable after one provider call",
    variant: "disableRetries",
    scenario: () => ({ pages: [], noCredential: true }),
    async run(call, sc, _entry, team) {
      expect(await codeOf(call({ team, cursor: null }))).toBe("tracker-unavailable");
      expect(sc.calls).toHaveLength(1);
    },
  },
  {
    name: "always failing is tracker-failed",
    variant: "disableRetries",
    scenario: () => ({ pages: [], alwaysFail: true }),
    async run(call, sc, _entry, team) {
      expect(await codeOf(call({ team, cursor: null }))).toBe("tracker-failed");
      expect(sc.calls.length).toBe(3);
    },
  },
  {
    name: "an unknown team is tracker-unavailable with no provider call",
    variant: "disableRetries",
    scenario: () => ({ pages: [] }),
    async run(call, sc) {
      expect(await codeOf(call({ team: "NOPE", cursor: null }))).toBe("tracker-unavailable");
      expect(sc.calls).toHaveLength(0);
    },
  },
];

describe.each(FAKE_PROVIDERS)("TrackerExport service ($id)", (entry) => {
  const scenarios = new Map<string, FakeScenario>();
  let envs: Map<string, RestateEnvironment>;
  let retryEnv: RestateEnvironment;
  let counter = 0;

  const fake = {
    id: entry.id,
    async listIssuesPage(mapping: RepoMapping, cursor: string | null): Promise<TrackerIssuePage> {
      const sc = scenarios.get(mapping.teamKey ?? "");
      if (!sc) throw new Error("no scenario");
      sc.calls.push({ args: [mapping, cursor] });
      if (sc.noCredential) throw new TrackerUnavailableError("no credential");
      if (sc.alwaysFail || sc.calls.length <= (sc.failFirst ?? 0)) throw new Error("tracker down");
      const index = cursor === null ? 0 : sc.pages.findIndex((_p, i) => i > 0 && sc.pages[i - 1].pageInfo.endCursor === cursor);
      return sc.pages[index];
    },
  } as unknown as TicketingProvider;

  beforeAll(async () => {
    const services = [createTrackerExport({
      getMapping: (team) => (scenarios.has(team) ? ({ owner: "o", repo: "r" } as RepoMapping) : undefined),
      providerFor: () => fake,
      retryPolicy: { maxRetryAttempts: 3, initialRetryInterval: { milliseconds: 20 }, maxRetryInterval: { milliseconds: 50 } },
    })];
    [envs, retryEnv] = await Promise.all([startVariants(services), startRetryEnabled(services)]);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([stopAll(envs), retryEnv?.stop()]);
  });

  describe.each(TRACKER_EXPORT_CASES)("$name ($variant)", (c) => {
    it("behaves", async () => {
      const team = `T${counter++}`;
      const sc: FakeScenario = { ...c.scenario(), calls: [] };
      scenarios.set(team, sc);
      const url = (c.variant === "retry" ? retryEnv : envs.get(c.variant)!).baseUrl();
      const call = (input: TrackerExportInput) => callService<TrackerIssuePage>(url, "TrackerExport", "page", input);
      await c.run(call, sc, entry, c.name.includes("unknown team") ? "NOPE" : team);
    }, 60_000);
  });
});
