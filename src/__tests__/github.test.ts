import { describe, it, expect } from "vitest";
import { dispatchWorkflow, postWorkflowDispatch, providerDispatchFields, getBranchSha, fetchRepoTarball, ensureBranchExists, capDispatchFields, capRunnerEnv, branchPrefixDispatchFields, branchPrefixRunnerEnv, skillsRepoDispatchFields, skillsRepoRunnerEnv, profilesDispatchFields, profilesRunnerEnv, assigneeRunnerEnv, buildEnvelopeDispatchInputs, cancelWorkflowRun, getPullRequestState, deleteBranch, findPullRequestByBranches, mergePullRequest, getCombinedChecksState, parseLinkNext, listRepoBranchesAndTags, listPullRequestFiles, listPullRequestCommits, getCommitTime, getDefaultBranchFileText, listPrComments } from "../github.js";
import { decodeRunConfig } from "../run-config.js";
import { buildIssueBranchName } from "../pipeline/branch-name.js";
import { DEFAULT_RETRY_POLICY } from "../pipeline/retry-backoff.js";
import { makeMapping } from "./helpers/builders.js";
import { fakeFetch, type ReplyInit } from "./helpers/fake-fetch.js";
import { githubError, githubFile } from "./helpers/github-replies.js";

const mockMapping = makeMapping();

const mockInputs = {
  issue_id: "id-123",
  issue_identifier: "TEST-1",
  issue_title: "Test issue",
  issue_description: "A test issue",
};

describe("dispatchWorkflow", () => {
  const DISPATCHES = "POST /repos/test-org/test-repo/actions/workflows/claude-implement.yml/dispatches";

  it("returns success on 204 response", async () => {
    const fake = fakeFetch({ [DISPATCHES]: { status: 204 } }).install();

    const result = await dispatchWorkflow("gh-token", mockMapping, mockInputs);
    expect(result).toEqual({ success: true, status: 204 });

    expect(fake.calls[0].url.href).toBe("https://api.github.com/repos/test-org/test-repo/actions/workflows/claude-implement.yml/dispatches");
    const body = JSON.parse(fake.calls[0].body);
    expect(body.ref).toBe("main");
    expect(body.inputs.issue_identifier).toBe("TEST-1");
    expect(body.inputs.issue_id).toBe("id-123");
  });

  it("returns success on 200 response", async () => {
    fakeFetch({ [DISPATCHES]: { status: 200 } }).install();
    const result = await dispatchWorkflow("gh-token", mockMapping, mockInputs);
    expect(result).toEqual({ success: true, status: 200 });
  });

  it("returns failure with error body on non-success status", async () => {
    fakeFetch({ [DISPATCHES]: { status: 422, text: "Unprocessable Entity" } }).install();

    const result = await dispatchWorkflow("gh-token", mockMapping, mockInputs);
    expect(result.success).toBe(false);
    expect(result.status).toBe(422);
    expect(result.error).toBe("Unprocessable Entity");
  });

  it("sends correct auth header", async () => {
    const fake = fakeFetch({ [DISPATCHES]: { status: 204 } }).install();
    await dispatchWorkflow("my-token", mockMapping, mockInputs);
    expect(fake.calls[0].headers.get("Authorization")).toBe("Bearer my-token");
  });

  it("does not include provider or aws_region in inputs for anthropic mappings", async () => {
    const fake = fakeFetch({ [DISPATCHES]: { status: 204 } }).install();
    await dispatchWorkflow("gh-token", mockMapping, {
      ...mockInputs,
      ...providerDispatchFields(mockMapping),
    });
    const body = JSON.parse(fake.calls[0].body);
    expect(body.inputs.provider).toBeUndefined();
    expect(body.inputs.aws_region).toBeUndefined();
  });

  it("forwards runner_image when present in inputs", async () => {
    const fake = fakeFetch({ [DISPATCHES]: { status: 204 } }).install();
    await dispatchWorkflow("gh-token", mockMapping, {
      ...mockInputs,
      runner_image: "ghcr.io/builddownai/ai-implement-runner:next",
    });
    const body = JSON.parse(fake.calls[0].body);
    expect(body.inputs.runner_image).toBe("ghcr.io/builddownai/ai-implement-runner:next");
  });

  it("omits runner_image when not provided", async () => {
    const fake = fakeFetch({ [DISPATCHES]: { status: 204 } }).install();
    await dispatchWorkflow("gh-token", mockMapping, mockInputs);
    const body = JSON.parse(fake.calls[0].body);
    expect(body.inputs.runner_image).toBeUndefined();
  });

  it("forwards provider and aws_region in inputs for bedrock mappings", async () => {
    const fake = fakeFetch({ [DISPATCHES]: { status: 204 } }).install();
    const bedrockMapping = makeMapping({ provider: "bedrock", awsRegion: "us-west-2" });
    await dispatchWorkflow("gh-token", bedrockMapping, {
      ...mockInputs,
      ...providerDispatchFields(bedrockMapping),
    });
    const body = JSON.parse(fake.calls[0].body);
    expect(body.inputs.provider).toBe("bedrock");
    expect(body.inputs.aws_region).toBe("us-west-2");
  });

  it("forwards base_branch in inputs while ref stays the workflow default branch", async () => {
    const fake = fakeFetch({ [DISPATCHES]: { status: 204 } }).install();
    await dispatchWorkflow("gh-token", mockMapping, {
      ...mockInputs,
      base_branch: "ai-implement/feature/eng-1",
    });
    const body = JSON.parse(fake.calls[0].body);
    expect(body.ref).toBe("main");
    expect(body.inputs.base_branch).toBe("ai-implement/feature/eng-1");
  });

  it("omits base_branch from inputs when it is not provided (non-grouped path)", async () => {
    const fake = fakeFetch({ [DISPATCHES]: { status: 204 } }).install();
    await dispatchWorkflow("gh-token", mockMapping, mockInputs);
    const body = JSON.parse(fake.calls[0].body);
    expect("base_branch" in body.inputs).toBe(false);
  });
});

// ---------- postWorkflowDispatch — returnRunDetails (AII-778) ----------

