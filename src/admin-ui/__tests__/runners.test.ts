import { describe, expect, it } from "vitest";
import { runnersHtml, runnersScript } from "../pages/runners.js";

describe("runners page", () => {
  it("declares the expected ids", () => {
    for (const id of ["runners-subtitle", "runners-error", "runners-mode-banner", "kpi-runner-mode", "kpi-runner-source", "kpi-live-sessions", "kpi-capacity-used", "kpi-capacity-max", "kpi-reaped", "kpi-reaper-sweep", "runners-sessions-body", "runners-sessions-empty", "runners-projects-body", "runners-projects-empty"]) {
      expect(runnersHtml).toContain(`id="${id}"`);
    }
  });
  it("registers route + exposes loadRunners", () => {
    expect(runnersScript).toContain("window.registerPage('runners'");
    expect(runnersScript).toContain("window.loadRunners = loadRunners");
  });
  it("calls the four expected endpoints", () => {
    for (const ep of ["/api/runner-mode", "/api/mappings", "/api/sessions", "/api/reaper/summary"]) {
      expect(runnersScript).toContain(ep);
    }
  });
  it("does not invent new endpoints", () => {
    expect(runnersScript).not.toMatch(/\/api\/(runners|fleet|machines)\b/);
  });
  it("uses window.api/window.esc only", () => {
    const stripped = runnersScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });
  it("uses const/let, not var", () => {
    expect(runnersScript).not.toMatch(/\bvar\s+\w/);
  });
});
