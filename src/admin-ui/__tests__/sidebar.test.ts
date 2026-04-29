import { describe, expect, it } from "vitest";
import { sidebarHtml, SIDEBAR_ROUTES } from "../sidebar.js";

describe("sidebar", () => {
  it("renders all four IA groups", () => {
    const html = sidebarHtml();
    for (const label of ["Work", "Configure", "Platform", "Developer"]) {
      expect(html).toContain(`>${label}<`);
    }
  });

  it("includes a data-route attribute for every routable item", () => {
    const html = sidebarHtml();
    for (const key of SIDEBAR_ROUTES) {
      expect(html).toContain(`data-route="${key}"`);
    }
  });

  it("includes the IA-rule routes (no missing items)", () => {
    expect(SIDEBAR_ROUTES).toEqual(expect.arrayContaining([
      "overview", "issues", "jobs", "pulls", "blockers",
      "projects", "pipelines", "models", "channels", "policies",
      "runners", "sessions", "reaper", "secrets", "settings",
      "mcp", "webhooks", "audit", "customizations", "updates",
    ]));
  });
});
