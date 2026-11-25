// Whole poll() cycles against a test database, with every request leaving the process faked (AII-1544).
// A cycle with nothing to dispatch reaches Restate alone, so these pin what each cycle runs before its deadline.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ConfigModule from "../config.js";
import type * as DeployPolicyModule from "../deploy-policy.js";
import type * as IndexModule from "../index.js";
import type * as LogModule from "../log.js";
import type * as SetupChecksModule from "../setup-checks/index.js";
import type * as StatusModule from "../restate/status.js";
import { makeAppConfig, makeAppendLogEntry, makeAppPrivateKey, makeMapping, makeProvider, makeRegistry } from "./helpers/builders.js";
import { fakeFetch, type Routes } from "./helpers/fake-fetch.js";
import { testDb } from "./helpers/test-db.js";

let config: typeof ConfigModule;
let policy: typeof DeployPolicyModule;
let index: typeof IndexModule;
let checks: typeof SetupChecksModule;
let status: typeof StatusModule;
let log: typeof LogModule;

beforeEach(async () => {
  ({ config, policy, index, checks, status, log } = (await testDb({
    modules: {
      config: () => import("../config.js"),
      policy: () => import("../deploy-policy.js"),
      index: () => import("../index.js"),
      checks: () => import("../setup-checks/index.js"),
      status: () => import("../restate/status.js"),
      log: () => import("../log.js"),
    },
  })).modules);
  status.setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "registered" } });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const SENT = { json: { invocationId: "inv_1", status: "Accepted" } };
// Every cycle refreshes the runner backend cache from Restate first.
const EVERY_CYCLE: Routes = { "POST /RunnerBackend/fly-machines/get": { json: null } };
const cycle = () => index.poll(makeAppConfig(), makeRegistry({ provider: makeProvider() }));
const setupCheckPaths = (calls: Array<{ path: string }>) => calls.map((call) => call.path).filter((path) => path.startsWith("/SetupChecks/"));

describe("a poll cycle's setup checks", () => {
  it("sends the runs a project saved since the cycle before needs, and nothing on the first cycle", async () => {
    const fake = fakeFetch({
      ...EVERY_CYCLE,
      "POST /SetupChecks/orchestrator/get": { json: null },
      "POST /SetupChecks/orchestrator/runProject/send": SENT,
      "POST /SetupChecks/orchestrator/runOrchestratorWide/send": SENT,
    }).install();
    await cycle();
    expect(setupCheckPaths(fake.calls)).toEqual(["/SetupChecks/orchestrator/get"]);
    config.upsertMapping("ENG", makeMapping());
    await cycle();
    expect(setupCheckPaths(fake.calls).slice(1)).toEqual(["/SetupChecks/orchestrator/runProject/send", "/SetupChecks/orchestrator/runOrchestratorWide/send"]);
    expect(JSON.parse(fake.calls.find((call) => call.path.endsWith("/runProject/send"))!.body)).toEqual({ project: "ENG" });
  });

  it("reads the stored run each cycle until a read answers, then fills this process's cache from it", async () => {
    const stored = { checkedAt: 5, results: [] };
    const fake = fakeFetch({ ...EVERY_CYCLE, "POST /SetupChecks/orchestrator/get": [{ status: 500, text: "boom" }, { json: stored }] }).install();
    await cycle();
    await cycle();
    await cycle();
    expect(setupCheckPaths(fake.calls)).toEqual(["/SetupChecks/orchestrator/get", "/SetupChecks/orchestrator/get"]);
    await vi.waitFor(() => expect(checks.getCachedSetupCheckRun()).toEqual(stored));
  });
});

describe("a poll cycle's late-review sweep", () => {
  it("resubmits nothing, and reads nothing for it, while Restate cannot serve", async () => {
    status.setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "unreachable" } });
    // A finished gap-fill run whose review was never submitted. The sweep reads its PR before submitting, and the hook would refuse a submit itself,
    // so only the sweep's own readiness keeps that read from happening.
    const row = log.appendLog(makeAppendLogEntry({ phase: "gap-analysis", dispatchId: "dispatch-1" }));
    log.updateJobStatus(row, "completed", "external_review_pending", "https://github.com/acme/app/pull/9");
    // The App's key signs, so a sweep that ran would mint a token to read the waiting review's PR: an unrouted request, which fails the test.
    // A key that signs also lets merge reconciliation read the App's bot login, as it does every cycle.
    const fake = fakeFetch({ ...EVERY_CYCLE, "GET /app": { json: { slug: "ai-implement" } } }).install();
    await index.poll(makeAppConfig({ githubAppPrivateKey: makeAppPrivateKey() }), makeRegistry({ provider: makeProvider() }));
    expect(fake.calls.map((call) => call.path)).toEqual(["/RunnerBackend/fly-machines/get", "/app"]);
  });
});

