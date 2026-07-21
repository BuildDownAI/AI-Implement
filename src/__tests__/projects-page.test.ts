import { describe, expect, it } from "vitest";
import { projectsHtml, projectsScript } from "../admin-ui/pages/projects.js";
import { stepperHtml } from "../admin-ui/stepper.js";

describe("projects page — sensitive-files glob fields", () => {
  it("projectsHtml contains 'Additional sensitive patterns' label", () => {
    expect(projectsHtml).toContain("Additional sensitive patterns");
  });

  it("projectsHtml contains 'Allowed exceptions' label", () => {
    expect(projectsHtml).toContain("Allowed exceptions");
  });

  it("projectsHtml has both textareas with placeholder 'one glob per line'", () => {
    const matches = (projectsHtml.match(/placeholder="one glob per line"/g) || []).length;
    expect(matches).toBeGreaterThanOrEqual(2);
  });

  it("projectsHtml Allowed-exceptions block contains guardrail-bypass warning", () => {
    expect(projectsHtml).toContain("bypass the sensitive-files guardrail");
  });

  it("projectsHtml contains textarea id md-sensitive-add", () => {
    expect(projectsHtml).toContain('id="md-sensitive-add"');
  });

  it("projectsHtml contains textarea id md-sensitive-allow", () => {
    expect(projectsHtml).toContain('id="md-sensitive-allow"');
  });

  it("projectsScript includes sensitiveAddPatterns payload field", () => {
    expect(projectsScript).toContain("sensitiveAddPatterns");
  });

  it("projectsScript includes sensitiveAllowPatterns payload field", () => {
    expect(projectsScript).toContain("sensitiveAllowPatterns");
  });

  it("stepperHtml contains textarea id np-sensitive-add", () => {
    expect(stepperHtml).toContain('id="np-sensitive-add"');
  });

  it("stepperHtml contains textarea id np-sensitive-allow", () => {
    expect(stepperHtml).toContain('id="np-sensitive-allow"');
  });

  it("stepperHtml contains 'one glob per line' placeholder", () => {
    const matches = (stepperHtml.match(/one glob per line/g) || []).length;
    expect(matches).toBeGreaterThanOrEqual(2);
  });

  it("stepperHtml contains guardrail-bypass warning", () => {
    expect(stepperHtml).toContain("bypass the sensitive-files guardrail");
  });
});
