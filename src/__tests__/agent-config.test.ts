import { describe, expect, it } from "vitest";
import {
  describeInvocationLimit,
  resolveStageAgentConfig,
  type AccountProfile,
  type StageAgentConfigurationV1,
} from "../agent-config.js";

const orchestratorDefaults: StageAgentConfigurationV1 = {
  version: 1,
  mode: "configured",
  stages: {
    planning: {
      agent: "claude",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      accountProfileId: "claude-api",
      invocationTimeoutMs: 300_000,
    },
    implementation: {
      agent: "codex",
      provider: "openai",
      model: "gpt-5.5-codex",
      accountProfileId: "openai-api",
      invocationTimeoutMs: 900_000,
    },
    review: {
      agent: "claude",
      provider: "bedrock",
      model: "anthropic.claude-sonnet-5-5-v1:0",
      accountProfileId: "claude-bedrock",
      invocationTimeoutMs: 240_000,
    },
  },
};

const accountProfiles: AccountProfile[] = [
  {
    id: "claude-api",
    identity: "Claude API profile",
    revision: 1,
    agent: "claude",
    provider: "anthropic",
    authMode: "anthropic-api-key",
    allowedProjectKeys: ["AII"],
  },
  {
    id: "claude-subscription",
    identity: "Claude subscription profile",
    revision: 5,
    agent: "claude",
    provider: "anthropic",
    authMode: "claude-subscription",
    allowedProjectKeys: ["AII"],
  },
  {
    id: "claude-bedrock",
    identity: "Claude Bedrock profile",
    revision: 2,
    agent: "claude",
    provider: "bedrock",
    authMode: "bedrock",
    allowedProjectKeys: ["AII"],
  },
  {
    id: "openai-api",
    identity: "OpenAI API profile",
    revision: 3,
    agent: "codex",
    provider: "openai",
    authMode: "openai-api-key",
    allowedProjectKeys: ["AII"],
  },
  {
    id: "openai-subscription",
    identity: "OpenAI subscription profile",
    revision: 4,
    agent: "codex",
    provider: "openai",
    authMode: "codex-subscription",
    allowedProjectKeys: ["AII"],
  },
];

function configuredProject(stages: StageAgentConfigurationV1["stages"] = {}): StageAgentConfigurationV1 {
  return { version: 1, mode: "configured", stages };
}

function expectError(fn: () => unknown, message: string | RegExp): void {
  expect(fn).toThrow(message);
}

function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return err as Error;
  }
  throw new Error("Expected function to throw");
}

