import { describe, expect, it } from "vitest";
import {
  buildDockerEnvFileContent,
  buildDockerRunArgs,
  buildLocalRunnerEnv,
  splitLocalRunnerEnv,
} from "../local-docker.js";
import type { LocalRunnerInput } from "../local-docker.js";

const baseInput: LocalRunnerInput = {
  image: "ai-implement-runner:local",
  issueId: "issue-uuid",
  issueIdentifier: "ENG-42",
  issueTitle: "Add local mode",
  issueDescription: "Run implementation jobs locally",
  owner: "BuildDownAI",
  repo: "AI-Implement",
  defaultBranch: "main",
  githubAppId: "12345",
  githubAppPrivateKey: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
  sessionToken: "session-token",
  machineNonce: "nonce-123",
  linearApiKey: "lin_api_test",
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
    expect(env.GITHUB_APP_ID).toBe("12345");
    expect(env.LINEAR_API_KEY).toBe("lin_api_test");
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
    expect(args).not.toContain("GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----");
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
    expect(publicEnv.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(publicEnv.SESSION_TOKEN).toBeUndefined();
    expect(secretEnv.GITHUB_APP_PRIVATE_KEY).toContain("BEGIN RSA PRIVATE KEY");
    expect(secretEnv.SESSION_TOKEN).toBe("session-token");
  });
});

describe("buildDockerEnvFileContent", () => {
  it("escapes literal newlines for env-file compatibility", () => {
    const content = buildDockerEnvFileContent({
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN-----\nkey\n-----END-----",
      SESSION_TOKEN: "session-token",
    });

    expect(content).toContain("GITHUB_APP_PRIVATE_KEY=-----BEGIN-----\\nkey\\n-----END-----");
    expect(content).toContain("SESSION_TOKEN=session-token");
  });
});
