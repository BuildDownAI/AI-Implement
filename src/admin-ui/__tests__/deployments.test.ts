import { describe, expect, it } from "vitest";
import { deploymentsHtml, deploymentsScript } from "../pages/deployments.js";

describe("deployments page", () => {
  it("declares the expected ids", () => {
    for (const id of [
      "deployments-subtitle",
      "deployments-error",
      "deployments-not-configured",
      "deployments-held-section",
      "deployments-held-title",
      "deployments-held-desc",
      "kpi-deploy-available",
      "kpi-deploy-checked",
      "kpi-deploy-status",
      "deployments-deploy-btn",
      "deployments-uptodate",
    ]) {
      expect(deploymentsHtml).toContain(`id="${id}"`);
    }
  });

  it("registers route + exposes loadDeployments", () => {
    expect(deploymentsScript).toContain("window.registerPage('deployments'");
    expect(deploymentsScript).toContain("window.loadDeployments = loadDeployments");
  });

  it("exposes triggerDeploy", () => {
    expect(deploymentsScript).toContain("window.triggerDeploy = triggerDeploy");
  });

  it("calls /api/deployment-status", () => {
    expect(deploymentsScript).toContain("/api/deployment-status");
  });

  it("calls /api/deploy for the deploy trigger", () => {
    expect(deploymentsScript).toContain("/api/deploy");
  });

  it("uses window.api/window.esc only", () => {
    const stripped = deploymentsScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });

  it("uses const/let, not var", () => {
    expect(deploymentsScript).not.toMatch(/\bvar\s+\w/);
  });

  it("updates the nav indicator based on availability", () => {
    expect(deploymentsScript).toContain("deploy-available");
    expect(deploymentsScript).toContain("navCount.hidden");
  });
});
