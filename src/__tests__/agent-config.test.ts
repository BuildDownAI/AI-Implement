import { describe, expect, it } from "vitest";
import {
  describeInvocationLimit,
  StageAccountError,
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
  },
  {
    id: "claude-subscription",
    identity: "Claude subscription profile",
    revision: 5,
    agent: "claude",
    provider: "anthropic",
    authMode: "claude-subscription",
  },
  {
    id: "claude-bedrock",
    identity: "Claude Bedrock profile",
    revision: 2,
    agent: "claude",
    provider: "bedrock",
    authMode: "bedrock",
  },
  {
    id: "openai-api",
    identity: "OpenAI API profile",
    revision: 3,
    agent: "codex",
    provider: "openai",
    authMode: "openai-api-key",
  },
  {
    id: "openai-subscription",
    identity: "OpenAI subscription profile",
    revision: 4,
    agent: "codex",
    provider: "openai",
    authMode: "codex-subscription",
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
        orchestratorDefaults,
        projectConfig: null,
        accountProfiles,
      }),
    ).toEqual({ mode: "legacy" });

    expect(
      resolveStageAgentConfig({
        orchestratorDefaults,
        projectConfig: { version: 1, mode: "legacy", stages: { implementation: { model: "" } } },
        accountProfiles,
      }),
    ).toEqual({ mode: "legacy" });

    expect(
      resolveStageAgentConfig({
        orchestratorDefaults: { ...orchestratorDefaults, version: 2 as 1 },
        projectConfig: { version: 1, mode: "legacy" },
        accountProfiles,
      }),
    ).toEqual({ mode: "legacy" });
  });

  it("resolves defaults and lets a project override only the model", () => {
    const result = resolveStageAgentConfig({
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
          orchestratorDefaults: { ...orchestratorDefaults, version: 2 as 1 },
          projectConfig: configuredProject(),
          accountProfiles,
        }),
      /unsupported version/,
    );

    expectError(
      () =>
        resolveStageAgentConfig({
          orchestratorDefaults,
          projectConfig: { version: 1, mode: "configured", stages: { bogus: {} } } as unknown as StageAgentConfigurationV1,
          accountProfiles,
        }),
      /unknown key/,
    );

    expectError(
      () =>
        resolveStageAgentConfig({
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
          orchestratorDefaults,
          projectConfig: configuredProject({ implementation: { invocationTimeoutMs: 0 } }),
          accountProfiles,
        }),
      /positive integer/,
    );

    const err = captureError(() =>
      resolveStageAgentConfig({
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
          orchestratorDefaults,
          projectConfig: configuredProject({ implementation: { provider: "anthropic" } }),
          accountProfiles,
        }),
      /provider does not match/,
    );

    expectError(
      () =>
        resolveStageAgentConfig({
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
          orchestratorDefaults,
          projectConfig: configuredProject({ implementation: { accountProfileId: "missing" } }),
          accountProfiles,
        }),
      /known profile/,
    );

    expectError(
      () =>
        resolveStageAgentConfig({
          orchestratorDefaults,
          projectConfig: configuredProject(),
          accountProfiles: accountProfiles.map((profile) =>
            profile.id === "openai-api" ? { ...profile, disabled: true } : profile,
          ),
        }),
      /disabled/,
    );
  });

  it("rejects malformed profile metadata and duplicate profile ids", () => {
    expectError(
      () =>
        resolveStageAgentConfig({
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
        orchestratorDefaults,
        projectConfig: configuredProject({ implementation: { "sk-secret-field": "x" } as unknown as never }),
        accountProfiles,
      }),
    );

    expect(err.message).toBe("projectConfig.stages.implementation contains unknown key(s)");
    expect(err.message).not.toContain("sk-secret-field");
  });
});

describe("fallback models", () => {
  it("inherits, overrides and restores inheritance without changing selection keys", () => {
    const defaults = structuredClone(orchestratorDefaults);
    defaults.stages!.planning!.fallbackModel = "backup";
    for (const [patch, expected, source] of [
      [{}, "backup", "orchestrator-default"],
      [{ fallbackModel: "project-backup" }, "project-backup", "project"],
      [{ fallbackModel: null }, "backup", "orchestrator-default"],
    ] as const) {
      const result = resolveStageAgentConfig({ orchestratorDefaults: defaults, projectConfig: configuredProject({ planning: patch }), accountProfiles });
      if (result.mode !== "configured") throw new Error("expected configured");
      expect(result.fallbackModels).toEqual({ planning: expected });
      expect(result.fallbackModelSources).toEqual({ planning: source });
      expect(Object.keys(result.stages.planning)).toHaveLength(5);
      expect(Object.keys(result.sources.planning)).toHaveLength(5);
    }
    const result = resolveStageAgentConfig({ orchestratorDefaults, projectConfig: configuredProject(), accountProfiles });
    if (result.mode !== "configured") throw new Error("expected configured");
    expect(result.fallbackModels).toEqual({});
  });

  it("rejects inherited collisions with a project primary model", () => {
    const defaults = structuredClone(orchestratorDefaults);
    defaults.stages!.planning!.fallbackModel = "backup";
    expect(() => resolveStageAgentConfig({ orchestratorDefaults: defaults, projectConfig: configuredProject({ planning: { model: "backup" } }), accountProfiles })).toThrow(/planning.*fallbackModel/);
  });

  it("drops redundant fallback metadata only while an account list is active", () => {
    const defaults = structuredClone(orchestratorDefaults);
    defaults.stages!.planning!.accounts = [{ accountProfileId: "claude-api", model: "backup" }, { accountProfileId: "claude-bedrock", model: "other" }];
    defaults.stages!.planning!.fallbackModel = "backup";
    const result = resolveStageAgentConfig({ orchestratorDefaults: defaults, projectConfig: configuredProject(), accountProfiles });
    if (result.mode !== "configured") throw new Error("expected configured");
    expect(result.fallbackModels).toEqual({});
    expect(result.fallbackModelSources).toEqual({});
    expect(() => resolveStageAgentConfig({ orchestratorDefaults: defaults, projectConfig: configuredProject({ planning: { accountProfileId: "claude-api" } }), accountProfiles })).toThrow("planning.fallbackModel must differ from model");
  });
});

