import { execFile as rawExecFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

import {
  buildDockerEnvFileContent,
  buildDockerRunArgs,
  buildLocalRunnerEnv,
  readPublishedPort,
  startLocalRunnerContainer,
  selectSweepableContainers,
  splitLocalRunnerEnv,
} from "../local-docker.js";
import type { LocalRunnerInput, StartLocalContainerInput } from "../local-docker.js";
import { encodeRunConfig, decodeRunConfig, decodeTrustedRunConfig, type RunConfigV1 } from "../run-config.js";
import { testTempRoot } from "./helpers/test-dir.js";

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
    expect(env).not.toHaveProperty("SESSION_MODE");
  });

  it.each([undefined, "autonomous", "hybrid", "shadow", ""])(
    "ignores deprecated sessionMode %j",
    (sessionMode) => {
      const env = buildLocalRunnerEnv({ ...baseInput, sessionMode });
      expect(env).toEqual(buildLocalRunnerEnv(baseInput));
      expect(env).not.toHaveProperty("SESSION_MODE");
    },
  );

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
      extraEnv: { ISSUE_ID: "override", CUSTOM_VAR: "ok" },
    });

    expect(env.ISSUE_ID).toBe("override");
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
      const decoded = decodeRunConfig(env.AI_IMPLEMENT_RUN_CONFIG) as unknown as Record<string, unknown>;
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

describe("buildDockerRunArgs default name", () => {
  it("keeps the issue-key name when no containerName is given", () => {
    const args = buildDockerRunArgs(baseInput);
    expect(args[args.indexOf("--name") + 1]).toMatch(/^ai-implement-eng-42-[a-z0-9]+$/);
  });
});

