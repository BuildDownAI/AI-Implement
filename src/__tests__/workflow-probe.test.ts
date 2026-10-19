import { beforeEach, describe, expect, it } from "vitest";
import {
  resolveWorkflowContract,
  resolveWorkflowCapabilities,
  __clearWorkflowProbeCacheForTests,
} from "../workflow-probe.js";
import { fakeFetch, type FakeFetch, type Reply } from "./helpers/fake-fetch.js";
import { githubError, githubFile } from "./helpers/replies/github.js";

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


describe("resolveWorkflowContract", () => {
  beforeEach(() => {
    __clearWorkflowProbeCacheForTests();
  });

  it("classifies a run_config-declaring workflow as envelope", async () => {
    const github = contents(githubFile(ENVELOPE_YML));
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
    const github = contents(githubFile(PUBLICATION_TOKEN_YML));
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
      supportsPrivateRunConfig: false,
      supportsExecutionPolicy: false,
      supportsStageAgentConfig: false,
    });
  });

  it("does not require publication-token support for envelope compatibility", async () => {
    const github = contents(githubFile(ENVELOPE_YML));
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
      supportsPrivateRunConfig: false,
      supportsExecutionPolicy: false,
      supportsStageAgentConfig: false,
    });
  });

  it("does not report publication-token support when the input is only mentioned in a YAML comment", async () => {
    const commentYml =
      "on:\n  workflow_dispatch:\n    inputs:\n      run_config:\n        required: true\n      # run_publication_token: would go here\n";
    const github = contents(githubFile(commentYml));
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
      supportsPrivateRunConfig: false,
      supportsExecutionPolicy: false,
      supportsStageAgentConfig: false,
    });
  });

  it("classifies a workflow without run_config as legacy", async () => {
    const github = contents(githubFile(LEGACY_YML));
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
    const github = contents(githubFile(LEGACY_YML));
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
      supportsPrivateRunConfig: false,
      supportsExecutionPolicy: false,
      supportsStageAgentConfig: false,
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
    const github = contents(githubFile(ENVELOPE_YML));
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
    const github = contents(githubFile(ENVELOPE_YML));
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
    const githubA = contents(githubFile(ENVELOPE_YML));
    const githubB = contents(githubFile(LEGACY_YML), "claude-plan.yml");

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
    const github = contents(githubFile(commentYml));
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
    const github = contents(githubFile(ENVELOPE_YML), "claude-plan.yml");
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
    const githubMain = contents(githubFile(LEGACY_YML), "claude-plan.yml");
    const githubDev = contents(githubFile(ENVELOPE_YML), "claude-plan.yml");

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
    const github = contents(githubFile(ATTEMPT_TOKEN_YML));
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
      supportsPrivateRunConfig: false,
      supportsExecutionPolicy: false,
      supportsStageAgentConfig: false,
    });
  });

  it("does not report attempt-correlation support for an otherwise-envelope workflow that lacks the marker", async () => {
    const github = contents(githubFile(ENVELOPE_YML));
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
    const github = contents(githubFile(commentYml));
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
    const github = contents(githubFile(legacyWithMarkerYml));
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
      supportsPrivateRunConfig: false,
      supportsExecutionPolicy: false,
      supportsStageAgentConfig: false,
    });
  });

  it("probes attempt-correlation support on the actual dispatch ref, not a cached different ref", async () => {
    const githubMain = contents(githubFile(ENVELOPE_YML));
    const githubDev = contents(githubFile(ATTEMPT_TOKEN_YML));

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

// ---------- supportsPrivateRunConfig (AII-982) ----------

describe("resolveWorkflowCapabilities — supportsPrivateRunConfig", () => {
  const MARKER = "# ai-implement-capability: private-run-config-v1\n";
  const probe = (github: FakeFetch) =>
    resolveWorkflowCapabilities({
      owner: "o",
      repo: "r",
      workflowFile: "w.yml",
      token: "t",
      ref: "main",
      fetchImpl: github.fetch,
    });

  beforeEach(() => __clearWorkflowProbeCacheForTests());

  it("is true only for an envelope workflow carrying the static marker", async () => {
    expect((await probe(contents(githubFile(MARKER + ENVELOPE_YML), "w.yml"))).supportsPrivateRunConfig).toBe(true);
  });

  it("is false for an envelope workflow without the marker", async () => {
    expect((await probe(contents(githubFile(ENVELOPE_YML), "w.yml"))).supportsPrivateRunConfig).toBe(false);
  });

  it("stays false for a legacy workflow that mentions the marker", async () => {
    expect((await probe(contents(githubFile(MARKER + LEGACY_YML), "w.yml"))).supportsPrivateRunConfig).toBe(false);
  });

  it("is false for 404 and fetch errors", async () => {
    expect((await probe(contents(githubError(404, "Not Found"), "w.yml"))).supportsPrivateRunConfig).toBe(false);
    __clearWorkflowProbeCacheForTests();
    expect((await probe(contents(() => { throw new Error("boom"); }, "w.yml"))).supportsPrivateRunConfig).toBe(false);
  });

  it("does not imply stage-agent support from the private-envelope marker", async () => {
    const caps = await probe(contents(githubFile(MARKER + ENVELOPE_YML), "w.yml"));
    expect(caps.supportsStageAgentConfig).toBe(false);
  });
});

describe("transient probe failures (AII-1292)", () => {
  beforeEach(() => {
    __clearWorkflowProbeCacheForTests();
  });
  const base = { owner: "o", repo: "r", workflowFile: "claude-implement.yml", token: "t", ref: "main" };
  // A path that names a directory answers with its listing, an array, rather than a file object.
  const transient: Array<[string, () => FakeFetch]> = [
    ["fetch throw", () => contents(() => { throw new Error("net"); })],
    ["HTTP 500", () => contents(githubError(500, "Server Error"))],
    ["bad JSON", () => contents({ text: "<html>upstream error</html>" })],
    ["non-file body", () => contents({ json: [{ type: "file", name: "claude-implement.yml" }] })],
  ];

  it.each(transient)("%s is not cached and never throws by default", async (_n, make) => {
    const github = make();
    const first = await resolveWorkflowCapabilities({ ...base, fetchImpl: github.fetch });
    await resolveWorkflowCapabilities({ ...base, fetchImpl: github.fetch });
    expect(first.contract).toBe("legacy");
    expect(github.calls).toHaveLength(2);
  });

  it.each(transient)("%s throws with failOnTransient", async (_n, make) => {
    await expect(resolveWorkflowCapabilities({ ...base, fetchImpl: make().fetch, failOnTransient: true })).rejects.toThrow();
  });

  it("a 404 and a real legacy workflow stay cached and do not throw with failOnTransient", async () => {
    const notFound = contents(githubError(404, "Not Found"));
    expect(await resolveWorkflowContract({ ...base, fetchImpl: notFound.fetch, failOnTransient: true })).toBe("legacy");
    await resolveWorkflowContract({ ...base, fetchImpl: notFound.fetch, failOnTransient: true });
    expect(notFound.calls).toHaveLength(1);

    __clearWorkflowProbeCacheForTests();
    const legacy = contents(githubFile(LEGACY_YML));
    expect(await resolveWorkflowContract({ ...base, fetchImpl: legacy.fetch, failOnTransient: true })).toBe("legacy");
    await resolveWorkflowContract({ ...base, fetchImpl: legacy.fetch });
    expect(legacy.calls).toHaveLength(1);
  });
});