describe("ordered stage accounts", () => {
  it.each(["resolution_failed", "unsupported_combination"] as const)("names the stage and preserves %s when no account resolves", code => {
    const defaults = structuredClone(orchestratorDefaults);
    defaults.stages!.planning!.accounts = [{ accountProfileId: "claude-api", model: "first" }, { accountProfileId: "claude-subscription", model: "" }];
    const resolve = () => resolveStageAgentConfig({
      orchestratorDefaults: defaults,
      projectConfig: configuredProject(),
      accountProfiles: accountProfiles.map(profile => ({ ...profile, disabled: code === "resolution_failed" && profile.id.startsWith("claude-") })),
      checkAccount: () => code === "unsupported_combination" ? code : null,
    });
    expect(resolve).toThrow(StageAccountError);
    expect(resolve).toThrow(`planning.accounts: no entry resolves (${code})`);
    try {
      resolve();
    } catch (error) {
      expect(error).toHaveProperty("code", code);
    }
  });

  it.each([
    { name: "first passes", reasons: [null, null], chosen: 0, fallbacks: ["b"] },
    { name: "second chosen", reasons: ["unsupported_combination", null], chosen: 1, fallbacks: [] },
    { name: "first failure", reasons: ["resolution_failed", "unsupported_combination"], chosen: null, fallbacks: [] },
    { name: "later split", reasons: [null, "resolution_failed", null], chosen: 0, fallbacks: ["c"] },
    { name: "blank model", reasons: [null, null], chosen: 0, fallbacks: ["b"] },
    { name: "singleton", reasons: [null], chosen: 0, fallbacks: [] },
  ])("$name", async ({ reasons, chosen, fallbacks }) => {
    const { chooseStageAccount } = await import("../agent-config.js");
    const entries = reasons.map((_, index) => ({ accountProfileId: String.fromCharCode(97 + index), model: index ? "" : "model", profileRevision: 3, agent: "claude" as const, provider: "anthropic" as const, authMode: "anthropic-api-key" as const }));
    const result = chooseStageAccount(entries, e => reasons[e.accountProfileId.charCodeAt(0) - 97] as import("../agent-config.js").AccountFailure | null);
    expect(result.chosen?.index ?? null).toBe(chosen);
    expect(result.fallbacks.map(e => e.accountProfileId)).toEqual(fallbacks);
    expect(result.fallbacks.every(e => e.model === "model" && e.profileRevision === 3)).toBe(true);
    if (chosen === null) expect(result.failure).toBe(reasons[0]);
    if (chosen === 1) expect(result.skipped).toEqual([{ index: 0, accountProfileId: "a", reason: reasons[0] }]);
  });

  it("keeps default fallbacks for model overrides and drops them for account overrides", () => {
    const defaults = structuredClone(orchestratorDefaults);
    defaults.stages!.planning!.accounts = [{ accountProfileId: "claude-api", model: "first" }, { accountProfileId: "claude-subscription", model: "" }];
    const resolve = (patch: import("../agent-config.js").StageSelectionPatch) => resolveStageAgentConfig({ orchestratorDefaults: defaults, projectConfig: configuredProject({ planning: patch }), accountProfiles });
    const model = resolve({ model: "override" });
    expect(model.mode === "configured" && model.accountFallbacks.planning?.[0].accountProfileId).toBe("claude-subscription");
    const account = resolve({ accountProfileId: "claude-api" });
    expect(account.mode === "configured" && account.accountFallbacks).toEqual({});
  });
});

it("refuses an unsupported profile combination on save and skips it during resolution", async () => {
  const { validateDefaultAccounts } = await import("../agent-config.js");
  const profiles = [...accountProfiles, { id: "invalid", identity: "Invalid", revision: 1, agent: "claude" as const, provider: "openai" as const, authMode: "openai-api-key" as const }];
  const defaults = structuredClone(orchestratorDefaults);
  defaults.stages!.planning!.accounts = [{ accountProfileId: "invalid", model: "m" }, { accountProfileId: "claude-api", model: "m" }];
  expect(() => validateDefaultAccounts(defaults, profiles)).toThrow("planning.accounts[0] does not resolve");
  const resolution = resolveStageAgentConfig({ orchestratorDefaults: defaults, projectConfig: configuredProject(), accountProfiles: profiles });
  expect(resolution.mode === "configured" && resolution.selection.planning).toEqual({ chosen: 1, skipped: [{ index: 0, accountProfileId: "invalid", reason: "resolution_failed" }] });
});