describe("postWorkflowDispatch — returnRunDetails opt-in", () => {
  const DISPATCHES = "POST /repos/acme/widgets/actions/workflows/claude-implement.yml/dispatches";

  const baseOpts = {
    token: "tok",
    owner: "acme",
    repo: "widgets",
    workflowFile: "claude-implement.yml",
    ref: "main",
    inputs: { run_config: "cfg", run_token: "rt" },
  };

  it("sends return_run_details: true in the POST body when opted in", async () => {
    const fake = fakeFetch({ [DISPATCHES]: { status: 204 } }).install();

    await postWorkflowDispatch({ ...baseOpts, returnRunDetails: true });

    const body = JSON.parse(fake.calls[0].body);
    expect(body.return_run_details).toBe(true);
  });

  it("omits return_run_details from the POST body when not opted in (legacy byte-for-byte)", async () => {
    const fake = fakeFetch({ [DISPATCHES]: { status: 204 } }).install();

    const result = await postWorkflowDispatch(baseOpts);

    const body = JSON.parse(fake.calls[0].body);
    expect("return_run_details" in body).toBe(false);
    expect(result).toEqual({ success: true, status: 204 });
    expect("outcome" in result).toBe(false);
  });

  it("200 with valid run details for the requested repo → accepted with exact identity", async () => {
    fakeFetch({
      [DISPATCHES]: {
        status: 200,
        json: {
          id: 555,
          html_url: "https://github.com/acme/widgets/actions/runs/555",
          repository: { full_name: "acme/widgets" },
        },
      },
    }).install();

    const result = await postWorkflowDispatch({ ...baseOpts, returnRunDetails: true });

    expect(result).toEqual({
      success: true,
      status: 200,
      outcome: "accepted",
      runId: 555,
      runUrl: "https://github.com/acme/widgets/actions/runs/555",
    });
  });

  it.each([
    { workflow_run_id: 555 },
    { workflow_run_id: 555, id: 555 },
    { run: { id: 555 } },
  ])("accepts documented dispatch IDs and compatible historical IDs: %j", async (fields) => {
    const urls = {
      run_url: "https://api.github.com/repos/acme/widgets/actions/runs/555",
      html_url: "https://github.com/acme/widgets/actions/runs/555",
    };
    const body = "run" in fields ? { run: { ...fields.run, ...urls } } : { ...fields, ...urls };
    fakeFetch({ [DISPATCHES]: { status: 200, json: body } }).install();

    expect(await postWorkflowDispatch({ ...baseOpts, returnRunDetails: true })).toEqual({
      success: true, status: 200, outcome: "accepted", runId: 555, runUrl: urls.html_url,
    });
  });

  it.each([
    { name: "conflicting identity fields", fields: { id: 556 } },
    { name: "a string run ID", fields: { workflow_run_id: "555" } },
    { name: "a nonpositive run ID", fields: { workflow_run_id: 0 } },
    { name: "an unsafe run ID", fields: { workflow_run_id: Number.MAX_SAFE_INTEGER + 1 } },
    { name: "a different HTML run ID", fields: { html_url: "https://github.com/acme/widgets/actions/runs/556" } },
    { name: "a different HTML repository", fields: { html_url: "https://github.com/other/widgets/actions/runs/555" } },
    { name: "a different API run ID", fields: { run_url: "https://api.github.com/repos/acme/widgets/actions/runs/556" } },
    { name: "a different API repository", fields: { run_url: "https://api.github.com/repos/other/widgets/actions/runs/555" } },
  ])("does not bind $name in a documented response", async ({ fields }) => {
    fakeFetch({
      [DISPATCHES]: {
        status: 200,
        json: {
          workflow_run_id: 555,
          run_url: "https://api.github.com/repos/acme/widgets/actions/runs/555",
          html_url: "https://github.com/acme/widgets/actions/runs/555",
          ...fields,
        },
      },
    }).install();

    expect(await postWorkflowDispatch({ ...baseOpts, returnRunDetails: true }))
      .toEqual({ success: true, status: 200, outcome: "unknown" });
  });

  it("204 → accepted with unresolved identity, distinct from rejected", async () => {
    fakeFetch({ [DISPATCHES]: { status: 204 } }).install();

    const result = await postWorkflowDispatch({ ...baseOpts, returnRunDetails: true });

    expect(result).toEqual({ success: true, status: 204, outcome: "accepted" });
    expect("runId" in result).toBe(false);
    expect("runUrl" in result).toBe(false);
  });

  it("a definite 422/404 application rejection → rejected", async () => {
    fakeFetch({ [DISPATCHES]: { status: 422, text: "Unprocessable Entity" } }).install();

    const result = await postWorkflowDispatch({ ...baseOpts, returnRunDetails: true });

    expect(result).toEqual({
      success: false,
      status: 422,
      error: "Unprocessable Entity",
      outcome: "rejected",
    });
  });

  it("a transport failure (thrown fetch) → unknown, without throwing", async () => {
    fakeFetch({ [DISPATCHES]: () => { throw new Error("network reset"); } }).install();

    const result = await postWorkflowDispatch({ ...baseOpts, returnRunDetails: true });

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("unknown");
  });

  it("legacy (non-opted-in) throws on a transport failure, unchanged", async () => {
    fakeFetch({ [DISPATCHES]: () => { throw new Error("network reset"); } }).install();

    await expect(postWorkflowDispatch(baseOpts)).rejects.toThrow("network reset");
  });

  it("an unparseable 200 body → unknown, not accepted", async () => {
    fakeFetch({ [DISPATCHES]: { status: 200, text: "not json" } }).install();

    const result = await postWorkflowDispatch({ ...baseOpts, returnRunDetails: true });

    expect(result).toEqual({ success: true, status: 200, outcome: "unknown" });
    expect("runId" in result).toBe(false);
  });

  it("a 5xx (ambiguous server outcome) → unknown, not rejected", async () => {
    fakeFetch({ [DISPATCHES]: { status: 503, text: "Service Unavailable" } }).install();

    const result = await postWorkflowDispatch({ ...baseOpts, returnRunDetails: true });

    expect(result).toEqual({
      success: false,
      status: 503,
      error: "Service Unavailable",
      outcome: "unknown",
    });
  });

  it("a 200 body whose html_url points at a different repo never populates trusted identity", async () => {
    fakeFetch({
      [DISPATCHES]: {
        status: 200,
        json: {
          id: 999,
          html_url: "https://github.com/other-org/other-repo/actions/runs/999",
          repository: { full_name: "other-org/other-repo" },
        },
      },
    }).install();

    const result = await postWorkflowDispatch({ ...baseOpts, returnRunDetails: true });

    expect(result).toEqual({ success: true, status: 200, outcome: "unknown" });
    expect("runId" in result).toBe(false);
    expect("runUrl" in result).toBe(false);
  });

  it("a 200 body whose repository field disagrees with a matching html_url never populates trusted identity", async () => {
    // html_url alone can't be trusted if another field on the same payload contradicts it —
    // both signals must agree before identity is trusted.
    fakeFetch({
      [DISPATCHES]: {
        status: 200,
        json: {
          id: 42,
          html_url: "https://github.com/acme/widgets/actions/runs/42",
          repository: { full_name: "acme/other-repo" },
        },
      },
    }).install();

    const result = await postWorkflowDispatch({ ...baseOpts, returnRunDetails: true });

    expect(result).toEqual({ success: true, status: 200, outcome: "unknown" });
  });

  it("still performs the existing 422 strip-and-retry when returnRunDetails is also requested", async () => {
    const fake = fakeFetch({
      [DISPATCHES]: [
        { status: 422, text: 'Unexpected inputs provided: ["runner_phase"]' },
        { status: 204 },
      ],
    }).install();

    const result = await postWorkflowDispatch({
      ...baseOpts,
      inputs: { run_config: "cfg", run_token: "rt", runner_phase: "kg-refresh" },
      returnRunDetails: true,
    });

    expect(fake.calls).toHaveLength(2);
    const secondBody = JSON.parse(fake.calls[1].body);
    expect("runner_phase" in secondBody.inputs).toBe(false);
    expect(secondBody.return_run_details).toBe(true);
    expect(result).toEqual({ success: true, status: 204, outcome: "accepted" });
  });

  it("never repeats a POST following an unknown outcome (no retry loop on ambiguity)", async () => {
    // Only the definite 422 strip-and-retry path issues a second request; an unknown
    // outcome (transport loss, unparseable/mismatched 200, 5xx) must return immediately so
    // a caller building retry logic on this contract never double-dispatches.
    const fake = fakeFetch({ [DISPATCHES]: [() => { throw new Error("timeout"); }] }).install();

    await postWorkflowDispatch({ ...baseOpts, returnRunDetails: true });

    expect(fake.calls).toHaveLength(1);
  });

  it("dispatchWorkflow (used by index.ts and comment-gapfill-drain.ts) never opts into returnRunDetails", async () => {
    const fake = fakeFetch({ "POST /repos/test-org/test-repo/actions/workflows/claude-implement.yml/dispatches": { status: 204 } }).install();

    const result = await dispatchWorkflow("gh-token", mockMapping, mockInputs);

    const body = JSON.parse(fake.calls[0].body);
    expect("return_run_details" in body).toBe(false);
    expect(result).toEqual({ success: true, status: 204 });
  });
});