describe("a poll cycle's automatic deploy on the published path", () => {
  const RUNNING = "1111111111111111111111111111111111111111";
  const HEAD = "2222222222222222222222222222222222222222";
  const IMAGE = "ghcr.io/builddownai/ai-implement-orchestrator:testing-2222222";
  // An orchestrator without a knowledge graph, watching testing while it runs an older commit.
  // flyOrchestratorApp and the SelfDeploy object's key are both FLY_APP_NAME in production.
  const deployable = () => makeAppConfig({
    githubAppPrivateKey: makeAppPrivateKey(),
    flyDeployToken: "fly-deploy-token",
    flyOrchestratorApp: "orchestrator",
    selfDeployTarget: { owner: "BuildDownAI", repo: "AI-Implement", branch: "testing", runningCommit: RUNNING },
  });

  it("starts nothing, and records nothing, until the head's image can be deployed, then starts it once", async () => {
    policy.setDeployPolicy({ autoDeploy: true });
    const fake = fakeFetch({
      ...EVERY_CYCLE,
      "GET /app": { json: { slug: "ai-implement" } },
      "GET /orgs/BuildDownAI/installation": { json: { id: 1, permissions: { contents: "read", statuses: "read" } } },
      "POST /app/installations/1/access_tokens": { json: { token: "installation-token", expires_at: "2099-01-01T00:00:00Z" } },
      "GET /repos/BuildDownAI/AI-Implement/commits": { json: [{ sha: HEAD }] },
      // The head is one commit past the running one, as GitHub's compare answers it.
      [`GET /repos/BuildDownAI/AI-Implement/compare/${RUNNING}...${HEAD}`]: { json: { status: "ahead", ahead_by: 1, behind_by: 0 } },
      "POST /SetupChecks/orchestrator/get": { json: null },
      // The status lands after the push: none on the first cycle, success on the second.
      [`GET /repos/BuildDownAI/AI-Implement/commits/${HEAD}/statuses`]: [{ json: [] }, { json: [{ context: "orchestrator-image/public", state: "success" }] }],
      "GET /token": { json: { token: "anonymous-token" } },
      "HEAD /v2/builddownai/ai-implement-orchestrator/manifests/testing-2222222": { status: 200 },
      "POST /SelfDeploy/orchestrator/start": { json: { deployId: "deploy-1", commit: HEAD, image: IMAGE, alreadyActive: false } },
    }).install();
    const starts = () => fake.calls.filter((call) => call.path === "/SelfDeploy/orchestrator/start");
    const registry = makeRegistry({ provider: makeProvider() });

    await index.poll(deployable(), registry);
    expect(starts()).toHaveLength(0);
    expect(policy.getLastActedCommit()).toBeNull();

    await index.poll(deployable(), registry);
    expect(starts()).toHaveLength(1);
    expect(JSON.parse(starts()[0].body)).toEqual({ branch: "testing", requestedBy: "auto-deploy" });
    expect(policy.getLastActedCommit()).toBe(HEAD);

    await index.poll(deployable(), registry);
    expect(starts()).toHaveLength(1);
  });
});

describe("the late-review hook", () => {
  const input = { dispatchId: "dispatch-2", owner: "acme", repo: "app", prNumber: 9, prUrl: "https://github.com/acme/app/pull/9", gapFill: true as const };

  it("submits LateExternalReview only while Restate can serve", async () => {
    const fake = fakeFetch({ "POST /LateExternalReview/dispatch-2/run/send": SENT }).install();
    status.setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "unreachable" } });
    expect(await index.lateExternalReviewSubmitHook(input)).toBe(false);
    expect(fake.calls).toEqual([]);
    status.setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "registered" } });
    expect(await index.lateExternalReviewSubmitHook(input)).toBe(true);
    expect(fake.calls.map((call) => call.path)).toEqual(["/LateExternalReview/dispatch-2/run/send"]);
  });
});
