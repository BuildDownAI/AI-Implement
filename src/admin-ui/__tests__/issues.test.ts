import { describe, expect, it } from "vitest";
import { issuesHtml, issuesScript } from "../pages/issues.js";
import { mountAdminPage } from "../../__tests__/helpers/fixtures/admin-ui.js";

function mountIssues(failedTrackers: Array<{ provider: string; error: string }>) {
  return mountAdminPage({
    html: issuesHtml,
    script: issuesScript,
    route: "issues",
    api: async () => ({ ok: true, status: 200, json: async () => ({ issues: [], inProgressCountsByTeam: {}, failedTrackers }) }),
  });
}

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

  it("calls /api/issues", () => {
    expect(issuesScript).toContain("/api/issues");
  });

  it("uses window.api/window.esc only", () => {
    const stripped = issuesScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });

  it("links issues through the provider-resolved issueUrl, never a hardcoded tracker host", () => {
    expect(issuesScript).toContain("window.safeUrl(issue.issueUrl)");
    expect(issuesScript).not.toContain("linear.app");
  });

  it("uses const/let, not var", () => {
    expect(issuesScript).not.toMatch(/\bvar\s+\w/);
  });
});

describe("issues page with a tracker that did not answer (AII-1549)", () => {
  it("names the tracker and its error, and says its teams' counts are missing", async () => {
    const { win, doc } = mountIssues([{ provider: "jira", error: "Jira search failed (500)" }]);
    await win.loadIssues();
    const banner = doc.getElementById("issues-partial") as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("jira");
    expect(banner.textContent).toContain("Jira search failed (500)");
    expect(banner.textContent).toContain("in-progress counts");
  });

  it("shows no banner when every tracker answered", async () => {
    const { win, doc } = mountIssues([]);
    await win.loadIssues();
    expect((doc.getElementById("issues-partial") as HTMLElement).hidden).toBe(true);
  });
});
