import { accountCombinations } from "./helpers/account-combinations.js";
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
  it.each(accountCombinations)("resolve combination $agent/$provider/$authMode: $permitted", ({ permitted, ...combo }) => {
    const defaults = structuredClone(orchestratorDefaults);
    defaults.stages!.planning = { ...defaults.stages!.planning!, agent: combo.agent, provider: combo.provider };
    const profiles = accountProfiles.map(profile => profile.id === "claude-api" ? { ...profile, ...combo } : profile);
    const resolve = () => resolveStageAgentConfig({ orchestratorDefaults: defaults, projectConfig: configuredProject(), accountProfiles: profiles });
    if (permitted) expect(resolve().mode).toBe("configured");
    else expect(resolve).toThrow(/unsupported .* provider\/authentication combination/);
  });

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

  it("rejects incompatible fields and project accounts", () => {
    expectError(
      () =>
        resolveStageAgentConfig({
          orchestratorDefaults,
          projectConfig: configuredProject({ implementation: { provider: "anthropic" } }),
          accountProfiles,
        }),
      /provider does not match/,
    );

    expect(() => resolveStageAgentConfig({
      orchestratorDefaults,
      projectConfig: configuredProject({ implementation: { accountProfileId: "claude-api" } }),
      accountProfiles,
    })).toThrow(StageAccountError);
  });

  it("rejects unknown project profiles and disabled defaults", () => {
    expect(() => resolveStageAgentConfig({
      orchestratorDefaults,
      projectConfig: configuredProject({ implementation: { accountProfileId: "missing" } }),
      accountProfiles,
    })).toThrow(StageAccountError);

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

  it("keeps default fallbacks for model and account overrides", () => {
    const defaults = structuredClone(orchestratorDefaults);
    defaults.stages!.planning!.accounts = [{ accountProfileId: "claude-api", model: "first" }, { accountProfileId: "claude-subscription", model: "" }];
    const resolve = (patch: import("../agent-config.js").StageSelectionPatch) => resolveStageAgentConfig({ orchestratorDefaults: defaults, projectConfig: configuredProject({ planning: patch }), accountProfiles });
    const model = resolve({ model: "override" });
    expect(model.mode === "configured" && model.accountFallbacks.planning?.[0].accountProfileId).toBe("claude-subscription");
    const account = resolve({ accountProfileId: "claude-api" });
    expect(account.mode === "configured" && account.accountFallbacks.planning?.map(e => e.accountProfileId)).toEqual(["claude-subscription"]);
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

it.each(["openai-api", "claude-api"])("drops fallback model metadata when dispatch selects another provider: %s", id => {
  const defaults = structuredClone(orchestratorDefaults);
  defaults.stages!.planning!.accounts = [{ accountProfileId: "claude-bedrock", model: "bedrock-model" }, { accountProfileId: id, model: "selected-model" }];
  defaults.stages!.planning!.fallbackModel = "claude-backup";
  defaults.stages!.review!.accountProfileId = "claude-api";
  defaults.stages!.review!.provider = "anthropic";
  const result = resolveStageAgentConfig({ orchestratorDefaults: defaults, projectConfig: configuredProject(), accountProfiles,
    checkAccount: entry => entry.provider === "bedrock" ? "unsupported_combination" : null });
  if (result.mode !== "configured") throw new Error("expected configured");
  expect(result.stages.planning.accountProfileId).toBe(id);
  expect(result.fallbackModels).toEqual({});
  expect(result.fallbackModelSources).toEqual({});
});

it("refuses blank fallback models across providers while allowing same-provider inheritance", async () => {
  const { validateDefaultAccounts } = await import("../agent-config.js");
  const defaults = structuredClone(orchestratorDefaults);
  defaults.stages!.planning!.accounts = [{ accountProfileId: "claude-api", model: "claude-model" }, { accountProfileId: "claude-bedrock", model: "" }];
  expect(() => validateDefaultAccounts(defaults, accountProfiles)).toThrow(/requires a model/);
  defaults.stages!.planning!.accounts[1].accountProfileId = "claude-subscription";
  expect(() => validateDefaultAccounts(defaults, accountProfiles)).not.toThrow();
});

describe("project accounts followed by orchestrator defaults", () => {
  const list = [
    { accountProfileId: "claude-api", model: "default-model" },
    { accountProfileId: "claude-subscription", model: "" },
  ];
  it.each([
    { name: "inherits a list", accounts: true, patch: {}, expected: [["claude-api", "default-model"], ["claude-subscription", "default-model"]] },
    { name: "inherits flat defaults", accounts: false, patch: {}, expected: [["claude-api", "claude-sonnet-5-5"]] },
    { name: "prepends to a list and normalizes blank default models", accounts: true, patch: { accountProfileId: "claude-bedrock", provider: "bedrock", model: "project-model" }, expected: [["claude-bedrock", "project-model"], ["claude-api", "default-model"], ["claude-subscription", "default-model"]] },
    { name: "prepends to flat defaults", accounts: false, patch: { accountProfileId: "claude-bedrock", provider: "bedrock", model: "project-model" }, expected: [["claude-bedrock", "project-model"], ["claude-api", "claude-sonnet-5-5"]] },
    { name: "deduplicates the first default before inheriting blank models", accounts: true, patch: { accountProfileId: "claude-api", model: "project-model" }, expected: [["claude-api", "project-model"], ["claude-subscription", "default-model"]] },
    { name: "preserves model-only list overrides", accounts: true, patch: { model: "project-model" }, expected: [["claude-api", "project-model"], ["claude-subscription", "project-model"]] },
    { name: "preserves model-only flat overrides", accounts: false, patch: { model: "project-model" }, expected: [["claude-api", "project-model"]] },
    { name: "deduplicates a flat default", accounts: false, patch: { accountProfileId: "claude-api", model: "project-model" }, expected: [["claude-api", "project-model"]] },
    { name: "drops paid defaults after a subscription project", accounts: true, patch: { accountProfileId: "openai-subscription", agent: "codex", provider: "openai", model: "project-model" }, expected: [["openai-subscription", "project-model"], ["claude-subscription", "default-model"]] },
  ])("$name", ({ accounts, patch, expected }) => {
    const defaults = structuredClone(orchestratorDefaults);
    if (accounts) defaults.stages!.planning!.accounts = structuredClone(list);
    const result = resolveStageAgentConfig({ orchestratorDefaults: defaults, projectConfig: configuredProject({ planning: patch as import("../agent-config.js").StageSelectionPatch }), accountProfiles });
    if (result.mode !== "configured") throw new Error("expected configured");
    expect(result.accountEntries!.planning!.map(e => [e.accountProfileId, e.model])).toEqual(expected);
    expect([result.stages.planning, ...(result.accountFallbacks.planning ?? [])].map(e => [e.accountProfileId, e.model])).toEqual(expected);
  });

  it("drops paid entries after an earlier retained subscription", () => {
    const defaults = structuredClone(orchestratorDefaults);
    defaults.stages!.planning!.accounts = [...list, { accountProfileId: "openai-api", model: "paid" }];
    const result = resolveStageAgentConfig({ orchestratorDefaults: defaults,
      projectConfig: configuredProject({ planning: { accountProfileId: "claude-bedrock", provider: "bedrock" } }), accountProfiles });
    if (result.mode !== "configured") throw new Error("expected configured");
    expect(result.accountEntries!.planning!.map(e => e.accountProfileId)).toEqual(["claude-bedrock", "claude-api", "claude-subscription"]);
  });

  it.each(["missing", "disabled", "backend"] as const)("refuses a %s project account even when a default passes", reason => {
    const defaults = structuredClone(orchestratorDefaults);
    Object.assign(defaults.stages!.review!, { accountProfileId: "claude-subscription", provider: "anthropic" });
    expect(() => resolveStageAgentConfig({ orchestratorDefaults: defaults,
      projectConfig: configuredProject({ planning: { accountProfileId: reason === "missing" ? "missing" : "claude-bedrock", provider: "bedrock", model: "project-model" } }),
      accountProfiles: accountProfiles.map(p => ({ ...p, disabled: reason === "disabled" && p.id === "claude-bedrock" })),
      checkAccount: e => reason === "backend" && e.accountProfileId === "claude-bedrock" ? "unsupported_combination" : null,
    })).toThrow(new StageAccountError("planning", reason === "backend" ? "unsupported_combination" : "resolution_failed"));
  });
});

it.each([false, true])("refuses a failed project account before handling fallback model collisions (list=%s)", accounts => {
  const defaults = structuredClone(orchestratorDefaults);
  defaults.stages!.planning!.fallbackModel = defaults.stages!.planning!.model;
  if (accounts) defaults.stages!.planning!.accounts = [{ accountProfileId: "claude-api", model: defaults.stages!.planning!.model! }];
  expect(() => resolveStageAgentConfig({ orchestratorDefaults: defaults,
    projectConfig: configuredProject({ planning: { accountProfileId: "missing", model: "project-model" } }), accountProfiles
  })).toThrow(new StageAccountError("planning", "resolution_failed"));
});

it("checks appended defaults and preserves their diagnostic failure reasons", () => {
  const defaults = structuredClone(orchestratorDefaults);
  Object.assign(defaults.stages!.review!, { accountProfileId: "claude-subscription", provider: "anthropic" });
  defaults.stages!.planning!.accounts = [
    { accountProfileId: "missing", model: "default-model" },
    { accountProfileId: "claude-bedrock", model: "bedrock-model" },
    { accountProfileId: "claude-api", model: "api-model" },
    { accountProfileId: "claude-subscription", model: "" },
  ];
  const result = resolveStageAgentConfig({ orchestratorDefaults: defaults,
    projectConfig: configuredProject({ planning: { accountProfileId: "openai-api", agent: "codex", provider: "openai", model: "project-model" } }),
    accountProfiles: accountProfiles.map(p => ({ ...p, disabled: p.id === "claude-api" })),
    checkAccount: e => e.accountProfileId === "claude-bedrock" ? "unsupported_combination" : null });
  if (result.mode !== "configured") throw new Error("expected configured");
  expect(result.accountEntries!.planning!.map(e => e.reason)).toEqual([null, "resolution_failed", "unsupported_combination", "resolution_failed", null]);
  expect(result.accountFallbacks.planning?.map(e => [e.accountProfileId, e.model])).toEqual([["claude-subscription", "default-model"]]);
});

it("refuses a failed project account before considering another provider", () => {
  expect(() => resolveStageAgentConfig({ orchestratorDefaults,
    projectConfig: configuredProject({ planning: { accountProfileId: "missing", provider: "bedrock", model: "project-model", fallbackModel: "bedrock-fallback" } }), accountProfiles
  })).toThrow(new StageAccountError("planning", "resolution_failed"));
});

it.each([false, true])("retains flat-default fallback metadata for a passing project account (provider change=%s)", changesProvider => {
  const defaults = structuredClone(orchestratorDefaults);
  defaults.stages!.planning!.fallbackModel = "default-backup";
  const result = resolveStageAgentConfig({ orchestratorDefaults: defaults,
    projectConfig: configuredProject({ planning: {
      accountProfileId: changesProvider ? "claude-bedrock" : "claude-api",
      provider: changesProvider ? "bedrock" : "anthropic", model: "project-model", fallbackModel: "project-backup",
    } }), accountProfiles });
  if (result.mode !== "configured") throw new Error("expected configured");
  expect(result.selection.planning).toEqual({ chosen: 0, skipped: [] });
  expect(result.sources.planning).toMatchObject({ accountProfileId: "project", provider: "project", model: "project" });
  expect(result.profiles.planning).toMatchObject({ id: changesProvider ? "claude-bedrock" : "claude-api" });
  expect(result.fallbackModels).toEqual({ planning: "project-backup" });
  expect(result.fallbackModelSources).toEqual({ planning: "project" });
  expect(result.accountFallbacks.planning ?? []).toEqual(changesProvider ? [expect.objectContaining({
    accountProfileId: "claude-api", model: "claude-sonnet-5-5", provider: "anthropic", profileRevision: 1, authMode: "anthropic-api-key",
  })] : []);
});

it.each([false, true])("checks fallback model collisions with a passing project account (list=%s)", accounts => {
  const defaults = structuredClone(orchestratorDefaults);
  defaults.stages!.planning!.fallbackModel = "default-backup";
  if (accounts) defaults.stages!.planning!.accounts = [{ accountProfileId: "claude-api", model: "default-model" }];
  const resolve = (model: string) => resolveStageAgentConfig({ orchestratorDefaults: defaults,
    projectConfig: configuredProject({ planning: { accountProfileId: "claude-bedrock", provider: "bedrock", model } }), accountProfiles });
  const result = resolve("project-model");
  if (result.mode !== "configured") throw new Error("expected configured");
  expect(result.fallbackModels).toEqual({ planning: "default-backup" });
  expect(result.fallbackModelSources).toEqual({ planning: "orchestrator-default" });
  expect(result.accountFallbacks.planning?.[0].accountProfileId).toBe("claude-api");
  expect(() => resolve("default-backup")).toThrow("planning.fallbackModel must differ from model");
});

describe("preferOpenModel stored stub", () => {
  const resolve = (patch: Record<string, unknown>) => resolveStageAgentConfig({
    orchestratorDefaults, accountProfiles,
    projectConfig: { version: 1, mode: "configured", stages: { implementation: patch } } as StageAgentConfigurationV1,
  });

  it.each([true, false, undefined])("accepts project implementation value %s without changing resolution", (value) => {
    expect(resolve(value === undefined ? {} : { preferOpenModel: value })).toEqual(resolve({}));
  });
  it("resolves true and false identically, including account selections and fallbacks", () => {
    const resolveWithAccounts = (preferOpenModel: boolean) => resolveStageAgentConfig({
      orchestratorDefaults: {
        ...orchestratorDefaults,
        stages: {
          ...orchestratorDefaults.stages,
          implementation: {
            ...orchestratorDefaults.stages!.implementation,
            accounts: [
              { accountProfileId: "openai-api", model: "gpt-5.5-codex" },
              { accountProfileId: "openai-subscription", model: "" },
            ],
          },
        },
      },
      accountProfiles,
      projectConfig: { version: 1, mode: "configured", stages: { implementation: { preferOpenModel } } },
    });
    const enabled = resolveWithAccounts(true);
    expect(enabled).toEqual(resolveWithAccounts(false));
    expect(enabled.mode).toBe("configured");
    if (enabled.mode === "configured") {
      expect(enabled.accountFallbacks.implementation).toHaveLength(1);
      expect(enabled.stages.implementation).not.toHaveProperty("preferOpenModel");
      expect(enabled.sources.implementation).not.toHaveProperty("preferOpenModel");
    }
  });
  it.each([null, "true", 1, {}, []])("rejects nonboolean %s", (value) => {
    expect(() => resolve({ preferOpenModel: value })).toThrow("must be a boolean");
  });
  it.each(["planning", "review"] as const)("rejects project %s presence", (stage) => {
    expect(() => resolveStageAgentConfig({
      orchestratorDefaults, accountProfiles,
      projectConfig: { version: 1, mode: "configured", stages: { [stage]: { preferOpenModel: false } } },
    })).toThrow("only supported");
  });
  it.each(["planning", "implementation", "review"] as const)("rejects defaults %s presence", (stage) => {
    expect(() => resolveStageAgentConfig({
      orchestratorDefaults: { ...orchestratorDefaults, stages: { ...orchestratorDefaults.stages, [stage]: { preferOpenModel: false } } },
      accountProfiles, projectConfig: { version: 1, mode: "configured" },
    })).toThrow("only supported");
  });
});