describe("ensureBranchExists", () => {
  const refReply = (sha: string): ReplyInit => ({ json: { object: { sha } } });

  it("returns the SHA when a branch exists and null on 404 (getBranchSha)", async () => {
    fakeFetch({
      "GET /repos/o/r/git/ref/heads/feat": refReply("abc123"),
      "GET /repos/o/r/git/ref/heads/missing": githubError(404, "Not Found"),
    }).install();

    expect(await getBranchSha("t", "o", "r", "feat")).toBe("abc123");
    expect(await getBranchSha("t", "o", "r", "missing")).toBeNull();
  });

  it("preserves slash separators in the ref path for multi-segment branch names", async () => {
    const fake = fakeFetch({ "GET /repos/o/r/git/ref/heads/ai-implement/feature/ool-78": refReply("abc123") }).install();
    await getBranchSha("t", "o", "r", "ai-implement/feature/ool-78");
    const url = fake.calls[0].url.href;
    expect(url).toBe("https://api.github.com/repos/o/r/git/ref/heads/ai-implement/feature/ool-78");
    expect(url).not.toContain("%2F");
  });

  it("throws on a 422 that is not an 'already exists' race", async () => {
    fakeFetch({
      "GET /repos/o/r/git/ref/heads/feat": githubError(404, "Not Found"),
      "GET /repos/o/r/git/ref/heads/testing": refReply("base-sha"),
      "POST /repos/o/r/git/refs": githubError(422, "Validation Failed"),
    }).install();

    await expect(ensureBranchExists("t", "o", "r", "feat", "testing")).rejects.toThrow(/HTTP 422/);
  });

  it("creates the branch from the base head when it does not exist", async () => {
    const fake = fakeFetch({
      "GET /repos/o/r/git/ref/heads/ai-implement/feature/eng-1": githubError(404, "Not Found"),
      "GET /repos/o/r/git/ref/heads/testing": refReply("base-sha"),
      "POST /repos/o/r/git/refs": { status: 201 },
    }).install();

    await ensureBranchExists("t", "o", "r", "ai-implement/feature/eng-1", "testing");

    const createCall = fake.calls[2];
    expect(createCall.url.href).toBe("https://api.github.com/repos/o/r/git/refs");
    expect(JSON.parse(createCall.body)).toEqual({ ref: "refs/heads/ai-implement/feature/eng-1", sha: "base-sha" });
  });

  it("is a no-op when the branch already exists", async () => {
    const fake = fakeFetch({ "GET /repos/o/r/git/ref/heads/feat": refReply("already-here") }).install();
    await ensureBranchExists("t", "o", "r", "feat", "testing");
    expect(fake.calls).toHaveLength(1); // only the existence check
  });

  it("tolerates a 422 create race as success", async () => {
    fakeFetch({
      "GET /repos/o/r/git/ref/heads/feat": githubError(404, "Not Found"),
      "GET /repos/o/r/git/ref/heads/testing": refReply("base-sha"),
      "POST /repos/o/r/git/refs": githubError(422, "Reference already exists"),
    }).install();

    await expect(ensureBranchExists("t", "o", "r", "feat", "testing")).resolves.toBeUndefined();
  });
});

describe("providerDispatchFields", () => {
  it("returns empty object for anthropic mappings", () => {
    expect(providerDispatchFields(makeMapping({ provider: "anthropic" }))).toEqual({});
  });

  it("returns provider and aws_region for bedrock mappings", () => {
    expect(
      providerDispatchFields(makeMapping({ provider: "bedrock", awsRegion: "eu-central-1" })),
    ).toEqual({ provider: "bedrock", aws_region: "eu-central-1" });
  });

  it("omits aws_region when bedrock mapping has no region set (orchestrator guard handles that case)", () => {
    expect(
      providerDispatchFields(makeMapping({ provider: "bedrock", awsRegion: null })),
    ).toEqual({ provider: "bedrock" });
  });
});

describe("capDispatchFields", () => {
  it("returns empty object when no caps are set", () => {
    expect(capDispatchFields(makeMapping({}))).toEqual({});
  });

  it("includes only the caps that are set, as strings", () => {
    expect(
      capDispatchFields(makeMapping({ maxTurns: 40, maxIterations: 2, maxJobMinutes: 30 })),
    ).toEqual({ max_turns: "40", max_iterations: "2", job_timeout_minutes: "30" });
  });

  it("omits caps left null", () => {
    expect(capDispatchFields(makeMapping({ maxTurns: 40 }))).toEqual({ max_turns: "40" });
  });
});

describe("capRunnerEnv", () => {
  it("returns empty object when no caps are set", () => {
    expect(capRunnerEnv(makeMapping({}))).toEqual({});
  });

  it("includes turn/iteration caps as env vars (strings) when set", () => {
    expect(capRunnerEnv(makeMapping({ maxTurns: 40, maxIterations: 2 }))).toEqual({
      AI_IMPLEMENT_MAX_TURNS: "40",
      AI_IMPLEMENT_MAX_ITERATIONS: "2",
    });
  });

  it("omits job timeout (GHA-only, not a runner env var)", () => {
    expect(capRunnerEnv(makeMapping({ maxTurns: 40, maxJobMinutes: 30 }))).toEqual({
      AI_IMPLEMENT_MAX_TURNS: "40",
    });
  });

  it("omits caps left null", () => {
    expect(capRunnerEnv(makeMapping({ maxIterations: 3 }))).toEqual({
      AI_IMPLEMENT_MAX_ITERATIONS: "3",
    });
  });
});