describe("serve mode (AII-2048)", () => {
  const serve = { identityKey: "publickeyv1_abc", runnerId: "dispatch-42" };

  it("adds the three authoritative env vars after extraEnv", () => {
    const env = buildLocalRunnerEnv({
      ...baseInput,
      serve,
      extraEnv: {
        AI_IMPLEMENT_RUNNER_SERVE: "0",
        AI_IMPLEMENT_RUNNER_ID: "mapping-id",
        RESTATE_IDENTITY_KEY: "mapping-key",
      },
    });
    expect(env.AI_IMPLEMENT_RUNNER_SERVE).toBe("1");
    expect(env.AI_IMPLEMENT_RUNNER_ID).toBe("dispatch-42");
    expect(env.RESTATE_IDENTITY_KEY).toBe("publickeyv1_abc");
  });

  it("adds exactly the loopback ephemeral publication to the args", () => {
    const args = buildDockerRunArgs({ ...baseInput, containerName: "c", serve }, "/tmp/x.env");
    expect(args).toContain("-p");
    expect(args[args.indexOf("-p") + 1]).toBe("127.0.0.1::9080");
    expect(args.filter((a) => a === "-p")).toHaveLength(1);
    expect(args).not.toContain("::9080");
  });

  it("leaves env and args unchanged when serve is absent", () => {
    expect(buildLocalRunnerEnv(baseInput)).toEqual(buildLocalRunnerEnv({ ...baseInput, serve: undefined }));
    expect(buildDockerRunArgs({ ...baseInput, containerName: "c" }, "/tmp/x.env"))
      .toEqual(buildDockerRunArgs({ ...baseInput, containerName: "c", serve: undefined }, "/tmp/x.env"));
  });

  it("adds no serve env or publication on the protected model-auth transport", () => {
    const bootstrap = {
      version: 1, audience: "model-auth", grantId: "g1", dispatchId: "d1", snapshotId: "s1", projectKey: "AII",
      backend: "local", expiresAt: 1, bearer: "B".repeat(43),
      bindings: [{ stage: "implementation", profileId: "cdx", profileRevision: 1, authMode: "codex-subscription" }],
    } as unknown as NonNullable<LocalRunnerInput["protectedModelAuth"]>["bootstrap"];
    const protectedInput: StartLocalContainerInput = {
      ...baseInput,
      anthropicApiKey: undefined,
      containerName: "c",
      protectedModelAuth: {
        bootstrap, projectKey: "AII",
        runConfig: { v: 1, issue: { id: "i", identifier: "ENG-42", title: "t", description: "d" } } as RunConfigV1,
        modelAuthUrl: "http://host.docker.internal:8080",
      },
    };
    const env = buildLocalRunnerEnv(protectedInput);
    for (const key of ["AI_IMPLEMENT_RUNNER_SERVE", "AI_IMPLEMENT_RUNNER_ID", "RESTATE_IDENTITY_KEY"]) {
      expect(env).not.toHaveProperty(key);
    }
    expect(buildDockerRunArgs(protectedInput, "/tmp/x.env")).not.toContain("-p");
  });

  it("combines serve with the protected model-auth transport", () => {
    const bootstrap = {
      version: 1, audience: "model-auth", grantId: "g1", dispatchId: "d1", snapshotId: "s1", projectKey: "AII",
      backend: "local", expiresAt: 1, bearer: "B".repeat(43),
      bindings: [{ stage: "implementation", profileId: "cdx", profileRevision: 1, authMode: "codex-subscription" }],
    } as unknown as NonNullable<LocalRunnerInput["protectedModelAuth"]>["bootstrap"];
    const input: StartLocalContainerInput = {
      ...baseInput,
      anthropicApiKey: undefined,
      containerName: "ai-implement-serve-protected",
      serve,
      protectedModelAuth: {
        bootstrap, projectKey: "AII",
        runConfig: { v: 1, issue: { id: "i", identifier: "ENG-42", title: "t", description: "d" } } as RunConfigV1,
        modelAuthUrl: "http://host.docker.internal:8080",
      },
    };
    const env = buildLocalRunnerEnv(input);
    // The three serve variables, and the protected model-auth values, all reach the env.
    expect(env.AI_IMPLEMENT_RUNNER_SERVE).toBe("1");
    expect(env.AI_IMPLEMENT_RUNNER_ID).toBe("dispatch-42");
    expect(env.RESTATE_IDENTITY_KEY).toBe("publickeyv1_abc");
    const { secretEnv } = splitLocalRunnerEnv(env, { protectedModelAuth: true });
    expect(secretEnv.AI_IMPLEMENT_MODEL_AUTH_DISPATCH_ID).toBe("d1");
    expect(secretEnv.AI_IMPLEMENT_MODEL_AUTH_PROJECT_KEY).toBe("AII");
    expect(secretEnv.AI_IMPLEMENT_MODEL_AUTH_BACKEND).toBe("local");
    expect(secretEnv.AI_IMPLEMENT_MODEL_AUTH_URL).toBe("http://host.docker.internal:8080");
    expect(decodeTrustedRunConfig(secretEnv.AI_IMPLEMENT_RUN_CONFIG!).credentials?.modelAuthGrant).toMatchObject({ bearer: "B".repeat(43) });
    // The args carry the loopback ephemeral publication, and no secret value.
    const args = buildDockerRunArgs(input, "/tmp/x.env");
    expect(args[args.indexOf("-p") + 1]).toBe("127.0.0.1::9080");
    expect(args.join("\n")).not.toContain("B".repeat(43));
  });
});

