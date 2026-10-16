import { describe, expect, it } from "vitest";
import { modelsAndProvidersHtml, modelsAndProvidersScript } from "../pages/models-and-providers.js";

describe("models-and-providers page", () => {
  it("declares the expected ids", () => {
    for (const id of ["mp-subtitle", "mp-error", "mp-kpis", "mp-rows", "mp-empty", "kpi-mp-projects", "kpi-mp-anthropic", "kpi-mp-bedrock", "kpi-mp-regions"]) {
      expect(modelsAndProvidersHtml).toContain(`id="${id}"`);
    }
  });
  it("registers the 'models' route and exposes loadModelsAndProviders", () => {
    expect(modelsAndProvidersScript).toContain("window.registerPage('models'");
    expect(modelsAndProvidersScript).toContain("window.loadModelsAndProviders = loadModelsAndProviders");
  });
  it("calls /api/mappings and only the AII-962 stage endpoints", () => {
    expect(modelsAndProvidersScript).toContain("/api/mappings");
    expect(modelsAndProvidersScript).not.toMatch(/\/api\/(models|providers|model-providers)\b/);
    expect(modelsAndProvidersScript).toContain("/api/agent-defaults");
    expect(modelsAndProvidersScript).toContain("/api/model-accounts");
  });
  it("drops the blanket repo-front-matter claim and explains opt-in", () => {
    expect(modelsAndProvidersHtml).not.toContain("Edit the model itself in the target repo");
    expect(modelsAndProvidersHtml).not.toContain("not in the orchestrator");
    expect(modelsAndProvidersHtml).toContain("Projects opt in separately");
    expect(modelsAndProvidersHtml).toContain("next run");
  });
  it("has no credential input", () => {
    expect(modelsAndProvidersHtml).not.toMatch(/type="password"/);
    expect(modelsAndProvidersScript).not.toMatch(/credentialRef|type="password"/);
  });
  it("uses window.api/window.esc only", () => {
    const stripped = modelsAndProvidersScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });
  it("uses const/let, not var", () => {
    expect(modelsAndProvidersScript).not.toMatch(/\bvar\s+\w/);
  });
});