describe("cancelWorkflowRun", () => {
  it("returns true on 202 Accepted", async () => {
    const fake = fakeFetch({ "POST /repos/owner/repo/actions/runs/42/cancel": { status: 202 } }).install();
    const result = await cancelWorkflowRun("token", "owner", "repo", 42);
    expect(result).toBe(true);
    expect(fake.calls[0].url.href).toBe("https://api.github.com/repos/owner/repo/actions/runs/42/cancel");
  });

  it("returns true on 409 (run not in a cancellable state)", async () => {
    fakeFetch({ "POST /repos/owner/repo/actions/runs/99/cancel": githubError(409, "Conflict") }).install();
    const result = await cancelWorkflowRun("token", "owner", "repo", 99);
    expect(result).toBe(true);
  });

  it("returns false on other non-OK statuses", async () => {
    fakeFetch({ "POST /repos/owner/repo/actions/runs/7/cancel": githubError(500, "Server Error") }).install();
    const result = await cancelWorkflowRun("token", "owner", "repo", 7);
    expect(result).toBe(false);
  });

  it("returns false on 404 without throwing", async () => {
    fakeFetch({ "POST /repos/owner/repo/actions/runs/1/cancel": githubError(404, "Not Found") }).install();
    await expect(cancelWorkflowRun("token", "owner", "repo", 1)).resolves.toBe(false);
  });
});

describe("getPullRequestState", () => {
  const PULL = "GET /repos/o/r/pulls/7";

  // The branch an implementation run opens for ENG-7, named as production names it.
  const branch = buildIssueBranchName("ENG-7", "Test");
  const head = { ref: branch, sha: "sha-7" };

  it("returns merged=true for a merged PR", async () => {
    fakeFetch({ [PULL]: { json: { merged: true, state: "closed", head } } }).install();
    expect(await getPullRequestState("t", "o", "r", 7)).toEqual({ merged: true, state: "closed", headRef: branch, headSha: "sha-7" });
  });
  it("returns merged=false for a closed-unmerged PR", async () => {
    fakeFetch({ [PULL]: { json: { merged: false, state: "closed", head } } }).install();
    expect(await getPullRequestState("t", "o", "r", 7)).toEqual({ merged: false, state: "closed", headRef: branch, headSha: "sha-7" });
  });
  it("returns null on a non-OK response", async () => {
    fakeFetch({ [PULL]: githubError(404, "Not Found") }).install();
    expect(await getPullRequestState("t", "o", "r", 7)).toBeNull();
  });
});

describe("branchPrefixDispatchFields", () => {
  it("returns empty object when no prefix is set", () => {
    expect(branchPrefixDispatchFields(makeMapping({}))).toEqual({});
    expect(branchPrefixDispatchFields(makeMapping({ branchPrefix: null }))).toEqual({});
  });

  it("includes branch_prefix when set", () => {
    expect(branchPrefixDispatchFields(makeMapping({ branchPrefix: "pr" }))).toEqual({
      branch_prefix: "pr",
    });
  });
});

describe("branchPrefixRunnerEnv", () => {
  it("returns empty object when no prefix is set", () => {
    expect(branchPrefixRunnerEnv(makeMapping({}))).toEqual({});
  });

  it("includes AI_IMPLEMENT_BRANCH_PREFIX when set", () => {
    expect(branchPrefixRunnerEnv(makeMapping({ branchPrefix: "pr" }))).toEqual({
      AI_IMPLEMENT_BRANCH_PREFIX: "pr",
    });
  });
});

describe("skillsRepoDispatchFields", () => {
  it("returns empty object when no skills repo is set", () => {
    expect(skillsRepoDispatchFields(makeMapping({}))).toEqual({});
    expect(skillsRepoDispatchFields(makeMapping({ skillsRepo: null }))).toEqual({});
  });

  it("includes skills_repo when set", () => {
    // The admin save stores a skills repository in its normalized URL form.
    expect(skillsRepoDispatchFields(makeMapping({ skillsRepo: "https://github.com/org/skills" }))).toEqual({
      skills_repo: "https://github.com/org/skills",
    });
  });
});

describe("skillsRepoRunnerEnv", () => {
  it("returns empty object when no skills repo is set", () => {
    expect(skillsRepoRunnerEnv(makeMapping({}))).toEqual({});
  });

  it("includes AI_IMPLEMENT_SKILLS_REPO when set", () => {
    expect(skillsRepoRunnerEnv(makeMapping({ skillsRepo: "https://github.com/org/skills" }))).toEqual({
      AI_IMPLEMENT_SKILLS_REPO: "https://github.com/org/skills",
    });
  });
});

describe("profilesDispatchFields", () => {
  it("returns empty object when the issue has no profiles", () => {
    expect(profilesDispatchFields({})).toEqual({});
    expect(profilesDispatchFields({ profiles: undefined })).toEqual({});
    expect(profilesDispatchFields({ profiles: [] })).toEqual({});
  });

  it("comma-joins profiles when present", () => {
    expect(profilesDispatchFields({ profiles: ["backend"] })).toEqual({ profiles: "backend" });
    expect(profilesDispatchFields({ profiles: ["backend", "webapp"] })).toEqual({
      profiles: "backend,webapp",
    });
  });
});

describe("profilesRunnerEnv", () => {
  it("returns empty object when the issue has no profiles", () => {
    expect(profilesRunnerEnv({})).toEqual({});
    expect(profilesRunnerEnv({ profiles: [] })).toEqual({});
  });

  it("includes AI_IMPLEMENT_PROFILES when profiles are present", () => {
    expect(profilesRunnerEnv({ profiles: ["backend", "webapp"] })).toEqual({
      AI_IMPLEMENT_PROFILES: "backend,webapp",
    });
  });
});

describe("assigneeRunnerEnv", () => {
  it("returns empty object when the issue has no assignee", () => {
    expect(assigneeRunnerEnv({})).toEqual({});
  });

  it("includes AI_IMPLEMENT_ASSIGNEE_NAME when present", () => {
    expect(assigneeRunnerEnv({ assigneeName: "Paz" })).toEqual({
      AI_IMPLEMENT_ASSIGNEE_NAME: "Paz",
    });
  });
});

