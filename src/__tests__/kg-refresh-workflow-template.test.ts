import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const TEMPLATE = "workflows/claude-kg-refresh.yml";

function getPipelineStep(): any {
  const doc = parse(readFileSync(TEMPLATE, "utf-8")) as any;
  const steps: any[] = doc.jobs["kg-refresh"].steps;
  return steps.find((s: any) => s.name === "Run pipeline");
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
});
