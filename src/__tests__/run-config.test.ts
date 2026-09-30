import { describe, expect, it, vi } from "vitest";
import {
  encodeRunConfig,
  decodeRunConfig,
  runConfigFromTaskDocument,
  buildImplRunConfig,
  type RunConfigV1,
  type TaskDocumentParams,
} from "../run-config.js";
import { DEFAULT_RETRY_POLICY } from "../pipeline/retry-backoff.js";
import type { RepoMapping, ReviewerSelection } from "../config.js";

const full: RunConfigV1 = {
  v: 1,
  issue: { id: "uuid-1", identifier: "AII-1", title: "T", description: "multi\nline ünicode" },
  prNumber: "42",
  baseBranch: "main",
  runnerPhase: "implementation",
  branchPrefix: "pr",
  skillsRepo: "org/skills",
  runnerCallbackUrl: "https://orch.example/runner",
  maxTurns: 50,
  maxIterations: 3,
  commentInstruction: "do the thing",
  sensitiveFiles: { add: ["*.secrets.toml"], allow: [".env", ".env.*"] },
  profiles: ["backend", "webapp"],
  planningContext: { parent: "- AII-0: parent", siblings: "None", dependencies: "- [related] AII-2: dep" },
  dependencyTokenScope: "installation",
  reviewers: [
    { id: "gap-analysis", gates: true },
    { id: "code-review", gates: false },
  ],
  retryPolicy: { ...DEFAULT_RETRY_POLICY, stageRetries: 0 },
};