describe("pre-change env and argv for the four launch paths", () => {
  // Pinned from the code before AII-2048. Absent `serve`, every launch path must reproduce it.
  const paths: Array<[string, StartLocalContainerInput, Record<string, string>, string[]]> = [
    [
      "implementation",
      { ...baseInput, containerName: "ai-implement-impl", extraEnv: { AI_IMPLEMENT_RUN_CONFIG: "IMPL-CONFIG", AI_IMPLEMENT_MAX_TURNS: "40" } },
      {
        AI_IMPLEMENT_MODE: "local", ISSUE_ID: "issue-uuid", ISSUE_IDENTIFIER: "ENG-42", ISSUE_TITLE: "Add local mode",
        ISSUE_DESCRIPTION: "Run implementation jobs locally", GITHUB_OWNER: "BuildDownAI", GITHUB_REPO: "AI-Implement",
        GITHUB_DEFAULT_BRANCH: "main", GITHUB_TOKEN: "ghs_test_token", SESSION_TOKEN: "session-token", MACHINE_NONCE: "nonce-123",
        RUNNER_PHASE: "implementation", ANTHROPIC_API_KEY: "sk-ant-test", ORCHESTRATOR_URL: "http://host.docker.internal:8080",
        AI_IMPLEMENT_RUN_CONFIG: "IMPL-CONFIG", AI_IMPLEMENT_MAX_TURNS: "40",
      },
      [
        "run", "-d", "--name", "ai-implement-impl", "--add-host", "host.docker.internal:host-gateway", "--env-file", "/tmp/runner.env",
        "-e", "AI_IMPLEMENT_MODE=local", "-e", "ISSUE_ID=issue-uuid", "-e", "ISSUE_IDENTIFIER=ENG-42", "-e", "ISSUE_TITLE=Add local mode",
        "-e", "ISSUE_DESCRIPTION=Run implementation jobs locally", "-e", "GITHUB_OWNER=BuildDownAI", "-e", "GITHUB_REPO=AI-Implement",
        "-e", "GITHUB_DEFAULT_BRANCH=main", "-e", "MACHINE_NONCE=nonce-123", "-e", "RUNNER_PHASE=implementation",
        "-e", "ORCHESTRATOR_URL=http://host.docker.internal:8080", "-e", "AI_IMPLEMENT_RUN_CONFIG=IMPL-CONFIG",
        "-e", "AI_IMPLEMENT_MAX_TURNS=40", "ai-implement-runner:local",
      ],
    ],
    [
      "planning",
      { ...baseInput, containerName: "ai-implement-plan", phase: "planning", extraEnv: { AI_IMPLEMENT_RUN_CONFIG: "PLAN-CONFIG" } },
      {
        AI_IMPLEMENT_MODE: "local", ISSUE_ID: "issue-uuid", ISSUE_IDENTIFIER: "ENG-42", ISSUE_TITLE: "Add local mode",
        ISSUE_DESCRIPTION: "Run implementation jobs locally", GITHUB_OWNER: "BuildDownAI", GITHUB_REPO: "AI-Implement",
        GITHUB_DEFAULT_BRANCH: "main", GITHUB_TOKEN: "ghs_test_token", SESSION_TOKEN: "session-token", MACHINE_NONCE: "nonce-123",
        RUNNER_PHASE: "planning", ANTHROPIC_API_KEY: "sk-ant-test", ORCHESTRATOR_URL: "http://host.docker.internal:8080",
        AI_IMPLEMENT_RUN_CONFIG: "PLAN-CONFIG",
      },
      [
        "run", "-d", "--name", "ai-implement-plan", "--add-host", "host.docker.internal:host-gateway", "--env-file", "/tmp/runner.env",
        "-e", "AI_IMPLEMENT_MODE=local", "-e", "ISSUE_ID=issue-uuid", "-e", "ISSUE_IDENTIFIER=ENG-42", "-e", "ISSUE_TITLE=Add local mode",
        "-e", "ISSUE_DESCRIPTION=Run implementation jobs locally", "-e", "GITHUB_OWNER=BuildDownAI", "-e", "GITHUB_REPO=AI-Implement",
        "-e", "GITHUB_DEFAULT_BRANCH=main", "-e", "MACHINE_NONCE=nonce-123", "-e", "RUNNER_PHASE=planning",
        "-e", "ORCHESTRATOR_URL=http://host.docker.internal:8080", "-e", "AI_IMPLEMENT_RUN_CONFIG=PLAN-CONFIG",
        "ai-implement-runner:local",
      ],
    ],
    [
      "review-fix",
      { ...baseInput, containerName: "ai-implement-review", phase: "implementation", extraEnv: { AI_IMPLEMENT_RUN_CONFIG: "REVIEW-CONFIG" } },
      {
        AI_IMPLEMENT_MODE: "local", ISSUE_ID: "issue-uuid", ISSUE_IDENTIFIER: "ENG-42", ISSUE_TITLE: "Add local mode",
        ISSUE_DESCRIPTION: "Run implementation jobs locally", GITHUB_OWNER: "BuildDownAI", GITHUB_REPO: "AI-Implement",
        GITHUB_DEFAULT_BRANCH: "main", GITHUB_TOKEN: "ghs_test_token", SESSION_TOKEN: "session-token", MACHINE_NONCE: "nonce-123",
        RUNNER_PHASE: "implementation", ANTHROPIC_API_KEY: "sk-ant-test", ORCHESTRATOR_URL: "http://host.docker.internal:8080",
        AI_IMPLEMENT_RUN_CONFIG: "REVIEW-CONFIG",
      },
      [
        "run", "-d", "--name", "ai-implement-review", "--add-host", "host.docker.internal:host-gateway", "--env-file", "/tmp/runner.env",
        "-e", "AI_IMPLEMENT_MODE=local", "-e", "ISSUE_ID=issue-uuid", "-e", "ISSUE_IDENTIFIER=ENG-42", "-e", "ISSUE_TITLE=Add local mode",
        "-e", "ISSUE_DESCRIPTION=Run implementation jobs locally", "-e", "GITHUB_OWNER=BuildDownAI", "-e", "GITHUB_REPO=AI-Implement",
        "-e", "GITHUB_DEFAULT_BRANCH=main", "-e", "MACHINE_NONCE=nonce-123", "-e", "RUNNER_PHASE=implementation",
        "-e", "ORCHESTRATOR_URL=http://host.docker.internal:8080", "-e", "AI_IMPLEMENT_RUN_CONFIG=REVIEW-CONFIG",
        "ai-implement-runner:local",
      ],
    ],
    [
      "kg-refresh",
      { ...baseInput, containerName: "ai-implement-kg", phase: "kg-refresh", extraEnv: { AI_IMPLEMENT_RUN_CONFIG: "KG-CONFIG" } },
      {
        AI_IMPLEMENT_MODE: "local", ISSUE_ID: "issue-uuid", ISSUE_IDENTIFIER: "ENG-42", ISSUE_TITLE: "Add local mode",
        ISSUE_DESCRIPTION: "Run implementation jobs locally", GITHUB_OWNER: "BuildDownAI", GITHUB_REPO: "AI-Implement",
        GITHUB_DEFAULT_BRANCH: "main", GITHUB_TOKEN: "ghs_test_token", SESSION_TOKEN: "session-token", MACHINE_NONCE: "nonce-123",
        RUNNER_PHASE: "kg-refresh", ANTHROPIC_API_KEY: "sk-ant-test", ORCHESTRATOR_URL: "http://host.docker.internal:8080",
        AI_IMPLEMENT_RUN_CONFIG: "KG-CONFIG",
      },
      [
        "run", "-d", "--name", "ai-implement-kg", "--add-host", "host.docker.internal:host-gateway", "--env-file", "/tmp/runner.env",
        "-e", "AI_IMPLEMENT_MODE=local", "-e", "ISSUE_ID=issue-uuid", "-e", "ISSUE_IDENTIFIER=ENG-42", "-e", "ISSUE_TITLE=Add local mode",
        "-e", "ISSUE_DESCRIPTION=Run implementation jobs locally", "-e", "GITHUB_OWNER=BuildDownAI", "-e", "GITHUB_REPO=AI-Implement",
        "-e", "GITHUB_DEFAULT_BRANCH=main", "-e", "MACHINE_NONCE=nonce-123", "-e", "RUNNER_PHASE=kg-refresh",
        "-e", "ORCHESTRATOR_URL=http://host.docker.internal:8080", "-e", "AI_IMPLEMENT_RUN_CONFIG=KG-CONFIG",
        "ai-implement-runner:local",
      ],
    ],
  ];

  it.each(paths)("%s keeps today's env and argv without serve", (_name, input, env, args) => {
    expect(buildLocalRunnerEnv(input)).toEqual(env);
    expect(buildDockerRunArgs(input, "/tmp/runner.env")).toEqual(args);
  });

  // The protected model-auth transport is the other launch shape; with serve absent it must
  // reproduce its pre-change env, argv, and private env-file byte for byte. The encoded run
  // config below is a literal captured before AII-2048, not regenerated by the implementation.
  it("protected model auth keeps today's complete env, argv, and env-file without serve", () => {
    const bootstrap = {
      version: 1, audience: "model-auth", grantId: "g1", dispatchId: "d1", snapshotId: "s1", projectKey: "AII",
      backend: "local", expiresAt: 1, bearer: "B".repeat(43),
      bindings: [{ stage: "implementation", profileId: "cdx", profileRevision: 1, authMode: "codex-subscription" }],
    } as unknown as NonNullable<LocalRunnerInput["protectedModelAuth"]>["bootstrap"];
    const runConfig = { v: 1, issue: { id: "i", identifier: "ENG-42", title: "t", description: "d" } } as RunConfigV1;
    const protectedInput: StartLocalContainerInput = {
      ...baseInput,
      anthropicApiKey: undefined,
      containerName: "ai-implement-protected",
      protectedModelAuth: {
        bootstrap, projectKey: "AII", runConfig,
        modelAuthUrl: "http://host.docker.internal:8080",
      },
    };
    const env = {
      AI_IMPLEMENT_MODE: "local", ISSUE_ID: "issue-uuid", ISSUE_IDENTIFIER: "ENG-42", ISSUE_TITLE: "Add local mode",
      ISSUE_DESCRIPTION: "Run implementation jobs locally", GITHUB_OWNER: "BuildDownAI", GITHUB_REPO: "AI-Implement",
      GITHUB_DEFAULT_BRANCH: "main", GITHUB_TOKEN: "ghs_test_token", SESSION_TOKEN: "session-token", MACHINE_NONCE: "nonce-123",
      RUNNER_PHASE: "implementation", ORCHESTRATOR_URL: "http://host.docker.internal:8080",
      AI_IMPLEMENT_MODEL_AUTH_DISPATCH_ID: "d1", AI_IMPLEMENT_MODEL_AUTH_PROJECT_KEY: "AII",
      AI_IMPLEMENT_MODEL_AUTH_BACKEND: "local", AI_IMPLEMENT_MODEL_AUTH_URL: "http://host.docker.internal:8080",
      AI_IMPLEMENT_RUN_CONFIG: "eyJ2IjoxLCJpc3N1ZSI6eyJpZCI6ImkiLCJpZGVudGlmaWVyIjoiRU5HLTQyIiwidGl0bGUiOiJ0IiwiZGVzY3JpcHRpb24iOiJkIn0sImNyZWRlbnRpYWxzIjp7InZlcnNpb24iOjEsIm1vZGVsQXV0aEdyYW50Ijp7InZlcnNpb24iOjEsImF1ZGllbmNlIjoibW9kZWwtYXV0aCIsImdyYW50SWQiOiJnMSIsImRpc3BhdGNoSWQiOiJkMSIsInNuYXBzaG90SWQiOiJzMSIsInByb2plY3RLZXkiOiJBSUkiLCJiYWNrZW5kIjoibG9jYWwiLCJleHBpcmVzQXQiOjEsImJlYXJlciI6IkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkIiLCJiaW5kaW5ncyI6W3sic3RhZ2UiOiJpbXBsZW1lbnRhdGlvbiIsInByb2ZpbGVJZCI6ImNkeCIsInByb2ZpbGVSZXZpc2lvbiI6MSwiYXV0aE1vZGUiOiJjb2RleC1zdWJzY3JpcHRpb24ifV19fX0=",
    };
    const args = [
      "run", "-d", "--name", "ai-implement-protected", "--add-host", "host.docker.internal:host-gateway", "--env-file", "/tmp/runner.env",
      "-e", "AI_IMPLEMENT_MODE=local", "-e", "ISSUE_ID=issue-uuid", "-e", "ISSUE_IDENTIFIER=ENG-42", "-e", "ISSUE_TITLE=Add local mode",
      "-e", "ISSUE_DESCRIPTION=Run implementation jobs locally", "-e", "GITHUB_OWNER=BuildDownAI", "-e", "GITHUB_REPO=AI-Implement",
      "-e", "GITHUB_DEFAULT_BRANCH=main", "-e", "MACHINE_NONCE=nonce-123", "-e", "RUNNER_PHASE=implementation",
      "-e", "ORCHESTRATOR_URL=http://host.docker.internal:8080", "ai-implement-runner:local",
    ];
    const envFile = [
      "GITHUB_TOKEN=ghs_test_token",
      "SESSION_TOKEN=session-token",
      "AI_IMPLEMENT_MODEL_AUTH_DISPATCH_ID=d1",
      "AI_IMPLEMENT_MODEL_AUTH_PROJECT_KEY=AII",
      "AI_IMPLEMENT_MODEL_AUTH_BACKEND=local",
      "AI_IMPLEMENT_MODEL_AUTH_URL=http://host.docker.internal:8080",
      `AI_IMPLEMENT_RUN_CONFIG=${env.AI_IMPLEMENT_RUN_CONFIG}`,
    ].join("\n") + "\n";

    expect(buildLocalRunnerEnv(protectedInput)).toEqual(env);
    expect(buildDockerRunArgs(protectedInput, "/tmp/runner.env")).toEqual(args);
    const { secretEnv } = splitLocalRunnerEnv(env, { protectedModelAuth: true });
    expect(buildDockerEnvFileContent(secretEnv)).toBe(envFile);
  });
});

