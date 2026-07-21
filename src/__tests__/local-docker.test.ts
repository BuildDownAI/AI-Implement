import { describe, expect, it } from "vitest";
import {
  buildDockerEnvFileContent,
  buildDockerRunArgs,
  buildLocalRunnerEnv,
  splitLocalRunnerEnv,
} from "../local-docker.js";
import type { LocalRunnerInput } from "../local-docker.js";
import { encodeRunConfig, decodeRunConfig, type RunConfigV1 } from "../run-config.js";

const baseInput: LocalRunnerInput = {
  image: "ai-implement-runner:local",
  issueId: "issue-uuid",
  issueIdentifier: "ENG-42",
  issueTitle: "Add local mode",
  issueDescription: "Run implementation jobs locally",
  owner: "BuildDownAI",
  repo: "AI-Implement",
  defaultBranch: "main",
  githubToken: "ghs_test_token",
  sessionToken: "session-token",
  machineNonce: "nonce-123",
  anthropicApiKey: "sk-ant-test",
  orchestratorUrl: "http://host.docker.internal:8080",
};

describe("buildLocalRunnerEnv", () => {
  it("maps issue, repo, auth, and local mode env vars", () => {
    const env = buildLocalRunnerEnv(baseInput);

    expect(env.AI_IMPLEMENT_MODE).toBe("local");
    expect(env.ISSUE_ID).toBe("issue-uuid");
    expect(env.ISSUE_IDENTIFIER).toBe("ENG-42");
    expect(env.GITHUB_OWNER).toBe("BuildDownAI");
    expect(env.GITHUB_REPO).toBe("AI-Implement");
    expect(env.GITHUB_TOKEN).toBe("ghs_test_token");
    // The App private key must never reach a runner — only the short-lived install token.
    expect(env.GITHUB_APP_ID).toBeUndefined();
    expect(env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(env.ORCHESTRATOR_URL).toBe("http://host.docker.internal:8080");
    expect(env.SESSION_MODE).toBe("autonomous");
  });

  it("uses OAuth when provided instead of requiring an Anthropic key", () => {
    const env = buildLocalRunnerEnv({
      ...baseInput,
      anthropicApiKey: undefined,
      claudeOAuthToken: "oauth-token",
    });

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("defaults RUNNER_PHASE to implementation", () => {
    const env = buildLocalRunnerEnv(baseInput);
    expect(env.RUNNER_PHASE).toBe("implementation");
  });

  it("sets RUNNER_PHASE=planning when phase is planning", () => {
    const env = buildLocalRunnerEnv({ ...baseInput, phase: "planning" });
    expect(env.RUNNER_PHASE).toBe("planning");
  });

  it("lets mapping extraEnv override defaults", () => {
    const env = buildLocalRunnerEnv({
      ...baseInput,
      extraEnv: { SESSION_MODE: "hybrid", CUSTOM_VAR: "ok" },
    });

    expect(env.SESSION_MODE).toBe("hybrid");
    expect(env.CUSTOM_VAR).toBe("ok");
  });

  describe("AI_IMPLEMENT_RUN_CONFIG envelope", () => {
    it("passes through AI_IMPLEMENT_RUN_CONFIG from extraEnv and is decodable", () => {
      const runConfig: RunConfigV1 = {
        v: 1,
        issue: { id: "issue-uuid", identifier: "ENG-42", title: "Add local mode", description: "Run implementation jobs locally" },
        runnerPhase: "implementation",
        maxTurns: 40,
        maxIterations: 3,
        branchPrefix: "pr",
        skillsRepo: "org/skills",
        runnerCallbackUrl: "http://host.docker.internal:8080/callback",
      };
      const env = buildLocalRunnerEnv({
        ...baseInput,
        runnerCallbackUrl: "http://host.docker.internal:8080/callback",
        extraEnv: {
          AI_IMPLEMENT_MAX_TURNS: "40",
          AI_IMPLEMENT_MAX_ITERATIONS: "3",
          AI_IMPLEMENT_BRANCH_PREFIX: "pr",
          AI_IMPLEMENT_SKILLS_REPO: "org/skills",
          AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig(runConfig),
        },
      });

      expect(env.AI_IMPLEMENT_RUN_CONFIG).toBeDefined();
      const decoded = decodeRunConfig(env.AI_IMPLEMENT_RUN_CONFIG);
      expect(decoded.issue.id).toBe("issue-uuid");
      expect(decoded.issue.identifier).toBe("ENG-42");
      expect(decoded.maxTurns).toBe(40);
      expect(decoded.maxIterations).toBe(3);
      expect(decoded.branchPrefix).toBe("pr");
      expect(decoded.skillsRepo).toBe("org/skills");
      expect(decoded.runnerCallbackUrl).toBe("http://host.docker.internal:8080/callback");
      expect(decoded.runnerPhase).toBe("implementation");
    });

    it("flat legacy vars remain alongside the envelope", () => {
      const runConfig: RunConfigV1 = {
        v: 1,
        issue: { id: "issue-uuid", identifier: "ENG-42", title: "Add local mode", description: "Run implementation jobs locally" },
        runnerPhase: "implementation",
        maxTurns: 40,
        branchPrefix: "pr",
        skillsRepo: "org/skills",
      };
      const env = buildLocalRunnerEnv({
        ...baseInput,
        extraEnv: {
          AI_IMPLEMENT_MAX_TURNS: "40",
          AI_IMPLEMENT_BRANCH_PREFIX: "pr",
          AI_IMPLEMENT_SKILLS_REPO: "org/skills",
          AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig(runConfig),
        },
      });

      expect(env.ISSUE_ID).toBe("issue-uuid");
      expect(env.AI_IMPLEMENT_MAX_TURNS).toBe("40");
      expect(env.AI_IMPLEMENT_BRANCH_PREFIX).toBe("pr");
      expect(env.AI_IMPLEMENT_SKILLS_REPO).toBe("org/skills");
      expect(env.AI_IMPLEMENT_RUN_CONFIG).toBeDefined();
    });

    it("planning session envelope has runnerPhase=planning", () => {
      const planningConfig: RunConfigV1 = {
        v: 1,
        issue: { id: "issue-uuid", identifier: "ENG-42", title: "Add local mode", description: "Run implementation jobs locally" },
        runnerPhase: "planning",
        maxTurns: 20,
      };
      const env = buildLocalRunnerEnv({
        ...baseInput,
        phase: "planning",
        extraEnv: {
          PARENT: "ENG-40",
          SIBLINGS: "",
          DEPENDENCIES: "",
          AI_IMPLEMENT_MAX_TURNS: "20",
          AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig(planningConfig),
        },
      });

      const decoded = decodeRunConfig(env.AI_IMPLEMENT_RUN_CONFIG);
      expect(decoded.runnerPhase).toBe("planning");
      expect(decoded.branchPrefix).toBeUndefined();
      expect(decoded.skillsRepo).toBeUndefined();
      expect(env.PARENT).toBe("ENG-40");
      expect(env.AI_IMPLEMENT_MAX_TURNS).toBe("20");
    });

    it("AI_IMPLEMENT_RUN_CONFIG is in the public env bucket (not secret)", () => {
      const runConfig: RunConfigV1 = {
        v: 1,
        issue: { id: "issue-uuid", identifier: "ENG-42", title: "Add local mode", description: "Run implementation jobs locally" },
        runnerPhase: "implementation",
      };
      const env = buildLocalRunnerEnv({
        ...baseInput,
        extraEnv: { AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig(runConfig) },
      });
      const { publicEnv, secretEnv } = splitLocalRunnerEnv(env);

      expect(publicEnv.AI_IMPLEMENT_RUN_CONFIG).toBeDefined();
      expect(secretEnv.AI_IMPLEMENT_RUN_CONFIG).toBeUndefined();
    });

    it("secrets are not present in the decoded envelope", () => {
      const runConfig: RunConfigV1 = {
        v: 1,
        issue: { id: "issue-uuid", identifier: "ENG-42", title: "T", description: "D" },
        runnerPhase: "implementation",
      };
      const env = buildLocalRunnerEnv({
        ...baseInput,
        extraEnv: { AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig(runConfig) },
      });
      const decoded = decodeRunConfig(env.AI_IMPLEMENT_RUN_CONFIG) as Record<string, unknown>;
      expect(decoded.SESSION_TOKEN).toBeUndefined();
      expect(decoded.GITHUB_TOKEN).toBeUndefined();
      expect(decoded.ANTHROPIC_API_KEY).toBeUndefined();
      expect(decoded.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });
  });
});

describe("buildDockerRunArgs", () => {
  it("builds a detached docker run command with host gateway and env file for secrets", () => {
    const args = buildDockerRunArgs({
      ...baseInput,
      containerName: "ai-implement-eng-42-test",
    }, "/tmp/runner.env");

    expect(args.slice(0, 2)).toEqual(["run", "-d"]);
    expect(args).toContain("--name");
    expect(args).toContain("ai-implement-eng-42-test");
    expect(args).toContain("--add-host");
    expect(args).toContain("host.docker.internal:host-gateway");
    expect(args).toContain("--env-file");
    expect(args).toContain("/tmp/runner.env");
    expect(args).toContain("-e");
    expect(args).toContain("AI_IMPLEMENT_MODE=local");
    expect(args).toContain("ISSUE_IDENTIFIER=ENG-42");
    expect(args).not.toContain("GITHUB_TOKEN=ghs_test_token"); // token is a secret → env-file, not a public -e arg
    expect(args).not.toContain("SESSION_TOKEN=session-token");
    expect(args).not.toContain("LINEAR_API_KEY=lin_api_test");
    expect(args).not.toContain("ANTHROPIC_API_KEY=sk-ant-test");
    expect(args.at(-1)).toBe("ai-implement-runner:local");
  });
});

describe("splitLocalRunnerEnv", () => {
  it("separates secrets from public docker argv env", () => {
    const { publicEnv, secretEnv } = splitLocalRunnerEnv(buildLocalRunnerEnv(baseInput));

    expect(publicEnv.ISSUE_IDENTIFIER).toBe("ENG-42");
    expect(publicEnv.GITHUB_TOKEN).toBeUndefined();
    expect(publicEnv.SESSION_TOKEN).toBeUndefined();
    expect(secretEnv.GITHUB_TOKEN).toBe("ghs_test_token"); // GITHUB_TOKEN routes into secretEnv via SECRET_ENV_KEYS
    expect(secretEnv.SESSION_TOKEN).toBe("session-token");
    // The App private key is gone entirely — present in neither map.
    expect(publicEnv.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(secretEnv.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
  });
});

describe("buildDockerEnvFileContent", () => {
  it("escapes literal newlines for env-file compatibility", () => {
    const content = buildDockerEnvFileContent({
      MULTILINE_SECRET: "-----BEGIN-----\nkey\n-----END-----",
      SESSION_TOKEN: "session-token",
    });

    expect(content).toContain("MULTILINE_SECRET=-----BEGIN-----\\nkey\\n-----END-----");
    expect(content).toContain("SESSION_TOKEN=session-token");
  });
});
