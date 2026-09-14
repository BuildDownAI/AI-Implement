import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  buildEnvelopeDispatchInputs,
  providerDispatchFields,
  capDispatchFields,
  branchPrefixDispatchFields,
  skillsRepoDispatchFields,
  profilesDispatchFields,
  postWorkflowDispatch,
  buildKgRefreshGhaDispatchBody,
  ENVELOPE_OPTIONAL_INPUTS,
} from "../github.js";
import { decodeRunConfig } from "../run-config.js";
import { DEFAULT_RETRY_POLICY } from "../pipeline/retry-backoff.js";
import { surfaceDispatchFailure } from "../dispatch-failure.js";
import { notify } from "../notify.js";
import type { RepoMapping } from "../config.js";
import { closeDb } from "../dedup.js";
import { initLogTable, appendLog, listLog, getJobById } from "../log.js";

// Mock notify so surfaceDispatchFailure doesn't make real HTTP calls.
vi.mock("../notify.js", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

function makeMapping(overrides: Partial<RepoMapping> = {}): RepoMapping {
  const base: RepoMapping = {
    owner: "test-org",
    repo: "test-repo",
    workflowFile: "claude-implement.yml",
    defaultBranch: "main",
    maxInProgressAiIssues: 3,
    executionMode: "github-actions",
    sessionMode: "autonomous",
    machineCpus: 2,
    machineMemoryMb: 4096,
    planningEnabled: false,
    planningWorkflowFile: "",
    autoApprovePlans: true,
    extraEnv: {},
    provider: "anthropic",
    ticketingProvider: "linear",
    ticketingConfig: { kind: "linear" },
    awsRegion: null,
    paused: false,
    maxTurns: null,
    maxIterations: null,
    maxJobMinutes: null,
    branchPrefix: null,
    skillsRepo: null,
    referenceRepos: null,
    sensitiveAddPatterns: null,
    sensitiveAllowPatterns: null,
    autoMerge: false,
    dependencyTokenScope: null,
    memoryProviderId: null,
    reviewers: null,
  };
  return {
    ...base,
    ...overrides,
    referenceRepos: overrides.referenceRepos === undefined ? base.referenceRepos : overrides.referenceRepos,
    reviewers: overrides.reviewers === undefined ? base.reviewers : overrides.reviewers,
  };
}

const baseIssue = {
  id: "issue-uuid-1",
  identifier: "AII-1",
  title: "Add login feature",
  description: "Implement login with OAuth",
};

// ---------- Case (a): Envelope mode dispatch shape ----------

describe("buildEnvelopeDispatchInputs — envelope shape (case a)", () => {
  it("contains run_config + run_token + run_progress_token and no legacy fields", () => {
    const mapping = makeMapping();
    const inputs = buildEnvelopeDispatchInputs(mapping, baseIssue, {
      retryPolicy: null,
      runnerPhase: "implementation",
      runToken: "tok-abc",
      runProgressToken: "prog-xyz",
    });

    // Envelope contract: only these keys expected for a minimal anthropic mapping
    expect(inputs.run_config).toBeDefined();
    expect(inputs.run_token).toBe("tok-abc");
    expect(inputs.run_progress_token).toBe("prog-xyz");
    expect("run_publication_token" in inputs).toBe(false);

    // issue_identifier is a display-only duplicate of run_config.issue.identifier,
    // present on every envelope dispatch for run-name: to read (AII-656).
    expect(inputs.issue_identifier).toBe(baseIssue.identifier);

    // Legacy per-field keys must be absent
    expect("issue_id" in inputs).toBe(false);
    expect("issue_title" in inputs).toBe(false);
    expect("issue_description" in inputs).toBe(false);
    expect("base_branch" in inputs).toBe(false);
    expect("max_turns" in inputs).toBe(false);
    expect("max_iterations" in inputs).toBe(false);
    expect("branch_prefix" in inputs).toBe(false);
    expect("skills_repo" in inputs).toBe(false);
    expect("profiles" in inputs).toBe(false);
    expect("runner_phase" in inputs).toBe(false);
    expect("runner_callback_url" in inputs).toBe(false);

    // Provider not included for anthropic
    expect("provider" in inputs).toBe(false);
    expect("aws_region" in inputs).toBe(false);
  });

  it("carries issue_identifier for a gap-analysis dispatch", () => {
    const inputs = buildEnvelopeDispatchInputs(makeMapping(), baseIssue, {
      retryPolicy: null,
      runnerPhase: "gap-analysis",
      prNumber: "42",
      runToken: "",
      runProgressToken: "",
    });

    expect(inputs.issue_identifier).toBe(baseIssue.identifier);
  });

  it("includes a dedicated publication token only when explicitly provided", () => {
    const inputs = buildEnvelopeDispatchInputs(makeMapping(), baseIssue, {
      retryPolicy: null,
      runnerPhase: "implementation",
      runToken: "result-token",
      runProgressToken: "progress-token",
      runPublicationToken: "publication-token",
    });

    expect(inputs.run_publication_token).toBe("publication-token");
  });

  it("decodes run_config back to original issue fields and runnerPhase", () => {
    const mapping = makeMapping();
    const inputs = buildEnvelopeDispatchInputs(mapping, baseIssue, {
      retryPolicy: null,
      runnerPhase: "implementation",
      runToken: "tok-abc",
      runProgressToken: "prog-xyz",
      runnerCallbackUrl: "https://orch.example/runner",
    });

    const decoded = decodeRunConfig(inputs.run_config!);
    expect(decoded.issue.id).toBe("issue-uuid-1");
    expect(decoded.issue.identifier).toBe("AII-1");
    expect(decoded.issue.title).toBe("Add login feature");
    expect(decoded.issue.description).toBe("Implement login with OAuth");
    expect(decoded.runnerPhase).toBe("implementation");
    expect(decoded.runnerCallbackUrl).toBe("https://orch.example/runner");
  });

  it("includes caps and branchPrefix inside run_config when set on mapping", () => {
    const mapping = makeMapping({
      maxTurns: 30,
      maxIterations: 2,
      maxJobMinutes: 60,
      branchPrefix: "pr",
      skillsRepo: "org/skills",
    });
    const inputs = buildEnvelopeDispatchInputs(mapping, baseIssue, {
      retryPolicy: null,
      runnerPhase: "implementation",
      runToken: "",
      runProgressToken: "",
    });

    // Caps ride inside run_config
    const decoded = decodeRunConfig(inputs.run_config!);
    expect(decoded.maxTurns).toBe(30);
    expect(decoded.maxIterations).toBe(2);
    expect(decoded.branchPrefix).toBe("pr");
    expect(decoded.skillsRepo).toBe("org/skills");

    // job_timeout_minutes stays as top-level pass-through
    expect(inputs.job_timeout_minutes).toBe("60");

    // Legacy cap inputs absent
    expect("max_turns" in inputs).toBe(false);
    expect("max_iterations" in inputs).toBe(false);
    expect("branch_prefix" in inputs).toBe(false);
    expect("skills_repo" in inputs).toBe(false);
  });

  it("puts baseBranch inside run_config (not as base_branch top-level input)", () => {
    const mapping = makeMapping();
    const inputs = buildEnvelopeDispatchInputs(mapping, baseIssue, {
      retryPolicy: null,
      runnerPhase: "implementation",
      baseBranch: "ai-implement/feature/eng-42",
      runToken: "",
      runProgressToken: "",
    });

    const decoded = decodeRunConfig(inputs.run_config!);
    expect(decoded.baseBranch).toBe("ai-implement/feature/eng-42");
    expect("base_branch" in inputs).toBe(false);
  });

  it("includes provider + aws_region for bedrock mappings", () => {
    const mapping = makeMapping({ provider: "bedrock", awsRegion: "us-east-1" });
    const inputs = buildEnvelopeDispatchInputs(mapping, baseIssue, {
      retryPolicy: null,
      runnerPhase: "implementation",
      runToken: "",
      runProgressToken: "",
    });

    expect(inputs.provider).toBe("bedrock");
    expect(inputs.aws_region).toBe("us-east-1");
  });

  it("includes runner_image when provided", () => {
    const mapping = makeMapping();
    const inputs = buildEnvelopeDispatchInputs(mapping, baseIssue, {
      retryPolicy: null,
      runnerPhase: "implementation",
      runToken: "",
      runProgressToken: "",
      runnerImage: "ghcr.io/builddownai/ai-implement-runner:next",
    });

    expect(inputs.runner_image).toBe("ghcr.io/builddownai/ai-implement-runner:next");
  });

  it("omits runner_image when not provided", () => {
    const mapping = makeMapping();
    const inputs = buildEnvelopeDispatchInputs(mapping, baseIssue, {
      retryPolicy: null,
      runnerPhase: "implementation",
      runToken: "",
      runProgressToken: "",
    });

    expect("runner_image" in inputs).toBe(false);
  });

  it("includes prNumber inside run_config when provided", () => {
    const mapping = makeMapping();
    const inputs = buildEnvelopeDispatchInputs(mapping, baseIssue, {
      retryPolicy: null,
      runnerPhase: "gap-analysis",
      prNumber: "42",
      runToken: "",
      runProgressToken: "",
    });

    const decoded = decodeRunConfig(inputs.run_config!);
    expect(decoded.prNumber).toBe("42");
    expect("pr_number" in inputs).toBe(false);
  });

  it("carries mapping reviewers inside run_config when set", () => {
    const reviewers = [
      { id: "gap-analysis", gates: true },
      { id: "code-review", gates: false },
    ];
    const mapping = makeMapping({ reviewers });
    const inputs = buildEnvelopeDispatchInputs(mapping, baseIssue, {
      retryPolicy: null,
      runnerPhase: "implementation",
      runToken: "",
      runProgressToken: "",
    });

    expect(decodeRunConfig(inputs.run_config!).reviewers).toEqual(reviewers);
  });
});

// ---------- Case (b): Legacy mode regression pin ----------

describe("legacy dispatch shape regression pin (case b)", () => {
  it("produces the exact key set for a minimal anthropic mapping (no caps, no prefix, same branch)", () => {
    const mapping = makeMapping();
    const issue = { ...baseIssue, profiles: [] as string[] };
    const baseBranch = "main"; // same as defaultBranch

    // Mirrors the inline assembly in dispatchGitHubActions for legacy mode
    const legacyInputs = {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      issue_title: issue.title,
      issue_description: issue.description || issue.title,
      runner_phase: "implementation" as const,
      ...providerDispatchFields(mapping),
      ...(baseBranch !== mapping.defaultBranch ? { base_branch: baseBranch } : {}),
      ...capDispatchFields(mapping),
      ...branchPrefixDispatchFields(mapping),
      ...skillsRepoDispatchFields(mapping),
      ...profilesDispatchFields(issue),
      runner_callback_url: "",
      run_token: "",
      run_progress_token: "",
    };

    expect(Object.keys(legacyInputs).sort()).toEqual([
      "issue_description",
      "issue_id",
      "issue_identifier",
      "issue_title",
      "run_progress_token",
      "run_token",
      "runner_callback_url",
      "runner_phase",
    ]);

    // Envelope field absent
    expect("run_config" in legacyInputs).toBe(false);
    // Provider absent for anthropic
    expect("provider" in legacyInputs).toBe(false);
    // Optional inputs absent when not set
    expect("base_branch" in legacyInputs).toBe(false);
    expect("max_turns" in legacyInputs).toBe(false);
    expect("branch_prefix" in legacyInputs).toBe(false);
    expect("skills_repo" in legacyInputs).toBe(false);
    expect("profiles" in legacyInputs).toBe(false);
  });

  it("never forwards assignee on the legacy contract, even for an assigned issue", () => {
    // Regression pin: `assignee` has never existed as a workflow_dispatch input in any
    // synced version of claude-implement.yml (unlike `profiles`, which predates the
    // envelope) — see docs/workflow-envelope.md. Forwarding it on the legacy contract
    // would 422 every dispatch for an assigned ticket, the common case. Mirrors the
    // inline assembly in dispatchGitHubActions for legacy mode.
    const mapping = makeMapping();
    const issue = { ...baseIssue, profiles: [] as string[], assigneeName: "Paz" };
    const baseBranch = "main"; // same as defaultBranch

    const legacyInputs = {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      issue_title: issue.title,
      issue_description: issue.description || issue.title,
      runner_phase: "implementation" as const,
      ...providerDispatchFields(mapping),
      ...(baseBranch !== mapping.defaultBranch ? { base_branch: baseBranch } : {}),
      ...capDispatchFields(mapping),
      ...branchPrefixDispatchFields(mapping),
      ...skillsRepoDispatchFields(mapping),
      ...profilesDispatchFields(issue),
      runner_callback_url: "",
      run_token: "",
      run_progress_token: "",
    };

    expect("assignee" in legacyInputs).toBe(false);
  });

  it("conditionally includes base_branch only when it differs from defaultBranch", () => {
    const mapping = makeMapping();
    const featureBranch = "ai-implement/feature/AII-5";
    const withBase = {
      ...(featureBranch !== mapping.defaultBranch ? { base_branch: featureBranch } : {}),
    };
    expect(withBase.base_branch).toBe(featureBranch);

    const withoutBase = {
      ...("main" !== mapping.defaultBranch ? { base_branch: "main" } : {}),
    };
    expect("base_branch" in withoutBase).toBe(false);
  });

  it("includes bedrock fields when provider=bedrock", () => {
    const mapping = makeMapping({ provider: "bedrock", awsRegion: "us-west-2" });
    const fields = providerDispatchFields(mapping);
    expect(fields.provider).toBe("bedrock");
    expect(fields.aws_region).toBe("us-west-2");
  });

  it("includes caps when set on mapping", () => {
    const mapping = makeMapping({ maxTurns: 25, maxIterations: 3, maxJobMinutes: 45 });
    const caps = capDispatchFields(mapping);
    expect(caps.max_turns).toBe("25");
    expect(caps.max_iterations).toBe("3");
    expect(caps.job_timeout_minutes).toBe("45");
  });
});

// ---------- Case (c): Planning dispatch in envelope mode ----------

describe("buildEnvelopeDispatchInputs — planning phase (case c)", () => {
  it("sets runnerPhase to planning inside run_config", () => {
    const mapping = makeMapping();
    const inputs = buildEnvelopeDispatchInputs(mapping, baseIssue, {
      retryPolicy: null,
      runnerPhase: "planning",
      runToken: "plan-tok",
    });

    const decoded = decodeRunConfig(inputs.run_config!);
    expect(decoded.runnerPhase).toBe("planning");
  });

  it("does not include run_progress_token (planning has no progress token)", () => {
    const mapping = makeMapping();
    const inputs = buildEnvelopeDispatchInputs(mapping, baseIssue, {
      retryPolicy: null,
      runnerPhase: "planning",
      runToken: "plan-tok",
      // runProgressToken deliberately omitted
    });

    expect("run_progress_token" in inputs).toBe(false);
  });

  it("never includes a publication token for planning", () => {
    const inputs = buildEnvelopeDispatchInputs(makeMapping(), baseIssue, {
      retryPolicy: null,
      runnerPhase: "planning",
      runToken: "plan-token",
      runPublicationToken: "must-not-leak",
    });

    expect("run_publication_token" in inputs).toBe(false);
  });

  it("still includes run_token for callback auth", () => {
    const mapping = makeMapping();
    const inputs = buildEnvelopeDispatchInputs(mapping, baseIssue, {
      retryPolicy: null,
      runnerPhase: "planning",
      runToken: "plan-tok",
    });

    expect(inputs.run_token).toBe("plan-tok");
  });

  it("carries issue_identifier for a planning dispatch", () => {
    const mapping = makeMapping();
    const inputs = buildEnvelopeDispatchInputs(mapping, baseIssue, {
      retryPolicy: null,
      runnerPhase: "planning",
      runToken: "plan-tok",
    });

    expect(inputs.issue_identifier).toBe(baseIssue.identifier);
  });
});

// ---------- Case (c2): dependencyTokenScope dispatch stamping ----------

describe("buildEnvelopeDispatchInputs — dependencyTokenScope stamping", () => {
  it("stamps dependencyTokenScope in run_config when mapping enables it", () => {
    const mapping = makeMapping({ dependencyTokenScope: "installation" });
    const inputs = buildEnvelopeDispatchInputs(mapping, baseIssue, {
      retryPolicy: null,
      runnerPhase: "implementation",
      runToken: "",
      runProgressToken: "",
    });

    const decoded = decodeRunConfig(inputs.run_config!);
    expect(decoded.dependencyTokenScope).toBe("installation");
  });

  it("omits dependencyTokenScope from run_config when mapping has null", () => {
    const mapping = makeMapping({ dependencyTokenScope: null });
    const inputs = buildEnvelopeDispatchInputs(mapping, baseIssue, {
      retryPolicy: null,
      runnerPhase: "implementation",
      runToken: "",
      runProgressToken: "",
    });

    const decoded = decodeRunConfig(inputs.run_config!);
    expect(decoded.dependencyTokenScope).toBeUndefined();
    expect("dependencyTokenScope" in decoded).toBe(false);
  });

  it("does not stamp dependencyTokenScope for planning dispatch", () => {
    const mapping = makeMapping({ dependencyTokenScope: "installation" });
    const inputs = buildEnvelopeDispatchInputs(mapping, baseIssue, {
      retryPolicy: null,
      runnerPhase: "planning",
      runToken: "plan-tok",
    });

    const decoded = decodeRunConfig(inputs.run_config!);
    expect(decoded.dependencyTokenScope).toBeUndefined();
    expect("dependencyTokenScope" in decoded).toBe(false);
  });

  it("stamps dependencyTokenScope for gap-analysis dispatch", () => {
    const mapping = makeMapping({ dependencyTokenScope: "installation" });
    const inputs = buildEnvelopeDispatchInputs(mapping, baseIssue, {
      retryPolicy: null,
      runnerPhase: "gap-analysis",
      prNumber: "99",
      runToken: "",
      runProgressToken: "",
    });

    const decoded = decodeRunConfig(inputs.run_config!);
    expect(decoded.dependencyTokenScope).toBe("installation");
  });
});

// ---------- Case (c3): retryPolicy dispatch stamping (BAC-27113) ----------

describe("buildEnvelopeDispatchInputs — retryPolicy stamping", () => {
  it("stamps retryPolicy in run_config when the caller passes it (GHA path)", () => {
    const mapping = makeMapping();
    const retryPolicy = {
      requestRetries: 2,
      stageRetries: 1,
      pushRetries: 2,
      backoffInitialMs: 30_000,
      backoffMaxMs: 300_000,
      backoffJitter: 0.2,
      reviewMaxTurns: 30,
    };
    const inputs = buildEnvelopeDispatchInputs(mapping, baseIssue, {
      runnerPhase: "implementation",
      runToken: "",
      runProgressToken: "",
      retryPolicy,
    });

    const decoded = decodeRunConfig(inputs.run_config!);
    expect(decoded.retryPolicy).toEqual(retryPolicy);
  });

  it("falls back to DEFAULT_RETRY_POLICY when the caller passes null (implementation/gap-analysis always carry it)", () => {
    const mapping = makeMapping();
    const inputs = buildEnvelopeDispatchInputs(mapping, baseIssue, {
      retryPolicy: null,
      runnerPhase: "implementation",
      runToken: "",
      runProgressToken: "",
    });

    const decoded = decodeRunConfig(inputs.run_config!);
    expect(decoded.retryPolicy).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("stamps DEFAULT_RETRY_POLICY for gap-analysis when the caller passes null", () => {
    const mapping = makeMapping();
    const inputs = buildEnvelopeDispatchInputs(mapping, baseIssue, {
      retryPolicy: null,
      runnerPhase: "gap-analysis",
      prNumber: "99",
      runToken: "",
      runProgressToken: "",
    });

    const decoded = decodeRunConfig(inputs.run_config!);
    expect(decoded.retryPolicy).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("stamps a custom retryPolicy for the review-fix re-dispatch shape (gap-analysis + prNumber, BAC-27135)", () => {
    const mapping = makeMapping();
    const retryPolicy = { ...DEFAULT_RETRY_POLICY, reviewMaxTurns: 77 };
    const inputs = buildEnvelopeDispatchInputs(mapping, baseIssue, {
      runnerPhase: "gap-analysis",
      prNumber: "42",
      runToken: "",
      runProgressToken: "",
      retryPolicy,
    });

    const decoded = decodeRunConfig(inputs.run_config!);
    expect(decoded.retryPolicy).toEqual(retryPolicy);
  });

  it("never stamps retryPolicy for planning (no retry loop)", () => {
    const inputs = buildEnvelopeDispatchInputs(makeMapping(), baseIssue, {
      retryPolicy: null,
      runnerPhase: "planning",
      runToken: "plan-tok",
    });

    const decoded = decodeRunConfig(inputs.run_config!);
    expect(decoded.retryPolicy).toBeUndefined();
    expect("retryPolicy" in decoded).toBe(false);
  });

  it("never stamps retryPolicy for kg-refresh, even when a policy is passed (no retry loop)", () => {
    const inputs = buildEnvelopeDispatchInputs(makeMapping(), baseIssue, {
      retryPolicy: { ...DEFAULT_RETRY_POLICY, reviewMaxTurns: 77 },
      runnerPhase: "kg-refresh",
      runToken: "kg-tok",
    });

    const decoded = decodeRunConfig(inputs.run_config!);
    expect(decoded.retryPolicy).toBeUndefined();
    expect("retryPolicy" in decoded).toBe(false);
  });
});

// ---------- Case (d): 422 surfacing ----------
// Uses a real SQLite DB (dedup singleton) and a mocked notify so we can
// assert on calls without making real HTTP requests.
//
// DB_PATH in dedup.ts is a module-level constant computed at import time, so
// env-var changes per-test have no effect. All tests in this file write to the
// same DB. We use a run-level random ID so issueIds are unique per execution
// and filter-based assertions never see entries from previous runs.

const SURF_RUN = Math.random().toString(36).slice(2, 10);

let dbPath: string;

function freshDb(label: string): string {
  return path.join(
    os.tmpdir(),
    `gh-dispatch-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
}

describe("surfaceDispatchFailure — 422 surfacing (case d)", () => {
  beforeEach(() => {
    vi.mocked(notify).mockClear();
    initLogTable();
  });

  it("writes a dispatch-failed log entry with contract when dispatch returns 422", async () => {
    const issueId = `${SURF_RUN}-d1`;
    await surfaceDispatchFailure(
      { status: 422, error: "Unprocessable Entity" },
      "slack",
      null, // no webhook — skip notify
      {
        site: "poll",
        issueId,
        issueIdentifier: "AII-42",
        issueTitle: "Test issue",
        repo: "test-org/test-repo",
        workflowFile: "claude-implement.yml",
        contract: "legacy",
        phase: "implementation",
      },
    );

    const jobs = listLog({ limit: 500 });
    const mine = jobs.filter((j) => j.issueId === issueId);
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe("dispatch-failed");
    expect(mine[0].contract).toBe("legacy");
    expect(mine[0].issueIdentifier).toBe("AII-42");
  });

  it("records contract=envelope when envelope mode failed", async () => {
    const issueId = `${SURF_RUN}-d2`;
    await surfaceDispatchFailure(
      { status: 422, error: "Unprocessable Entity" },
      "slack",
      null,
      {
        site: "poll",
        issueId,
        issueIdentifier: "AII-43",
        repo: "test-org/test-repo",
        workflowFile: "claude-implement.yml",
        contract: "envelope",
      },
    );

    const jobs = listLog({ limit: 500 });
    const mine = jobs.filter((j) => j.issueId === issueId);
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe("dispatch-failed");
    expect(mine[0].contract).toBe("envelope");
  });

  it("calls notify with dispatch-failed phase, repoFullName, workflowFile, and re-sync hint for 422", async () => {
    await surfaceDispatchFailure(
      { status: 422, error: "Unprocessable Entity" },
      "slack",
      "https://hooks.slack.com/test",
      {
        site: "poll",
        issueId: `${SURF_RUN}-d3`,
        issueIdentifier: "AII-44",
        issueTitle: "Test",
        repo: "test-org/test-repo",
        workflowFile: "claude-implement.yml",
        contract: "legacy",
      },
    );

    expect(notify).toHaveBeenCalledOnce();
    const [, , notification] = vi.mocked(notify).mock.calls[0];
    expect(notification.phase).toBe("dispatch-failed");
    expect(notification.repoFullName).toBe("test-org/test-repo");
    expect(notification.workflowFile).toBe("claude-implement.yml");
    expect(notification.hint).toMatch(/re-sync/i);
  });

  it("does not call notify when webhookUrl is null", async () => {
    const issueId = `${SURF_RUN}-d4`;
    await surfaceDispatchFailure(
      { status: 422, error: "Unprocessable Entity" },
      "slack",
      null, // no webhook
      {
        site: "poll",
        issueId,
        issueIdentifier: "AII-45",
        repo: "test-org/test-repo",
        workflowFile: "claude-implement.yml",
        contract: "legacy",
      },
    );

    expect(notify).not.toHaveBeenCalled();
    // Log entry still written
    const jobs = listLog({ limit: 500 });
    const mine = jobs.filter((j) => j.issueId === issueId);
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe("dispatch-failed");
  });

  it("notifies for non-422 failures (e.g. 500) without the re-sync hint", async () => {
    await surfaceDispatchFailure(
      { status: 500, error: "Internal Server Error" },
      "slack",
      "https://hooks.slack.com/test",
      {
        site: "poll",
        issueId: `${SURF_RUN}-d5`,
        issueIdentifier: "AII-46",
        repo: "test-org/test-repo",
        workflowFile: "claude-implement.yml",
        contract: "legacy",
      },
    );

    expect(notify).toHaveBeenCalledOnce();
    const [, , notification] = vi.mocked(notify).mock.calls[0];
    expect(notification.phase).toBe("dispatch-failed");
    expect(notification.hint).toBeUndefined();
  });
});

// ---------- appendLog: contract + status persistence ----------

describe("appendLog with status and contract fields", () => {
  beforeEach(() => {
    closeDb(); // ensure previous connection closed before switching DB path
    dbPath = freshDb("log");
    process.env.DEDUP_DB_PATH = dbPath;
    initLogTable();
  });

  afterEach(() => {
    closeDb();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("stores status='dispatch-failed' and contract='legacy' when explicitly set", () => {
    const id = appendLog({
      issueId: "i1",
      status: "dispatch-failed",
      contract: "legacy",
    });
    const job = getJobById(id);
    expect(job?.status).toBe("dispatch-failed");
    expect(job?.contract).toBe("legacy");
  });

  it("stores contract='envelope' when set", () => {
    const id = appendLog({ issueId: "i2", contract: "envelope" });
    expect(getJobById(id)?.contract).toBe("envelope");
  });

  it("defaults status to dispatched when not specified", () => {
    const id = appendLog({ issueId: "i3" });
    expect(getJobById(id)?.status).toBe("dispatched");
  });

  it("defaults contract to null when not specified", () => {
    const id = appendLog({ issueId: "i4" });
    expect(getJobById(id)?.contract).toBeNull();
  });

  it("ensureLogColumns is idempotent (contract column added twice is safe)", () => {
    // initLogTable calls ensureLogColumns internally — call it again to verify idempotency
    expect(() => initLogTable()).not.toThrow();
    const id = appendLog({ issueId: "i5", contract: "envelope" });
    expect(getJobById(id)?.contract).toBe("envelope");
  });
});

// ---------- Case (e): postWorkflowDispatch — 422 strip-and-retry (AII-654) ----------
// Pattern anchor: Cloudshare fork commits 31f3979 and dfb461d (dispatchWorkflow 422 retry
// for issue_identifier); the existing base_branch 422 attribution in src/index.ts:985-996.

describe("postWorkflowDispatch — 422 strip-and-retry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function textResponse(status: number, body: string | null): Response {
    return new Response(body, { status });
  }

  it("exposes exactly runner_phase, runner_callback_url, and issue_identifier as the optional-input list", () => {
    expect(ENVELOPE_OPTIONAL_INPUTS).toEqual(["runner_phase", "runner_callback_url", "issue_identifier"]);
  });

  it("strips a single optional input named in the 422 body and retries once", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse(422, 'Unexpected inputs provided: ["runner_phase"]'))
      .mockResolvedValueOnce(textResponse(204, null));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postWorkflowDispatch({
      token: "tok",
      owner: "acme",
      repo: "kg-repo",
      workflowFile: "claude-implement.yml",
      ref: "main",
      inputs: { run_config: "cfg", run_token: "rt", runner_phase: "kg-refresh" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect("runner_phase" in secondBody.inputs).toBe(false);
    expect(secondBody.inputs.run_config).toBe("cfg");
    expect(result).toEqual({ success: true, status: 204 });
  });

  it("strips issue_identifier alone when the 422 names it on the envelope contract", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse(422, 'Unexpected inputs provided: ["issue_identifier"]'))
      .mockResolvedValueOnce(textResponse(204, null));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postWorkflowDispatch({
      token: "tok",
      owner: "acme",
      repo: "impl-repo",
      workflowFile: "claude-implement.yml",
      ref: "main",
      inputs: { run_config: "cfg", run_token: "rt", issue_identifier: "AII-656" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect("issue_identifier" in secondBody.inputs).toBe(false);
    expect(secondBody.inputs.run_config).toBe("cfg");
    expect(result).toEqual({ success: true, status: 204 });
  });

  it("does not retry on the legacy contract (no run_config) when the 422 names issue_identifier", async () => {
    // issue_identifier is authoritative issue data on the legacy contract, not a
    // compatibility duplicate, so stripping it there must not happen.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse(422, 'Unexpected inputs provided: ["issue_identifier"]'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postWorkflowDispatch({
      token: "tok",
      owner: "acme",
      repo: "legacy-repo",
      workflowFile: "claude-implement.yml",
      ref: "main",
      inputs: {
        issue_id: "1",
        issue_identifier: "AII-1",
        issue_title: "t",
        issue_description: "d",
        runner_phase: "implementation",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
  });

  it("strips both runner_phase and runner_callback_url when the 422 names both", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse(422, 'Unexpected inputs provided: ["runner_phase", "runner_callback_url"]'))
      .mockResolvedValueOnce(textResponse(204, null));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postWorkflowDispatch({
      token: "tok",
      owner: "acme",
      repo: "kg-repo",
      workflowFile: "claude-implement.yml",
      ref: "main",
      inputs: {
        run_config: "cfg",
        run_token: "rt",
        runner_phase: "kg-refresh",
        runner_callback_url: "https://orch.example",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect("runner_phase" in secondBody.inputs).toBe(false);
    expect("runner_callback_url" in secondBody.inputs).toBe(false);
    expect(result.success).toBe(true);
  });

  it("does not retry when the 422 names an input outside ENVELOPE_OPTIONAL_INPUTS", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse(422, 'Unexpected inputs provided: ["base_branch"]'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postWorkflowDispatch({
      token: "tok",
      owner: "acme",
      repo: "kg-repo",
      workflowFile: "claude-implement.yml",
      ref: "main",
      inputs: { run_config: "cfg", run_token: "rt", base_branch: "main" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: false, status: 422, error: 'Unexpected inputs provided: ["base_branch"]' });
  });

  it("does not retry on the legacy contract (no run_config), even when the 422 names runner_phase", async () => {
    // Mirrors src/index.ts:985-996's guard: runner_phase is authoritative issue data on the
    // legacy contract, not a compatibility duplicate, so stripping it there must not happen.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse(422, 'Unexpected inputs provided: ["runner_phase"]'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postWorkflowDispatch({
      token: "tok",
      owner: "acme",
      repo: "legacy-repo",
      workflowFile: "claude-implement.yml",
      ref: "main",
      inputs: {
        issue_id: "1",
        issue_identifier: "AII-1",
        issue_title: "t",
        issue_description: "d",
        runner_phase: "implementation",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
  });

  it("a retry that 422s again returns failure with exactly 2 fetches (no loop)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse(422, 'Unexpected inputs provided: ["runner_phase"]'))
      .mockResolvedValueOnce(textResponse(422, 'Unexpected inputs provided: ["runner_phase"]'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postWorkflowDispatch({
      token: "tok",
      owner: "acme",
      repo: "kg-repo",
      workflowFile: "claude-implement.yml",
      ref: "main",
      inputs: { run_config: "cfg", run_token: "rt", runner_phase: "kg-refresh" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.status).toBe(422);
  });

  it("a second 422 naming a *different* optional input still returns failure with exactly 2 fetches (no third request)", async () => {
    // Reproduces the bug the "repeats the already-removed name" test above cannot catch:
    // the first 422 names runner_phase, the retry's own 422 names the *other* optional input,
    // runner_callback_url (still present in the stripped payload). The retry must be returned
    // as failure unconditionally rather than triggering a third request.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse(422, 'Unexpected inputs provided: ["runner_phase"]'))
      .mockResolvedValueOnce(textResponse(422, 'Unexpected inputs provided: ["runner_callback_url"]'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postWorkflowDispatch({
      token: "tok",
      owner: "acme",
      repo: "kg-repo",
      workflowFile: "claude-implement.yml",
      ref: "main",
      inputs: {
        run_config: "cfg",
        run_token: "rt",
        runner_phase: "kg-refresh",
        runner_callback_url: "https://orch.example",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect("runner_phase" in secondBody.inputs).toBe(false);
    expect("runner_callback_url" in secondBody.inputs).toBe(true);
    expect(result).toEqual({
      success: false,
      status: 422,
      error: 'Unexpected inputs provided: ["runner_callback_url"]',
    });
  });

  it("does not strip on a prefix collision (rejected name is a superstring of an optional input)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse(422, 'Unexpected inputs provided: ["runner_phase_extra"]'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postWorkflowDispatch({
      token: "tok",
      owner: "acme",
      repo: "kg-repo",
      workflowFile: "claude-implement.yml",
      ref: "main",
      inputs: { run_config: "cfg", run_token: "rt", runner_phase: "kg-refresh" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: false, status: 422, error: 'Unexpected inputs provided: ["runner_phase_extra"]' });
  });

  it("does not strip on a suffix collision (rejected name is a superstring of an optional input)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse(422, 'Unexpected inputs provided: ["extra_runner_callback_url"]'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postWorkflowDispatch({
      token: "tok",
      owner: "acme",
      repo: "kg-repo",
      workflowFile: "claude-implement.yml",
      ref: "main",
      inputs: {
        run_config: "cfg",
        run_token: "rt",
        runner_callback_url: "https://orch.example",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: false,
      status: 422,
      error: 'Unexpected inputs provided: ["extra_runner_callback_url"]',
    });
  });

  it("still matches a fully-qualified input name inside a rejection naming several other inputs", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse(422, 'Unexpected inputs provided: ["base_branch", "runner_phase", "issue_identifier"]'))
      .mockResolvedValueOnce(textResponse(204, null));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postWorkflowDispatch({
      token: "tok",
      owner: "acme",
      repo: "kg-repo",
      workflowFile: "claude-implement.yml",
      ref: "main",
      inputs: { run_config: "cfg", run_token: "rt", runner_phase: "kg-refresh" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect("runner_phase" in secondBody.inputs).toBe(false);
    expect(result.success).toBe(true);
  });

  it("parses GitHub's actual JSON error response (escaped quotes in the message field)", async () => {
    const ghJsonBody = JSON.stringify({
      message: 'Unexpected inputs provided: ["runner_phase", "runner_callback_url"]',
      documentation_url: "https://docs.github.com/rest/actions/workflows#create-a-workflow-dispatch-event",
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse(422, ghJsonBody))
      .mockResolvedValueOnce(textResponse(204, null));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postWorkflowDispatch({
      token: "tok",
      owner: "acme",
      repo: "kg-repo",
      workflowFile: "claude-implement.yml",
      ref: "main",
      inputs: {
        run_config: "cfg",
        run_token: "rt",
        runner_phase: "kg-refresh",
        runner_callback_url: "https://orch.example",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect("runner_phase" in secondBody.inputs).toBe(false);
    expect("runner_callback_url" in secondBody.inputs).toBe(false);
    expect(result).toEqual({ success: true, status: 204 });
  });

  it("matches the unexpected-inputs marker case-insensitively", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse(422, 'UNEXPECTED INPUTS PROVIDED: ["runner_phase"]'))
      .mockResolvedValueOnce(textResponse(204, null));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postWorkflowDispatch({
      token: "tok",
      owner: "acme",
      repo: "kg-repo",
      workflowFile: "claude-implement.yml",
      ref: "main",
      inputs: { run_config: "cfg", run_token: "rt", runner_phase: "kg-refresh" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
  });

  it("does not retry when run_config is an empty string (legacy-shaped envelope guard)", async () => {
    // run_config: "" must not satisfy the envelope guard — an empty string is falsy data,
    // not evidence the caller is on the envelope contract, and runner_phase must stay
    // authoritative for whatever contract actually sent an empty run_config.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse(422, 'Unexpected inputs provided: ["runner_phase"]'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postWorkflowDispatch({
      token: "tok",
      owner: "acme",
      repo: "legacy-ish-repo",
      workflowFile: "claude-implement.yml",
      ref: "main",
      inputs: { run_config: "", run_token: "rt", runner_phase: "implementation" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
  });

  it("does not retry on a non-422 failure", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(textResponse(500, "Internal Server Error"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postWorkflowDispatch({
      token: "tok",
      owner: "acme",
      repo: "kg-repo",
      workflowFile: "claude-implement.yml",
      ref: "main",
      inputs: { run_config: "cfg", run_token: "rt", runner_phase: "kg-refresh" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: false, status: 500, error: "Internal Server Error" });
  });

  it("the kg-refresh dispatch path (buildKgRefreshGhaDispatchBody + postWorkflowDispatch) retries on 422", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse(422, 'Unexpected inputs provided: ["runner_phase", "runner_callback_url"]'))
      .mockResolvedValueOnce(textResponse(204, null));
    vi.stubGlobal("fetch", fetchMock);

    const inputs = buildKgRefreshGhaDispatchBody({
      runConfig: "b64cfg",
      runToken: "run-tok",
      runProgressToken: "prog-tok",
      runnerImage: undefined,
      runnerCallbackUrl: "https://orch.example",
      runnerPhase: "kg-refresh",
      jobTimeoutMinutes: "240",
      issueIdentifier: "AII-656",
    });

    expect(inputs.issue_identifier).toBe("AII-656");

    const result = await postWorkflowDispatch({
      token: "gh-tok",
      owner: "acme",
      repo: "kg-repo",
      workflowFile: "claude-implement.yml",
      ref: "main",
      inputs,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect("runner_phase" in secondBody.inputs).toBe(false);
    expect("runner_callback_url" in secondBody.inputs).toBe(false);
    expect(secondBody.inputs.run_config).toBe("b64cfg");
    expect(secondBody.inputs.job_timeout_minutes).toBe("240");
    expect(secondBody.inputs.issue_identifier).toBe("AII-656");
    expect(result).toEqual({ success: true, status: 204 });
  });
});
