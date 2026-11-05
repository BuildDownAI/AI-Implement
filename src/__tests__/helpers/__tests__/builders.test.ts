import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { parseChatGptPlanRecord } from "../../../chatgpt-plan-token.js";
import { getMappings, initMappingsTable, upsertMapping } from "../../../config.js";
import { runDevHarnessCli } from "../../../dev-harness/cli.js";
import { clearTokenCache, getScopedInstallationToken } from "../../../github-app-auth.js";
import { parseTaskFile } from "../../../dev-harness/task-file.js";
import { parseModelAuthGrantBootstrap, toSafeGrantMetadata } from "../../../model-auth-contract.js";
import { normalizeRetryPolicy } from "../../../pipeline/retry-backoff.js";
import { ProviderRegistry } from "../../../providers/registry.js";
import { validateReviewFixResultMetadata, validateScopedPrIdentity } from "../../../review-fix-contract.js";
import { decodeRunConfig, encodeRunConfig } from "../../../run-config.js";
import { FakeProvider } from "../../providers/fake.js";
import { fakeFetch } from "../fake-fetch.js";
import { testDb } from "../test-db.js";
import {
  makeAccessEntry,
  makeAppConfig,
  makeAppendLogEntry,
  makeChatGptPlanRecord,
  makeContext,
  makeExecutor,
  makeFeedbackLoopOutputs,
  makeIssue,
  makeJob,
  makeMapping,
  makeProvider,
  makeRegistry,
  makeReviewFixResult,
  makeReviewFixRunConfig,
  makeScopedInstallationToken,
  makeScopedPrIdentity,
} from "../builders.js";
import { makeLaunchDecision, makeSnapshot } from "../fixtures/configured-run.js";
import { makeDevHarnessCliDeps, makeDevRunHandle, makeTaskFile } from "../fixtures/dev-harness.js";

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
    expect({ ...paused, paused: makeMapping().paused }).toEqual(makeMapping());
  });

  it("returns fresh nested objects on every call", () => {
    const first = makeMapping();
    first.extraEnv.LEAKED = "1";
    expect(makeMapping().extraEnv).toEqual({});
  });
});

describe("makeAccessEntry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds the entry an admin's own save stores and reads back", async () => {
    const { access } = (await testDb({ modules: { access: () => import("../../../access-entries.js") } })).modules;
    const entry = makeAccessEntry();
    access.saveAccessEntries([{ kind: entry.kind, value: entry.value, role: entry.role }], "admin@example.com");
    expect(access.listAccessEntries()).toEqual([entry]);
  });

  it("replaces only the overridden field", () => {
    const user = makeAccessEntry({ role: "user" });
    expect(user.role).toBe("user");
    expect({ ...user, role: makeAccessEntry().role }).toEqual(makeAccessEntry());
  });

  it("returns fresh bindings on every call", () => {
    makeAccessEntry().bindings.push({ provider: "google", subject: "leaked" });
    expect(makeAccessEntry().bindings).toEqual([]);
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
    expect({ ...running, status: makeJob().status }).toEqual(makeJob());
  });
});

describe("makeAppendLogEntry", () => {
  it("builds an entry the log stores and reads back unchanged, as a first dispatch", async () => {
    const { log } = (await testDb({ modules: { log: () => import("../../../log.js") } })).modules;
    const entry = makeAppendLogEntry();
    const job = log.getJobById(log.appendLog(entry));
    expect(job).toMatchObject({ ...entry, status: "dispatched", dispatchNumber: 1, groupingParent: false });
  });

  it("names the issue makeIssue builds", () => {
    const issue = makeIssue();
    expect(makeAppendLogEntry()).toMatchObject({
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      teamKey: issue.scopeKey,
      issueState: issue.nativeStatus,
    });
  });

  it("gives each build its own dispatch id", () => {
    expect(makeAppendLogEntry().dispatchId).not.toBe(makeAppendLogEntry().dispatchId);
  });

  it("replaces only the overridden field", () => {
    const entry = makeAppendLogEntry({ phase: "planning" });
    expect(entry.phase).toBe("planning");
    expect({ ...entry, phase: "implementation" }).toEqual({ ...makeAppendLogEntry(), dispatchId: entry.dispatchId });
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
    expect({ ...titled, title: makeIssue().title }).toEqual(makeIssue());
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
    expect({ ...other, prNumber: makeScopedPrIdentity().prNumber }).toEqual(makeScopedPrIdentity());
  });
});

