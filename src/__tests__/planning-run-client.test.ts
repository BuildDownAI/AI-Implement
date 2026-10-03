import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as LogModule from "../log.js";
import type * as DispatchAdmissionModule from "../dispatch-admission.js";
import type * as RunnerTokensModule from "../runner-tokens.js";
import type * as RunnerCallbackModule from "../runner-callback.js";
import type * as StepLogModule from "../step-log.js";
import type * as ClientModule from "../restate/planning-run-client.js";
import { FakeProvider } from "./providers/fake.js";
import { createPlanningRunWorkflow, type PlanningRunInput } from "../restate/planning-run-workflow.js";

const SECRET = "test-secret-with-enough-entropy-for-hmac";
const INGRESS = "http://restate.test";

let dbPath: string;
let dedup: typeof DedupModule;
let log: typeof LogModule;
let dispatchAdmission: typeof DispatchAdmissionModule;
let runnerTokens: typeof RunnerTokensModule;
let runnerCallback: typeof RunnerCallbackModule;
let stepLog: typeof StepLogModule;
let client: typeof ClientModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `planning-run-client-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  log = await import("../log.js");
  dispatchAdmission = await import("../dispatch-admission.js");
  runnerTokens = await import("../runner-tokens.js");
  runnerCallback = await import("../runner-callback.js");
  stepLog = await import("../step-log.js");
  client = await import("../restate/planning-run-client.js");
  dedup.getDb();
  log.initLogTable();
  stepLog.initStepLogTable();
});

afterEach(() => {
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
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

interface Captured { url: string; method: string; body: string; headers: Record<string, string> }

function capturingFetch(respond: () => Response): { fetchImpl: typeof fetch; requests: Captured[] } {
  const requests: Captured[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const raw = init?.body;
    const body = raw === undefined || raw === null ? "" : typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    requests.push({ url: String(url), method: init?.method ?? "GET", body, headers });
    return respond();
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

describe("PlanningRun report sender", () => {
  it("contract: PlanningRun.report — the hook's request is one the real handler accepts", async () => {
    const { token, dispatchId } = plantPlanningDispatch({ kind: "restate", attemptId: "attempt-1" });
    const { fetchImpl, requests } = capturingFetch(() => new Response("", { status: 200 }));
    const legacy = vi.fn(async () => {});
    const hook = client.createPlanningAdmissionTerminationHook({
      ingress: client.createPlanningRunIngressClient(INGRESS, { fetchImpl }),
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
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: `${INGRESS}/${workflow.name}/${dispatchId}/report`, method: "POST" });
    expect(requests[0].body).toBe("");
  });

  it("a Legacy-owned reservation calls legacy and sends no request", async () => {
    const { token, dispatchId } = plantPlanningDispatch({ kind: "legacy" });
    const { fetchImpl, requests } = capturingFetch(() => new Response("", { status: 200 }));
    const legacy = vi.fn(async () => {});
    const hook = client.createPlanningAdmissionTerminationHook({
      ingress: client.createPlanningRunIngressClient(INGRESS, { fetchImpl }),
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
    expect(requests).toEqual([]);
  });

  it("with the ingress unavailable the hook resolves, logs one warning, and does not throw", async () => {
    const { dispatchId } = plantPlanningDispatch({ kind: "restate", attemptId: "attempt-2" });
    const fetchImpl = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hook = client.createPlanningAdmissionTerminationHook({
      ingress: client.createPlanningRunIngressClient(INGRESS, { fetchImpl }),
      legacy: vi.fn(async () => {}),
    });

    await expect(hook(dispatchId)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(dispatchId);
  });
});

describe("createPlanningRunIngressClient", () => {
  it("submit sends no idempotency key: the workflow key is the idempotency", async () => {
    const { fetchImpl, requests } = capturingFetch(() => new Response(JSON.stringify({ invocationId: "inv_1", status: "Accepted" }), { status: 200 }));
    const result = await client.createPlanningRunIngressClient(INGRESS, { fetchImpl }).submit("d-1", INPUT);

    expect(result).toEqual({ status: "accepted" });
    expect(requests[0].url).toContain("/PlanningRun/d-1/run/send");
    expect(requests[0].headers["idempotency-key"]).toBeUndefined();
    expect(JSON.parse(requests[0].body)).toMatchObject({ dispatchId: "d-1" });
  });

  it.each([
    [404, "not-found"],
    [409, "conflict"],
    [500, "unavailable"],
  ])("maps HTTP %i to %s without throwing", async (status, expected) => {
    const { fetchImpl } = capturingFetch(() => new Response(JSON.stringify({ message: "x" }), { status }));
    const sender = client.createPlanningRunIngressClient(INGRESS, { fetchImpl });
    expect(await sender.report("d-1")).toEqual({ status: expected });
    expect(await sender.submit("d-1", INPUT)).toEqual({ status: expected });
  });
});
