import { describe, expect, it } from "vitest";
import { overviewHtml, overviewScript } from "../pages/overview.js";

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

  it("uses the existing data endpoints (no new backend)", () => {
    expect(overviewScript).toContain("/api/log");
    expect(overviewScript).toContain("/api/mappings");
    expect(overviewScript).toContain("/api/reaper/summary");
    expect(overviewScript).not.toMatch(/\/api\/(blockers|kpis|overview)\b/);
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
  });
});
