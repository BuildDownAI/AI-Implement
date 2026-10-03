import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getMappings, initMappingsTable, upsertMapping } from "../../config.js";
import type { LLMExecutor } from "../../pipeline/types.js";
import { ProviderRegistry } from "../../providers/registry.js";
import { validateReviewFixResultMetadata, validateScopedPrIdentity } from "../../review-fix-contract.js";
import { FakeProvider } from "../providers/fake.js";
import {
  makeAppConfig,
  makeContext,
  makeExecutor,
  makeIssue,
  makeJob,
  makeMapping,
  makeProvider,
  makeRegistry,
  makeReviewFixResult,
  makeScopedPrIdentity,
} from "./builders.js";

describe("makeMapping", () => {
  beforeAll(() => {
    initMappingsTable();
  });

  it("builds a mapping the store reads back unchanged", () => {
    upsertMapping("BUILDER", makeMapping());
    expect(getMappings().BUILDER).toEqual(makeMapping());
  });

  it("replaces only the overridden field", () => {
    const paused = makeMapping({ paused: true });
    expect(paused.paused).toBe(true);
    expect({ ...paused, paused: false }).toEqual(makeMapping());
  });

  it("returns fresh nested objects on every call", () => {
    const first = makeMapping();
    first.extraEnv.LEAKED = "1";
    expect(makeMapping().extraEnv).toEqual({});
  });
});

describe("makeJob", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds a just-dispatched implementation job", () => {
    const job = makeJob();
    expect(job).toMatchObject({ status: "dispatched", phase: "implementation", conclusion: null });
    expect(job.dispatchedAt).toBe(Date.now());
  });

  it("replaces only the overridden field", () => {
    const running = makeJob({ status: "running" });
    expect(running.status).toBe("running");
    expect({ ...running, status: "dispatched" }).toEqual(makeJob());
  });
});

describe("makeIssue", () => {
  it("builds an issue a provider can hold and find", async () => {
    const issue = makeIssue();
    const provider = new FakeProvider({ initialIssues: [issue] });
    expect(await provider.findByKey("ENG-1")).toEqual(issue);
    expect((await provider.fetchAIImplementSnapshot()).needsPlanning).toEqual([issue]);
  });

  it("replaces only the overridden field", () => {
    const titled = makeIssue({ title: "Other" });
    expect(titled.title).toBe("Other");
    expect({ ...titled, title: "Test" }).toEqual(makeIssue());
  });
});

describe("makeScopedPrIdentity", () => {
  it("builds an identity the contract validator accepts unchanged", () => {
    const scope = makeScopedPrIdentity();
    expect(validateScopedPrIdentity(scope)).toEqual({ ok: true, value: scope });
  });

  it("replaces only the overridden field", () => {
    const other = makeScopedPrIdentity({ prNumber: 43 });
    expect(other.prNumber).toBe(43);
    expect({ ...other, prNumber: 42 }).toEqual(makeScopedPrIdentity());
  });
});

describe("makeReviewFixResult", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds a result the contract validator accepts unchanged, for the shared PR identity", () => {
    const result = makeReviewFixResult();
    expect(validateReviewFixResultMetadata(result)).toEqual({ ok: true, value: result });
    expect(result).toMatchObject(makeScopedPrIdentity());
  });

  it("builds an attempt whose deadline has not passed", () => {
    expect(makeReviewFixResult().deadlineAt).toBeGreaterThan(Date.now());
  });

  it("replaces only the overridden field", () => {
    const retried = makeReviewFixResult({ githubRunAttempt: 2 });
    expect(retried.githubRunAttempt).toBe(2);
    expect({ ...retried, githubRunAttempt: 1 }).toEqual(makeReviewFixResult());
  });
});

describe("makeExecutor", () => {
  it("resolves every invoke with a clean, empty run", async () => {
    const executor = makeExecutor();
    expect(await executor.invoke({ prompt: "prompt", model: "model" })).toEqual({ stdout: "", exitCode: 0, tokensUsed: 0 });
    expect(executor.invoke).toHaveBeenCalledWith({ prompt: "prompt", model: "model" });
  });

  it("replaces only the overridden result field", async () => {
    const failed = await makeExecutor({ exitCode: 1 }).invoke({ prompt: "prompt", model: "model" });
    expect(failed).toEqual({ stdout: "", exitCode: 1, tokensUsed: 0 });
  });

  it("restores its result after mockReset", async () => {
    const executor = makeExecutor();
    const invoke = vi.mocked(executor.invoke);
    invoke.mockResolvedValue({ stdout: "other", exitCode: 2, tokensUsed: 5 });
    invoke.mockReset();
    expect(await executor.invoke({ prompt: "prompt", model: "model" })).toEqual({ stdout: "", exitCode: 0, tokensUsed: 0 });
  });
});