describe("makeScopedInstallationToken", () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.500Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    clearTokenCache();
  });

  it("builds what getScopedInstallationToken returns for GitHub's mint reply", async () => {
    const built = makeScopedInstallationToken();
    fakeFetch({
      "GET /orgs/acme/installation": { json: { id: built.installationId, repository_selection: "selected" } },
      [`POST /app/installations/${built.installationId}/access_tokens`]: {
        status: 201,
        json: { token: built.token, expires_at: built.expiresAt },
      },
    }).install();
    expect(await getScopedInstallationToken("1", privateKey, "acme", { forceRefresh: true })).toEqual(built);
  });

  it("expires an hour after it is built, in GitHub's form", () => {
    expect(makeScopedInstallationToken().expiresAt).toBe("2026-01-01T01:00:00Z");
  });

  it("replaces only the overridden field", () => {
    const other = makeScopedInstallationToken({ token: "other-token" });
    expect(other.token).toBe("other-token");
    expect({ ...other, token: makeScopedInstallationToken().token }).toEqual(makeScopedInstallationToken());
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
    expect({ ...retried, githubRunAttempt: makeReviewFixResult().githubRunAttempt }).toEqual(makeReviewFixResult());
  });
});

describe("makeReviewFixRunConfig", () => {
  it("builds an envelope the runner decodes unchanged, for a pilot attempt on the shared PR identity", () => {
    const config = makeReviewFixRunConfig();
    expect(decodeRunConfig(encodeRunConfig(config))).toEqual(config);
    expect(config.reviewFix).toMatchObject(makeScopedPrIdentity());
    expect(config.reviewFix!.deadlineAt).toBeGreaterThan(Date.now());
  });

  it("carries a retry policy the runner's guard keeps unchanged", () => {
    const { retryPolicy } = makeReviewFixRunConfig();
    expect(normalizeRetryPolicy(retryPolicy)).toEqual(retryPolicy);
  });

  it("derives the issue and PR number from the attempt", () => {
    const config = makeReviewFixRunConfig({ attemptId: "attempt-9", repository: "acme/app", prNumber: 7 });
    expect(config.issue).toMatchObject({ id: "review-fix:attempt-9", identifier: "review-fix-7", title: "Review-fix for acme/app#7" });
    expect(config.prNumber).toBe("7");
  });

  it("replaces only the overridden field", () => {
    const deadlineAt = Date.now() + 1_000;
    const withoutCallback = makeReviewFixRunConfig({ deadlineAt }, { runnerCallbackUrl: undefined });
    expect(withoutCallback.runnerCallbackUrl).toBeUndefined();
    expect({ ...withoutCallback, runnerCallbackUrl: "https://orchestrator.example" }).toEqual(makeReviewFixRunConfig({ deadlineAt }));
  });
});