describe("buildEnvelopeDispatchInputs", () => {
  const baseIssue = { id: "uuid-1", identifier: "AII-1", title: "T", description: "D" };
  // Profiles and an assignee name come only from the Jira provider, so those tests use a Jira mapping and issue.
  const jiraMapping = makeMapping({
    ticketingProvider: "jira",
    ticketingConfig: {
      kind: "jira", jql: "project = ACME", repoFieldValue: "test-org/test-repo",
      statusFieldOverride: null, repoFieldOverride: null, profilesFieldOverride: null, baseBranchFieldOverride: null,
    },
  });
  const jiraIssue = { id: "10001", identifier: "ACME-1", title: "T", description: "D" };

  it("carries profiles in run_config when non-empty", () => {
    const inputs = buildEnvelopeDispatchInputs(jiraMapping, { ...jiraIssue, profiles: ["backend", "webapp"] }, { runnerPhase: "implementation", retryPolicy: DEFAULT_RETRY_POLICY });
    const cfg = decodeRunConfig(inputs.run_config as string);
    expect(cfg.profiles).toEqual(["backend", "webapp"]);
  });

  it("omits profiles from run_config when absent or empty", () => {
    const noProfiles = buildEnvelopeDispatchInputs(jiraMapping, jiraIssue, { runnerPhase: "implementation", retryPolicy: DEFAULT_RETRY_POLICY });
    expect(decodeRunConfig(noProfiles.run_config as string).profiles).toBeUndefined();

    const emptyProfiles = buildEnvelopeDispatchInputs(jiraMapping, { ...jiraIssue, profiles: [] }, { runnerPhase: "implementation", retryPolicy: DEFAULT_RETRY_POLICY });
    expect(decodeRunConfig(emptyProfiles.run_config as string).profiles).toBeUndefined();
  });

  it("carries assigneeName in run_config when present", () => {
    const inputs = buildEnvelopeDispatchInputs(jiraMapping, { ...jiraIssue, assigneeName: "Paz" }, { runnerPhase: "implementation", retryPolicy: DEFAULT_RETRY_POLICY });
    expect(decodeRunConfig(inputs.run_config as string).assigneeName).toBe("Paz");
  });

  it("omits assigneeName from run_config when absent", () => {
    const inputs = buildEnvelopeDispatchInputs(jiraMapping, jiraIssue, { runnerPhase: "implementation", retryPolicy: DEFAULT_RETRY_POLICY });
    expect(decodeRunConfig(inputs.run_config as string).assigneeName).toBeUndefined();
  });

  it("carries planningContext in run_config when provided", () => {
    const ctx = { parent: "- AII-0: parent", siblings: "None", dependencies: "None" };
    const inputs = buildEnvelopeDispatchInputs(mockMapping, baseIssue, {
      retryPolicy: null,
      runnerPhase: "planning",
      planningContext: ctx,
    });
    const cfg = decodeRunConfig(inputs.run_config as string);
    expect(cfg.planningContext).toEqual(ctx);
  });

  it("omits planningContext from run_config when not provided", () => {
    const inputs = buildEnvelopeDispatchInputs(mockMapping, baseIssue, { runnerPhase: "planning", retryPolicy: null });
    expect(decodeRunConfig(inputs.run_config as string).planningContext).toBeUndefined();
  });

  it("implementation dispatch carries profiles but no planningContext", () => {
    const inputs = buildEnvelopeDispatchInputs(jiraMapping, { ...jiraIssue, profiles: ["backend"] }, { runnerPhase: "implementation", retryPolicy: DEFAULT_RETRY_POLICY });
    const cfg = decodeRunConfig(inputs.run_config as string);
    expect(cfg.profiles).toEqual(["backend"]);
    expect(cfg.planningContext).toBeUndefined();
  });

  it("planning dispatch with context but no profiles", () => {
    const ctx = { parent: "- AII-0: parent", siblings: "None", dependencies: "None" };
    const inputs = buildEnvelopeDispatchInputs(mockMapping, baseIssue, { runnerPhase: "planning", planningContext: ctx, retryPolicy: null });
    const cfg = decodeRunConfig(inputs.run_config as string);
    expect(cfg.profiles).toBeUndefined();
    expect(cfg.planningContext).toEqual(ctx);
  });

  it("implementation dispatch carries referenceRepos when mapping has entries", () => {
    const repos = [{ repo: "https://github.com/org/ref-repo", path: "refs/repo-a" }];
    const inputs = buildEnvelopeDispatchInputs(makeMapping({ referenceRepos: repos }), baseIssue, { runnerPhase: "implementation", retryPolicy: DEFAULT_RETRY_POLICY });
    const cfg = decodeRunConfig(inputs.run_config as string);
    expect(cfg.referenceRepos).toEqual(repos);
  });

  it("implementation dispatch omits referenceRepos when mapping has none", () => {
    const inputs = buildEnvelopeDispatchInputs(makeMapping({ referenceRepos: null }), baseIssue, { runnerPhase: "implementation", retryPolicy: DEFAULT_RETRY_POLICY });
    expect(decodeRunConfig(inputs.run_config as string).referenceRepos).toBeUndefined();
  });

  it("planning dispatch omits referenceRepos even when mapping has entries", () => {
    const repos = [{ repo: "https://github.com/org/ref-repo", path: "refs/repo-a" }];
    const inputs = buildEnvelopeDispatchInputs(makeMapping({ referenceRepos: repos }), baseIssue, { runnerPhase: "planning", retryPolicy: null });
    expect(decodeRunConfig(inputs.run_config as string).referenceRepos).toBeUndefined();
  });

  it("kg-refresh dispatch omits referenceRepos even when mapping has entries", () => {
    const repos = [{ repo: "https://github.com/org/ref-repo", path: "refs/repo-a" }];
    const inputs = buildEnvelopeDispatchInputs(makeMapping({ referenceRepos: repos }), baseIssue, { runnerPhase: "kg-refresh", retryPolicy: null });
    expect(decodeRunConfig(inputs.run_config as string).referenceRepos).toBeUndefined();
  });

  it("gap-analysis dispatch carries referenceRepos when mapping has entries", () => {
    const repos = [{ repo: "https://github.com/org/ref-repo", path: "refs/repo-a" }];
    const inputs = buildEnvelopeDispatchInputs(makeMapping({ referenceRepos: repos }), baseIssue, { runnerPhase: "gap-analysis", retryPolicy: DEFAULT_RETRY_POLICY });
    expect(decodeRunConfig(inputs.run_config as string).referenceRepos).toEqual(repos);
  });

  it("encode-then-decode round-trip preserves all referenceRepos entries including one without ref", () => {
    const repos = [
      { repo: "https://github.com/org/repo-a", path: "refs/repo-a", ref: "main" },
      { repo: "https://github.com/org/repo-b", path: "refs/repo-b" },
    ];
    const inputs = buildEnvelopeDispatchInputs(makeMapping({ referenceRepos: repos }), baseIssue, { runnerPhase: "implementation", retryPolicy: DEFAULT_RETRY_POLICY });
    const cfg = decodeRunConfig(inputs.run_config as string);
    expect(cfg.referenceRepos).toEqual(repos);
    expect("ref" in (cfg.referenceRepos?.[1] ?? {})).toBe(false);
  });
});

describe("deleteBranch", () => {
  const REF = "DELETE /repos/owner/repo/git/refs/heads/ai-implement/feature/foo-1";

  it("returns true on 204 No Content", async () => {
    const fake = fakeFetch({ [REF]: { status: 204 } }).install();
    expect(await deleteBranch("tok", "owner", "repo", "ai-implement/feature/foo-1")).toBe(true);
    expect(fake.calls[0].url.href).toBe("https://api.github.com/repos/owner/repo/git/refs/heads/ai-implement/feature/foo-1");
  });

  it("returns true on 404 (idempotent — branch already deleted)", async () => {
    fakeFetch({ [REF]: githubError(404, "Not Found") }).install();
    expect(await deleteBranch("tok", "owner", "repo", "ai-implement/feature/foo-1")).toBe(true);
  });

  it('returns true on 422 "Reference does not exist" (the git-refs API reports a missing ref as 422, not 404)', async () => {
    fakeFetch({ [REF]: githubError(422, "Reference does not exist") }).install();
    expect(await deleteBranch("tok", "owner", "repo", "ai-implement/feature/foo-1")).toBe(true);
  });

  it("throws on a 422 that is not a missing ref (e.g. protected branch)", async () => {
    fakeFetch({ [REF]: githubError(422, "Refusing to delete the default branch") }).install();
    await expect(deleteBranch("tok", "owner", "repo", "ai-implement/feature/foo-1")).rejects.toThrow();
  });

  it("throws on other non-success statuses", async () => {
    fakeFetch({ [REF]: githubError(403, "Resource not accessible by integration") }).install();
    await expect(deleteBranch("tok", "owner", "repo", "ai-implement/feature/foo-1")).rejects.toThrow();
  });
});

