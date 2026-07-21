import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveWorkflowContract,
  __clearWorkflowProbeCacheForTests,
} from "../workflow-probe.js";

const ENVELOPE_YML =
  "on:\n  workflow_dispatch:\n    inputs:\n      run_config:\n        required: true\n";

const LEGACY_YML =
  "on:\n  workflow_dispatch:\n    inputs:\n      issue_id:\n        required: true\n";

function mockContents(yamlBody: string): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      type: "file",
      encoding: "base64",
      content: Buffer.from(yamlBody, "utf8").toString("base64"),
    }),
  });
}

function mockFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe("resolveWorkflowContract", () => {
  beforeEach(() => {
    __clearWorkflowProbeCacheForTests();
  });

  it("classifies a run_config-declaring workflow as envelope", async () => {
    const fetchImpl = mockContents(ENVELOPE_YML);
    const mode = await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      fetchImpl,
    });
    expect(mode).toBe("envelope");
  });

  it("classifies a workflow without run_config as legacy", async () => {
    const fetchImpl = mockContents(LEGACY_YML);
    const mode = await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      fetchImpl,
    });
    expect(mode).toBe("legacy");
  });

  it("returns legacy on 404 without throwing", async () => {
    const fetchImpl = mockFetch(404, null);
    const mode = await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      fetchImpl,
    });
    expect(mode).toBe("legacy");
  });

  it("returns legacy when fetch throws without rethrowing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("net"));
    const mode = await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      fetchImpl,
    });
    expect(mode).toBe("legacy");
  });

  it("caches the result within TTL — second call performs zero extra fetches", async () => {
    const fetchImpl = mockContents(ENVELOPE_YML);
    await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      fetchImpl,
    });
    await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("re-probes after TTL expiry", async () => {
    const fetchImpl = mockContents(ENVELOPE_YML);
    let fakeNow = 0;
    const nowMs = () => fakeNow;

    await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      fetchImpl,
      nowMs,
    });

    fakeNow = 300_001;

    await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      fetchImpl,
      nowMs,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses separate cache entries per workflowFile", async () => {
    const fetchImplA = mockContents(ENVELOPE_YML);
    const fetchImplB = mockContents(LEGACY_YML);

    const modeA = await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      fetchImpl: fetchImplA,
    });
    const modeB = await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-plan.yml",
      token: "t",
      fetchImpl: fetchImplB,
    });

    expect(modeA).toBe("envelope");
    expect(modeB).toBe("legacy");
    expect(fetchImplA).toHaveBeenCalledOnce();
    expect(fetchImplB).toHaveBeenCalledOnce();
  });

  it("returns legacy when response encoding is not base64", async () => {
    const fetchImpl = mockFetch(200, { type: "file", encoding: "utf-8", content: ENVELOPE_YML });
    const mode = await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      fetchImpl,
    });
    expect(mode).toBe("legacy");
  });

  it("does not classify run_config mentioned only in a YAML comment as envelope", async () => {
    const commentYml =
      "on:\n  workflow_dispatch:\n    inputs:\n      # run_config: would go here\n      issue_id:\n        required: true\n";
    const fetchImpl = mockContents(commentYml);
    const mode = await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      fetchImpl,
    });
    expect(mode).toBe("legacy");
  });
});
