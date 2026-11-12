import { describe, expect, it, vi } from "vitest";
import { overviewHtml, overviewScript } from "../pages/overview.js";
import { blockersHtml, blockersScript } from "../pages/blockers.js";
import { mountAdminPage } from "../../__tests__/helpers/fixtures/admin-ui.js";
import { SETUP_CHECK_GROUP_LABELS } from "../../setup-checks/index.js";

type CapacityByMapping = Record<string, { used: number; cap: number; source: "reservations" }>;

function mountOverview(fixtures: {
  log?: unknown[];
  mappings?: Record<string, unknown>;
  capacityOk?: boolean;
  capacityReject?: boolean;
  capacityByMapping?: CapacityByMapping | null;
  setupChecks?: { status: number; body?: unknown };
}) {
  const { log = [], mappings = {}, capacityOk = true, capacityReject = false, capacityByMapping = {} } = fixtures;
  const { setupChecks = { status: 200, body: { run: null, progress: null, groups: SETUP_CHECK_GROUP_LABELS } } } = fixtures;
  return mountAdminPage({
    html: overviewHtml,
    script: overviewScript,
    route: "overview",
    api: async (url) => {
      if (url === "/api/setup-checks") return { ok: setupChecks.status === 200, status: setupChecks.status, json: async () => setupChecks.body };
      if (url === "/api/log") return { ok: true, status: 200, json: async () => log };
      if (url === "/api/mappings") return { ok: true, status: 200, json: async () => mappings };
      if (url === "/api/reaper/summary") return { ok: true, status: 200, json: async () => ({ lastSweepAt: null }) };
      if (url === "/api/blockers") {
        if (capacityReject) throw new Error("network unavailable");
        if (!capacityOk) return { ok: false, status: 503, json: async () => ({ error: "unavailable" }) };
        return {
          ok: true,
          status: 200,
          json: async () => ({ blockers: [], totals: { teams: 0, issues: 0, byReason: {} }, capacityByMapping }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
}

function mountBlockers(fixtures: {
  totals?: { teams: number; issues: number; byReason: Record<string, number> };
  capacityByMapping?: CapacityByMapping | null;
}) {
  const { totals = { teams: 0, issues: 0, byReason: {} }, capacityByMapping = {} } = fixtures;
  return mountAdminPage({
    html: blockersHtml,
    script: blockersScript,
    route: "blockers",
    api: async (url) => {
      if (url === "/api/blockers") {
        return { ok: true, status: 200, json: async () => ({ blockers: [], totals, capacityByMapping }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
}

describe("overview page", () => {
  it("declares all four KPI tile ids", () => {
    for (const id of ["kpi-running", "kpi-capacity", "kpi-blocked", "kpi-failed"]) {
      expect(overviewHtml).toContain(`id="${id}"`);
    }
  });

  it("declares the card body ids the script targets", () => {
    for (const id of ["overview-running-body", "overview-failures-body", "overview-projects-body", "overview-atcap-body"]) {
      expect(overviewHtml).toContain(`id="${id}"`);
    }
  });

  it("registers the 'overview' route and exposes loadOverview on window", () => {
    expect(overviewScript).toContain("window.registerPage('overview'");
    expect(overviewScript).toContain("window.loadOverview = loadOverview");
  });

  it("uses the existing data endpoints plus the shared capacity projection (AII-797)", () => {
    expect(overviewScript).toContain("/api/log");
    expect(overviewScript).toContain("/api/mappings");
    expect(overviewScript).toContain("/api/reaper/summary");
    // Capacity now rides /api/blockers's capacityByMapping, the same field blockers.ts
    // reads, rather than a bespoke endpoint.
    expect(overviewScript).toContain("/api/blockers");
    expect(overviewScript).not.toMatch(/\/api\/(kpis|overview)\b/);
  });

  it("has no bare api(/esc( calls (must use window.api/window.esc)", () => {
    const scriptWithoutWindow = overviewScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(scriptWithoutWindow).not.toMatch(/\bapi\(/);
    expect(scriptWithoutWindow).not.toMatch(/\besc\(/);
  });

  it("uses const/let, not var", () => {
    expect(overviewScript).not.toMatch(/\bvar\s+\w/);
  });

  it("opens the shared job drawer from running and failure rows", () => {
    expect(overviewScript).toContain("function wireOverviewDrawerRows");
    expect(overviewScript).toContain("overview-running-body");
    expect(overviewScript).toContain("overview-failures-body");
    expect(overviewScript).toContain("data-job-id");
    expect(overviewScript).toContain("window.openJobDrawer(Number(jobId))");
  });

  it("treats review_failed jobs as failed/attention rows", () => {
    expect(overviewScript).toContain("review_failed: 'warn'");
    expect(overviewScript).toContain("status === 'review_failed'");
    expect(overviewScript).toContain("review failed");
    expect(overviewScript).toContain("review incomplete");
    expect(overviewScript).toContain("REVIEWER_TURNS_EXHAUSTED");
    expect(overviewScript).toContain("PROVIDER_UNAVAILABLE");
  });

  it("includes stuck_giveup in the attention KPI filter", () => {
    expect(overviewScript).toContain("stuck_giveup");
    expect(overviewScript).toContain("e.conclusion === 'stuck_giveup'");
  });

  it("treats stuck_review_fix like stuck_giveup in the attention and failure filters", () => {
    const needle = "(e.conclusion === 'stuck_giveup' || e.conclusion === 'stuck_review_fix')";
    expect(overviewScript.split(needle).length - 1).toBe(2);
  });

  it("includes timed_out in jobStatusBadge map for display consistency", () => {
    expect(overviewScript).toContain("timed_out: 'warn'");
  });

  it("includes stuck_giveup in renderRecentFailures filter", () => {
    const failuresIdx = overviewScript.indexOf("renderRecentFailures");
    const afterFn = overviewScript.slice(failuresIdx);
    expect(afterFn).toContain("stuck_giveup");
  });

  it("no longer renders the removed gap-fill trigger row", () => {
    expect(overviewScript).not.toContain("Gap-fill trigger");
  });
});

describe("overview page setup-check line (AII-1541)", () => {
  const row = (group: string, state: string) => ({ id: "restate", title: "Restate engine", group, tier: "core", onAdminPath: false, state });
  const line = async (setupChecks: { status: number; body?: unknown }) => {
    const { win, doc } = mountOverview({ setupChecks });
    await win.loadOverview();
    await vi.waitFor(() => expect(doc.getElementById("overview-setup-status")?.textContent).not.toMatch(/^\s*$/));
    return doc.getElementById("overview-setup-status")!;
  };

  it("names each group with a failing row once, in the route's group order, and links to the Setup page", async () => {
    const run = { checkedAt: 1, results: [row("github", "fail"), row("tracker", "fail"), row("tracker", "fail"), row("model", "warn"), row("orchestrator", "pass")] };
    const el = await line({ status: 200, body: { run, progress: null, groups: SETUP_CHECK_GROUP_LABELS } });
    const text = el.textContent!;
    const labels = SETUP_CHECK_GROUP_LABELS;
    const times = (label: string) => text.split(label).length - 1;
    expect([labels.orchestrator, labels.tracker, labels.github, labels.model].map(times)).toEqual([0, 1, 1, 0]);
    expect(text.indexOf(labels.tracker)).toBeLessThan(text.indexOf(labels.github));
    expect(el.querySelector("a")?.getAttribute("href")).toBe("#setup");
  });

  it.each([
    ["no failing row", { status: 200, body: { run: { checkedAt: 1, results: [row("orchestrator", "warn")] }, progress: null, groups: SETUP_CHECK_GROUP_LABELS } }, /no setup check fails/i],
    ["no run yet", { status: 200, body: { run: null, progress: null, groups: SETUP_CHECK_GROUP_LABELS } }, /not run/],
    ["a run in progress", { status: 200, body: { run: null, progress: { startedAt: 1, total: 2, finished: [], running: [{ id: "restate", title: "Restate engine", group: "orchestrator" }] }, groups: SETUP_CHECK_GROUP_LABELS } }, /running/],
    ["an unreadable stored run", { status: 503, body: { error: "restate-unavailable" } }, /cannot be read/],
  ])("says so for %s", async (_case, setupChecks, fact) => {
    expect((await line(setupChecks)).textContent).toMatch(fact);
  });

  it("no longer reads the environment status or shows its pills", () => {
    expect(overviewScript).not.toContain("/api/admin/config-status");
    expect(overviewHtml).not.toContain("overview-env-status");
  });
});

describe("overview page capacity projection (AII-797)", () => {
  const mapping = {
    owner: "BuildDownAI",
    repo: "AI-Implement",
    executionMode: "github-actions",
    provider: "anthropic",
    maxInProgressAiIssues: 3,
  };

  it("counts a prepared/unknown/stopping reservation as used with no visible running row", async () => {
    const { win, doc } = mountOverview({
      log: [],
      mappings: { AII: mapping },
      capacityByMapping: { AII: { used: 3, cap: 3, source: "reservations" } },
    });
    await win.loadOverview();
    expect(doc.getElementById("kpi-running-value")?.textContent).toBe("0");
    expect(doc.getElementById("kpi-capacity-value")?.textContent).toBe("3");
    expect(doc.getElementById("kpi-blocked-value")?.textContent).toBe("1");
    expect(doc.getElementById("overview-atcap-body")?.textContent).toContain("AII");
    expect(doc.getElementById("overview-atcap-empty")?.classList.contains("hidden")).toBe(true);
  });

  it("does not let a stray job-log row inflate saturation beyond the reservation count", async () => {
    // Five "running" rows tagged for a team whose reservation projection shows only 1/3
    // used — e.g. a stranded tracker label or a stale row. The at-cap KPI and panel must
    // follow capacityByMapping, never a count derived from filtering the job log.
    const staleRunning = Array.from({ length: 5 }, (_, i) => ({ id: i, teamKey: "AII", status: "running" }));
    const { win, doc } = mountOverview({
      log: staleRunning,
      mappings: { AII: mapping },
      capacityByMapping: { AII: { used: 1, cap: 3, source: "reservations" } },
    });
    await win.loadOverview();
    expect(doc.getElementById("kpi-running-value")?.textContent).toBe("5");
    expect(doc.getElementById("kpi-blocked-value")?.textContent).toBe("0");
    expect(doc.getElementById("overview-atcap-body")?.textContent).not.toContain("AII");
    expect(doc.getElementById("overview-atcap-empty")?.classList.contains("hidden")).toBe(false);
  });

  it("renders unavailable, never 0/free, when the capacity projection fetch fails", async () => {
    const { win, doc } = mountOverview({
      log: [],
      mappings: { AII: mapping },
      capacityOk: false,
    });
    await win.loadOverview();
    expect(doc.getElementById("kpi-capacity-value")?.textContent).toBe("—");
    expect(doc.getElementById("kpi-blocked-value")?.textContent).toBe("—");
    expect(doc.getElementById("overview-atcap-unavailable")?.classList.contains("hidden")).toBe(false);
    expect(doc.getElementById("overview-atcap-empty")?.classList.contains("hidden")).toBe(true);
    expect(doc.getElementById("overview-projects-body")?.textContent).toContain("unavailable");
  });

  it("renders unavailable when the capacity request rejects before a response", async () => {
    const { win, doc } = mountOverview({
      mappings: { AII: mapping },
      capacityReject: true,
    });
    await win.loadOverview();
    expect(doc.getElementById("kpi-capacity-value")?.textContent).toBe("—");
    expect(doc.getElementById("kpi-blocked-value")?.textContent).toBe("—");
    expect(doc.getElementById("overview-atcap-unavailable")?.classList.contains("hidden")).toBe(false);
    expect(doc.getElementById("overview-atcap-empty")?.classList.contains("hidden")).toBe(true);
    expect(doc.getElementById("overview-projects-body")?.textContent).toContain("unavailable");
  });

  it("renders unavailable when the capacity payload is malformed", async () => {
    const { win, doc } = mountOverview({
      log: [],
      mappings: { AII: mapping },
      capacityByMapping: null,
    });
    await win.loadOverview();
    expect(doc.getElementById("kpi-capacity-value")?.textContent).toBe("—");
    expect(doc.getElementById("kpi-blocked-value")?.textContent).toBe("—");
  });

  it("keeps the running-jobs KPI separately named from capacity used", async () => {
    const { win, doc } = mountOverview({
      log: [{ id: 1, teamKey: "AII", status: "running" }],
      mappings: { AII: mapping },
      capacityByMapping: { AII: { used: 3, cap: 3, source: "reservations" } },
    });
    await win.loadOverview();
    expect(doc.getElementById("kpi-running-value")?.textContent).toBe("1");
    expect(doc.getElementById("kpi-capacity-value")?.textContent).toBe("3");
  });

  it("overview and blockers render the same at-cap-teams count from the same capacity payload", async () => {
    const capacityByMapping: CapacityByMapping = {
      AII: { used: 3, cap: 3, source: "reservations" },
      OTHER: { used: 1, cap: 3, source: "reservations" },
    };
    const overview = mountOverview({
      log: [],
      mappings: { AII: mapping, OTHER: { ...mapping, maxInProgressAiIssues: 3 } },
      capacityByMapping,
    });
    const blockers = mountBlockers({ capacityByMapping });
    await overview.win.loadOverview();
    await blockers.win.loadBlockers();
    const overviewBlocked = overview.doc.getElementById("kpi-blocked-value")?.textContent;
    const blockersConcurrency = blockers.doc.getElementById("kpi-blocked-concurrency")?.textContent;
    expect(overviewBlocked).toBe("1");
    expect(blockersConcurrency).toBe("1");
    expect(overviewBlocked).toBe(blockersConcurrency);
  });
});
