import { describe, expect, it } from "vitest";
import { blockersHtml, blockersScript } from "../pages/blockers.js";

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
  it("uses const/let, not var", () => {
    expect(blockersScript).not.toMatch(/\bvar\s+\w/);
  });
});
