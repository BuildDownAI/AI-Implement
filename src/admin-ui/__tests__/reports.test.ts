import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { reportsHtml, reportsScript } from "../pages/reports.js";
import type { FleetReport } from "../../report-card.js";

describe("reports page", () => {
  it("declares expected element ids", () => {
    for (const id of [
      "reports-days",
      "reports-repo-count",
      "reports-fleet-body",
      "reports-fleet-empty",
      "reports-oneshot",
      "reports-eventual",
      "reports-escape",
      "reports-planning-body",
      "reports-runaways-body",
      "reports-runaways-empty",
    ]) {
      expect(reportsHtml).toContain(`id="${id}"`);
    }
  });

  it("includes all five sections", () => {
    expect(reportsHtml).toContain("Fleet by repo");
    expect(reportsHtml).toContain("Outcomes");
    expect(reportsHtml).toContain("Planning A/B");
    expect(reportsHtml).toContain("Runaways");
  });

  it("has a days selector with 7, 30, and 90 options", () => {
    expect(reportsHtml).toContain('value="7"');
    expect(reportsHtml).toContain('value="30"');
    expect(reportsHtml).toContain('value="90"');
  });

  it("registers the 'reports' route and exposes loadReports on window", () => {
    expect(reportsScript).toContain("window.registerPage('reports'");
    expect(reportsScript).toContain("window.loadReports = loadReports");
  });

  it("calls /api/report", () => {
    expect(reportsScript).toContain("/api/report");
  });

  it("runaways link to the runners page", () => {
    expect(reportsScript).toContain('href="#runners"');
  });

  it("uses window.api/window.esc only (no bare api/esc calls)", () => {
    const stripped = reportsScript
      .replace(/window\.api\(/g, "")
      .replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });

  it("uses const/let, not var", () => {
    expect(reportsScript).not.toMatch(/\bvar\s+\w/);
  });
});

// ---- Render tests ----

const baseReport: FleetReport = {
  byRepo: [
    { repo: "org/repo-a", jobs: 10, issues: 8, completed: 7, failed: 2, merged: 5, avgPasses: 1.5, costUsd: 12.34 },
  ],
  oneShotPct: 0.6,
  eventualPct: 0.8,
  planning: {
    planned: { jobs: 4, oneShotPct: 0.75, avgPasses: 1.25, avgCostUsd: 2.5, mergedPct: 0.5 },
    unplanned: { jobs: 6, oneShotPct: 0.5, avgPasses: 1.67, avgCostUsd: 3.1, mergedPct: 0.33 },
  },
  escapeRate: 0.05,
  runaways: [{ issueIdentifier: "AII-99", repo: "org/repo-a", dispatches: 4, consecutiveFailures: 3 }],
};

function mountPage(report: FleetReport): { win: Record<string, unknown> & { loadReports: () => Promise<void> }; doc: Document } {
  const dom = new JSDOM(`<!DOCTYPE html><body>${reportsHtml}</body>`, { runScripts: "dangerously" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = dom.window as any as Record<string, unknown> & { loadReports: () => Promise<void> };
  win["api"] = async () => ({ ok: true, json: async () => report });
  win["esc"] = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  win["registerPage"] = () => {};
  const script = dom.window.document.createElement("script");
  script.textContent = reportsScript;
  dom.window.document.head.appendChild(script);
  return { win, doc: dom.window.document };
}

describe("reports page render", () => {
  it("populates the fleet table with repo rows", async () => {
    const { win, doc } = mountPage(baseReport);
    await win.loadReports();
    const fleetBody = doc.getElementById("reports-fleet-body")!;
    expect(fleetBody.children.length).toBe(1);
    expect(fleetBody.textContent).toContain("org/repo-a");
    expect(fleetBody.textContent).toContain("1.5");
    expect(fleetBody.textContent).toContain("$12.34");
    expect(doc.getElementById("reports-fleet-empty")!.classList.contains("hidden")).toBe(true);
    expect(doc.getElementById("reports-repo-count")!.textContent).toBe("(1 repos)");
  });

  it("fills the outcome KPI spans", async () => {
    const { win, doc } = mountPage(baseReport);
    await win.loadReports();
    expect(doc.getElementById("reports-oneshot")!.textContent).toBe("60.0%");
    expect(doc.getElementById("reports-eventual")!.textContent).toBe("80.0%");
    expect(doc.getElementById("reports-escape")!.textContent).toBe("5.0%");
  });

  it("renders both planning cohort rows", async () => {
    const { win, doc } = mountPage(baseReport);
    await win.loadReports();
    const planningBody = doc.getElementById("reports-planning-body")!;
    expect(planningBody.children.length).toBe(2);
    expect(planningBody.textContent).toContain("Planned");
    expect(planningBody.textContent).toContain("Unplanned");
  });

  it("populates the runaways table and hides the empty notice", async () => {
    const { win, doc } = mountPage(baseReport);
    await win.loadReports();
    const runaBody = doc.getElementById("reports-runaways-body")!;
    expect(runaBody.children.length).toBe(1);
    expect(runaBody.textContent).toContain("AII-99");
    expect(doc.getElementById("reports-runaways-empty")!.classList.contains("hidden")).toBe(true);
  });

  it("shows em dash for null escapeRate", async () => {
    const { win, doc } = mountPage({ ...baseReport, escapeRate: null });
    await win.loadReports();
    expect(doc.getElementById("reports-escape")!.textContent).toBe("\u2014");
  });

  it("shows the fleet empty notice when byRepo is empty", async () => {
    const { win, doc } = mountPage({ ...baseReport, byRepo: [] });
    await win.loadReports();
    expect(doc.getElementById("reports-fleet-body")!.innerHTML).toBe("");
    expect(doc.getElementById("reports-fleet-empty")!.classList.contains("hidden")).toBe(false);
    expect(doc.getElementById("reports-repo-count")!.textContent).toBe("(0 repos)");
  });

  it("shows the runaways empty notice when runaways is empty", async () => {
    const { win, doc } = mountPage({ ...baseReport, runaways: [] });
    await win.loadReports();
    expect(doc.getElementById("reports-runaways-body")!.innerHTML).toBe("");
    expect(doc.getElementById("reports-runaways-empty")!.classList.contains("hidden")).toBe(false);
  });
});