describe("makeFeedbackLoopOutputs", () => {
  it("builds a run the reviewer approved on its first pass", () => {
    const outputs = makeFeedbackLoopOutputs();
    expect(outputs).toMatchObject({ approved: true, iterations: 1, terminationReason: "approved" });
    expect(outputs.passes).toEqual([expect.objectContaining({ iteration: 1, reviewApproved: true })]);
  });

  it("keeps the passes and termination in step with approved and iterations", () => {
    const outputs = makeFeedbackLoopOutputs({ approved: false, iterations: 3 });
    expect(outputs.terminationReason).toBe("iterations_exhausted");
    expect(outputs.passes.map((p) => [p.iteration, p.reviewApproved])).toEqual([[1, false], [2, false], [3, false]]);
    expect(makeFeedbackLoopOutputs({ iterations: 2 }).passes.map((p) => p.reviewApproved)).toEqual([false, true]);
  });

  it("ends the last pass the way its termination reason says, with every pass carrying its attempts", () => {
    const maxTurns = makeFeedbackLoopOutputs({ iterations: 2, terminationReason: "max_turns" });
    expect(maxTurns.approved).toBe(false);
    expect(maxTurns.passes.map((p) => [p.implementOutcome, p.reviewApproved, p.attempts])).toEqual([["success", false, 1], ["max_turns", null, 1]]);
    expect(maxTurns.finalFeedback).toContain("turn cap");
    const outage = makeFeedbackLoopOutputs({ terminationReason: "provider_unavailable" });
    expect(outage.passes).toEqual([expect.objectContaining({ implementOutcome: "error", reviewApproved: null })]);
    expect(outage.failure).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: false });
    expect(makeFeedbackLoopOutputs({ terminationReason: "review_error" }).passes[0].reviewApproved).toBeNull();
    expect(makeFeedbackLoopOutputs().failure).toBeUndefined();
  });

  it("lets an override replace a derived field", () => {
    expect(makeFeedbackLoopOutputs({ approved: false, terminationReason: "max_turns" }).terminationReason).toBe("max_turns");
    expect(makeFeedbackLoopOutputs({ passes: [] }).passes).toEqual([]);
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
    const executor = makeExecutor();
    expect(makeContext({}, executor).llmExecutor).toBe(executor);
  });

  it("replaces only the overridden data field", () => {
    const ctx = makeContext({ issueTitle: "Other" });
    expect(ctx.data.issueTitle).toBe("Other");
    expect({ ...ctx.data, issueTitle: makeContext().data.issueTitle }).toEqual(makeContext().data);
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
    await expect(provider.markPlanComplete("issue-1", "ENG", { awaitApproval: false })).resolves.toBeUndefined();
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

  it("records the calls made to its methods", async () => {
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

  it("keeps the real findByKeyInAnyTracker over the given mappings", async () => {
    const issue = makeIssue();
    const provider = makeProvider({ findByKey: vi.fn(async () => issue) });
    expect(await makeRegistry({ provider }).findByKeyInAnyTracker("ENG-1")).toEqual({ kind: "none", failedProviderIds: [] });
    expect(
      await makeRegistry({ provider, mappings: { ENG: makeMapping() } }).findByKeyInAnyTracker("ENG-1"),
    ).toEqual({ kind: "found", provider, issue, failedProviderIds: [] });
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
    try {
      const linear = makeProvider();
      const registry = makeRegistry({ providers: { linear } });
      await expect(registry.forMapping(jiraMapping)).rejects.toThrow('makeRegistry has no provider for tracker "jira"');
      expect(await registry.forAllMappings([makeMapping(), jiraMapping])).toEqual([linear]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Skipping provider "jira"'));
    } finally {
      warn.mockRestore();
    }
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
    expect({ ...fly, flySessionsApp: makeAppConfig().flySessionsApp }).toEqual(makeAppConfig());
  });
});

describe("makeChatGptPlanRecord", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds a record the plan-record parser accepts unchanged, saved now with an hour of access left", () => {
    const record = makeChatGptPlanRecord();
    expect(parseChatGptPlanRecord(record)).toEqual({ ok: true, value: record });
    expect(record.savedAt).toBe(Date.now());
    expect(record.accessTokenExpiresAt).toBe(Date.now() + 60 * 60_000);
  });

  it("keeps the access token's expiry an hour after an overridden savedAt", () => {
    expect(makeChatGptPlanRecord({ savedAt: 1_000_000 }).accessTokenExpiresAt).toBe(1_000_000 + 60 * 60_000);
  });

  it("replaces only the overridden field", () => {
    const other = makeChatGptPlanRecord({ email: "other@example.com" });
    expect(other.email).toBe("other@example.com");
    expect({ ...other, email: makeChatGptPlanRecord().email }).toEqual(makeChatGptPlanRecord());
  });
});

