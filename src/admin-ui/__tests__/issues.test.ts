import { describe, expect, it } from "vitest";
import { issuesHtml, issuesScript } from "../pages/issues.js";

describe("issues page", () => {
  it("declares the expected ids", () => {
    for (const id of ["issues-subtitle", "issues-error", "issues-count", "issues-body", "issues-empty", "issues-progress-body"]) {
      expect(issuesHtml).toContain(`id="${id}"`);
    }
  });

  it("registers the 'issues' route and exposes loadIssues", () => {
    expect(issuesScript).toContain("window.registerPage('issues'");
    expect(issuesScript).toContain("window.loadIssues = loadIssues");
  });

  it("calls /api/linear/issues", () => {
    expect(issuesScript).toContain("/api/linear/issues");
  });

  it("uses window.api/window.esc only", () => {
    const stripped = issuesScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });

  it("uses const/let, not var", () => {
    expect(issuesScript).not.toMatch(/\bvar\s+\w/);
  });
});