describe("readPublishedPort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockPort(stdout: string) {
    vi.mocked(rawExecFile).mockImplementationOnce((_cmd: unknown, _args: unknown, cb: unknown) => {
      (cb as (err: null, result: { stdout: string; stderr: string }) => void)(null, { stdout, stderr: "" });
      return {} as ReturnType<typeof rawExecFile>;
    });
  }

  it("runs docker port <container> 9080", async () => {
    mockPort("127.0.0.1:49153\n");
    await readPublishedPort("c-1", 9080);
    expect(rawExecFile).toHaveBeenCalledWith("docker", ["port", "c-1", "9080"], expect.any(Function));
  });

  it("parses an IPv4 line", async () => {
    mockPort("127.0.0.1:49153\n");
    await expect(readPublishedPort("c-1", 9080)).resolves.toBe(49153);
  });

  it("parses an IPv6 line", async () => {
    mockPort("[::1]:49154\n");
    await expect(readPublishedPort("c-1", 9080)).resolves.toBe(49154);
  });

  it("parses multiline IPv4 and IPv6 output", async () => {
    mockPort("127.0.0.1:49155\n[::1]:49155\n");
    await expect(readPublishedPort("c-1", 9080)).resolves.toBe(49155);
  });

  it("returns null for empty output", async () => {
    mockPort("");
    await expect(readPublishedPort("c-1", 9080)).resolves.toBeNull();
  });
});

