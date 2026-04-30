import { describe, expect, it } from "vitest";
import { drawerHtml, drawerScript } from "../drawer.js";

describe("job drawer", () => {
  it("declares the expected drawer ids", () => {
    for (const id of [
      "job-drawer-wrap",
      "drawer-issue-row",
      "drawer-title",
      "drawer-meta",
      "drawer-failure-alert",
      "drawer-elapsed",
      "drawer-timeline",
      "drawer-steps",
      "drawer-context",
      "drawer-logs-link",
      "drawer-step-count",
    ]) {
      expect(drawerHtml).toContain(`id="${id}"`);
    }
  });

  it("exposes openJobDrawer and closeJobDrawer on window", () => {
    expect(drawerScript).toContain("window.openJobDrawer = openJobDrawer");
    expect(drawerScript).toContain("window.closeJobDrawer = closeJobDrawer");
  });

  it("fetches /api/jobs/:id/steps", () => {
    expect(drawerScript).toMatch(/\/api\/jobs\//);
    expect(drawerScript).toContain("/steps");
  });

  it("uses window.api/window.esc only", () => {
    const stripped = drawerScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });

  it("uses const/let, not var", () => {
    expect(drawerScript).not.toMatch(/\bvar\s+\w/);
  });

  it("registers an ESC handler to close the drawer", () => {
    expect(drawerScript).toMatch(/keydown/);
    expect(drawerScript).toMatch(/Escape/);
  });
});
