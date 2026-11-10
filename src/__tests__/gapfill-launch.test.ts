import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { makeMapping, makeReviewFixRunConfig } from "./helpers/builders.js";
import { decodeRunConfig } from "../run-config.js";
import type { DispatchFlyGapfillInput } from "../gapfill-launch.js";

const mocks = vi.hoisted(() => ({ create: vi.fn(), bootstrap: vi.fn() }));
vi.mock("../fly-machines.js", async (original) => ({
  ...await original<typeof import("../fly-machines.js")>(),
  createMachine: mocks.create,
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

it("preserves reviewFix in protected delivery and falls back to the managed dispatch id", async () => {
  const { sealModelAuthBootstrap } = await import("../model-auth-seal.js");
  const { MODEL_AUTH_ENV } = await import("../model-auth-contract.js");
  const { decodeTrustedRunConfig } = await import("../run-config.js");
  const grant = {
    version: 1, audience: "model-auth", grantId: "grant-1", dispatchId: "d-1", projectKey: "AII",
    snapshotId: "snap-1", backend: "fly", expiresAt: Date.now() + 60_000, bearer: "test-bearer-0123456789abcdefghijklmnop",
    bindings: [{ stage: "implementation", profileId: "sub", profileRevision: 1, authMode: "claude-subscription", ownerGeneration: 3 }],
  };
  mocks.bootstrap.mockImplementation(async (args) => ({
    sealed: sealModelAuthBootstrap({ grant, protectionKey: { ref: MODEL_AUTH_ENV.protectionKey, key: Buffer.alloc(32, 1) } }),
    projectKey: args.projectKey, modelAuthUrl: args.modelAuthUrl, runConfig: args.runConfig,
    secret: { name: MODEL_AUTH_ENV.protectionKey, available: true, version: 7 },
  }));
  const reviewFix = makeReviewFixRunConfig({ executionBackend: "fly-machines" }).reviewFix;
  await dispatchFlyGapfill(input({ reviewFix, decision: {
    kind: "launch", dispatchId: "d-1", projectKey: "AII", backend: "fly-machines",
    snapshot: JSON.parse(readFileSync(new URL("./helpers/fixtures/managed-run-config-pre-fallbacks.json", import.meta.url), "utf8")).agentConfig,
    fallbackModels: {}, grant: {} as never,
    takeBootstrap: () => grant as never,
  } }));
  const config = mocks.create.mock.calls[0]![2];
  expect(config.config.metadata.dispatch_id).toBe("d-1");
  expect(decodeTrustedRunConfig(config.config.env.AI_IMPLEMENT_RUN_CONFIG).reviewFix).toEqual(reviewFix);
});
