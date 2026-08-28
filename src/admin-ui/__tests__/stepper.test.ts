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
    // The repo-field value is derived from the GitHub repo entered on the Source
    // step, so the stepper never asks for it. Only the Edit dialog can override it.
    expect(stepperHtml).not.toContain('id="np-jira-repo-value"');
  });

  it("moves the Linear Team Key out of the Source step into the Ticketing Config step", () => {
    // np-teamKey lives inside np-linear-config (data-step="1"), not data-step="2".
    const linearCfgIdx = stepperHtml.indexOf('id="np-linear-config"');
    const teamKeyIdx = stepperHtml.indexOf('id="np-teamKey"');
    const ownerIdx = stepperHtml.indexOf('id="np-github-repo"');
    expect(linearCfgIdx).toBeGreaterThan(-1);
    expect(teamKeyIdx).toBeGreaterThan(linearCfgIdx);
    expect(teamKeyIdx).toBeLessThan(ownerIdx);
  });

  it("posts ticketingProvider and ticketingConfig", () => {
    expect(stepperScript).toContain("ticketingProvider:");
    expect(stepperScript).toContain("ticketingConfig:");
  });

  it("declares the input ids the script reads", () => {
    for (const id of ["np-teamKey", "np-github-repo", "np-defaultBranch", "np-sessionMode", "np-awsRegion", "np-maxAi"]) {
      expect(stepperHtml).toContain(`id="${id}"`);
    }
  });

  it("collects and submits the configured default branch", () => {
    expect(stepperScript).toContain("defaultBranch:");
    expect(stepperScript).toContain("np-defaultBranch");
    expect(stepperScript).toContain("defaultBranch: data.defaultBranch");
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

describe("new-project stepper — single GitHub repo entry", () => {
  it("asks for the repo once, as one owner/repo input", () => {
    expect(stepperHtml).toContain('id="np-github-repo"');
    expect(stepperHtml).not.toContain('id="np-owner"');
    expect(stepperHtml).not.toContain('id="np-repo"');
  });

  it("splits the combined input into owner and repo before submitting", () => {
    expect(stepperScript).toContain("function splitGithubRepo(");
    expect(stepperScript).toContain("data.owner = parts ? parts.owner : ''");
    expect(stepperScript).toContain("data.repo = parts ? parts.repo : ''");
    expect(stepperScript).toContain("owner: data.owner");
    expect(stepperScript).toContain("repo: data.repo");
  });

  it("posts a null repoFieldValue so the orchestrator derives it", () => {
    expect(stepperScript).toContain("repoFieldValue: null");
    expect(stepperScript).not.toContain("data.jiraRepoFieldValue");
  });

  it("drops the repo-field-value option plumbing the stepper no longer needs", () => {
    expect(stepperScript).not.toContain("stepperPopulateRepoValueOptions");
    expect(stepperScript).not.toContain("onStepperRepoFieldChange");
    expect(stepperScript).not.toContain("/api/jira/field-options");
  });
});

/**
 * Extracts splitGithubRepo from the script string and evaluates it. The script is
 * a template literal, so every regex in it is double-escaped in the source; only
 * running the emitted text proves the escaping survived.
 */
function loadSplitGithubRepo(): (raw: unknown) => { owner: string; repo: string } | null {
  const start = stepperScript.indexOf("  function splitGithubRepo(");
  expect(start).toBeGreaterThan(-1);
  const end = stepperScript.indexOf("\n  }\n", start) + "\n  }\n".length;
  const src = stepperScript.slice(start, end);
  return new Function(`${src}; return splitGithubRepo;`)() as (
    raw: unknown,
  ) => { owner: string; repo: string } | null;
}

describe("splitGithubRepo", () => {
  const split = loadSplitGithubRepo();

  it("splits owner/repo", () => {
    expect(split("acme-corp/backend")).toEqual({ owner: "acme-corp", repo: "backend" });
  });

  it("tolerates surrounding and inner whitespace", () => {
    expect(split("  acme-corp / backend  ")).toEqual({ owner: "acme-corp", repo: "backend" });
  });

  it("accepts a pasted GitHub URL", () => {
    expect(split("https://github.com/acme-corp/backend")).toEqual({ owner: "acme-corp", repo: "backend" });
    expect(split("https://www.github.com/acme-corp/backend.git")).toEqual({ owner: "acme-corp", repo: "backend" });
  });

  it("tolerates a trailing slash", () => {
    expect(split("acme-corp/backend/")).toEqual({ owner: "acme-corp", repo: "backend" });
  });

  it("rejects a bare repo name with no owner", () => {
    expect(split("backend")).toBeNull();
  });

  it("rejects a half-empty pair", () => {
    expect(split("acme-corp/")).toBeNull();
    expect(split("/backend")).toBeNull();
    expect(split("/")).toBeNull();
  });

  it("rejects more than two segments", () => {
    expect(split("acme-corp/backend/extra")).toBeNull();
  });

  it("rejects empty, null and undefined", () => {
    expect(split("")).toBeNull();
    expect(split("   ")).toBeNull();
    expect(split(null)).toBeNull();
    expect(split(undefined)).toBeNull();
  });
});
