import { describe, expect, it } from "vitest";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { loadPipelineDefinition } from "../pipeline/pipeline-loader.js";
import { redactStepCredentials } from "../pipeline/step-redaction.js";
import type { PipelineContextData, Step } from "../pipeline/types.js";

const TOKEN = "ghs_SENTINEL_TOKEN_VALUE";
const NONCE = "SENTINEL_NONCE_VALUE";

function step(inputs: Record<string, unknown>, outputs: Record<string, unknown>): Step {
  return {
    id: "clone",
    type: "clone",
    status: "passed",
    started_at: "2026-10-07T00:00:00.000Z",
    ended_at: "2026-10-07T00:00:01.000Z",
    parent_step_id: null,
    inputs,
    outputs,
    logs_url: null,
  };
}

describe("redactStepCredentials", () => {
  it("strips credentials from the clone step's real inputs and outputs shape", () => {
    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml");
    const cloneDef = pipeline.steps.find((s) => s.id === "clone")!;
    const context = new DefaultPipelineContext({
      githubToken: TOKEN,
      nonce: NONCE,
      githubOwner: "org",
      githubRepo: "repo",
      branch: "main",
      workspaceDir: "/workspace",
    } as unknown as PipelineContextData);
    const inputs = context.resolveInputs(cloneDef.inputs);
    expect(inputs.githubToken).toBe(TOKEN);
    expect(inputs.machineNonce).toBe(NONCE);

    const outputs = {
      workspaceDir: "/workspace",
      clonedRef: "abc123",
      cloneMethod: "shallow",
      repoOwner: "org",
      repoRepo: "repo",
      branch: "main",
      githubToken: TOKEN,
    };
    const result = redactStepCredentials(step({ ...inputs, ghToken: TOKEN, anythingSecret: "s" }, outputs));

    const json = JSON.stringify(result);
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain(NONCE);
    expect(result.outputs).toMatchObject({
      workspaceDir: "/workspace",
      repoOwner: "org",
      repoRepo: "repo",
      branch: "main",
      clonedRef: "abc123",
    });
    expect(result.inputs).not.toHaveProperty("machineNonce");
    expect(result.inputs).not.toHaveProperty("ghToken");
    expect(result.inputs).not.toHaveProperty("anythingSecret");
    expect(result.inputs).not.toHaveProperty("githubToken");
    expect(result.outputs).not.toHaveProperty("githubToken");
  });

  it("returns an equal step when there is no credential key, and does not mutate its input", () => {
    const plain = step({ a: 1, nested: { b: [1, 2] } }, { workspaceDir: "/w" });
    expect(redactStepCredentials(plain)).toEqual(plain);

    const secret = step({ githubToken: TOKEN }, { x: { deepSecret: "s", ok: true } });
    const copy = structuredClone(secret);
    const result = redactStepCredentials(secret);
    expect(secret).toEqual(copy);
    expect(result.outputs).toEqual({ x: { ok: true } });
  });

  it("tolerates a step whose inputs or outputs are missing", () => {
    const bare = { ...step({}, {}), inputs: undefined, outputs: undefined } as unknown as Step;
    expect(() => redactStepCredentials(bare)).not.toThrow();
  });
});