describe("startLocalRunnerContainer", () => {
  it("calls the launch marker only after local preparation succeeds", async () => {
    // The secret env file's directory is created under os.tmpdir(), which reads the temp variables per call.
    testTempRoot("local-docker");
    let marked = false;
    await expect(startLocalRunnerContainer({
      ...baseInput,
      onBeforeLaunch: () => { marked = true; throw new Error("stop before docker"); },
    })).rejects.toThrow("stop before docker");
    expect(marked).toBe(true);
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

  it("keeps RUN_PROGRESS_TOKEN out of docker argv env", () => {
    const { publicEnv, secretEnv } = splitLocalRunnerEnv(buildLocalRunnerEnv({
      ...baseInput,
      extraEnv: { RUN_PROGRESS_TOKEN: "progress-token" },
    }));

    expect(publicEnv.RUN_PROGRESS_TOKEN).toBeUndefined();
    expect(secretEnv.RUN_PROGRESS_TOKEN).toBe("progress-token");
  });

  it("keeps RUN_PUBLICATION_TOKEN out of docker argv env", () => {
    const { publicEnv, secretEnv } = splitLocalRunnerEnv(buildLocalRunnerEnv({
      ...baseInput,
      runPublicationToken: "publication-token",
    }));

    expect(publicEnv.RUN_PUBLICATION_TOKEN).toBeUndefined();
    expect(secretEnv.RUN_PUBLICATION_TOKEN).toBe("publication-token");
  });

  it("sets the progress and publication tokens only when non-empty", () => {
    const set = buildLocalRunnerEnv({
      ...baseInput,
      runProgressToken: "progress-token",
      runPublicationToken: "publication-token",
    });
    expect(set.RUN_PROGRESS_TOKEN).toBe("progress-token");
    expect(set.RUN_PUBLICATION_TOKEN).toBe("publication-token");

    for (const overrides of [{ runProgressToken: "", runPublicationToken: "" }, {}]) {
      const env = buildLocalRunnerEnv({ ...baseInput, ...overrides });
      expect(env).not.toHaveProperty("RUN_PROGRESS_TOKEN");
      expect(env).not.toHaveProperty("RUN_PUBLICATION_TOKEN");
    }
  });

  it("extraEnv overrides the progress and publication tokens", () => {
    const env = buildLocalRunnerEnv({
      ...baseInput,
      runProgressToken: "progress-token",
      runPublicationToken: "publication-token",
      extraEnv: { RUN_PROGRESS_TOKEN: "extra-progress", RUN_PUBLICATION_TOKEN: "extra-publication" },
    });
    expect(env.RUN_PROGRESS_TOKEN).toBe("extra-progress");
    expect(env.RUN_PUBLICATION_TOKEN).toBe("extra-publication");
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

describe("selectSweepableContainers", () => {
  const exited = (id: string, name: string, status = "Exited (0) 5 minutes ago") => ({ id, name, status });

  it("selects exited containers not tied to an in-flight job", () => {
    const containers = [exited("a".repeat(64), "ai-implement-san2-2-x1")];
    expect(selectSweepableContainers(containers, [])).toEqual(containers);
  });

  it("protects containers whose full ID matches an in-flight job machineId", () => {
    const id = "b".repeat(64);
    expect(selectSweepableContainers([exited(id, "ai-implement-san2-3-x2")], [id])).toEqual([]);
  });

  it("protects containers when the in-flight machineId is a short-ID prefix", () => {
    const full = "c".repeat(64);
    expect(selectSweepableContainers([exited(full, "n")], [full.slice(0, 12)])).toEqual([]);
    expect(selectSweepableContainers([exited(full.slice(0, 12), "n")], [full])).toEqual([]);
  });

  it("leaves recently exited containers alone (grace period)", () => {
    const fresh = exited("d".repeat(64), "n", "Exited (0) 10 seconds ago");
    const subSecond = exited("e".repeat(64), "n", "Exited (0) Less than a second ago");
    expect(selectSweepableContainers([fresh, subSecond], [])).toEqual([]);
  });
});

describe("protected model auth (AII-1390)", () => {
  const BEARER = "B".repeat(43);
  const bootstrap = {
    version: 1, audience: "model-auth", grantId: "g1", dispatchId: "d1", snapshotId: "s1", projectKey: "AII",
    backend: "local", expiresAt: 1, bearer: BEARER, bindings: [{ stage: "implementation", profileId: "cdx", profileRevision: 1, authMode: "codex-subscription" }],
  } as unknown as NonNullable<LocalRunnerInput["protectedModelAuth"]>["bootstrap"];
  const runConfig: RunConfigV1 = { v: 1, issue: { id: "i", identifier: "ENG-42", title: "t", description: "d" } } as RunConfigV1;
  const protectedInput: LocalRunnerInput = {
    ...baseInput,
    anthropicApiKey: undefined,
    protectedModelAuth: { bootstrap, projectKey: "AII", runConfig, modelAuthUrl: "http://host.docker.internal:8080" },
  };

  it("keeps the bearer, run config and model-auth values out of argv and in the env file", () => {
    const env = buildLocalRunnerEnv(protectedInput);
    const args = buildDockerRunArgs({ ...protectedInput, containerName: "c" }, "/tmp/x.env").join("\n");
    expect(args).not.toContain(BEARER);
    expect(args).not.toContain("AI_IMPLEMENT_RUN_CONFIG");
    expect(args).not.toContain("AI_IMPLEMENT_MODEL_AUTH");
    const { secretEnv } = splitLocalRunnerEnv(env, { protectedModelAuth: true });
    const content = buildDockerEnvFileContent(secretEnv);
    expect(content).toContain("AI_IMPLEMENT_MODEL_AUTH_URL=http://host.docker.internal:8080");
    expect(content).toContain("AI_IMPLEMENT_MODEL_AUTH_BACKEND=local");
    expect(content).toContain("AI_IMPLEMENT_MODEL_AUTH_DISPATCH_ID=d1");
    expect(content).toContain("AI_IMPLEMENT_MODEL_AUTH_PROJECT_KEY=AII");
    const rc = decodeTrustedRunConfig(secretEnv.AI_IMPLEMENT_RUN_CONFIG!);
    expect(rc.credentials?.modelAuthGrant).toMatchObject({ bearer: BEARER, backend: "local" });
  });

  it("applies authoritative values after extraEnv", () => {
    const env = buildLocalRunnerEnv({ ...protectedInput, extraEnv: { ISSUE_ID: "override" } });
    expect(env.ISSUE_ID).toBe("override");
    expect(env.AI_IMPLEMENT_MODEL_AUTH_URL).toBe("http://host.docker.internal:8080");
  });

  it.each(["AI_IMPLEMENT_MODEL_AUTH_URL", "ai_implement_run_config", "OPENAI_API_KEY"])(
    "rejects extraEnv %s without echoing the value",
    (name) => {
      expect(() => buildLocalRunnerEnv({ ...protectedInput, extraEnv: { [name]: "leak-me" } })).toThrow(/rejected/);
      try { buildLocalRunnerEnv({ ...protectedInput, extraEnv: { [name]: "leak-me" } }); } catch (e) {
        expect((e as Error).message).not.toContain("leak-me");
      }
    },
  );

  it("rejects legacy credentials and a pre-set grant", () => {
    expect(() => buildLocalRunnerEnv({ ...protectedInput, anthropicApiKey: "sk-ant" })).toThrow(/rejected/);
    expect(() => buildLocalRunnerEnv({ ...protectedInput, claudeOAuthToken: "tok" })).toThrow(/rejected/);
    expect(() => buildLocalRunnerEnv({
      ...protectedInput,
      protectedModelAuth: { ...protectedInput.protectedModelAuth!, runConfig: { ...runConfig, credentials: { version: 1, modelAuthGrant: bootstrap } } as RunConfigV1 },
    })).toThrow(/rejected/);
  });

  it("legacy input keeps today's docker run args, extraEnv last", () => {
    const args = buildDockerRunArgs({ ...baseInput, containerName: "c", extraEnv: { ISSUE_ID: "override", FOO: "bar" } }, "/tmp/x.env");
    expect(args).toEqual([
      "run", "-d", "--name", "c", "--add-host", "host.docker.internal:host-gateway", "--env-file", "/tmp/x.env",
      "-e", "AI_IMPLEMENT_MODE=local",
      "-e", "ISSUE_ID=override",
      "-e", "ISSUE_IDENTIFIER=ENG-42",
      "-e", "ISSUE_TITLE=Add local mode",
      "-e", "ISSUE_DESCRIPTION=Run implementation jobs locally",
      "-e", "GITHUB_OWNER=BuildDownAI",
      "-e", "GITHUB_REPO=AI-Implement",
      "-e", "GITHUB_DEFAULT_BRANCH=main",
      "-e", "MACHINE_NONCE=nonce-123",
      "-e", "RUNNER_PHASE=implementation",
      "-e", "ORCHESTRATOR_URL=http://host.docker.internal:8080",
      "-e", "FOO=bar",
      "ai-implement-runner:local",
    ]);
  });
});
