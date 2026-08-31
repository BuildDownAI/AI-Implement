import { describe, expect, it } from "vitest";
import { adminHtml } from "../index.js";
import { SIDEBAR_ROUTES } from "../sidebar.js";

describe("admin HTML", () => {
  it("contains a data-page section for every sidebar route", () => {
    for (const route of SIDEBAR_ROUTES) {
      expect(adminHtml, `missing data-page="${route}"`).toContain(`data-page="${route}"`);
    }
  });

  // Carries no nav entry, so the route sweep above cannot reach it — and without the section the
  // router's fallback would show a blank page rather than an explanation.
  it("contains the no-access fallback section, which has no sidebar route", () => {
    expect(adminHtml).toContain('data-page="no-access"');
    expect(SIDEBAR_ROUTES).not.toContain("no-access");
  });

  it("renders the four IA group labels in the sidebar", () => {
    for (const label of ["Work", "Configure", "Platform", "Developer"]) {
      expect(adminHtml).toContain(`>${label}<`);
    }
  });

  it("retains login form ids for backend auth tests", () => {
    expect(adminHtml).toContain('id="access-code"');
    expect(adminHtml).toContain('id="login-error"');
  });

  it("exposes the per-project workflow sync action", () => {
    expect(adminHtml).toContain("Sync workflows");
    expect(adminHtml).toContain("/sync-workflows");
    expect(adminHtml).toContain("window.syncWorkflows");
  });
});