describe("makeLaunchDecision (fixtures/configured-run.ts)", () => {
  it.each([
    ["github-actions", "gha"],
    ["fly-machines", "fly"],
    ["local-docker", "local"],
  ] as const)("on %s, mints a %s grant the parser accepts and carries its safe metadata", (backend, grantBackend) => {
    const snapshot = makeSnapshot();
    const { decision, bootstrap } = makeLaunchDecision(snapshot, backend);

    expect(parseModelAuthGrantBootstrap(bootstrap)).toEqual({ ok: true, value: bootstrap });
    expect(bootstrap.backend).toBe(grantBackend);
    expect(decision).toMatchObject({ kind: "launch", backend, snapshot, dispatchId: bootstrap.dispatchId, projectKey: bootstrap.projectKey });
    expect(decision.grant).toEqual(toSafeGrantMetadata(bootstrap));
  });

  it("mints its grant on the real clock, expiring four hours after the build as the orchestrator's do", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    onTestFinished(() => void vi.useRealTimers());
    const { decision, bootstrap } = makeLaunchDecision(makeSnapshot(), "github-actions");
    expect(bootstrap.expiresAt).toBe(Date.now() + 4 * 60 * 60 * 1000);
    expect(decision.grant).toEqual(toSafeGrantMetadata(bootstrap));
  });

  it("hands the bootstrap out once, then undefined", () => {
    const { decision, bootstrap } = makeLaunchDecision(makeSnapshot(), "fly-machines");
    expect(decision.takeBootstrap()).toBe(bootstrap);
    expect(decision.takeBootstrap()).toBeUndefined();
  });

  it("applies overrides to the grant and the decision alike", () => {
    const { decision, bootstrap } = makeLaunchDecision(makeSnapshot(), "local-docker", { dispatchId: "d-9", projectKey: "AII" });
    expect(bootstrap).toMatchObject({ dispatchId: "d-9", projectKey: "AII" });
    expect(decision).toMatchObject({ dispatchId: "d-9", projectKey: "AII" });
    expect(decision.grant).toMatchObject({ dispatchId: "d-9", projectKey: "AII" });
  });
});

describe("the dev harness fixtures (fixtures/dev-harness.ts)", () => {
  it("makeTaskFile is what the task-file parser returns for its task", () => {
    expect(parseTaskFile("---\nidentifier: DEV-1\ntitle: Test task\n---\n\nImplement the test task.\n")).toEqual(makeTaskFile());
  });

  it("makeDevRunHandle runs a mounted implementation of makeTaskFile's task, with overrides spread last", () => {
    expect(makeDevRunHandle()).toMatchObject({ phase: "implementation", workspaceMode: "mounted", task: makeTaskFile() });
    expect(makeDevRunHandle({ phase: "full" }).phase).toBe("full");
  });

  it("makeDevHarnessCliDeps describes a clean run the CLI completes with exit 0", async () => {
    const deps = makeDevHarnessCliDeps();
    expect(await runDevHarnessCli(["--workspace", "/dev-run/workspace", "--task", "/dev-run/task.md"], deps)).toBe(0);
    expect(deps.collectRunArtifacts).toHaveBeenCalledWith(expect.objectContaining({ task: makeTaskFile() }), 0, expect.any(Function));
  });

  it("keeps each dependency's default through mockReset", async () => {
    const deps = makeDevHarnessCliDeps();
    vi.mocked(deps.getRunStatus).mockReset();
    await expect(deps.getRunStatus(makeDevRunHandle())).resolves.toEqual({ status: "exited", running: false, exitCode: 0 });
  });
});
