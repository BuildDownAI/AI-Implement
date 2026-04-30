import { describe, expect, it } from "vitest";
import { pullsHtml, pullsScript } from "../pages/pulls.js";

describe("pulls page", () => {
  it("declares the expected ids", () => {
    for (const id of ["pulls-subtitle", "pulls-error", "pulls-count", "pulls-body", "pulls-empty"]) {
      expect(pullsHtml).toContain(`id="${id}"`);
    }
  });
  it("registers the route and exposes loadPulls", () => {
    expect(pullsScript).toContain("window.registerPage('pulls'");
    expect(pullsScript).toContain("window.loadPulls = loadPulls");
  });
  it("calls /api/pulls and nothing new", () => {
    expect(pullsScript).toContain("/api/pulls");
    expect(pullsScript).not.toMatch(/\/api\/(github|pr|reviews)\b/);
  });
  it("uses window.api/window.esc only", () => {
    const stripped = pullsScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });
  it("uses const/let, not var", () => {
    expect(pullsScript).not.toMatch(/\bvar\s+\w/);
  });
});
