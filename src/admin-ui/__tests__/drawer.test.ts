import { describe, expect, it } from "vitest";
import { drawerHtml, drawerScript } from "../drawer.js";
import { componentsCss } from "../components.js";

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

  it("auto-refreshes the open drawer and stops refreshing on close", () => {
    expect(drawerScript).toContain("const DRAWER_REFRESH_MS = 5000");
    expect(drawerScript).toContain("function startDrawerAutoRefresh");
    expect(drawerScript).toContain("setInterval(function ()");
    expect(drawerScript).toContain("refreshJobDrawer(id, { background: true })");
    expect(drawerScript).toContain("function stopDrawerAutoRefresh");
    expect(drawerScript).toContain("clearInterval(drawerRefreshTimer)");
  });

  it("maps local-docker jobs into the implementation/review timeline", () => {
    expect(drawerScript).toContain("mode === 'local-docker'");
    expect(drawerScript).toContain("post-push review running");
  });

  it("shows review_failed jobs as review attention instead of completed", () => {
    expect(drawerScript).toContain("s === 'review_failed'");
    expect(drawerScript).toContain("Review needs attention");
    expect(drawerScript).toContain("post-push review needs attention");
  });

  it("renders passed step records as success badges", () => {
    expect(drawerScript).toContain("step.status === 'completed' || step.status === 'passed'");
  });

  it("hides unavailable workflow logs links without leaving an empty href", () => {
    expect(drawerScript).toContain("hasWorkflowLogs");
    expect(drawerScript).toContain("logsLink.removeAttribute('href')");
  });

  it("normalizes logged owner/repo values before building GitHub URLs", () => {
    expect(drawerScript).toContain("function repoPartsForJob");
    expect(drawerScript).toContain("job.repo.includes('/')");
  });

  it("has a global hidden rule that wins over button display styles", () => {
    expect(componentsCss).toContain("[hidden] { display: none !important; }");
  });
});
