import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { makeMapping, makeReviewFixRunConfig } from "./helpers/builders.js";
import { decodeRunConfig } from "../run-config.js";
import type { DispatchFlyGapfillInput } from "../gapfill-launch.js";

const mocks = vi.hoisted(() => ({ create: vi.fn(), bootstrap: vi.fn() }));
vi.mock("../fly-machines.js", async (original) => ({
  ...await original<typeof import("../fly-machines.js")>(),
  createMachine: mocks.create,
  generateSessionToken: () => "fixed-session-token",
  generateMachineNonce: () => "fixed-machine-nonce",
  listAppSecrets: vi.fn(async () => []),
}));
vi.mock("../repo-image.js", () => ({ resolveSessionImage: vi.fn(async () => ({ image: "runner:latest", source: "default" })) }));
vi.mock("../orchestrator-settings.js", async (original) => ({ ...await original<typeof import("../orchestrator-settings.js")>(), getRetryPolicy: () => null }));
vi.mock("../fly-protection-key.js", () => ({ buildProtectedFlyBootstrap: mocks.bootstrap }));
const { dispatchFlyGapfill } = await import("../gapfill-launch.js");

function input(extra: Partial<DispatchFlyGapfillInput> = {}): DispatchFlyGapfillInput {
  return {
    mapping: makeMapping(), issue: { issueId: "i", issueIdentifier: "AII-1", issueTitle: "title" },
    owner: "acme", repo: "billing", prNumber: 7, issueIdentifier: "AII-1", githubToken: "gh",
    scopeKey: "AII", allTeamKeys: [], flySessionsToken: "fly", flySessionsApp: "sessions",
    flySessionsRegion: null, flyOrchestratorApp: null, sessionImage: "runner:latest",
    runnerCallbackBaseUrl: "https://orch.example", tenantId: null, anthropicApiKey: "key", claudeOAuthToken: null,
    runnerCallbackUrl: "https://orch.example/callback", runToken: "result", runProgressToken: "progress",
    decision: { kind: "legacy" }, onBeforeLaunch: vi.fn(), ...extra,
  };
}
beforeEach(() => { mocks.create.mockReset(); mocks.create.mockImplementation(async (_token, _app, config) => ({ id: "m", name: config.name, config: config.config })); });

