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
      "reports-attr-body",
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

function mountPage(report: FleetReport, jobs: unknown[] = []): { win: Record<string, unknown> & { loadReports: () => Promise<void> }; doc: Document } {
  const dom = new JSDOM(`<!DOCTYPE html><body>${reportsHtml}</body>`, { runScripts: "dangerously" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = dom.window as any as Record<string, unknown> & { loadReports: () => Promise<void> };
  win["api"] = async (url: string) => ({ ok: true, status: 200, json: async () => (url.startsWith("/api/log") ? jobs : report) });
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

  describe("agent attribution", () => {
    const usage = { availability: "complete", tokensIn: 1, tokensOut: 2, costUsd: 0, costStatus: "reported" };
    const attr = (o: Record<string, unknown>) => ({
      version: 1, invocationId: "i", snapshotId: "s", stage: "implementation", agent: "codex", provider: "openai",
      model: "m1", profileId: "p1", authMode: "openai-api-key", limit: null, outcome: "success", usage, ...o,
    });
    const job = (id: string, attribution: unknown) => ({ issueId: id, issueIdentifier: id, attribution });
    const render = async (jobs: unknown[]) => {
      const { win, doc } = mountPage(baseReport, jobs);
      await win.loadReports();
      return doc.getElementById("reports-attr-body")!;
    };

    it("keeps mixed stages and profiles distinguishable", async () => {
      const body = await render([
        job("A-1", attr({ stage: "planning", agent: "claude", provider: "anthropic", model: "mA", profileId: "pA", authMode: "anthropic-api-key" })),
        job("A-2", attr({ stage: "review", model: "mB", profileId: "pB", authMode: "codex-subscription", usage: { ...usage, availability: "unavailable", costUsd: null, costStatus: "unavailable" } })),
      ]);
      expect(body.children.length).toBe(2);
      expect(body.children[0].textContent).toContain("planning");
      expect(body.children[0].textContent).toContain("claude/anthropic/mA");
      expect(body.children[0].textContent).toContain("pA");
      expect(body.children[1].textContent).toContain("review");
      expect(body.children[1].textContent).toContain("codex/openai/mB");
      expect(body.children[1].textContent).toContain("codex-subscription");
    });

    it("never shows unavailable cost as zero, and labels partial cost", async () => {
      const body = await render([
        job("A-1", attr({ usage: { ...usage, availability: "unavailable", costUsd: null, costStatus: "unavailable" } })),
        job("A-2", attr({ usage: { ...usage, availability: "partial", costUsd: 1.5 } })),
        job("A-3", attr({ usage: null })),
        job("A-4", attr({})),
      ]);
      expect(body.children[0].textContent).toContain("unavailable");
      expect(body.children[0].textContent).not.toContain("$0.00");
      expect(body.children[1].textContent).toContain("partial cost");
      expect(body.children[2].textContent).toContain("usage unavailable");
      expect(body.children[3].textContent).toContain("$0.00");
    });

    it("shows outcome and actual limit for failures", async () => {
      const body = await render([
        job("A-1", attr({ outcome: "error", limit: { kind: "timeout_ms", value: 5000 } })),
        job("A-2", attr({ outcome: "max_turns", limit: { kind: "max_turns", value: 7 } })),
      ]);
      expect(body.children[0].textContent).toContain("error");
      expect(body.children[0].textContent).toContain("5000 ms timeout");
      expect(body.children[1].textContent).toContain("7 max turns");
    });

    it("renders legacy rows with an explicit marker", async () => {
      const body = await render([job("A-1", null), { issueId: "A-2" }]);
      expect(body.children.length).toBe(2);
      expect(body.children[0].textContent).toContain("No attribution (legacy)");
      expect(body.children[1].textContent).toContain("No attribution (legacy)");
      expect(body.children[0].textContent).not.toContain("$");
    });

    it("escapes external labels", async () => {
      const body = await render([job("A-1", attr({ model: "<img src=x onerror=alert(1)>", profileId: "<b>x</b>" }))]);
      expect(body.querySelector("img")).toBeNull();
      expect(body.querySelector("b")).toBeNull();
      expect(body.textContent).toContain("<img src=x onerror=alert(1)>");
    });

    it("shows a note when the job read is refused", async () => {
      const { win, doc } = mountPage(baseReport);
      const api = win["api"] as (u: string) => Promise<unknown>;
      win["api"] = async (u: string) => (u.startsWith("/api/log") ? { ok: false, status: 403, json: async () => ({}) } : api(u));
      await win.loadReports();
      expect(doc.getElementById("reports-attr-note")!.textContent).toContain("403");
    });
  });
});
