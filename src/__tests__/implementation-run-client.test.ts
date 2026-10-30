import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { RecordedUsage } from "../agent-usage.js";
import type * as DispatchAdmissionModule from "../dispatch-admission.js";
import type * as ClientModule from "../restate/implementation-run-client.js";
import { createImplementationRunWorkflow, type ImplementationRunInput } from "../restate/implementation-run-workflow.js";
import { fakeFetch, hangUntilAborted } from "./helpers/fake-fetch.js";
import { testDb } from "./helpers/test-db.js";

const INGRESS = "http://restate.test";

let dispatchAdmission: typeof DispatchAdmissionModule;
let client: typeof ClientModule;

beforeEach(async () => {
  ({ dispatchAdmission, client } = (
    await testDb({
      modules: {
        dispatchAdmission: () => import("../dispatch-admission.js"),
        client: () => import("../restate/implementation-run-client.js"),
      },
    })
  ).modules);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const INPUT: ImplementationRunInput = {
  dispatchId: "d-1", teamKey: "ENG", issueId: "i", issueIdentifier: "ENG-1", launchContext: {}, maxJobMinutes: 90, backend: "github-actions",
};

function plantImplementationDispatch(dispatchId: string, owner: DispatchAdmissionModule.LifecycleOwner): void {
  const admitted = dispatchAdmission.acquire({
    dispatchId, mappingKey: "ENG", scope: { kind: "issue", issueScope: "ENG", issueId: "i" },
    kind: "implementation", backend: "github-actions", lifecycleOwner: owner, cap: 1,
  });
  expect(admitted.ok).toBe(true);
}

describe("ImplementationRun report sender", () => {
  // The end-to-end proof through `handleRunnerResult` belongs to AII-1557, which adds the implementation hook
  // to the callback. This test proves what the sender puts on the wire for the real handler.
  it("contract: ImplementationRun.report — the hook's request is one the real handler accepts", async () => {
    plantImplementationDispatch("d-hook", { kind: "restate", attemptId: "attempt-1" });
    const ingress = fakeFetch({ "POST /ImplementationRun/d-hook/report": [{ status: 200, text: "" }] });
    const legacy = vi.fn(async () => {});
    const hook = client.createImplementationAdmissionTerminationHook({
      ingress: client.createImplementationRunIngressClient(INGRESS, { fetchImpl: ingress.fetch }),
      legacy,
    });

    await hook("d-hook");

    expect(legacy).not.toHaveBeenCalled();
    // Existing producers omit usage and retain the empty request body.
    const workflow = createImplementationRunWorkflow({} as never);
    expect(ingress.calls).toHaveLength(1);
    expect(ingress.calls[0].url.href).toBe(`${INGRESS}/${workflow.name}/d-hook/report`);
    expect(ingress.calls[0].method).toBe("POST");
    expect(ingress.calls[0].body).toBe("");
  });

  it("forwards supplied usage through the SDK as the report body", async () => {
    const dispatchId = "d-usage";
    plantImplementationDispatch(dispatchId, { kind: "restate", attemptId: "attempt-1" });
    const ingress = fakeFetch({ [`POST /ImplementationRun/${dispatchId}/report`]: [{ status: 200, json: { status: "accepted" } }] });
    const hook = client.createImplementationAdmissionTerminationHook({
      ingress: client.createImplementationRunIngressClient(INGRESS, { fetchImpl: ingress.fetch }),
      legacy: vi.fn(async () => {}),
    });
    const usage: RecordedUsage = {
      records: [{
        attribution: {
          version: 1, invocationId: "implementation-invocation", snapshotId: "implementation-snapshot",
          stage: "implementation", agent: "claude", provider: "anthropic", model: "claude-model",
          profileId: "implementation-profile", authMode: "anthropic-api-key", limit: null, outcome: "success",
          usage: { availability: "complete", tokensIn: 12, tokensOut: 2, costUsd: 0, costStatus: "reported" },
        },
        cacheReadTokens: 0, cacheCreationTokens: 4, attempts: 2,
      }],
      attribution: null, pushedCommits: null, listWhole: true, timedOut: false,
    };
    await hook(dispatchId, usage);
    expect(ingress.calls).toHaveLength(1);
    expect(JSON.parse(ingress.calls[0].body)).toEqual({ usage });
  });

  it("a Legacy-owned reservation calls legacy and sends no request", async () => {
    plantImplementationDispatch("d-legacy", { kind: "legacy" });
    const ingress = fakeFetch({});
    const legacy = vi.fn(async () => {});
    const hook = client.createImplementationAdmissionTerminationHook({
      ingress: client.createImplementationRunIngressClient(INGRESS, { fetchImpl: ingress.fetch }),
      legacy,
    });

    await hook("d-legacy", { records: [], attribution: null, pushedCommits: null, listWhole: true, timedOut: false });

    expect(legacy).toHaveBeenCalledWith("d-legacy");
    expect(ingress.calls).toEqual([]);
  });

  it("with the ingress unavailable the hook resolves, logs one warning, and does not throw", async () => {
    plantImplementationDispatch("d-down", { kind: "restate", attemptId: "attempt-2" });
    const ingress = fakeFetch({
      "POST /ImplementationRun/d-down/report": [() => {
        throw new TypeError("connect ECONNREFUSED");
      }],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hook = client.createImplementationAdmissionTerminationHook({
      ingress: client.createImplementationRunIngressClient(INGRESS, { fetchImpl: ingress.fetch }),
      legacy: vi.fn(async () => {}),
    });

    await expect(hook("d-down")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("d-down");
  });
});

describe("createImplementationRunIngressClient", () => {
  it("submit sends no idempotency key: the workflow key is the idempotency", async () => {
    const ingress = fakeFetch({ "POST /ImplementationRun/d-1/run/send": [{ json: { invocationId: "inv_1", status: "Accepted" } }] });
    const result = await client.createImplementationRunIngressClient(INGRESS, { fetchImpl: ingress.fetch }).submit("d-1", INPUT);

    expect(result).toEqual({ status: "accepted" });
    expect(ingress.calls[0].headers.get("idempotency-key")).toBeNull();
    expect(JSON.parse(ingress.calls[0].body)).toMatchObject({ dispatchId: "d-1", maxJobMinutes: 90 });
  });

  it.each([
    [404, "not-found"],
    [409, "conflict"],
    [500, "unavailable"],
  ])("maps HTTP %i to %s without throwing", async (status, expected) => {
    const ingress = fakeFetch({
      "POST /ImplementationRun/d-1/report": [{ status, json: { message: "x" } }],
      "POST /ImplementationRun/d-1/run/send": [{ status, json: { message: "x" } }],
    });
    const sender = client.createImplementationRunIngressClient(INGRESS, { fetchImpl: ingress.fetch });
    expect(await sender.report("d-1")).toEqual({ status: expected });
    expect(await sender.submit("d-1", INPUT)).toEqual({ status: expected });
  });

  it("submit answers unavailable when the ingress does not answer within the timeout", async () => {
    const ingress = fakeFetch({ "POST /ImplementationRun/d-1/run/send": [hangUntilAborted] });
    const sender = client.createImplementationRunIngressClient(INGRESS, { fetchImpl: ingress.fetch, timeoutMs: 50 });
    expect(await sender.submit("d-1", INPUT)).toEqual({ status: "unavailable" });
  });
});
