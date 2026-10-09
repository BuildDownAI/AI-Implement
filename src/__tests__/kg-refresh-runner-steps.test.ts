import { describe, it, expect } from "vitest";
import { loadPipelineDefinition } from "../pipeline/pipeline-loader.js";
import { KG_REFRESH_RUNNER_STEPS } from "../restate/kg-refresh-types.js";

describe("KG_REFRESH_RUNNER_STEPS", () => {
  it("equals the step ids of pipelines/kg-refresh.yml, in order", () => {
    const ids = loadPipelineDefinition("pipelines/kg-refresh.yml").steps.map((s) => s.id);
    expect(ids).toEqual([...KG_REFRESH_RUNNER_STEPS]);
  });
});
