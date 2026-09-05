import { describe, expect, it } from "vitest";
import { stepperHtml, stepperScript } from "../stepper.js";

/** Rail order. Inserting a step renumbers every later one, so this is the spine of the file. */
const STEPS = ["Ticketing", "Config", "Source", "Context", "Execution", "Provider", "Capacity", "Secrets", "Review"];

describe("new-project stepper — step numbering", () => {
  it("declares one block per step and no more", () => {
    for (let i = 0; i < STEPS.length; i++) expect(stepperHtml).toContain(`data-step="${i}"`);
    expect(stepperHtml).not.toContain(`data-step="${STEPS.length}"`);
    const blocks = [...stepperHtml.matchAll(/data-step="(\d)"/g)].map((m) => m[1]);
    expect(blocks.length).toBe(new Set(blocks).size);
  });

  it("keeps LAST_STEP, STEP_LABELS and the markup in agreement", () => {
    expect(stepperScript).toContain(`const LAST_STEP = ${STEPS.length - 1};`);
    const labels = stepperScript.match(/STEP_LABELS = \[(.*?)\]/)?.[1] ?? "";
    expect(labels.split(",").map((s) => s.trim().replace(/'/g, ""))).toEqual(STEPS);
  });

  // Every step must be reachable by collectStep, or its fields are silently dropped when
  // the operator moves past it. Review (the last) collects nothing.
  it("collects every step except Review", () => {
    const body = stepperScript.slice(stepperScript.indexOf("function collectStep"));
    for (let i = 0; i < STEPS.length - 1; i++) {
      expect(body, `collectStep has no branch for step ${i} (${STEPS[i]})`).toContain(`n === ${i}`);
    }
  });
});

describe("new-project stepper", () => {
  it("declares all nine step blocks", () => {
    for (let i = 0; i < STEPS.length; i++) expect(stepperHtml).toContain(`data-step="${i}"`);
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
    for (const id of ["np-teamKey", "np-owner", "np-repo", "np-defaultBranch", "np-sessionMode", "np-awsRegion", "np-maxAi"]) {
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

describe("new-project stepper — the four touch points a new field needs", () => {
  // The initializer and the reset inside openNewProjectStepper are two separate lists.
  // A field added to one and not the other keeps its previous value across a reopen.
  it("resets every field the initializer declares", () => {
    const init = stepperScript.slice(
      stepperScript.indexOf("const data = {"),
      stepperScript.indexOf("let jiraFieldsLoaded"),
    );
    const fields = [...init.matchAll(/(\w+):/g)].map((m) => m[1]);
    expect(fields.length).toBeGreaterThan(20);
    const reset = stepperScript.slice(
      stepperScript.indexOf("function openNewProjectStepper"),
      stepperScript.indexOf("// Clear inputs"),
    );
    for (const field of fields) {
      expect(reset, `data.${field} is declared but never reset on reopen`).toContain(`data.${field} =`);
    }
  });

  it("clears only inputs that exist in the markup", () => {
    const list = stepperScript.match(/const toClear = \[(.*?)\]/s)?.[1] ?? "";
    const ids = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(8);
    for (const id of ids) {
      expect(stepperHtml, `toClear names ${id}, which no element declares`).toContain(`id="${id}"`);
    }
  });

  it.each([
    ["branchPrefix", "np-branch-prefix"],
    ["maxTurns", "np-maxTurns"],
    ["maxIterations", "np-maxIterations"],
    ["maxJobMinutes", "np-maxJobMinutes"],
  ])("%s is declared, reset, collected and submitted", (field, id) => {
    expect(stepperHtml).toContain(`id="${id}"`);
    expect(stepperScript).toContain(`data.${field} =`);
    expect(stepperScript).toContain(`'${id}'`);
    expect(stepperScript).toMatch(new RegExp(`${field}: data\\.${field}`));
  });
});

describe("new-project stepper — field placement", () => {
  const stepOf = (id: string): number => {
    const at = stepperHtml.indexOf(`id="${id}"`);
    const before = [...stepperHtml.slice(0, at).matchAll(/data-step="(\d)"/g)];
    return Number(before[before.length - 1][1]);
  };

  it.each([
    ["np-owner", 2],
    ["np-defaultBranch", 2],
    ["np-branch-prefix", 2],
    ["np-sensitive-add", 2],
    ["np-sensitive-allow", 2],
    ["np-skills-repo", 3],
    ["np-dep-token-scope", 3],
    ["np-sessionMode", 4],
    ["np-maxAi", 6],
    ["np-maxTurns", 6],
    ["np-maxJobMinutes", 6],
  ])("%s sits on step %i", (id, step) => {
    expect(stepOf(id)).toBe(step);
  });

  it("gives the Context step its own heading rather than folding it into Source", () => {
    expect(stepperHtml).toContain('<h3 style="font-size:13px;font-weight:600;margin:0 0 4px">Context</h3>');
  });

  it("renames the Runner step to Execution, so it does not collide with Runner context", () => {
    expect(stepperHtml).toContain('<h3 style="font-size:13px;font-weight:600;margin:0 0 4px">Execution</h3>');
    expect(stepperHtml).not.toContain(">Runner</h3>");
  });
});

describe("new-project stepper — review step", () => {
  it.each([["branchPrefix"], ["caps"]])("has a review row for %s", (key) => {
    expect(stepperHtml).toContain(`data-review="${key}"`);
  });

  // The review mirrors the rail so a wrong value tells you which step to go back to.
  it("groups its rows under the step each value was set on", () => {
    const headings = [...stepperHtml.matchAll(/np-review-h">([A-Za-z ]+?)(?: <span|<\/div>)/g)].map((m) => m[1].trim());
    expect(headings).toEqual([
      "Ticketing",
      "Source",
      "Context",
      "Execution",
      "Provider",
      "Capacity",
      "Secrets",
      "Pinned defaults",
    ]);
  });

  it("puts every review row under a heading", () => {
    const body = stepperHtml.slice(stepperHtml.indexOf('data-step="8"'));
    expect(body.indexOf('class="np-review-h"')).toBeLessThan(body.indexOf('class="np-review-row"'));
  });

  it("populates every review slot the markup declares", () => {
    const keys = [...stepperHtml.matchAll(/data-review="(\w+)"/g)].map((m) => m[1]);
    for (const key of keys) {
      expect(stepperScript, `no set('${key}', …) in populateReview`).toContain(`set('${key}'`);
    }
  });

  // Constants, so they live in the markup rather than being written by populateReview.
  it("names the three values the stepper pins and the dialog can change later", () => {
    const pinned = stepperHtml.slice(stepperHtml.indexOf("Pinned defaults"));
    expect(pinned).toContain("claude-implement.yml");
    expect(pinned).toContain("claude-plan.yml");
    expect(pinned).toContain("Extra env");
  });
});
