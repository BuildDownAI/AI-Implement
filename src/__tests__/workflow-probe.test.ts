import { beforeEach, describe, expect, it } from "vitest";
import {
  resolveWorkflowContract,
  resolveWorkflowCapabilities,
  __clearWorkflowProbeCacheForTests,
} from "../workflow-probe.js";
import { fakeFetch, type FakeFetch, type Reply } from "./helpers/fake-fetch.js";

const ENVELOPE_YML =
  "on:\n  workflow_dispatch:\n    inputs:\n      run_config:\n        required: true\n";

const LEGACY_YML =
  "on:\n  workflow_dispatch:\n    inputs:\n      issue_id:\n        required: true\n";

const PUBLICATION_TOKEN_YML =
  "on:\n  workflow_dispatch:\n    inputs:\n      run_config:\n        required: true\n      run_publication_token:\n        required: false\n";

const ATTEMPT_TOKEN_YML =
  "on:\n  workflow_dispatch:\n    inputs:\n      run_config:\n        required: true\n      run_attempt_token:\n        required: false\n";

/** GitHub's contents API answering for one workflow file of o/r. */
function contents(reply: Reply, workflowFile = "claude-implement.yml"): FakeFetch {
  return fakeFetch({ [`GET /repos/o/r/contents/.github/workflows/${workflowFile}`]: reply });
}

/** The contents API's reply for a file, base64-encoded as GitHub sends it. */
function yamlFile(yamlBody: string): Reply {
  return { json: { type: "file", encoding: "base64", content: Buffer.from(yamlBody, "utf8").toString("base64") } };
}

describe("resolveWorkflowContract", () => {
  beforeEach(() => {
    __clearWorkflowProbeCacheForTests();
  });

  it("classifies a run_config-declaring workflow as envelope", async () => {
    const github = contents(yamlFile(ENVELOPE_YML));
    const mode = await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      ref: "main",
      fetchImpl: github.fetch,
    });
    expect(mode).toBe("envelope");
  });

  it("reports publication-token support separately from ordinary envelope support", async () => {
    const github = contents(yamlFile(PUBLICATION_TOKEN_YML));
    const capabilities = await resolveWorkflowCapabilities({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      ref: "main",
      fetchImpl: github.fetch,
    });
    expect(capabilities).toEqual({
      contract: "envelope",
      supportsRunPublicationToken: true,
      supportsAttemptCorrelation: false,
    });
  });

  it("does not require publication-token support for envelope compatibility", async () => {
    const github = contents(yamlFile(ENVELOPE_YML));
    const capabilities = await resolveWorkflowCapabilities({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      ref: "main",
      fetchImpl: github.fetch,
    });
    expect(capabilities).toEqual({
      contract: "envelope",
      supportsRunPublicationToken: false,
      supportsAttemptCorrelation: false,
    });
  });

  it("does not report publication-token support when the input is only mentioned in a YAML comment", async () => {
    const commentYml =
      "on:\n  workflow_dispatch:\n    inputs:\n      run_config:\n        required: true\n      # run_publication_token: would go here\n";
    const github = contents(yamlFile(commentYml));
    const capabilities = await resolveWorkflowCapabilities({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      ref: "main",
      fetchImpl: github.fetch,
    });
    expect(capabilities).toEqual({
      contract: "envelope",
      supportsRunPublicationToken: false,
      supportsAttemptCorrelation: false,
    });
  });

  it("classifies a workflow without run_config as legacy", async () => {
    const github = contents(yamlFile(LEGACY_YML));
    const mode = await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      ref: "main",
      fetchImpl: github.fetch,
    });
    expect(mode).toBe("legacy");
  });

  it("returns legacy on 404 without throwing", async () => {
    const github = contents({ status: 404 });
    const mode = await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      ref: "main",
      fetchImpl: github.fetch,
    });
    expect(mode).toBe("legacy");
  });

  it("reports no optional capabilities when the workflow is legacy", async () => {
    const github = contents(yamlFile(LEGACY_YML));
    const capabilities = await resolveWorkflowCapabilities({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      ref: "main",
      fetchImpl: github.fetch,
    });
    expect(capabilities).toEqual({
      contract: "legacy",
      supportsRunPublicationToken: false,
      supportsAttemptCorrelation: false,
    });
  });

  it("returns legacy when fetch throws without rethrowing", async () => {
    const github = contents(() => {
      throw new Error("net");
    });
    const mode = await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      ref: "main",
      fetchImpl: github.fetch,
    });
    expect(mode).toBe("legacy");
  });

  it("caches the result within TTL — second call performs zero extra fetches", async () => {
    const github = contents(yamlFile(ENVELOPE_YML));
    await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      ref: "main",
      fetchImpl: github.fetch,
    });
    await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      ref: "main",
      fetchImpl: github.fetch,
    });
    expect(github.calls).toHaveLength(1);
  });

  it("re-probes after TTL expiry", async () => {
    const github = contents(yamlFile(ENVELOPE_YML));
    let fakeNow = 0;
    const nowMs = () => fakeNow;

    await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      ref: "main",
      fetchImpl: github.fetch,
      nowMs,
    });

    fakeNow = 300_001;

    await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      ref: "main",
      fetchImpl: github.fetch,
      nowMs,
    });

    expect(github.calls).toHaveLength(2);
  });

  it("uses separate cache entries per workflowFile", async () => {
    const githubA = contents(yamlFile(ENVELOPE_YML));
    const githubB = contents(yamlFile(LEGACY_YML), "claude-plan.yml");

    const modeA = await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      ref: "main",
      fetchImpl: githubA.fetch,
    });
    const modeB = await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-plan.yml",
      token: "t",
      ref: "main",
      fetchImpl: githubB.fetch,
    });

    expect(modeA).toBe("envelope");
    expect(modeB).toBe("legacy");
    expect(githubA.calls).toHaveLength(1);
    expect(githubB.calls).toHaveLength(1);
  });

  it("returns legacy when response encoding is not base64", async () => {
    const github = contents({ json: { type: "file", encoding: "utf-8", content: ENVELOPE_YML } });
    const mode = await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      ref: "main",
      fetchImpl: github.fetch,
    });
    expect(mode).toBe("legacy");
  });

  it("does not classify run_config mentioned only in a YAML comment as envelope", async () => {
    const commentYml =
      "on:\n  workflow_dispatch:\n    inputs:\n      # run_config: would go here\n      issue_id:\n        required: true\n";
    const github = contents(yamlFile(commentYml));
    const mode = await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      ref: "main",
      fetchImpl: github.fetch,
    });
    expect(mode).toBe("legacy");
  });

  it("probes the given ref, not the repo's implicit default branch", async () => {
    const github = contents(yamlFile(ENVELOPE_YML), "claude-plan.yml");
    await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-plan.yml",
      token: "t",
      ref: "dev",
      fetchImpl: github.fetch,
    });

    expect(github.calls[0].url.href).toBe(
      "https://api.github.com/repos/o/r/contents/.github/workflows/claude-plan.yml?ref=dev",
    );
  });

  it("keeps separate cache entries per ref, so a stale-ref dispatch can't reuse a live-ref probe", async () => {
    const githubMain = contents(yamlFile(LEGACY_YML), "claude-plan.yml");
    const githubDev = contents(yamlFile(ENVELOPE_YML), "claude-plan.yml");

    const modeMain = await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-plan.yml",
      token: "t",
      ref: "main",
      fetchImpl: githubMain.fetch,
    });
    const modeDev = await resolveWorkflowContract({
      owner: "o",
      repo: "r",
      workflowFile: "claude-plan.yml",
      token: "t",
      ref: "dev",
      fetchImpl: githubDev.fetch,
    });

    expect(modeMain).toBe("legacy");
    expect(modeDev).toBe("envelope");
    expect(githubMain.calls).toHaveLength(1);
    expect(githubDev.calls).toHaveLength(1);
  });
});

