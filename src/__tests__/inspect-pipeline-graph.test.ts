import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectPipelinesAndSteps } from "../inspect-pipeline-graph.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(rel: string, content: string): void {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
}

describe("inspectPipelinesAndSteps", () => {
  it("empty cwd → empty arrays", () => {
    const result = inspectPipelinesAndSteps({ cwd: tmpDir });
    expect(result.pipelines).toEqual([]);
    expect(result.steps).toEqual([]);
  });

  it("built-in pipeline parses correctly", () => {
    writeFile(
      "pipelines/autonomous.yml",
      `id: autonomous-loop\nsteps:\n  - id: clone\n    type: clone\n  - id: install\n    type: install\n`,
    );
    const result = inspectPipelinesAndSteps({ cwd: tmpDir });
    expect(result.pipelines).toHaveLength(1);
    const p = result.pipelines[0];
    expect(p.id).toBe("autonomous-loop");
    expect(p.steps).toHaveLength(2);
    expect(p.error).toBeNull();
    expect(p.isOverride).toBe(false);
    expect(p.file).toBe("pipelines/autonomous.yml");
  });

  it("custom pipeline overrides built-in", () => {
    writeFile(
      "pipelines/autonomous.yml",
      `id: autonomous-loop\nsteps:\n  - id: clone\n    type: clone\n`,
    );
    writeFile(
      "custom/pipelines/autonomous.yml",
      `id: autonomous-loop-custom\nsteps:\n  - id: clone\n    type: clone\n`,
    );
    const result = inspectPipelinesAndSteps({ cwd: tmpDir });
    expect(result.pipelines).toHaveLength(1);
    const p = result.pipelines[0];
    expect(p.file).toBe("custom/pipelines/autonomous.yml");
    expect(p.isOverride).toBe(true);
  });

  it("YAML parse error captured in entry", () => {
    writeFile("pipelines/bad.yml", "id: [unclosed");
    const result = inspectPipelinesAndSteps({ cwd: tmpDir });
    expect(result.pipelines).toHaveLength(1);
    const p = result.pipelines[0];
    expect(p.error).toMatch(/YAML parse error/);
  });

  it("step override detected at top level", () => {
    writeFile("src/pipeline/steps/foo.ts", "export default {}");
    writeFile("custom/steps/foo.ts", "export default {}");
    const result = inspectPipelinesAndSteps({ cwd: tmpDir });
    const step = result.steps.find((s) => s.id === "foo");
    expect(step).toBeDefined();
    expect(step!.builtinPath).toBe("src/pipeline/steps/foo.ts");
    expect(step!.customPath).toBe("custom/steps/foo.ts");
    expect(step!.hasCustomOverride).toBe(true);
  });

  it("additive step (only custom, no built-in) has hasCustomOverride: false", () => {
    writeFile("custom/steps/extra.ts", "export default {}");
    const result = inspectPipelinesAndSteps({ cwd: tmpDir });
    const step = result.steps.find((s) => s.id === "extra");
    expect(step).toBeDefined();
    expect(step!.builtinPath).toBeNull();
    expect(step!.customPath).toBe("custom/steps/extra.ts");
    expect(step!.hasCustomOverride).toBe(false);
  });

  it("pipeline step hasCustomOverride cross-references custom steps", () => {
    writeFile("custom/steps/bar.ts", "export default {}");
    writeFile(
      "pipelines/mypipeline.yml",
      `id: mypipeline\nsteps:\n  - id: do-bar\n    type: custom\n    moduleId: bar\n`,
    );
    const result = inspectPipelinesAndSteps({ cwd: tmpDir });
    expect(result.pipelines).toHaveLength(1);
    const p = result.pipelines[0];
    expect(p.error).toBeNull();
    const stepEntry = p.steps.find((s) => s.id === "do-bar");
    expect(stepEntry).toBeDefined();
    expect(stepEntry!.hasCustomOverride).toBe(true);
  });
});