describe("makeContext", () => {
  it("builds a context whose default executor refuses to run", async () => {
    const ctx = makeContext();
    expect(ctx.data.issueIdentifier).toBe("ENG-1");
    await expect(ctx.llmExecutor.invoke({ prompt: "prompt", model: "model" })).rejects.toThrow("No LLMExecutor provided");
  });

  it("uses the executor it is given", () => {
    const executor: LLMExecutor = { invoke: vi.fn<LLMExecutor["invoke"]>() };
    expect(makeContext({}, executor).llmExecutor).toBe(executor);
  });

  it("replaces only the overridden data field", () => {
    const ctx = makeContext({ issueTitle: "Other" });
    expect(ctx.data.issueTitle).toBe("Other");
    expect({ ...ctx.data, issueTitle: "Test" }).toEqual(makeContext().data);
  });

  it("starts with no step outputs, and keeps outputs set on it", () => {
    const ctx = makeContext();
    expect(ctx.getOutputs("clone")).toEqual({});
    ctx.setOutputs("clone", { workspaceDir: "/tmp/ws" });
    expect(ctx.getOutputs("clone")).toEqual({ workspaceDir: "/tmp/ws" });
  });
});

describe("makeProvider", () => {
  it("resolves every method to a safe value of its own type", async () => {
    const provider = makeProvider();
    const issue = makeIssue();
    expect(provider.id).toBe("linear");
    expect(await provider.fetchAIImplementSnapshot()).toEqual({
      needsPlanning: [],
      readyForImplementation: [],
      inProgressCountsByScope: {},
      parentsToFinalize: [],
    });
    expect(await provider.fetchLifecycleStates(["issue-1"])).toEqual(new Map());
    expect(await provider.fetchFeatureNodeRollUps()).toEqual([]);
    await expect(provider.markPlanningStarted("issue-1", "ENG")).resolves.toBeUndefined();
    await expect(provider.markPlanComplete("issue-1", "ENG")).resolves.toBeUndefined();
    await expect(provider.markPlanningFailed("issue-1", "ENG", "reason")).resolves.toBe(true);
    await expect(provider.markImplementing("issue-1", "ENG")).resolves.toBeUndefined();
    await expect(provider.markPrReady("issue-1", "ENG", "https://github.com/test-org/test-repo/pull/1")).resolves.toBe(true);
    await expect(provider.markImplementationFailed("issue-1", "ENG", "reason")).resolves.toBe(true);
    await expect(provider.clearWorkingState("issue-1", "ENG")).resolves.toBe(true);
    await expect(provider.markMerged("issue-1", "ENG")).resolves.toBeUndefined();
    await expect(provider.postComment("issue-1", "body")).resolves.toBeUndefined();
    expect(await provider.fetchPlanningContext("issue-1")).toBe("");
    expect(provider.issueUrl(issue)).toBe("https://linear.app/issue/ENG-1");
    expect(await provider.findByKey("ENG-1")).toBeNull();
  });

  it("records calls on every method", async () => {
    const provider = makeProvider();
    await provider.markMerged("issue-1", "ENG");
    expect(provider.markMerged).toHaveBeenCalledWith("issue-1", "ENG");
  });

  it("restores a method's default after mockReset", async () => {
    const provider = makeProvider();
    const findByKey = vi.mocked(provider.findByKey);
    findByKey.mockResolvedValue(makeIssue());
    findByKey.mockReset();
    expect(await provider.findByKey("ENG-1")).toBeNull();
  });

  it("replaces only the overridden method", async () => {
    const issue = makeIssue();
    const findByKey = vi.fn(async () => issue);
    const provider = makeProvider({ findByKey });
    expect(provider.findByKey).toBe(findByKey);
    expect(vi.isMockFunction(provider.postComment)).toBe(true);
    await expect(provider.clearWorkingState("issue-1", "ENG")).resolves.toBe(true);
  });
});