it("preserves defaults and returns only safe machine identity", async () => {
  const result = await dispatchFlyGapfill(input());
  const config = mocks.create.mock.calls[0]![2];
  expect(config.name).toBe("session-aii-1");
  expect(config.config.metadata).not.toHaveProperty("dispatch_id");
  expect(decodeRunConfig(config.config.env.AI_IMPLEMENT_RUN_CONFIG)).not.toHaveProperty("reviewFix");
  expect(result).toEqual({ machine: { id: "m", name: "session-aii-1" }, resolvedImage: "runner:latest" });
});
it("carries a supplied baseBranch and omits it when not given", async () => {
  await dispatchFlyGapfill(input({ baseBranch: "ai-implement/feature/eng-7" }));
  expect(decodeRunConfig(mocks.create.mock.calls.at(-1)![2].config.env.AI_IMPLEMENT_RUN_CONFIG).baseBranch).toBe("ai-implement/feature/eng-7");
  await dispatchFlyGapfill(input());
  expect(decodeRunConfig(mocks.create.mock.calls.at(-1)![2].config.env.AI_IMPLEMENT_RUN_CONFIG)).not.toHaveProperty("baseBranch");
});
it("carries a supplied issue description on Fly and falls back when it is blank", async () => {
  const body = "Current tracker body with acceptance criteria";
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await dispatchFlyGapfill(input({ issueDescription: body }));
    const machine = mocks.create.mock.calls.at(-1)![2];
    expect(decodeRunConfig(machine.config.env.AI_IMPLEMENT_RUN_CONFIG).issue.description).toBe(body);
    expect(machine.config.env.ISSUE_DESCRIPTION).toBe(body);
    expect(log.mock.calls.map(([line]) => String(line)).join("\n")).not.toContain(body);

    await dispatchFlyGapfill(input({ issueDescription: "   " }));
    const fallback = mocks.create.mock.calls.at(-1)![2];
    expect(decodeRunConfig(fallback.config.env.AI_IMPLEMENT_RUN_CONFIG).issue.description).toBe("title");
    expect(fallback.config.env.ISSUE_DESCRIPTION).toBe("title");
  } finally {
    log.mockRestore();
  }
});
it("preserves the previous environment and run config for omitted and explicit agent-default", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const machines = [];
    for (const implementationSandbox of [undefined, { sandbox: "agent-default", reason: "unprotected" }, { sandbox: "agent-default", reason: "process-secrets-off" }] as const) {
      await dispatchFlyGapfill(input({ implementationSandbox }));
      const machine = mocks.create.mock.calls.at(-1)![2];
      expect(machine.config.metadata.implementation_sandbox).toBe(`agent-default:${implementationSandbox?.reason ?? "unprotected"}`);
      expect(log).toHaveBeenLastCalledWith(expect.stringContaining(`implementation_sandbox: agent-default:${implementationSandbox?.reason ?? "unprotected"}`));
      machines.push(machine);
    }
    const env = machines[0].config.env;
    expect({ ...env, AI_IMPLEMENT_RUN_CONFIG: decodeRunConfig(env.AI_IMPLEMENT_RUN_CONFIG) }).toEqual({
      "AI_IMPLEMENT_RUN_CONFIG": {
        "issue": {
          "description": "title",
          "id": "i",
          "identifier": "AII-1",
          "title": "title",
        },
        "prNumber": "7",
        "retryPolicy": {
          "backoffInitialMs": 30000,
          "backoffJitter": 0.2,
          "backoffMaxMs": 300000,
          "pushRetries": 2,
          "requestRetries": 2,
          "reviewMaxTurns": 30,
          "stageRetries": 1,
        },
        "runnerCallbackUrl": "https://orch.example/callback",
        "runnerPhase": "gap-analysis",
        "v": 1,
      },
      "ANTHROPIC_API_KEY": "key",
      "GITHUB_DEFAULT_BRANCH": "main",
      "GITHUB_OWNER": "acme",
      "GITHUB_REPO": "billing",
      "GITHUB_TOKEN": "gh",
      "ISSUE_DESCRIPTION": "title",
      "ISSUE_ID": "i",
      "ISSUE_IDENTIFIER": "AII-1",
      "ISSUE_TITLE": "title",
      "MACHINE_NONCE": "fixed-machine-nonce",
      "ORCHESTRATOR_URL": "https://orch.example",
      "RUNNER_CALLBACK_URL": "https://orch.example/callback",
      "RUNNER_PHASE": "implementation",
      "RUN_PROGRESS_TOKEN": "progress",
      "RUN_TOKEN": "result",
      "SESSION_TOKEN": "fixed-session-token",
    });
    for (const machine of machines.slice(1)) {
      expect(machine.config.env).toEqual(env);
      expect(machine).toEqual({ ...machines[0], config: { ...machines[0].config, metadata: { ...machines[0].config.metadata, implementation_sandbox: machine.config.metadata.implementation_sandbox } } });
    }
  } finally {
    log.mockRestore();
  }
});