describe("findPullRequestByBranches", () => {
  const PULLS = "GET /repos/owner/repo/pulls";

  it("returns merged PR when merged_at is set", async () => {
    fakeFetch({
      [PULLS]: { json: [{ number: 5, html_url: "https://github.com/owner/repo/pull/5", state: "closed", merged_at: "2026-06-30T12:00:00Z", updated_at: "2026-06-30T12:00:00Z", head: { sha: "sha-5" } }] },
    }).install();
    expect(await findPullRequestByBranches("tok", "owner", "repo", "head-branch", "base-branch")).toEqual({
      number: 5, url: "https://github.com/owner/repo/pull/5", state: "closed", merged: true, headSha: "sha-5",
    });
  });

  it("returns open PR with merged=false", async () => {
    fakeFetch({
      [PULLS]: { json: [{ number: 3, html_url: "https://github.com/owner/repo/pull/3", state: "open", merged_at: null, updated_at: "2026-07-01T08:00:00Z", head: { sha: "sha-3" } }] },
    }).install();
    expect(await findPullRequestByBranches("tok", "owner", "repo", "h", "b")).toEqual({
      number: 3, url: "https://github.com/owner/repo/pull/3", state: "open", merged: false, headSha: "sha-3",
    });
  });

  it("returns closed-unmerged PR with merged=false", async () => {
    fakeFetch({
      [PULLS]: { json: [{ number: 2, html_url: "https://github.com/owner/repo/pull/2", state: "closed", merged_at: null, updated_at: "2026-07-01T08:00:00Z", head: { sha: "sha-2" } }] },
    }).install();
    expect(await findPullRequestByBranches("tok", "owner", "repo", "h", "b")).toEqual({
      number: 2, url: "https://github.com/owner/repo/pull/2", state: "closed", merged: false, headSha: "sha-2",
    });
  });

  it("returns null when the PR list is empty", async () => {
    fakeFetch({ [PULLS]: { json: [] } }).install();
    expect(await findPullRequestByBranches("tok", "owner", "repo", "h", "b")).toBeNull();
  });

  it("prefers a merged PR when multiple results are returned", async () => {
    fakeFetch({
      [PULLS]: {
        json: [
          { number: 9, html_url: "https://github.com/owner/repo/pull/9", state: "closed", merged_at: null, updated_at: "2026-07-02T09:00:00Z", head: { sha: "sha-9" } },
          { number: 8, html_url: "https://github.com/owner/repo/pull/8", state: "closed", merged_at: "2026-06-30T12:00:00Z", updated_at: "2026-06-30T12:00:00Z", head: { sha: "sha-8" } },
        ],
      },
    }).install();
    const result = await findPullRequestByBranches("tok", "owner", "repo", "h", "b");
    expect(result).toMatchObject({ number: 8, merged: true, headSha: "sha-8" });
  });

  it("prefers an open PR over a newer closed-unmerged one (reopened PRs keep their created date)", async () => {
    fakeFetch({
      [PULLS]: {
        json: [
          { number: 12, html_url: "https://github.com/owner/repo/pull/12", state: "closed", merged_at: null, updated_at: "2026-07-02T09:00:00Z", head: { sha: "sha-12" } },
          { number: 7, html_url: "https://github.com/owner/repo/pull/7", state: "open", merged_at: null, updated_at: "2026-07-01T08:00:00Z", head: { sha: "sha-7" } },
        ],
      },
    }).install();
    expect(await findPullRequestByBranches("tok", "owner", "repo", "h", "b")).toEqual({
      number: 7, url: "https://github.com/owner/repo/pull/7", state: "open", merged: false, headSha: "sha-7",
    });
  });

  it("prefers a merged PR over an open one", async () => {
    fakeFetch({
      [PULLS]: {
        json: [
          { number: 12, html_url: "https://github.com/owner/repo/pull/12", state: "open", merged_at: null, updated_at: "2026-07-02T09:00:00Z", head: { sha: "sha-12" } },
          { number: 7, html_url: "https://github.com/owner/repo/pull/7", state: "closed", merged_at: "2026-06-30T12:00:00Z", updated_at: "2026-06-30T12:00:00Z", head: { sha: "sha-7" } },
        ],
      },
    }).install();
    expect(await findPullRequestByBranches("tok", "owner", "repo", "h", "b")).toEqual({
      number: 7, url: "https://github.com/owner/repo/pull/7", state: "closed", merged: true, headSha: "sha-7",
    });
  });

  it("picks the most recently updated PR when all are closed-unmerged, regardless of list order", async () => {
    fakeFetch({
      [PULLS]: {
        json: [
          { number: 4, html_url: "https://github.com/owner/repo/pull/4", state: "closed", merged_at: null, updated_at: "2026-06-20T10:00:00Z", head: { sha: "sha-4" } },
          { number: 2, html_url: "https://github.com/owner/repo/pull/2", state: "closed", merged_at: null, updated_at: "2026-07-05T10:00:00Z", head: { sha: "sha-2" } },
          { number: 3, html_url: "https://github.com/owner/repo/pull/3", state: "closed", merged_at: null, updated_at: "2026-06-28T10:00:00Z", head: { sha: "sha-3" } },
        ],
      },
    }).install();
    expect(await findPullRequestByBranches("tok", "owner", "repo", "h", "b")).toEqual({
      number: 2, url: "https://github.com/owner/repo/pull/2", state: "closed", merged: false, headSha: "sha-2",
    });
  });

  it("requests the list sorted by updated desc so the per_page window holds recently active PRs", async () => {
    const fake = fakeFetch({ [PULLS]: { json: [] } }).install();
    await findPullRequestByBranches("tok", "owner", "repo", "h", "b");
    expect(fake.calls[0].url.href).toContain("state=all&sort=updated&direction=desc&per_page=10");
  });

  it("returns null on non-OK response", async () => {
    fakeFetch({ [PULLS]: githubError(404, "Not Found") }).install();
    expect(await findPullRequestByBranches("tok", "owner", "repo", "h", "b")).toBeNull();
  });
});

describe("mergePullRequest", () => {
  const MERGE = "PUT /repos/owner/repo/pulls/5/merge";

  it('returns "merged" on HTTP 200', async () => {
    fakeFetch({ [MERGE]: { status: 200 } }).install();
    expect(await mergePullRequest("tok", "owner", "repo", 5, "sha5", "merge")).toBe("merged");
  });

  it('returns "blocked" on HTTP 405', async () => {
    fakeFetch({ [MERGE]: githubError(405, "Pull Request is not mergeable") }).install();
    expect(await mergePullRequest("tok", "owner", "repo", 5, "sha5", "merge")).toBe("blocked");
  });

  it('returns "conflict" on HTTP 409', async () => {
    fakeFetch({ [MERGE]: githubError(409, "Conflict") }).install();
    expect(await mergePullRequest("tok", "owner", "repo", 5, "sha5", "merge")).toBe("conflict");
  });
});

