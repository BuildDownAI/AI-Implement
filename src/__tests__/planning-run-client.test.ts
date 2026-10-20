import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as LogModule from "../log.js";
import type * as DispatchAdmissionModule from "../dispatch-admission.js";
import type * as RunnerTokensModule from "../runner-tokens.js";
import type * as RunnerCallbackModule from "../runner-callback.js";
import type * as ClientModule from "../restate/planning-run-client.js";
import { FakeProvider } from "./providers/fake.js";
import { createPlanningRunWorkflow, type PlanningRunInput } from "../restate/planning-run-workflow.js";
import { fakeFetch, hangUntilAborted } from "./helpers/fake-fetch.js";
import { testDb } from "./helpers/test-db.js";

const SECRET = "test-secret-with-enough-entropy-for-hmac";
const INGRESS = "http://restate.test";

let log: typeof LogModule;
let dispatchAdmission: typeof DispatchAdmissionModule;
let runnerTokens: typeof RunnerTokensModule;
let runnerCallback: typeof RunnerCallbackModule;
let client: typeof ClientModule;

beforeEach(async () => {
  ({ log, dispatchAdmission, runnerTokens, runnerCallback, client } = (
    await testDb({
      modules: {
        log: () => import("../log.js"),
        dispatchAdmission: () => import("../dispatch-admission.js"),
        runnerTokens: () => import("../runner-tokens.js"),
        runnerCallback: () => import("../runner-callback.js"),
        client: () => import("../restate/planning-run-client.js"),
      },
    })
  ).modules);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const makeResolve = (provider: FakeProvider) => async () => provider;

const INPUT: PlanningRunInput = {
  dispatchId: "d-1", teamKey: "ENG", issueId: "i", issueIdentifier: "ENG-1", planningContext: {}, backend: "github-actions",
};

/** Mints a planning token, reserves its dispatch under `owner`, and adds the job row the planning branch looks up. */
function plantPlanningDispatch(owner: DispatchAdmissionModule.LifecycleOwner): { token: string; dispatchId: string } {
  const { token, dispatchId } = runnerTokens.mintRunToken({
    issueId: "i", mappingTeamKey: "ENG", phase: "planning", ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS, secret: SECRET,
  });
  const admitted = dispatchAdmission.acquire({
    dispatchId, mappingKey: "ENG", scope: { kind: "issue", issueScope: "ENG", issueId: "i" },
    kind: "planning", backend: "github-actions", lifecycleOwner: owner, cap: 1,
  });
  expect(admitted.ok).toBe(true);
  log.appendLog({
    issueId: "i", issueIdentifier: "ENG-1", issueTitle: "Plan it", teamKey: "ENG", repo: "o/r",
    dispatchId, executionMode: "github-actions", phase: "planning",
  });
  return { token, dispatchId };
}

describe("PlanningRun report sender", () => {
  it("contract: PlanningRun.report — the hook's request is one the real handler accepts", async () => {
    const { token, dispatchId } = plantPlanningDispatch({ kind: "restate", attemptId: "attempt-1" });
    const ingress = fakeFetch({ [`POST /PlanningRun/${dispatchId}/report`]: [{ status: 200, text: "" }] });
    const legacy = vi.fn(async () => {});
    const hook = client.createPlanningAdmissionTerminationHook({
      ingress: client.createPlanningRunIngressClient(INGRESS, { fetchImpl: ingress.fetch }),
      legacy,
    });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "planning", outcome: "success", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider({ recordCalls: true })),
      checkPlanningAdmissionTermination: hook,
    });

    expect(res.status).toBe(200);
    expect(legacy).not.toHaveBeenCalled();
    // The `report` handler declares no input: the request must address it by service, key and
    // handler name, and carry no body for a schema to reject.
    const workflow = createPlanningRunWorkflow({} as never);
    expect(ingress.calls).toHaveLength(1);
    expect(ingress.calls[0].url.href).toBe(`${INGRESS}/${workflow.name}/${dispatchId}/report`);
    expect(ingress.calls[0].method).toBe("POST");
    expect(ingress.calls[0].body).toBe("");
  });

  it("a Legacy-owned reservation calls legacy and sends no request", async () => {
    const { token, dispatchId } = plantPlanningDispatch({ kind: "legacy" });
    const ingress = fakeFetch({});
    const legacy = vi.fn(async () => {});
    const hook = client.createPlanningAdmissionTerminationHook({
      ingress: client.createPlanningRunIngressClient(INGRESS, { fetchImpl: ingress.fetch }),
      legacy,
    });

    const res = await runnerCallback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body: { phase: "planning", outcome: "success", comments: [] },
      secret: SECRET,
      resolveProvider: makeResolve(new FakeProvider({ recordCalls: true })),
      checkPlanningAdmissionTermination: hook,
    });

    expect(res.status).toBe(200);
    expect(legacy).toHaveBeenCalledWith(dispatchId);
    expect(ingress.calls).toEqual([]);
  });

  it("with the ingress unavailable the hook resolves, logs one warning, and does not throw", async () => {
    const { dispatchId } = plantPlanningDispatch({ kind: "restate", attemptId: "attempt-2" });
    const ingress = fakeFetch({
      [`POST /PlanningRun/${dispatchId}/report`]: [() => {
        throw new TypeError("connect ECONNREFUSED");
      }],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hook = client.createPlanningAdmissionTerminationHook({
      ingress: client.createPlanningRunIngressClient(INGRESS, { fetchImpl: ingress.fetch }),
      legacy: vi.fn(async () => {}),
    });

    await expect(hook(dispatchId)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(dispatchId);
  });
});

describe("createPlanningRunIngressClient", () => {
  it("submit sends no idempotency key: the workflow key is the idempotency", async () => {
    const ingress = fakeFetch({ "POST /PlanningRun/d-1/run/send": [{ json: { invocationId: "inv_1", status: "Accepted" } }] });
    const result = await client.createPlanningRunIngressClient(INGRESS, { fetchImpl: ingress.fetch }).submit("d-1", INPUT);

    expect(result).toEqual({ status: "accepted" });
    expect(ingress.calls[0].url.href).toContain("/PlanningRun/d-1/run/send");
    expect(ingress.calls[0].headers.get("idempotency-key")).toBeNull();
    expect(JSON.parse(ingress.calls[0].body)).toMatchObject({ dispatchId: "d-1" });
  });

  it.each([
    [404, "not-found"],
    [409, "conflict"],
    [500, "unavailable"],
  ])("maps HTTP %i to %s without throwing", async (status, expected) => {
    const ingress = fakeFetch({
      "POST /PlanningRun/d-1/report": [{ status, json: { message: "x" } }],
      "POST /PlanningRun/d-1/run/send": [{ status, json: { message: "x" } }],
    });
    const sender = client.createPlanningRunIngressClient(INGRESS, { fetchImpl: ingress.fetch });
    expect(await sender.report("d-1")).toEqual({ status: expected });
    expect(await sender.submit("d-1", INPUT)).toEqual({ status: expected });
  });
});

describe("createPlanningRunIngressClient timeouts", () => {
  it("submit answers unavailable when the ingress does not answer within the timeout", async () => {
    const ingress = fakeFetch({ "POST /PlanningRun/d-1/run/send": [hangUntilAborted] });
    const sender = client.createPlanningRunIngressClient(INGRESS, { fetchImpl: ingress.fetch, timeoutMs: 50 });
    expect(await sender.submit("d-1", INPUT)).toEqual({ status: "unavailable" });
  });
});
