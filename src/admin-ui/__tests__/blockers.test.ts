import { describe, expect, it } from "vitest";
import { blockersHtml, blockersScript } from "../pages/blockers.js";
import { mountAdminPage } from "../../__tests__/helpers/fixtures/admin-ui.js";

type CapacityByMapping = Record<string, { used: number; cap: number; source: "reservations" }>;

function mountBlockers(fixtures: {
  ok?: boolean;
  reject?: boolean;
  totals?: { teams: number; issues: number; byReason: Record<string, number> };
  capacityByMapping?: CapacityByMapping | null;
  failedTrackers?: Array<{ provider: string; error: string }>;
}) {
  const { ok = true, reject = false, totals = { teams: 0, issues: 0, byReason: {} }, capacityByMapping = {}, failedTrackers = [] } = fixtures;
  return mountAdminPage({
    html: blockersHtml,
    script: blockersScript,
    route: "blockers",
    api: async (url) => {
      if (url !== "/api/blockers") return { ok: true, status: 200, json: async () => ({}) };
      if (reject) throw new Error("network unavailable");
      if (!ok) return { ok: false, status: 502, json: async () => ({ error: "upstream unavailable" }) };
      return { ok: true, status: 200, json: async () => ({ blockers: [], totals, capacityByMapping, failedTrackers }) };
    },
  });
}

describe("blockers page", () => {
  it("declares the expected ids", () => {
    for (const id of ["blockers-subtitle", "blockers-error", "blockers-kpis", "blockers-body", "blockers-empty", "kpi-blocked-total", "kpi-blocked-teams", "kpi-blocked-concurrency", "kpi-blocked-dedup"]) {
      expect(blockersHtml).toContain(`id="${id}"`);
    }
  });
  it("registers route + exposes loadBlockers", () => {
    expect(blockersScript).toContain("window.registerPage('blockers'");
    expect(blockersScript).toContain("window.loadBlockers = loadBlockers");
  });
  it("calls /api/blockers", () => {
    expect(blockersScript).toContain("/api/blockers");
  });
  it("uses window.api/window.esc only", () => {
    const stripped = blockersScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });
  it("links issues through the provider-resolved issueUrl, never a hardcoded tracker host", () => {
    expect(blockersScript).toContain("window.safeUrl(b.issueUrl)");
    expect(blockersScript).not.toContain("linear.app");
  });

  it("uses const/let, not var", () => {
    expect(blockersScript).not.toMatch(/\bvar\s+\w/);
  });
});

describe("blockers page capacity projection (AII-797)", () => {
  it("reports teams at capacity from capacityByMapping, not the blocked-issue count", async () => {
    const { win, doc } = mountBlockers({
      totals: { teams: 1, issues: 4, byReason: { concurrency: 4, dedup: 0 } },
      capacityByMapping: { AII: { used: 3, cap: 3, source: "reservations" } },
    });
    await win.loadBlockers();
    // capacityByMapping reports 1 team at cap, independent of the 4 blocked issues
    // totals.byReason.concurrency counts for that same team.
    expect(doc.getElementById("kpi-blocked-concurrency")?.textContent).toBe("1");
  });

  it("counts a team at cap from reservations with zero blocked issues on record", async () => {
    const { win, doc } = mountBlockers({
      totals: { teams: 0, issues: 0, byReason: {} },
      capacityByMapping: { AII: { used: 3, cap: 3, source: "reservations" } },
    });
    await win.loadBlockers();
    expect(doc.getElementById("kpi-blocked-concurrency")?.textContent).toBe("1");
  });

  it("renders unavailable, never 0, when the capacity payload is malformed", async () => {
    const { win, doc } = mountBlockers({
      totals: { teams: 0, issues: 0, byReason: {} },
      capacityByMapping: null,
    });
    await win.loadBlockers();
    expect(doc.getElementById("kpi-blocked-concurrency")?.textContent).toBe("—");
  });

  it("hides the KPI grid behind the error banner rather than showing 0 when /api/blockers fails", async () => {
    const { win, doc } = mountBlockers({ ok: false });
    await win.loadBlockers();
    expect((doc.getElementById("blockers-kpis") as HTMLElement).hidden).toBe(true);
    expect((doc.getElementById("blockers-error") as HTMLElement).hidden).toBe(false);
  });

  it("hides the KPI grid when the blockers request rejects", async () => {
    const { win, doc } = mountBlockers({ reject: true });
    await win.loadBlockers();
    expect((doc.getElementById("blockers-kpis") as HTMLElement).hidden).toBe(true);
    expect((doc.getElementById("blockers-error") as HTMLElement).textContent).toContain("Capacity data unavailable");
  });
});

describe("blockers page with a tracker that did not answer (AII-1549)", () => {
  it("names the tracker and its error beside the rows the others returned", async () => {
    const { win, doc } = mountBlockers({ failedTrackers: [{ provider: "jira", error: "Jira search failed (500)" }] });
    await win.loadBlockers();
    const banner = doc.getElementById("blockers-partial") as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("jira");
    expect(banner.textContent).toContain("Jira search failed (500)");
    expect((doc.getElementById("blockers-kpis") as HTMLElement).hidden).toBe(false);
  });

  it("shows no banner when every tracker answered", async () => {
    const { win, doc } = mountBlockers({});
    await win.loadBlockers();
    expect((doc.getElementById("blockers-partial") as HTMLElement).hidden).toBe(true);
  });
});