describe("resolveStageAgentConfig", () => {
  it("returns explicit legacy mode when project configuration is absent or legacy", () => {
    expect(
      resolveStageAgentConfig({
        projectKey: "AII",
        orchestratorDefaults,
        projectConfig: null,
        accountProfiles,
      }),
    ).toEqual({ mode: "legacy" });

    expect(
      resolveStageAgentConfig({
        projectKey: "AII",
        orchestratorDefaults,
        projectConfig: { version: 1, mode: "legacy", stages: { implementation: { model: "" } } },
        accountProfiles,
      }),
    ).toEqual({ mode: "legacy" });

    expect(
      resolveStageAgentConfig({
        projectKey: "AII",
        orchestratorDefaults: { ...orchestratorDefaults, version: 2 as 1 },
        projectConfig: { version: 1, mode: "legacy" },
        accountProfiles,
      }),
    ).toEqual({ mode: "legacy" });
  });

  it("resolves defaults and lets a project override only the model", () => {
    const result = resolveStageAgentConfig({
      projectKey: "AII",
      orchestratorDefaults,
      projectConfig: configuredProject({ implementation: { model: "gpt-5.6-codex" } }),
      accountProfiles,
    });

    expect(result.mode).toBe("configured");
    if (result.mode !== "configured") return;
    expect(result.stages.implementation).toEqual({
      agent: "codex",
      provider: "openai",
      model: "gpt-5.6-codex",
      accountProfileId: "openai-api",
      invocationTimeoutMs: 900_000,
    });
    expect(result.sources.implementation).toEqual({
      agent: "orchestrator-default",
      provider: "orchestrator-default",
      model: "project",
      accountProfileId: "orchestrator-default",
      invocationTimeoutMs: "orchestrator-default",
    });
  });

  it("treats a null override as cleared and restores inheritance", () => {
    const result = resolveStageAgentConfig({
      projectKey: "AII",
      orchestratorDefaults,
      projectConfig: configuredProject({ implementation: { model: null } }),
      accountProfiles,
    });

    expect(result.mode).toBe("configured");
    if (result.mode !== "configured") return;
    expect(result.stages.implementation.model).toBe("gpt-5.5-codex");
    expect(result.sources.implementation.model).toBe("orchestrator-default");
  });

  it("projects account metadata without credential or session fields", () => {
    const result = resolveStageAgentConfig({
      projectKey: "AII",
      orchestratorDefaults,
      projectConfig: configuredProject({ implementation: { accountProfileId: "openai-secret-bearing" } }),
      accountProfiles: [
        ...accountProfiles,
        {
          id: "openai-secret-bearing",
          identity: "OpenAI projected profile",
          revision: 1,
          agent: "codex",
          provider: "openai",
          authMode: "openai-api-key",
          allowedProjectKeys: ["AII"],
          apiKey: "sk-must-not-project",
        } as AccountProfile,
      ],
    });

    expect(result.mode).toBe("configured");
    if (result.mode !== "configured") return;
    expect(result.profiles.implementation).toEqual({
      id: "openai-secret-bearing",
      identity: "OpenAI projected profile",
      revision: 1,
      agent: "codex",
      provider: "openai",
      authMode: "openai-api-key",
    });
    expect(JSON.stringify(result)).not.toContain("sk-must-not-project");
  });

  it("supports explicit Claude subscription profiles for configured stages", () => {
    const result = resolveStageAgentConfig({
      projectKey: "AII",
      orchestratorDefaults,
      projectConfig: configuredProject({ planning: { accountProfileId: "claude-subscription" } }),
      accountProfiles,
    });

    expect(result.mode).toBe("configured");
    if (result.mode !== "configured") return;
    expect(result.profiles.planning).toMatchObject({
      id: "claude-subscription",
      agent: "claude",
      provider: "anthropic",
      authMode: "claude-subscription",
    });
  });

  it("distinguishes Claude native turn limits from Codex elapsed time", () => {
    expect(describeInvocationLimit({ agent: "claude", invocationTimeoutMs: 100_000 })).toContain(
      "Claude native turn limits remain separate",
    );
    expect(describeInvocationLimit({ agent: "codex", invocationTimeoutMs: 100_000 })).toContain(
      "Codex is bounded by elapsed time",
    );
    expect(describeInvocationLimit({ agent: "codex", invocationTimeoutMs: 100_000 })).toContain(
      "existing AI-Implement loop iteration cap",
    );
  });

  it("bounds invocation time by the remaining job deadline", () => {
    const result = resolveStageAgentConfig({
      projectKey: "AII",
      orchestratorDefaults,
      projectConfig: configuredProject(),
      accountProfiles,
      remainingJobMs: 120_000,
    });

    expect(result.mode).toBe("configured");
    if (result.mode !== "configured") return;
    expect(result.stages.implementation.invocationTimeoutMs).toBe(120_000);
    expect(result.sources.implementation.invocationTimeoutMs).toBe("job-deadline");
  });

  it("rejects unknown versions, stages, and selection fields", () => {
    expectError(
      () =>
        resolveStageAgentConfig({
          projectKey: "AII",
          orchestratorDefaults: { ...orchestratorDefaults, version: 2 as 1 },
          projectConfig: configuredProject(),
          accountProfiles,
        }),
      /unsupported version/,
    );

    expectError(
      () =>
        resolveStageAgentConfig({
          projectKey: "AII",
          orchestratorDefaults,
          projectConfig: { version: 1, mode: "configured", stages: { bogus: {} } } as unknown as StageAgentConfigurationV1,
          accountProfiles,
        }),
      /unknown key/,
    );

    expectError(
      () =>
        resolveStageAgentConfig({
          projectKey: "AII",
          orchestratorDefaults,
          projectConfig: configuredProject({ implementation: { temperature: 0 } as unknown as never }),
          accountProfiles,
        }),
      /unknown key/,
    );
  });

  it("rejects incomplete and malformed selections", () => {
    expectError(
      () =>
        resolveStageAgentConfig({
          projectKey: "AII",
          orchestratorDefaults: {
            version: 1,
            mode: "configured",
            stages: {
              ...orchestratorDefaults.stages,
              implementation: { ...orchestratorDefaults.stages?.implementation, model: undefined },
            },
          },
          projectConfig: configuredProject(),
          accountProfiles,
        }),
      /implementation.model is required/,
    );

    expectError(
      () =>
        resolveStageAgentConfig({
          projectKey: "AII",
          orchestratorDefaults,
          projectConfig: configuredProject({ implementation: { invocationTimeoutMs: 0 } }),
          accountProfiles,
        }),
      /positive integer/,
    );

    const err = captureError(() =>
      resolveStageAgentConfig({
        projectKey: "AII",
        orchestratorDefaults,
        projectConfig: configuredProject({ implementation: { agent: "sk-secret-agent" as "codex" } }),
        accountProfiles,
      }),
    );
    expect(err.message).toBe("implementation.agent is unsupported");
    expect(err.message).not.toContain("sk-secret-agent");
  });

  it("rejects unsupported provider and authentication combinations", () => {
    expectError(
      () =>
        resolveStageAgentConfig({
          projectKey: "AII",
          orchestratorDefaults,
          projectConfig: configuredProject({ implementation: { provider: "anthropic" } }),
          accountProfiles,
        }),
      /provider does not match/,
    );

    expectError(
      () =>
        resolveStageAgentConfig({
          projectKey: "AII",
          orchestratorDefaults,
          projectConfig: configuredProject({ implementation: { accountProfileId: "claude-api" } }),
          accountProfiles,
        }),
      /agent does not match/,
    );
  });

  it("rejects disabled, unknown, missing-permission, or unauthorized profiles", () => {
    expectError(
      () =>
        resolveStageAgentConfig({
          projectKey: "AII",
          orchestratorDefaults,
          projectConfig: configuredProject({ implementation: { accountProfileId: "missing" } }),
          accountProfiles,
        }),
      /known profile/,
    );

    expectError(
      () =>
        resolveStageAgentConfig({
          projectKey: "AII",
          orchestratorDefaults,
          projectConfig: configuredProject(),
          accountProfiles: accountProfiles.map((profile) =>
            profile.id === "openai-api" ? { ...profile, disabled: true } : profile,
          ),
        }),
      /disabled/,
    );

    expectError(
      () =>
        resolveStageAgentConfig({
          projectKey: "AII",
          orchestratorDefaults,
          projectConfig: configuredProject(),
          accountProfiles: accountProfiles.map((profile) => {
            if (profile.id !== "openai-api") return profile;
            const { allowedProjectKeys, ...withoutPermissions } = profile;
            void allowedProjectKeys;
            return withoutPermissions as AccountProfile;
          }),
        }),
      /permission metadata is required/,
    );

    expectError(
      () =>
        resolveStageAgentConfig({
          projectKey: "OTHER",
          orchestratorDefaults,
          projectConfig: configuredProject(),
          accountProfiles,
        }),
      /not authorized/,
    );
  });

  it("rejects malformed profile metadata and duplicate profile ids", () => {
    expectError(
      () =>
        resolveStageAgentConfig({
          projectKey: "AII",
          orchestratorDefaults,
          projectConfig: configuredProject(),
          accountProfiles: accountProfiles.map((profile) =>
            profile.id === "openai-api" ? { ...profile, revision: 0 } : profile,
          ),
        }),
      /revision must be a positive integer/,
    );

    expectError(
      () =>
        resolveStageAgentConfig({
          projectKey: "AII",
          orchestratorDefaults,
          projectConfig: configuredProject(),
          accountProfiles: accountProfiles.map((profile) =>
            profile.id === "openai-api" ? { ...profile, identity: "   " } : profile,
          ),
        }),
      /identity must be a non-empty string/,
    );

    expectError(
      () =>
        resolveStageAgentConfig({
          projectKey: "AII",
          orchestratorDefaults,
          projectConfig: configuredProject(),
          accountProfiles: [...accountProfiles, { ...accountProfiles[0] }],
        }),
      /id must be unique/,
    );
  });

  it("does not echo unknown field names when rejecting strict configuration objects", () => {
    const err = captureError(() =>
      resolveStageAgentConfig({
        projectKey: "AII",
        orchestratorDefaults,
        projectConfig: configuredProject({ implementation: { "sk-secret-field": "x" } as unknown as never }),
        accountProfiles,
      }),
    );

    expect(err.message).toBe("projectConfig.stages.implementation contains unknown key(s)");
    expect(err.message).not.toContain("sk-secret-field");
  });
});