// ---------- supportsAttemptCorrelation (AII-778) ----------

describe("resolveWorkflowCapabilities — supportsAttemptCorrelation", () => {
  beforeEach(() => {
    __clearWorkflowProbeCacheForTests();
  });

  it("reports attempt-correlation support when the workflow declares run_attempt_token", async () => {
    const github = contents(yamlFile(ATTEMPT_TOKEN_YML));
    const capabilities = await resolveWorkflowCapabilities({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      ref: "main",
      fetchImpl: github.fetch,
    });
    expect(capabilities).toEqual({
      contract: "envelope",
      supportsRunPublicationToken: false,
      supportsAttemptCorrelation: true,
    });
  });

  it("does not report attempt-correlation support for an otherwise-envelope workflow that lacks the marker", async () => {
    const github = contents(yamlFile(ENVELOPE_YML));
    const capabilities = await resolveWorkflowCapabilities({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      ref: "main",
      fetchImpl: github.fetch,
    });
    expect(capabilities.supportsAttemptCorrelation).toBe(false);
  });

  it("does not report attempt-correlation support when the marker is only mentioned in a YAML comment", async () => {
    const commentYml =
      "on:\n  workflow_dispatch:\n    inputs:\n      run_config:\n        required: true\n      # run_attempt_token: would go here\n";
    const github = contents(yamlFile(commentYml));
    const capabilities = await resolveWorkflowCapabilities({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      ref: "main",
      fetchImpl: github.fetch,
    });
    expect(capabilities.supportsAttemptCorrelation).toBe(false);
  });

  it("cannot claim attempt-correlation support on a legacy-contract workflow, even if run_attempt_token appears in the YAML", async () => {
    // A workflow that declares run_attempt_token but not run_config is not on the envelope
    // contract at all — the marker must be gated by contract === "envelope", the same way
    // supportsRunPublicationToken is, so an unsupported (legacy) workflow can never claim
    // pilot support.
    const legacyWithMarkerYml =
      "on:\n  workflow_dispatch:\n    inputs:\n      issue_id:\n        required: true\n      run_attempt_token:\n        required: false\n";
    const github = contents(yamlFile(legacyWithMarkerYml));
    const capabilities = await resolveWorkflowCapabilities({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      ref: "main",
      fetchImpl: github.fetch,
    });
    expect(capabilities).toEqual({
      contract: "legacy",
      supportsRunPublicationToken: false,
      supportsAttemptCorrelation: false,
    });
  });

  it("probes attempt-correlation support on the actual dispatch ref, not a cached different ref", async () => {
    const githubMain = contents(yamlFile(ENVELOPE_YML));
    const githubDev = contents(yamlFile(ATTEMPT_TOKEN_YML));

    const main = await resolveWorkflowCapabilities({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      ref: "main",
      fetchImpl: githubMain.fetch,
    });
    const dev = await resolveWorkflowCapabilities({
      owner: "o",
      repo: "r",
      workflowFile: "claude-implement.yml",
      token: "t",
      ref: "dev",
      fetchImpl: githubDev.fetch,
    });

    expect(main.supportsAttemptCorrelation).toBe(false);
    expect(dev.supportsAttemptCorrelation).toBe(true);
  });
});