it("passes the resolved repository image to persistence before creating the machine", async () => {
  const { resolveSessionImage } = await import("../repo-image.js");
  vi.mocked(resolveSessionImage).mockResolvedValueOnce({ image: "repo:override", source: "override" });
  const onBeforeLaunch = vi.fn();
  mocks.create.mockImplementationOnce(async (_token, _app, config) => {
    expect(onBeforeLaunch).toHaveBeenCalledWith(expect.any(Object), expect.any(String), "repo:override");
    expect(config.config.image).toBe("repo:override");
    throw new Error("lost acknowledgement");
  });
  await expect(dispatchFlyGapfill(input({ onBeforeLaunch }))).rejects.toThrow("lost acknowledgement");
});
it("carries the run name, dispatch metadata and backend-aware marker", async () => {
  const reviewFix = makeReviewFixRunConfig({ executionBackend: "fly-machines" }).reviewFix;
  await dispatchFlyGapfill(input({ runName: "review-d-1", dispatchId: "d-1", reviewFix }));
  const config = mocks.create.mock.calls[0]![2];
  expect(config.name).toBe("review-d-1");
  expect(config.config.metadata.dispatch_id).toBe("d-1");
  expect(decodeRunConfig(config.config.env.AI_IMPLEMENT_RUN_CONFIG).reviewFix).toEqual(reviewFix);
});
it("rejects invalid names before the launch hook", async () => {
  const args = input({ runName: "bad/name" });
  await expect(dispatchFlyGapfill(args)).rejects.toThrow(/runName/);
  expect(args.onBeforeLaunch).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
});
it("rejects conflicting protected dispatch ids before consuming bootstrap", async () => {
  const takeBootstrap = vi.fn();
  const args = input({ dispatchId: "other", decision: { kind: "launch", dispatchId: "d-1", takeBootstrap } as never });
  await expect(dispatchFlyGapfill(args)).rejects.toThrow(/dispatchId mismatch/);
  expect(takeBootstrap).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
});

it.each([[true, true], [false, true], [true, false]] as const)("preserves protected policy delivery (isolated=%s builderSecrets=%s)", async (isolated, builderSecrets) => {
  const { setFlyProcessLevelSecrets, initSettingsTable } = await import("../runner-mode.js");
  initSettingsTable();
  setFlyProcessLevelSecrets(true);
  const { sealModelAuthBootstrap } = await import("../model-auth-seal.js");
  const { MODEL_AUTH_ENV } = await import("../model-auth-contract.js");
  const { decodeTrustedRunConfig } = await import("../run-config.js");
  const grant = {
    version: 1, audience: "model-auth", grantId: "grant-1", dispatchId: "d-1", projectKey: "AII",
    snapshotId: "snap-1", backend: "fly", expiresAt: Date.now() + 60_000, bearer: "test-bearer-0123456789abcdefghijklmnop",
    bindings: [{ stage: "implementation", profileId: "sub", profileRevision: 1, authMode: "claude-subscription" }],
  };
  mocks.bootstrap.mockImplementation(async (args) => {
    setFlyProcessLevelSecrets(builderSecrets);
    return ({
    sealed: sealModelAuthBootstrap({ grant, protectionKey: { ref: MODEL_AUTH_ENV.protectionKey, key: Buffer.alloc(32, 1) } }),
    projectKey: args.projectKey, modelAuthUrl: args.modelAuthUrl, runConfig: args.runConfig,
    secret: { name: MODEL_AUTH_ENV.protectionKey, available: true, version: 7 },
  }); });
  const reviewFix = makeReviewFixRunConfig({ executionBackend: "fly-machines" }).reviewFix;
  const launching = dispatchFlyGapfill(input({ reviewFix, implementationSandbox: isolated ? { sandbox: "runner-isolated" } : { sandbox: "agent-default", reason: "process-secrets-off" }, decision: {
    kind: "launch", dispatchId: "d-1", projectKey: "AII", backend: "fly-machines",
    snapshot: JSON.parse(readFileSync(new URL("./helpers/fixtures/managed-run-config-pre-fallbacks.json", import.meta.url), "utf8")).agentConfig,
    fallbackModels: {}, grant: {} as never,
    takeBootstrap: () => grant as never,
  } }));
  if (!builderSecrets) {
    await expect(launching).rejects.toThrow(/process-level secrets/);
    expect(mocks.create).not.toHaveBeenCalled();
    setFlyProcessLevelSecrets(true);
    return;
  }
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await launching;
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining(`implementation_sandbox: ${isolated ? "runner-isolated" : "agent-default:process-secrets-off"}`));
  } finally {
    log.mockRestore();
  }
  const config = mocks.create.mock.calls[0]![2];
  expect(config.config.metadata.dispatch_id).toBe("d-1");
  expect(decodeTrustedRunConfig(config.config.env.AI_IMPLEMENT_RUN_CONFIG).reviewFix).toEqual(reviewFix);
  const policy = decodeTrustedRunConfig(config.config.env.AI_IMPLEMENT_RUN_CONFIG).credentials?.executionPolicy;
  expect(policy).toEqual(isolated ? { version: 1, implementationSandbox: "ephemeral-full-access", backend: "fly", dispatchId: "d-1", projectKey: "AII", ephemeralRunnerAsserted: true } : undefined);
  expect(config.config.metadata.implementation_sandbox).toBe(isolated ? "runner-isolated" : "agent-default:process-secrets-off");
});

