import { describe, expect, it } from "vitest";
import { stepperHtml, stepperScript } from "../stepper.js";

describe("new-project stepper", () => {
  it("declares all eight step blocks", () => {
    for (let i = 0; i < 8; i++) expect(stepperHtml).toContain(`data-step="${i}"`);
  });

  it("splits Ticketing into a system-select step and a provider-specific config step", () => {
    expect(stepperHtml).toContain('id="np-ticketing-provider"');
    expect(stepperHtml).toContain('id="np-linear-config"');
    expect(stepperHtml).toContain('id="np-jira-config"');
    expect(stepperHtml).toContain('id="np-jira-jql"');
    expect(stepperHtml).toContain('id="np-jira-repo-value"');
  });

  it("moves the Linear Team Key out of the Source step into the Ticketing Config step", () => {
    // np-teamKey lives inside np-linear-config (data-step="1"), not data-step="2".
    const linearCfgIdx = stepperHtml.indexOf('id="np-linear-config"');
    const teamKeyIdx = stepperHtml.indexOf('id="np-teamKey"');
    const ownerIdx = stepperHtml.indexOf('id="np-owner"');
    expect(linearCfgIdx).toBeGreaterThan(-1);
    expect(teamKeyIdx).toBeGreaterThan(linearCfgIdx);
    expect(teamKeyIdx).toBeLessThan(ownerIdx);
  });

  it("posts ticketingProvider and ticketingConfig", () => {
    expect(stepperScript).toContain("ticketingProvider:");
    expect(stepperScript).toContain("ticketingConfig:");
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
