/**
 * The sender side of `PlanningRun` (AII-1019): an ingress client for the `submit` and `report`
 * calls, and the termination hook that `handleRunnerResult` calls for a planning callback
 * (`checkPlanningAdmissionTermination`, `src/runner-callback.ts`). The hook is injected through
 * that existing input; `runner-callback.ts` itself does not change. Sibling of
 * `createKgRefreshIngressClient` in `kg-refresh-production.ts`.
 */
import * as restateClients from "@restatedev/restate-sdk-clients";
import { read as readAdmission, type DispatchAdmissionRecord } from "../dispatch-admission.js";
import type { PlanningRunDefinition, PlanningRunInput } from "./planning-run-workflow.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";

export type PlanningIngressResult =
  | { readonly status: "accepted" }
  | { readonly status: "conflict" }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

export interface PlanningRunIngressClient {
  /** Starts the workflow keyed by `dispatchId`; the workflow key is the idempotency (Restate rejects an idempotency key on a workflow handler with HTTP 400). */
  submit(dispatchId: string, input: PlanningRunInput): Promise<PlanningIngressResult>;
  /** Resolves the workflow's `report` promise. */
  report(dispatchId: string): Promise<PlanningIngressResult>;
}

export interface PlanningRunIngressClientDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const INGRESS_TIMEOUT_MS = 10_000;

/** Real client on the SDK's typed client. Never throws: a connection error or timeout resolves `unavailable`. */
export function createPlanningRunIngressClient(
  baseUrl: string = RESTATE_INGRESS_BASE_URL,
  deps: PlanningRunIngressClientDeps = {},
): PlanningRunIngressClient {
  const ingress = restateClients.connect({ url: baseUrl, ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}) });
  const timeout = deps.timeoutMs ?? INGRESS_TIMEOUT_MS;
  const workflow = (dispatchId: string) => ingress.workflowClient<PlanningRunDefinition>({ name: "PlanningRun" }, dispatchId);

  async function invoke(call: () => PromiseLike<unknown>): Promise<PlanningIngressResult> {
    try {
      await call();
      return { status: "accepted" };
    } catch (err) {
      if (err instanceof restateClients.HttpCallError) {
        if (err.status === 404) return { status: "not-found" };
        if (err.status === 409) return { status: "conflict" };
      }
      return { status: "unavailable" };
    }
  }

  return {
    submit: (dispatchId, input) =>
      invoke(() => workflow(dispatchId).workflowSubmit(input)),
    report: (dispatchId) => invoke(() => workflow(dispatchId).report(restateClients.rpc.opts({ timeout }))),
  };
}

export interface PlanningAdmissionTerminationHookDeps {
  ingress: Pick<PlanningRunIngressClient, "report">;
  /** The Legacy fast release (`tryFastReleasePlanningAdmission` in `src/index.ts`). */
  legacy: (dispatchId: string) => Promise<void>;
  /** Defaults to `dispatch-admission.read`; a seam for a caller with no database. */
  readAdmission?: (dispatchId: string) => Pick<DispatchAdmissionRecord, "lifecycleOwner"> | null;
}

/**
 * Has the signature of `checkPlanningAdmissionTermination`. A Restate-owned reservation gets a
 * `report` to its workflow (the workflow key is the dispatch id); anything else is Legacy-owned.
 * One attempt, no retry: the workflow still finds the end of the run on its own tick.
 */
export function createPlanningAdmissionTerminationHook(
  deps: PlanningAdmissionTerminationHookDeps,
): (dispatchId: string) => Promise<void> {
  const lookup = deps.readAdmission ?? readAdmission;
  return async (dispatchId) => {
    if (lookup(dispatchId)?.lifecycleOwner.kind !== "restate") {
      await deps.legacy(dispatchId);
      return;
    }
    const result = await deps.ingress.report(dispatchId);
    if (result.status === "accepted") {
      console.log(`[planning-run] report sent dispatch=${dispatchId}`);
    } else {
      console.warn(`[planning-run] report not accepted dispatch=${dispatchId} status=${result.status}`);
    }
  };
}
