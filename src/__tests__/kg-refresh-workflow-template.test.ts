import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const TEMPLATE = "workflows/claude-implement.yml";

function getParsedTemplate(): any {
  return parse(readFileSync(TEMPLATE, "utf-8")) as any;
}

function getPipelineStep(): any {
  const doc = getParsedTemplate();
  const steps: any[] = doc.jobs["implement"].steps;
  return steps.find((s: any) => s.name === "Run pipeline");
}

function getMaskStep(): any {
  const doc = getParsedTemplate();
  const steps: any[] = doc.jobs["implement"].steps;
  return steps.find((s: any) => s.name === "Mask runner callback tokens");
}

function getEntrypointCaseArms(): string[] {
  const sh = readFileSync("session/entrypoint.sh", "utf-8");
  return [...sh.matchAll(/^\s+([a-z][a-z-]*)\)\s+RUNNER_ENTRY=/gm)].map((m) => m[1]);
}

describe("claude-implement.yml template — runner_phase and runner_callback_url inputs", () => {
  it("has a Run pipeline step", () => {
    expect(getPipelineStep()).toBeDefined();
  });

  it("declares runner_phase as an optional workflow_dispatch input with default 'implementation'", () => {
    const doc = getParsedTemplate();
    const inputs = doc.on.workflow_dispatch.inputs;
    expect(inputs).toHaveProperty("runner_phase");
    expect(inputs.runner_phase.required).toBe(false);
    expect(inputs.runner_phase.default).toBe("implementation");
  });

  it("declares runner_callback_url as an optional workflow_dispatch input", () => {
    const doc = getParsedTemplate();
    const inputs = doc.on.workflow_dispatch.inputs;
    expect(inputs).toHaveProperty("runner_callback_url");
    expect(inputs.runner_callback_url.required).toBe(false);
  });

  it("exports RUNNER_PHASE referencing inputs.runner_phase in the Run pipeline step env", () => {
    const step = getPipelineStep();
    expect(step.env).toHaveProperty("RUNNER_PHASE");
    expect(step.env.RUNNER_PHASE).toContain("runner_phase");
  });

  it("exports RUNNER_CALLBACK_URL referencing inputs.runner_callback_url in the Run pipeline step env", () => {
    const step = getPipelineStep();
    expect(step.env).toHaveProperty("RUNNER_CALLBACK_URL");
    expect(step.env.RUNNER_CALLBACK_URL).toContain("runner_callback_url");
  });

  it("declares run_progress_token as a workflow_dispatch input (regression guard)", () => {
    const doc = getParsedTemplate();
    const inputs = doc.on.workflow_dispatch.inputs;
    expect(inputs).toHaveProperty("run_progress_token");
    expect(inputs.run_progress_token.required).toBe(false);
  });

  it("exports RUN_PROGRESS_TOKEN in the Run pipeline step env (regression guard)", () => {
    const step = getPipelineStep();
    expect(step.env).toHaveProperty("RUN_PROGRESS_TOKEN");
    expect(step.env.RUN_PROGRESS_TOKEN).toContain("run_progress_token");
  });

  it("masks run_progress_token in the Mask runner callback tokens step (regression guard)", () => {
    const step = getMaskStep();
    expect(step).toBeDefined();
    expect(step.env?.RUN_PROGRESS_TOKEN).toContain("run_progress_token");
    expect(step.run).toContain("::add-mask::$RUN_PROGRESS_TOKEN");
    expect(step.run).not.toContain("inputs.run_progress_token");
  });

  it("passes AI_IMPLEMENT_LOG_LEVEL from the repo variable into the Run pipeline step env", () => {
    const step = getPipelineStep();
    expect(step.env.AI_IMPLEMENT_LOG_LEVEL).toBe("${{ vars.AI_IMPLEMENT_LOG_LEVEL }}");
  });

  it("'kg-refresh' case arm exists in session/entrypoint.sh", () => {
    const arms = getEntrypointCaseArms();
    expect(arms.length).toBeGreaterThan(0);
    expect(arms).toContain("kg-refresh");
  });

});
