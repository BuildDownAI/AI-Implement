import { describe, expect, it } from "vitest";
import { pipelinesAndStepsHtml, pipelinesAndStepsScript } from "../pages/pipelines-and-steps.js";

describe("pipelines-and-steps page", () => {
  it("declares the expected ids", () => {
    for (const id of [
      "ps-subtitle",
      "ps-error",
      "ps-pipelines-body",
      "ps-pipelines-empty",
      "ps-steps-body",
      "ps-steps-empty",
    ]) {
      expect(pipelinesAndStepsHtml).toContain(`id="${id}"`);
    }
  });

  it("registers route + exposes loadPipelinesAndSteps", () => {
    expect(pipelinesAndStepsScript).toContain("window.registerPage('pipelines'");
    expect(pipelinesAndStepsScript).toContain("window.loadPipelinesAndSteps = loadPipelinesAndSteps");
  });

  it("calls /api/pipelines-steps", () => {
    expect(pipelinesAndStepsScript).toContain("/api/pipelines-steps");
  });

  it("uses window.api/window.esc only", () => {
    const stripped = pipelinesAndStepsScript
      .replace(/window\.api\(/g, "")
      .replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });

  it("uses const/let, not var", () => {
    expect(pipelinesAndStepsScript).not.toMatch(/\bvar\s+\w/);
  });
});