it("carries advisory mode in Fly and GHA envelopes and rejects legacy GHA", async () => {
  const reviewOnly = { reviewers: [{ id: "integration-review", gates: true }] };
  await dispatchFlyGapfill(input({ reviewOnly }));
  expect(decodeRunConfig(mocks.create.mock.calls[0][2].config.env.AI_IMPLEMENT_RUN_CONFIG).reviewOnly).toEqual(reviewOnly);
  const { prepareGhaGapfillLaunch } = await import("../gapfill-launch.js");
  const args = {
    mapping: makeMapping(), issue: { issueId: "i" }, item: { owner: "acme", repo: "billing", prNumber: 7 },
    ghToken: "gh", decision: { kind: "legacy" as const }, runnerCallbackBaseUrl: null,
    runnerCallbackUrl: "", runToken: "", runProgressToken: "", reviewOnly,
    resolveRunnerImage: async () => undefined, checkContract: async () => "envelope" as const,
  };
  const launch = await prepareGhaGapfillLaunch(args);
  expect(decodeRunConfig(launch.inputs.run_config!).reviewOnly).toEqual(reviewOnly);
  await expect(prepareGhaGapfillLaunch({ ...args, checkContract: async () => "legacy" as const })).rejects.toThrow(/review-only requires/);
});
it("carries a supplied issue description in GHA envelope and legacy inputs", async () => {
  const { prepareGhaGapfillLaunch } = await import("../gapfill-launch.js");
  const body = "Current tracker body with acceptance criteria";
  const args = {
    mapping: makeMapping(), issue: { issueId: "i", issueIdentifier: "AII-1", issueTitle: "title" },
    item: { owner: "acme", repo: "billing", prNumber: 7 },
    ghToken: "gh", decision: { kind: "legacy" as const }, runnerCallbackBaseUrl: null,
    runnerCallbackUrl: "", runToken: "", runProgressToken: "", issueDescription: body,
    resolveRunnerImage: async () => undefined, checkContract: async () => "envelope" as const,
  };
  const envelope = await prepareGhaGapfillLaunch(args);
  expect(decodeRunConfig(envelope.inputs.run_config!).issue.description).toBe(body);

  const legacy = await prepareGhaGapfillLaunch({ ...args, checkContract: async () => "legacy" as const });
  expect(legacy.inputs.issue_description).toBe(body);
  expect(legacy.inputs.issue_title).toBe("title");

  const omitted = await prepareGhaGapfillLaunch({ ...args, issueDescription: undefined });
  expect(decodeRunConfig(omitted.inputs.run_config!).issue.description).toBe("title");
  const omittedLegacy = await prepareGhaGapfillLaunch({ ...args, issueDescription: undefined, checkContract: async () => "legacy" as const });
  expect(omittedLegacy.inputs.issue_description).toBe("title");
});


it.each([
  { machineCpuKind: "shared" as const, review: false },
  { machineCpuKind: "performance" as const, review: false },
  { machineCpuKind: "performance" as const, review: true },
])("builds the configured guest for gap-fill/review-fix: %j", async ({ machineCpuKind, review }) => {
  await dispatchFlyGapfill(input({
    mapping: makeMapping({ machineCpuKind, machineCpus: 4, machineMemoryMb: 8192 }),
    ...(review ? { reviewFix: makeReviewFixRunConfig({ executionBackend: "fly-machines" }).reviewFix } : {}),
  }));
  expect(mocks.create.mock.calls[0][2].config.guest).toEqual({
    cpu_kind: machineCpuKind, cpus: 4, memory_mb: 8192,
  });
});