describe("makeRegistry", () => {
  const jiraMapping = makeMapping({
    ticketingProvider: "jira",
    ticketingConfig: { kind: "jira", jql: "project = ENG", repoFieldValue: "test-org/test-repo" },
  });

  it("is a real ProviderRegistry", () => {
    expect(makeRegistry()).toBeInstanceOf(ProviderRegistry);
  });

  it("returns the given provider for any mapping", async () => {
    const provider = makeProvider();
    const registry = makeRegistry({ provider });
    expect(await registry.forMapping(makeMapping())).toBe(provider);
    expect(await registry.forMapping(makeMapping({ ticketingProvider: "filesystem" }))).toBe(provider);
  });

  it("keeps the real forAllMappings: one provider per distinct tracker, none for none", async () => {
    const provider = makeProvider();
    const registry = makeRegistry({ provider });
    expect(await registry.forAllMappings([])).toEqual([]);
    expect(await registry.forAllMappings([makeMapping(), makeMapping()])).toEqual([provider]);
    expect(await registry.forAllMappings([makeMapping(), jiraMapping])).toEqual([provider, provider]);
  });

  it("routes each mapping to its tracker's provider when given one per tracker", async () => {
    const linear = makeProvider();
    const jira = makeProvider({ id: "jira" });
    const registry = makeRegistry({ providers: { linear, jira } });
    expect(await registry.forMapping(makeMapping())).toBe(linear);
    expect(await registry.forMapping(jiraMapping)).toBe(jira);
    expect(await registry.forAllMappings([makeMapping(), jiraMapping])).toEqual([linear, jira]);
  });

  it("fails loudly for a tracker with no provider, which the real forAllMappings skips with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const linear = makeProvider();
    const registry = makeRegistry({ providers: { linear } });
    await expect(registry.forMapping(jiraMapping)).rejects.toThrow('makeRegistry has no provider for tracker "jira"');
    expect(await registry.forAllMappings([makeMapping(), jiraMapping])).toEqual([linear]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Skipping provider "jira"'));
    warn.mockRestore();
  });

  it("finds an issue held by two trackers as ambiguous", async () => {
    const issue = makeIssue();
    const linear = makeProvider({ findByKey: vi.fn(async () => issue) });
    const jira = makeProvider({ id: "jira", findByKey: vi.fn(async () => issue) });
    const registry = makeRegistry({ providers: { linear, jira }, mappings: { ENG: makeMapping(), OPS: jiraMapping } });
    expect(await registry.findByKeyInAnyTracker("ENG-1")).toEqual({ kind: "ambiguous", providerIds: ["jira", "linear"] });
  });

  it("refuses one provider and per-tracker providers together, at the type check", () => {
    // A variable, not a literal: a literal is refused by the excess-property check alone.
    const both = { provider: makeProvider(), providers: {} };
    // @ts-expect-error: the two options are mutually exclusive.
    makeRegistry(both);
  });

  it("keeps the real findByKeyInAnyTracker over the given mappings", async () => {
    const issue = makeIssue();
    const provider = makeProvider({ findByKey: vi.fn(async () => issue) });
    expect(await makeRegistry({ provider }).findByKeyInAnyTracker("ENG-1")).toEqual({ kind: "none", failedProviderIds: [] });
    expect(
      await makeRegistry({ provider, mappings: { ENG: makeMapping() } }).findByKeyInAnyTracker("ENG-1"),
    ).toEqual({ kind: "found", provider, issue, failedProviderIds: [] });
  });
});

describe("makeAppConfig", () => {
  it("builds a config with every optional integration off", () => {
    const config = makeAppConfig();
    expect(config).toMatchObject({
      notifyWebhookUrl: null,
      flySessionsToken: null,
      runnerCallbackBaseUrl: null,
      runnerTokenSecret: null,
      kgSidecarUrl: null,
      selfDeployTarget: null,
    });
  });

  it("replaces only the overridden field", () => {
    const fly = makeAppConfig({ flySessionsApp: "sessions" });
    expect(fly.flySessionsApp).toBe("sessions");
    expect({ ...fly, flySessionsApp: null }).toEqual(makeAppConfig());
  });
});
