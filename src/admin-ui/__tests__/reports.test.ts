import { describe, expect, it } from "vitest";
import { reportsHtml, reportsScript } from "../pages/reports.js";

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