describe("getCombinedChecksState", () => {
  const CHECK_RUNS = "GET /repos/owner/repo/commits/abc/check-runs";
  const STATUS = "GET /repos/owner/repo/commits/abc/status";
  // GitHub reports a commit with no statuses as "pending" with a zero count.
  const noStatuses: ReplyInit = { json: { state: "pending", total_count: 0, statuses: [] } };

  it('returns "success" when there are zero check-runs and zero commit statuses', async () => {
    fakeFetch({
      [CHECK_RUNS]: { json: { total_count: 0, check_runs: [] } },
      [STATUS]: noStatuses,
    }).install();
    expect(await getCombinedChecksState("tok", "owner", "repo", "abc")).toBe("success");
  });

  it('returns "pending" when a check-run is in_progress', async () => {
    fakeFetch({
      [CHECK_RUNS]: { json: { total_count: 1, check_runs: [{ status: "in_progress", conclusion: null }] } },
      [STATUS]: noStatuses,
    }).install();
    expect(await getCombinedChecksState("tok", "owner", "repo", "abc")).toBe("pending");
  });

  it('returns "failure" when a completed check-run has conclusion "failure"', async () => {
    fakeFetch({
      [CHECK_RUNS]: { json: { total_count: 1, check_runs: [{ status: "completed", conclusion: "failure" }] } },
      [STATUS]: noStatuses,
    }).install();
    expect(await getCombinedChecksState("tok", "owner", "repo", "abc")).toBe("failure");
  });

  it('does not return "success" when check-runs 403s, even with an empty/ok commit-status response (AII-736)', async () => {
    // A check-runs read the App is not permitted to do is not evidence the checks passed —
    // falling through to the unconditional "success" would let auto-merge merge a PR with red
    // or running checks purely because the token could not read them.
    fakeFetch({
      [CHECK_RUNS]: githubError(403, "Resource not accessible by integration"),
      [STATUS]: noStatuses,
    }).install();
    expect(await getCombinedChecksState("tok", "owner", "repo", "abc")).not.toBe("success");
  });

  it('returns "pending" specifically on a check-runs 403, matching the existing hold-and-continue branch in auto-merge.ts', async () => {
    fakeFetch({
      [CHECK_RUNS]: githubError(403, "Resource not accessible by integration"),
      [STATUS]: noStatuses,
    }).install();
    expect(await getCombinedChecksState("tok", "owner", "repo", "abc")).toBe("pending");
  });

  it('returns "pending" specifically on a check-runs 404, treated as a permission error on a repo the token can otherwise see (AII-736)', async () => {
    fakeFetch({
      [CHECK_RUNS]: githubError(404, "Not Found"),
      [STATUS]: noStatuses,
    }).install();
    expect(await getCombinedChecksState("tok", "owner", "repo", "abc")).toBe("pending");
  });

  it('does not return "success" on a transient, non-permission check-runs read failure (e.g. a 500), even with an empty/ok commit-status response (AII-736)', async () => {
    fakeFetch({
      [CHECK_RUNS]: githubError(500, "Server Error"),
      [STATUS]: noStatuses,
    }).install();
    expect(await getCombinedChecksState("tok", "owner", "repo", "abc")).toBe("pending");
  });
});

describe("fetchRepoTarball", () => {
  const tarball = (bytes: number[]) => () => new Response(new Uint8Array(bytes));

  it("requests the tarball endpoint at the exact ref", async () => {
    const fake = fakeFetch({ "GET /repos/Owner/Repo/tarball/abc123": tarball([1, 2, 3]) }).install();
    await fetchRepoTarball("tok", "Owner", "Repo", "abc123");

    // A wrong path here surfaces only as a 404 at deploy time, when the orchestrator
    // is mid-deploy and least able to explain itself.
    expect(fake.calls[0].url.href).toBe(
      "https://api.github.com/repos/Owner/Repo/tarball/abc123",
    );
  });

  it("sends the bearer token — the source repository may be private", async () => {
    const fake = fakeFetch({ "GET /repos/Owner/Repo/tarball/abc123": tarball([1]) }).install();
    await fetchRepoTarball("tok", "Owner", "Repo", "abc123");

    expect(fake.calls[0].headers.get("Authorization")).toBe("Bearer tok");
  });

  it("returns the bytes as a Buffer", async () => {
    fakeFetch({ "GET /repos/Owner/Repo/tarball/abc123": tarball([31, 139, 8]) }).install();
    const out = await fetchRepoTarball("tok", "Owner", "Repo", "abc123");
    expect(Buffer.isBuffer(out)).toBe(true);
    expect([...out]).toEqual([31, 139, 8]);
  });

  it("throws on a non-ok response rather than returning an empty context", async () => {
    // Returning empty bytes would extract to an empty build context and fail much later.
    fakeFetch({ "GET /repos/Owner/Repo/tarball/nope": githubError(404, "Not Found") }).install();
    await expect(fetchRepoTarball("tok", "Owner", "Repo", "nope")).rejects.toThrow(/HTTP 404/);
  });
});

describe("listPullRequestFiles (AII-639)", () => {
  const FILES = "GET /repos/o/r/pulls/7/files";
  // GitHub's pagination links name the repository by its numeric id, carry per_page, and add rel="last".
  const PAGE_2 = "https://api.github.com/repositories/1300192/pulls/7/files?per_page=100&page=2";

  it("follows Link rel=\"next\" so a guard-relevant file past the first page is still returned", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `docs/page-${i}.md` }));
    const page2 = [{ filename: "sources.yml" }];
    const fake = fakeFetch({
      [FILES]: { json: page1, headers: { link: `<${PAGE_2}>; rel="next", <${PAGE_2}>; rel="last"` } },
      "GET /repositories/1300192/pulls/7/files": { json: page2 },
    }).install();
    const files = await listPullRequestFiles("tok", "o", "r", 7);
    expect(files).toHaveLength(101);
    expect(files).toContain("sources.yml");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].url.href).toBe(PAGE_2); // followed verbatim
  });

  it("throws on a non-OK page so the caller can report files_fetch_failed instead of treating it as no change", async () => {
    fakeFetch({ [FILES]: githubError(502, "Server Error") }).install();
    await expect(listPullRequestFiles("tok", "o", "r", 7)).rejects.toThrow(/listPullRequestFiles failed: HTTP 502/);
  });
});

describe("listPullRequestCommits (AII-1302)", () => {
  const COMMITS = "GET /repos/o/r/pulls/7/commits";

  it("follows Link rel=\"next\" and returns SHAs oldest first across pages", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ sha: `sha-${i}` }));
    const page2 = [{ sha: "head" }];
    const fake = fakeFetch({
      [COMMITS]: [
        { json: page1, headers: { link: '<https://api.github.com/repos/o/r/pulls/7/commits?per_page=100&page=2>; rel="next"' } },
        { json: page2 },
      ],
    }).install();
    const shas = await listPullRequestCommits("tok", "o", "r", 7);
    expect(shas).toHaveLength(101);
    expect(shas[0]).toBe("sha-0");
    expect(shas[100]).toBe("head");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0].url.href).toContain("/pulls/7/commits?per_page=100");
    expect(fake.calls[1].url.href).toContain("page=2");
  });

  it("throws on a non-OK page rather than reading it as no commits", async () => {
    fakeFetch({ [COMMITS]: githubError(502, "Server Error") }).install();
    await expect(listPullRequestCommits("tok", "o", "r", 7)).rejects.toThrow(/listPullRequestCommits failed: HTTP 502/);
  });
});

