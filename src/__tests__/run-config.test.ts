import { describe, expect, it } from "vitest";
import {
  encodeRunConfig,
  decodeRunConfig,
  runConfigFromTaskDocument,
  buildImplRunConfig,
  type RunConfigV1,
  type TaskDocumentParams,
} from "../run-config.js";
import { DEFAULT_RETRY_POLICY } from "../pipeline/retry-backoff.js";
import type { RepoMapping } from "../config.js";

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
    expect((decoded as Record<string, unknown>).futureField).toBeUndefined();
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
    expect((decoded as Record<string, unknown>).bogusKey).toBeUndefined();
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
});

function makeMapping(overrides: Partial<RepoMapping> = {}): RepoMapping {
  return {
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
    sensitiveAddPatterns: null,
    sensitiveAllowPatterns: null,
    autoMerge: false,
    dependencyTokenScope: null,
    ...overrides,
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
    expect((decoded as Record<string, unknown>).bogusKey).toBeUndefined();
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
    expect((decoded as Record<string, unknown>).bogusKey).toBeUndefined();
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
