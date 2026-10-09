import { describe, expect, it } from "vitest";
import { sidebarHtml, SIDEBAR_ROUTES, GRANT_BLOCKERS } from "../sidebar.js";
import { PAGE_ROUTES } from "../../access-page-grants.js";
import { componentsCss } from "../components.js";

describe("sidebar", () => {
  it("renders all four IA groups", () => {
    const html = sidebarHtml();
    for (const label of ["Work", "Configure", "Platform", "Developer"]) {
      expect(html).toContain(`>${label}<`);
    }
  });

  it("lists Knowledge Graph Pipelines as the last Work item, after Reports", () => {
    const html = sidebarHtml();
    const work = html.slice(html.indexOf(">Work<"), html.indexOf(">Configure<"));
    const routes = [...work.matchAll(/data-route="([^"]+)"/g)].map((m) => m[1]);
    expect(routes[routes.length - 1]).toBe("kg-pipelines");
    expect(routes[routes.length - 2]).toBe("reports");
    expect(html).toContain("Knowledge Graph Pipelines");
  });

  it("keeps kg-pipelines admin-only: a grant blocker and no PAGE_ROUTES entry", () => {
    expect(GRANT_BLOCKERS["kg-pipelines"]).toBe("Starts knowledge-graph refreshes and changes the materialize setting.");
    expect(Object.keys(PAGE_ROUTES)).not.toContain("kg-pipelines");
  });

  it("includes a data-route attribute for every routable item", () => {
    const html = sidebarHtml();
    for (const key of SIDEBAR_ROUTES) {
      expect(html).toContain(`data-route="${key}"`);
    }
  });

  it("clips the sidebar to the viewport so nothing escapes past its edge", () => {
    // Matched within the .sidebar rule rather than by adjacency, so reordering
    // or inserting a property does not fail a fix that still works.
    const sidebarRule = /\.sidebar\s*\{([^}]*)\}/.exec(componentsCss)?.[1] ?? "";
    expect(sidebarRule).toContain("height: 100vh");
    expect(sidebarRule).toContain("overflow: hidden");
  });

  it("gives the nav region its own scroll so the brand and footer stay pinned", () => {
    const navRule = /\.sidebar-nav\s*\{([^}]*)\}/.exec(componentsCss)?.[1] ?? "";
    expect(navRule).toContain("flex: 1");
    expect(navRule).toContain("overflow-y: auto");
    expect(sidebarHtml()).toContain('class="sidebar-nav"');
  });

  it("includes the IA-rule routes (no missing items)", () => {
    expect(SIDEBAR_ROUTES).toEqual(expect.arrayContaining([
      "overview", "issues", "jobs", "pulls", "blockers",
      "projects", "pipelines", "models", "channels", "policies",
      "runners", "sessions", "reaper", "secrets", "settings",
      "webhooks", "audit", "customizations", "updates",
    ]));
  });
});