describe("parseLinkNext", () => {
  it("returns null for a null header", () => {
    expect(parseLinkNext(null)).toBeNull();
  });

  it("returns null when only rel='prev' is present", () => {
    expect(parseLinkNext('<https://api.github.com/repos/o/r/branches?page=1>; rel="prev"')).toBeNull();
  });

  it("returns the URL for a header containing rel='next'", () => {
    const header = '<https://api.github.com/repos/o/r/branches?page=2>; rel="next"';
    expect(parseLinkNext(header)).toBe("https://api.github.com/repos/o/r/branches?page=2");
  });

  it("extracts rel='next' when the header contains multiple relations", () => {
    const header =
      '<https://api.github.com/repos/o/r/branches?page=1>; rel="prev", ' +
      '<https://api.github.com/repos/o/r/branches?page=3>; rel="next"';
    expect(parseLinkNext(header)).toBe("https://api.github.com/repos/o/r/branches?page=3");
  });
});

describe("listRepoBranchesAndTags pagination", () => {
  function page(names: string[], nextUrl: string | null): ReplyInit {
    return {
      json: names.map((name) => ({ name })),
      ...(nextUrl ? { headers: { link: `<${nextUrl}>; rel="next"` } } : {}),
    };
  }

  it("follows Link rel=next and accumulates all branches across pages", async () => {
    const page1Names = Array.from({ length: 100 }, (_, i) => `branch-${String(i).padStart(3, "0")}`);
    const page2Names = Array.from({ length: 22 }, (_, i) => `branch-${String(i + 100).padStart(3, "0")}`);

    fakeFetch({
      "GET /repos/o/r/branches": page(page1Names, "https://api.github.com/repositories/1300192/branches?per_page=100&page=2"),
      "GET /repositories/1300192/branches": page(page2Names, null),
      "GET /repos/o/r/tags": page([], null),
    }).install();

    const result = await listRepoBranchesAndTags("tok", "o", "r");
    expect(result.branches).toHaveLength(122);
    expect(result.branches[0]).toBe("branch-000");
    expect(result.branches[99]).toBe("branch-099");
    expect(result.branches[121]).toBe("branch-121");
  });

  it("returns a single page of results when there is no Link header", async () => {
    fakeFetch({
      "GET /repos/o/r/branches": page(["main", "dev"], null),
      "GET /repos/o/r/tags": page(["v1.0"], null),
    }).install();

    const result = await listRepoBranchesAndTags("tok", "o", "r");
    expect(result.branches).toEqual(["main", "dev"]);
    expect(result.tags).toEqual(["v1.0"]);
  });
});

describe("getCommitTime", () => {
  const COMMIT = "GET /repos/o/r/commits/abc";

  it("parses commit.committer.date to epoch ms", async () => {
    const fake = fakeFetch({ [COMMIT]: { json: { commit: { committer: { date: "2026-10-10T19:10:30Z" } } } } }).install();
    expect(await getCommitTime("t", "o", "r", "abc")).toBe(Date.parse("2026-10-10T19:10:30Z"));
    expect(fake.calls[0].url.href).toBe("https://api.github.com/repos/o/r/commits/abc");
  });

  it("throws on a non-ok response", async () => {
    fakeFetch({ [COMMIT]: githubError(404, "Not Found") }).install();
    await expect(getCommitTime("t", "o", "r", "abc")).rejects.toThrow(/404/);
  });

  it("throws on a missing or invalid date", async () => {
    fakeFetch({
      [COMMIT]: [
        { json: { commit: { committer: null } } }, // GitHub always sends committer, but it may be null
        { json: { commit: { committer: { date: "nope" } } } },
      ],
    }).install();
    await expect(getCommitTime("t", "o", "r", "abc")).rejects.toThrow(/valid committer date/);
    await expect(getCommitTime("t", "o", "r", "abc")).rejects.toThrow(/valid committer date/);
  });

  it("throws on a fetch error", async () => {
    fakeFetch({ [COMMIT]: () => { throw new Error("net"); } }).install();
    await expect(getCommitTime("t", "o", "r", "abc")).rejects.toThrow(/net/);
  });
});

describe("getDefaultBranchFileText", () => {
  const X = "GET /repos/o/r/contents/x";

  it("decodes a base64 file and encodes each path segment", async () => {
    const fake = fakeFetch({ "GET /repos/o/r/contents/.ai-implement/my%20file%231.yml": githubFile("a: 1\n") }).install();
    expect(await getDefaultBranchFileText("t", "o", "r", ".ai-implement/my file#1.yml")).toBe("a: 1\n");
    expect(fake.calls[0].url.href).toBe("https://api.github.com/repos/o/r/contents/.ai-implement/my%20file%231.yml");
  });

  it("returns null on 404", async () => {
    fakeFetch({ [X]: githubError(404, "Not Found") }).install();
    expect(await getDefaultBranchFileText("t", "o", "r", "x")).toBeNull();
  });

  it("throws on other non-ok responses", async () => {
    fakeFetch({ [X]: githubError(500, "Server Error") }).install();
    await expect(getDefaultBranchFileText("t", "o", "r", "x")).rejects.toThrow(/500/);
  });

  it("returns null when the path is not a file", async () => {
    // GitHub answers a directory with an array of its entries, not a file object.
    fakeFetch({ [X]: { json: [{ type: "file", name: "a.yml", path: "x/a.yml" }] } }).install();
    expect(await getDefaultBranchFileText("t", "o", "r", "x")).toBeNull();
  });
});

describe("listPrComments strict option (AII-1309)", () => {
  const COMMENTS = "GET /repos/o/r/issues/5/comments";

  it("stops quietly on a non-ok response by default", async () => {
    fakeFetch({ [COMMENTS]: githubError(502, "Server Error") }).install();
    expect(await listPrComments("t", "o", "r", 5)).toEqual([]);
  });

  it.each([502, 403])("throws on a %s when strict", async (status) => {
    fakeFetch({ [COMMENTS]: githubError(status, "Request failed") }).install();
    await expect(listPrComments("t", "o", "r", 5, { strict: true })).rejects.toThrow(new RegExp(String(status)));
  });

  it("throws when strict and a later page fails", async () => {
    fakeFetch({
      [COMMENTS]: [
        { json: [{ id: 1, body: "a" }], headers: { link: '<https://api.github.com/repos/o/r/issues/5/comments?per_page=100&page=2>; rel="next"' } },
        githubError(502, "Server Error"),
      ],
    }).install();
    await expect(listPrComments("t", "o", "r", 5, { strict: true })).rejects.toThrow(/502/);
  });
});