describe("run-config envelope", () => {
  it("round-trips a full config", () => {
    expect(decodeRunConfig(encodeRunConfig(full))).toEqual(full);
  });
  it("round-trips a minimal config", () => {
    const min: RunConfigV1 = { v: 1, issue: { id: "i", identifier: "AII-2", title: "t", description: "" } };
    expect(decodeRunConfig(encodeRunConfig(min))).toEqual(min);
  });
  it("ignores unknown keys (forward compat)", () => {
    const withExtra = { ...full, futureField: { nested: true } };
    const b64 = Buffer.from(JSON.stringify(withExtra), "utf-8").toString("base64");
    expect(decodeRunConfig(b64).issue.identifier).toBe("AII-1");
  });
  it("throws on unsupported version", () => {
    const b64 = Buffer.from(JSON.stringify({ ...full, v: 2 }), "utf-8").toString("base64");
    expect(() => decodeRunConfig(b64)).toThrow(/unsupported run_config version/i);
  });
  it("throws on malformed base64/JSON and on missing issue block", () => {
    expect(() => decodeRunConfig("not-base64!!!")).toThrow();
    const noIssue = Buffer.from(JSON.stringify({ v: 1 }), "utf-8").toString("base64");
    expect(() => decodeRunConfig(noIssue)).toThrow(/issue/i);
  });
  it("truncates oversized descriptions with a marker", () => {
    const big = { ...full, issue: { ...full.issue, description: "x".repeat(60_000) } };
    const decoded = decodeRunConfig(encodeRunConfig(big));
    expect(decoded.issue.description.length).toBeLessThanOrEqual(40_000 + 100);
    expect(decoded.issue.description).toContain("[truncated by ai-implement");
  });

  it("round-trips profiles", () => {
    const cfg: RunConfigV1 = {
      v: 1,
      issue: { id: "i", identifier: "AII-2", title: "t", description: "" },
      profiles: ["backend", "webapp"],
    };
    expect(decodeRunConfig(encodeRunConfig(cfg)).profiles).toEqual(["backend", "webapp"]);
  });

  it("round-trips planningContext", () => {
    const cfg: RunConfigV1 = {
      v: 1,
      issue: { id: "i", identifier: "AII-2", title: "t", description: "" },
      planningContext: { parent: "- AII-1: parent", siblings: "None", dependencies: "None" },
    };
    expect(decodeRunConfig(encodeRunConfig(cfg)).planningContext).toEqual({
      parent: "- AII-1: parent",
      siblings: "None",
      dependencies: "None",
    });
  });

  it("pickKnownKeys preserves profiles and planningContext", () => {
    const withExtra = {
      ...full,
      futureField: "ignored",
    };
    const b64 = Buffer.from(JSON.stringify(withExtra), "utf-8").toString("base64");
    const decoded = decodeRunConfig(b64);
    expect(decoded.profiles).toEqual(["backend", "webapp"]);
    expect(decoded.planningContext).toEqual({ parent: "- AII-0: parent", siblings: "None", dependencies: "- [related] AII-2: dep" });
    expect((decoded as unknown as Record<string, unknown>).futureField).toBeUndefined();
  });

  it("handles empty profiles array and absent planningContext", () => {
    const cfg: RunConfigV1 = {
      v: 1,
      issue: { id: "i", identifier: "AII-2", title: "t", description: "" },
      profiles: [],
    };
    const decoded = decodeRunConfig(encodeRunConfig(cfg));
    expect(decoded.profiles).toEqual([]);
    expect(decoded.planningContext).toBeUndefined();
  });

  it("absent profiles and planningContext decode as undefined", () => {
    const min: RunConfigV1 = { v: 1, issue: { id: "i", identifier: "AII-2", title: "t", description: "" } };
    const decoded = decodeRunConfig(encodeRunConfig(min));
    expect(decoded.profiles).toBeUndefined();
    expect(decoded.planningContext).toBeUndefined();
  });

  it("round-trips dependencyTokenScope: installation", () => {
    const cfg: RunConfigV1 = {
      v: 1,
      issue: { id: "i", identifier: "AII-3", title: "t", description: "" },
      dependencyTokenScope: "installation",
    };
    expect(decodeRunConfig(encodeRunConfig(cfg)).dependencyTokenScope).toBe("installation");
  });

  it("absent dependencyTokenScope decodes as undefined (no key materialized)", () => {
    const min: RunConfigV1 = { v: 1, issue: { id: "i", identifier: "AII-4", title: "t", description: "" } };
    const decoded = decodeRunConfig(encodeRunConfig(min));
    expect(decoded.dependencyTokenScope).toBeUndefined();
    expect("dependencyTokenScope" in decoded).toBe(false);
  });

  it("pickKnownKeys preserves dependencyTokenScope and drops bogus extra keys", () => {
    const withExtra = { ...full, bogusKey: "dropped" };
    const b64 = Buffer.from(JSON.stringify(withExtra), "utf-8").toString("base64");
    const decoded = decodeRunConfig(b64);
    expect(decoded.dependencyTokenScope).toBe("installation");
    expect((decoded as unknown as Record<string, unknown>).bogusKey).toBeUndefined();
  });

  it("round-trips retryPolicy", () => {
    const cfg: RunConfigV1 = {
      v: 1,
      issue: { id: "i", identifier: "AII-5", title: "t", description: "" },
      retryPolicy: { ...DEFAULT_RETRY_POLICY, reviewMaxTurns: 60 },
    };
    expect(decodeRunConfig(encodeRunConfig(cfg)).retryPolicy).toEqual({
      ...DEFAULT_RETRY_POLICY,
      reviewMaxTurns: 60,
    });
  });

  it("absent retryPolicy decodes as undefined (no key materialized)", () => {
    const min: RunConfigV1 = { v: 1, issue: { id: "i", identifier: "AII-6", title: "t", description: "" } };
    const decoded = decodeRunConfig(encodeRunConfig(min));
    expect(decoded.retryPolicy).toBeUndefined();
    expect("retryPolicy" in decoded).toBe(false);
  });

  it("round-trips reviewers through pickKnownKeys", () => {
    const reviewers: ReviewerSelection[] = [
      { id: "gap-analysis", gates: true, maxTurns: 45 },
      { id: "custom", gates: false },
    ];
    const withExtra = { ...full, reviewers, bogusKey: "dropped" };
    const b64 = Buffer.from(JSON.stringify(withExtra), "utf-8").toString("base64");
    const decoded = decodeRunConfig(b64);
    expect(decoded.reviewers).toEqual(reviewers);
    expect((decoded as unknown as Record<string, unknown>).bogusKey).toBeUndefined();
  });

  it("drops malformed reviewers during decode instead of rejecting the envelope", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const withMalformedReviewers = { ...full, reviewers: [{ id: "gap-analysis", gates: "yes" }] };
      const b64 = Buffer.from(JSON.stringify(withMalformedReviewers), "utf-8").toString("base64");
      const decoded = decodeRunConfig(b64);
      expect(decoded.issue.identifier).toBe("AII-1");
      expect(decoded.reviewers).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("reviewers"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  const validReviewFix: RunConfigV1["reviewFix"] = {
    version: 1,
    attemptId: "attempt-1",
    installationId: 123,
    repository: "acme/widgets",
    prNumber: 42,
    deadlineAt: Date.parse("2026-01-01T00:00:00.000Z"),
  };

  it("round-trips reviewFix", () => {
    const cfg: RunConfigV1 = {
      v: 1,
      issue: { id: "i", identifier: "AII-776", title: "t", description: "" },
      reviewFix: validReviewFix,
    };
    expect(decodeRunConfig(encodeRunConfig(cfg)).reviewFix).toEqual(validReviewFix);
  });

  it("absent reviewFix decodes as undefined (no key materialized)", () => {
    const min: RunConfigV1 = { v: 1, issue: { id: "i", identifier: "AII-776", title: "t", description: "" } };
    const decoded = decodeRunConfig(encodeRunConfig(min));
    expect(decoded.reviewFix).toBeUndefined();
    expect("reviewFix" in decoded).toBe(false);
  });

  it("pickKnownKeys preserves reviewFix and drops unrelated unknown keys in the same payload", () => {
    const withExtra = { ...full, reviewFix: validReviewFix, bogusKey: "dropped" };
    const b64 = Buffer.from(JSON.stringify(withExtra), "utf-8").toString("base64");
    const decoded = decodeRunConfig(b64);
    expect(decoded.reviewFix).toEqual(validReviewFix);
    expect((decoded as unknown as Record<string, unknown>).bogusKey).toBeUndefined();
  });

  it("throws (fails closed) on malformed or unsupported reviewFix instead of dropping it", () => {
    const cases: Array<[string, unknown]> = [
      ["version not 1", { ...validReviewFix, version: 2 }],
      ["missing attemptId", { ...validReviewFix, attemptId: undefined }],
      ["empty attemptId", { ...validReviewFix, attemptId: "" }],
      ["non-integer installationId", { ...validReviewFix, installationId: 1.5 }],
      ["non-positive installationId", { ...validReviewFix, installationId: 0 }],
      ["repository not owner/repo shaped", { ...validReviewFix, repository: "widgets" }],
      ["non-integer prNumber", { ...validReviewFix, prNumber: 1.5 }],
      ["non-positive prNumber", { ...validReviewFix, prNumber: -1 }],
      ["unparsable deadlineAt", { ...validReviewFix, deadlineAt: "not-a-date" }],
    ];
    for (const [label, reviewFix] of cases) {
      const withReviewFix = { ...full, reviewFix };
      const b64 = Buffer.from(JSON.stringify(withReviewFix), "utf-8").toString("base64");
      expect(() => decodeRunConfig(b64), label).toThrow(/reviewFix/);
    }
  });

  it("throws when reviewFix is not an object", () => {
    const withReviewFix = { ...full, reviewFix: "not-an-object" };
    const b64 = Buffer.from(JSON.stringify(withReviewFix), "utf-8").toString("base64");
    expect(() => decodeRunConfig(b64)).toThrow(/reviewFix/);
  });

  it("drops reviewers with malformed per-reviewer maxTurns during decode", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const maxTurns of [0, 201, 1.5, "45"]) {
        const withMalformedReviewers = { ...full, reviewers: [{ id: "gap-analysis", gates: true, maxTurns }] };
        const b64 = Buffer.from(JSON.stringify(withMalformedReviewers), "utf-8").toString("base64");
        const decoded = decodeRunConfig(b64);
        expect(decoded.issue.identifier).toBe("AII-1");
        expect(decoded.reviewers).toBeUndefined();
      }
      expect(warnSpy).toHaveBeenCalledTimes(4);
      for (const call of warnSpy.mock.calls) expect(call[0]).toContain("reviewers");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

function makeMapping(overrides: Partial<RepoMapping> = {}): RepoMapping {
  const base: RepoMapping = {
    owner: "test-org",
    repo: "test-repo",
    workflowFile: "claude-implement.yml",
    defaultBranch: "main",
    maxInProgressAiIssues: 3,
    executionMode: "fly-machines",
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

const implBaseIssue = {
  id: "issue-uuid",
  identifier: "ENG-42",
  title: "Add feature X",
  description: "Implement the feature",
};

// buildImplRunConfig backs both the Fly Machines and local Docker implementation
// dispatch paths (BAC-27113) — a single shared builder, tested once here.
describe("buildImplRunConfig", () => {
  it("stamps the caller-supplied retryPolicy into the envelope", () => {
    const mapping = makeMapping();
    const retryPolicy = {
      requestRetries: 3,
      stageRetries: 2,
      pushRetries: 1,
      backoffInitialMs: 45_000,
      backoffMaxMs: 250_000,
      backoffJitter: 0.1,
      reviewMaxTurns: 45,
    };

    const runConfig = buildImplRunConfig({
      issue: implBaseIssue,
      mapping,
      baseBranch: mapping.defaultBranch,
      retryPolicy,
    });

    const decoded = decodeRunConfig(encodeRunConfig(runConfig));
    expect(decoded.retryPolicy).toEqual(retryPolicy);
  });

  it("carries DEFAULT_RETRY_POLICY through when the caller passes it explicitly", () => {
    const mapping = makeMapping();

    const runConfig = buildImplRunConfig({
      issue: implBaseIssue,
      mapping,
      baseBranch: mapping.defaultBranch,
      retryPolicy: DEFAULT_RETRY_POLICY,
    });

    const decoded = decodeRunConfig(encodeRunConfig(runConfig));
    expect(decoded.retryPolicy).toEqual(DEFAULT_RETRY_POLICY);
    expect(decoded.runnerPhase).toBe("implementation");
    expect(decoded.issue.identifier).toBe("ENG-42");
  });

  it("carries the mapping's referenceRepos and dependencyTokenScope like the inline builders it replaced", () => {
    const repos = [{ repo: "https://github.com/acme/shared", path: "vendor/shared" }];
    const mapping = makeMapping({ referenceRepos: repos, dependencyTokenScope: "installation" });

    const runConfig = buildImplRunConfig({
      issue: implBaseIssue,
      mapping,
      baseBranch: "release",
      runnerCallbackUrl: "https://orch.example/api/runner",
      groupingParent: true,
      retryPolicy: DEFAULT_RETRY_POLICY,
    });

    const decoded = decodeRunConfig(encodeRunConfig(runConfig));
    expect(decoded.referenceRepos).toEqual(repos);
    expect(decoded.dependencyTokenScope).toBe("installation");
    expect(decoded.baseBranch).toBe("release");
    expect(decoded.runnerCallbackUrl).toBe("https://orch.example/api/runner");
    expect(decoded.groupingParent).toBe(true);
  });

  it("carries the mapping's reviewers when set, including an empty array", () => {
    const reviewers: ReviewerSelection[] = [{ id: "gap-analysis", gates: false }];
    const mapping = makeMapping({ reviewers });

    const runConfig = buildImplRunConfig({
      issue: implBaseIssue,
      mapping,
      baseBranch: mapping.defaultBranch,
      retryPolicy: DEFAULT_RETRY_POLICY,
    });

    expect(decodeRunConfig(encodeRunConfig(runConfig)).reviewers).toEqual(reviewers);

    const emptyConfig = buildImplRunConfig({
      issue: implBaseIssue,
      mapping: makeMapping({ reviewers: [] }),
      baseBranch: mapping.defaultBranch,
      retryPolicy: DEFAULT_RETRY_POLICY,
    });
    expect(decodeRunConfig(encodeRunConfig(emptyConfig)).reviewers).toEqual([]);
  });

  it("round-trips kgDryRun: true", () => {
    const cfg: RunConfigV1 = {
      v: 1,
      issue: { id: "i", identifier: "AII-632", title: "t", description: "" },
      kgDryRun: true,
    };
    expect(decodeRunConfig(encodeRunConfig(cfg)).kgDryRun).toBe(true);
  });

  it("absent kgDryRun decodes as undefined (no key materialized, never serialized as false)", () => {
    const min: RunConfigV1 = { v: 1, issue: { id: "i", identifier: "AII-632", title: "t", description: "" } };
    const decoded = decodeRunConfig(encodeRunConfig(min));
    expect(decoded.kgDryRun).toBeUndefined();
    expect("kgDryRun" in decoded).toBe(false);
  });

  it("pickKnownKeys preserves kgDryRun alongside kgSourceRepo", () => {
    const withKg = { ...full, kgSourceRepo: "org/kg", kgDryRun: true as const, bogusKey: "dropped" };
    const b64 = Buffer.from(JSON.stringify(withKg), "utf-8").toString("base64");
    const decoded = decodeRunConfig(b64);
    expect(decoded.kgSourceRepo).toBe("org/kg");
    expect(decoded.kgDryRun).toBe(true);
    expect((decoded as unknown as Record<string, unknown>).bogusKey).toBeUndefined();
  });

  it("round-trips kgSourceRef", () => {
    const cfg: RunConfigV1 = {
      v: 1,
      issue: { id: "i", identifier: "AII-633", title: "t", description: "" },
      kgSourceRef: "pr-head-branch",
    };
    expect(decodeRunConfig(encodeRunConfig(cfg)).kgSourceRef).toBe("pr-head-branch");
  });

  it("absent kgSourceRef decodes as undefined (no key materialized)", () => {
    const min: RunConfigV1 = { v: 1, issue: { id: "i", identifier: "AII-633", title: "t", description: "" } };
    const decoded = decodeRunConfig(encodeRunConfig(min));
    expect(decoded.kgSourceRef).toBeUndefined();
    expect("kgSourceRef" in decoded).toBe(false);
  });

  it("pickKnownKeys preserves kgSourceRef alongside kgSourceRepo and kgDryRun", () => {
    const withKg = { ...full, kgSourceRepo: "org/kg", kgDryRun: true as const, kgSourceRef: "feature/head", bogusKey: "dropped" };
    const b64 = Buffer.from(JSON.stringify(withKg), "utf-8").toString("base64");
    const decoded = decodeRunConfig(b64);
    expect(decoded.kgSourceRepo).toBe("org/kg");
    expect(decoded.kgDryRun).toBe(true);
    expect(decoded.kgSourceRef).toBe("feature/head");
    expect((decoded as unknown as Record<string, unknown>).bogusKey).toBeUndefined();
  });
});

describe("runConfigFromTaskDocument", () => {
  const ISSUE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("builds a minimal RunConfigV1 from title and description", () => {
    const params: TaskDocumentParams = { title: "My Task", description: "Do the thing." };
    const result = runConfigFromTaskDocument(params, ISSUE_ID);
    expect(result.v).toBe(1);
    expect(result.issue.id).toBe(ISSUE_ID);
    expect(result.issue.title).toBe("My Task");
    expect(result.issue.description).toBe("Do the thing.");
  });

  it("uses the provided identifier", () => {
    const params: TaskDocumentParams = { title: "T", description: "", identifier: "DEV-42" };
    const result = runConfigFromTaskDocument(params, ISSUE_ID);
    expect(result.issue.identifier).toBe("DEV-42");
  });

  it("falls back to a DEV-timestamp identifier when none is provided", () => {
    const params: TaskDocumentParams = { title: "T", description: "" };
    const result = runConfigFromTaskDocument(params, ISSUE_ID);
    expect(result.issue.identifier).toMatch(/^DEV-\d+$/);
  });

  it("maps baseBranch to config.baseBranch", () => {
    const params: TaskDocumentParams = { title: "T", description: "", baseBranch: "main" };
    const result = runConfigFromTaskDocument(params, ISSUE_ID);
    expect(result.baseBranch).toBe("main");
  });

  it("maps profiles to config.profiles", () => {
    const params: TaskDocumentParams = {
      title: "T",
      description: "",
      profiles: ["backend", "webapp"],
    };
    const result = runConfigFromTaskDocument(params, ISSUE_ID);
    expect(result.profiles).toEqual(["backend", "webapp"]);
  });

  it("maps maxTurns to config.maxTurns", () => {
    const params: TaskDocumentParams = { title: "T", description: "", maxTurns: 50 };
    const result = runConfigFromTaskDocument(params, ISSUE_ID);
    expect(result.maxTurns).toBe(50);
  });

  it("maps maxIterations to config.maxIterations", () => {
    const params: TaskDocumentParams = { title: "T", description: "", maxIterations: 3 };
    const result = runConfigFromTaskDocument(params, ISSUE_ID);
    expect(result.maxIterations).toBe(3);
  });

  it("omits optional keys when absent (no spurious undefined properties)", () => {
    const params: TaskDocumentParams = { title: "T", description: "" };
    const result = runConfigFromTaskDocument(params, ISSUE_ID);
    expect("baseBranch" in result).toBe(false);
    expect("profiles" in result).toBe(false);
    expect("maxTurns" in result).toBe(false);
    expect("maxIterations" in result).toBe(false);
  });

  it("produces a config that round-trips through encode/decode", () => {
    const params: TaskDocumentParams = {
      title: "T",
      description: "Body.",
      identifier: "DEV-9",
      baseBranch: "main",
      profiles: ["backend"],
      maxTurns: 10,
      maxIterations: 2,
    };
    const config = runConfigFromTaskDocument(params, ISSUE_ID);
    const decoded = decodeRunConfig(encodeRunConfig(config));
    expect(decoded.issue.identifier).toBe("DEV-9");
    expect(decoded.baseBranch).toBe("main");
    expect(decoded.profiles).toEqual(["backend"]);
    expect(decoded.maxTurns).toBe(10);
    expect(decoded.maxIterations).toBe(2);
  });
});

describe("agentConfig resolved snapshot", () => {
  const mk = (stage: "planning" | "implementation" | "review", agent: "claude" | "codex", provider: "anthropic" | "bedrock" | "openai", authMode: string, src = "project") => ({
    sel: { agent, provider, model: "m", accountProfileId: `p-${stage}`, invocationTimeoutMs: 60_000 },
    src: { agent: src, provider: src, model: src, accountProfileId: src, invocationTimeoutMs: "job-deadline" },
    prof: { id: `p-${stage}`, identity: "acct", revision: 2, agent, provider, authMode },
  });
  const build = (): any => {
    const p = mk("planning", "claude", "anthropic", "claude-subscription");
    const i = mk("implementation", "codex", "openai", "codex-subscription", "orchestrator-default");
    const r = mk("review", "codex", "openai", "openai-api-key");
    return {
      version: 1,
      snapshotId: "snap-1",
      configRevisions: { orchestratorDefault: 1, project: 3 },
      stages: { planning: p.sel, implementation: i.sel, review: r.sel },
      sources: { planning: p.src, implementation: i.src, review: r.src },
      profiles: { planning: p.prof, implementation: i.prof, review: r.prof },
    };
  };
  const base = { v: 1, issue: { id: "1", identifier: "A-1", title: "t", description: "d" } };
  const decodeWith = (agentConfig: unknown) =>
    decodeRunConfig(Buffer.from(JSON.stringify({ ...base, agentConfig }), "utf-8").toString("base64"));

  it("legacy envelope has no agentConfig key", () => {
    expect("agentConfig" in decodeRunConfig(encodeRunConfig(base as RunConfigV1))).toBe(false);
  });

  it("round-trips a valid snapshot", () => {
    const cfg = { ...base, agentConfig: build() } as RunConfigV1;
    expect(decodeRunConfig(encodeRunConfig(cfg)).agentConfig).toEqual(build());
  });

  it("accepts every auth mode", () => {
    const combos: Array<["claude" | "codex", "anthropic" | "bedrock" | "openai", string]> = [
      ["claude", "anthropic", "anthropic-api-key"], ["claude", "bedrock", "bedrock"],
      ["claude", "anthropic", "claude-subscription"], ["codex", "openai", "openai-api-key"],
      ["codex", "openai", "codex-subscription"],
    ];
    for (const [a, p, m] of combos) {
      const s = build();
      const x = mk("review", a, p, m);
      s.stages.review = x.sel; s.profiles.review = x.prof;
      expect(() => decodeWith(s)).not.toThrow();
    }
  });

  const mutations: Array<[string, (s: any) => void]> = [
    ["bad version", (s) => { s.version = 2; }],
    ["missing stage", (s) => { delete s.stages.review; }],
    ["extra stage", (s) => { s.stages.extra = s.stages.review; }],
    ["zero revision", (s) => { s.profiles.review.revision = 0; }],
    ["string config revision", (s) => { s.configRevisions.project = "3"; }],
    ["negative timeout", (s) => { s.stages.review.invocationTimeoutMs = -1; }],
    ["fractional timeout", (s) => { s.stages.review.invocationTimeoutMs = 1.5; }],
    ["string timeout", (s) => { s.stages.review.invocationTimeoutMs = "5"; }],
    ["bad source", (s) => { s.sources.review.model = "user"; }],
    ["profile id mismatch", (s) => { s.profiles.review.id = "other"; }],
    ["profile agent mismatch", (s) => { s.profiles.review.agent = "claude"; }],
    ["profile provider mismatch", (s) => { s.profiles.review.provider = "anthropic"; }],
    ["codex with anthropic-api-key", (s) => { s.profiles.review.authMode = "anthropic-api-key"; }],
  ];
  for (const [name, mutate] of mutations) {
    it(`rejects ${name}`, () => {
      const s = build();
      mutate(s);
      expect(() => decodeWith(s)).toThrow(/agentConfig/);
      expect(() => encodeRunConfig({ ...base, agentConfig: s } as RunConfigV1)).toThrow(/agentConfig/);
    });
  }

  it.each([null, [], "x", 5])("rejects non-object agentConfig %#", (v) => {
    expect(() => decodeWith(v)).toThrow(/agentConfig/);
  });

  it("rejects credential-shaped fields without echoing values", () => {
    const secret = "sk-SYNTHETIC-SECRET-VALUE";
    const inject: Array<(s: any) => void> = [
      (s) => { s.apiKey = secret; },
      (s) => { s.stages.review.token = secret; },
      (s) => { s.profiles.review.credential = secret; },
      (s) => { s.profiles.planning.accessToken = secret; },
      (s) => { s.sources.review.apiKey = secret; },
      (s) => { s.configRevisions.token = secret; },
    ];
    for (const fn of inject) {
      const s = build();
      fn(s);
      let msg = "";
      try { decodeWith(s); } catch (e) { msg = (e as Error).message; }
      expect(msg).toMatch(/unknown field/);
      expect(msg).not.toContain(secret);
      expect(msg).not.toContain("apiKey");
      expect(msg.length).toBeLessThan(200);
    }
  });

  it("whitelist drops unknown top-level keys and keeps the snapshot", () => {
    const out = decodeRunConfig(Buffer.from(JSON.stringify({ ...base, extra: 1, agentConfig: build() })).toString("base64"));
    expect("extra" in out).toBe(false);
    expect(out.agentConfig).toEqual(build());
  });

  it("builder defaults omit agentConfig, and accept then validate an explicit snapshot", () => {
    const mapping = makeMapping();
    const input = { issue: implBaseIssue, mapping, baseBranch: mapping.defaultBranch, retryPolicy: DEFAULT_RETRY_POLICY };
    expect("agentConfig" in buildImplRunConfig(input)).toBe(false);
    expect(buildImplRunConfig({ ...input, agentConfig: build() }).agentConfig).toEqual(build());
    const bad = build();
    bad.stages.review.invocationTimeoutMs = 0;
    expect(() => buildImplRunConfig({ ...input, agentConfig: bad })).toThrow(/agentConfig/);
  });
});
