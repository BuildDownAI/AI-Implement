import { describe, expect, it } from "vitest";
import { stepperHtml, stepperScript } from "../stepper.js";

describe("new-project stepper", () => {
  it("declares all six step blocks", () => {
    for (let i = 0; i < 6; i++) expect(stepperHtml).toContain(`data-step="${i}"`);
  });

  it("declares the input ids the script reads", () => {
    for (const id of ["np-teamKey", "np-owner", "np-repo", "np-sessionMode", "np-awsRegion", "np-maxAi"]) {
      expect(stepperHtml).toContain(`id="${id}"`);
    }
  });

  it("exposes navigation handlers on window", () => {
    for (const sym of ["openNewProjectStepper", "closeNewProjectStepper", "stepperBack", "stepperNext", "stepperSubmit"]) {
      expect(stepperScript).toContain(`window.${sym} = ${sym}`);
    }
  });

  it("submits to existing /api/mappings (no new endpoint)", () => {
    expect(stepperScript).toContain("/api/mappings");
    expect(stepperScript).not.toMatch(/\/api\/(projects|new-project|stepper)\b/);
  });

  it("uses window.api/window.esc only", () => {
    const stripped = stepperScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });

  it("uses const/let, not var", () => {
    expect(stepperScript).not.toMatch(/\bvar\s+\w/);
  });
});
