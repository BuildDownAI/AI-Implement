import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const TEMPLATE = "workflows/claude-kg-refresh.yml";

function getParsedTemplate(): any {
  return parse(readFileSync(TEMPLATE, "utf-8")) as any;
}

function getPipelineStep(): any {
  const doc = getParsedTemplate();
  const steps: any[] = doc.jobs["kg-refresh"].steps;
  return steps.find((s: any) => s.name === "Run pipeline");
}

function getMaskStep(): any {
  const doc = getParsedTemplate();
  const steps: any[] = doc.jobs["kg-refresh"].steps;
  return steps.find((s: any) => s.name === "Mask runner callback token");
}

function getEntrypointCaseArms(): string[] {
  const sh = readFileSync("session/entrypoint.sh", "utf-8");
  return [...sh.matchAll(/^\s+([a-z][a-z-]*)\)\s+RUNNER_ENTRY=/gm)].map((m) => m[1]);
}

describe("claude-kg-refresh.yml template", () => {
  it("has a Run pipeline step", () => {
    expect(getPipelineStep()).toBeDefined();
  });

  it("sets RUNNER_PHASE: kg-refresh in the Run pipeline step env", () => {
    const step = getPipelineStep();
    expect(step.env.RUNNER_PHASE).toBe("kg-refresh");
  });

  it("RUNNER_PHASE value matches a named case arm in session/entrypoint.sh", () => {
    const arms = getEntrypointCaseArms();
    expect(arms.length).toBeGreaterThan(0);
    expect(arms).toContain("kg-refresh");
  });

  it("declares run_progress_token as a workflow_dispatch input", () => {
    const doc = getParsedTemplate();
    const inputs = doc.on.workflow_dispatch.inputs;
    expect(inputs).toHaveProperty("run_progress_token");
    expect(inputs.run_progress_token.required).toBe(false);
  });

  it("masks run_progress_token in the Mask runner callback token step", () => {
    const step = getMaskStep();
    expect(step).toBeDefined();
    expect(step.env?.RUN_PROGRESS_TOKEN).toContain("run_progress_token");
    expect(step.run).toContain("::add-mask::$RUN_PROGRESS_TOKEN");
    expect(step.run).not.toContain("inputs.run_progress_token");
  });

  it("exports RUN_PROGRESS_TOKEN in the Run pipeline step env", () => {
    const step = getPipelineStep();
    expect(step.env).toHaveProperty("RUN_PROGRESS_TOKEN");
    expect(step.env.RUN_PROGRESS_TOKEN).toContain("run_progress_token");
  });

  it("has a Bind workflow run ID step", () => {
    const doc = getParsedTemplate();
    const steps: any[] = doc.jobs["kg-refresh"].steps;
    const bindStep = steps.find((s: any) => s.name === "Bind workflow run ID");
    expect(bindStep).toBeDefined();
  });

  it("Bind workflow run ID step has a non-empty if condition", () => {
    const doc = getParsedTemplate();
    const steps: any[] = doc.jobs["kg-refresh"].steps;
    const bindStep = steps.find((s: any) => s.name === "Bind workflow run ID");
    expect(bindStep.if).toBeTruthy();
  });

  it("Bind workflow run ID step posts to /runner/progress", () => {
    const doc = getParsedTemplate();
    const steps: any[] = doc.jobs["kg-refresh"].steps;
    const bindStep = steps.find((s: any) => s.name === "Bind workflow run ID");
    expect(bindStep.run).toContain("/runner/progress");
  });

  it("Bind workflow run ID step sends githubRunId in the body", () => {
    const doc = getParsedTemplate();
    const steps: any[] = doc.jobs["kg-refresh"].steps;
    const bindStep = steps.find((s: any) => s.name === "Bind workflow run ID");
    expect(bindStep.run).toContain("githubRunId");
    expect(bindStep.run).toContain("github.run_id");
  });

  it("Bind workflow run ID step appears between Mask and Run pipeline", () => {
    const doc = getParsedTemplate();
    const steps: any[] = doc.jobs["kg-refresh"].steps;
    const maskIdx = steps.findIndex((s: any) => s.name === "Mask runner callback token");
    const bindIdx = steps.findIndex((s: any) => s.name === "Bind workflow run ID");
    const pipelineIdx = steps.findIndex((s: any) => s.name === "Run pipeline");
    expect(maskIdx).toBeGreaterThanOrEqual(0);
    expect(bindIdx).toBeGreaterThan(maskIdx);
    expect(bindIdx).toBeLessThan(pipelineIdx);
  });

  it("Bind workflow run ID step is non-fatal (ends with || true)", () => {
    const doc = getParsedTemplate();
    const steps: any[] = doc.jobs["kg-refresh"].steps;
    const bindStep = steps.find((s: any) => s.name === "Bind workflow run ID");
    expect(bindStep.run).toContain("|| true");
  });
});
