/**
 * The sender side of `PlanningRun` (AII-1019): an ingress client for the `submit` and `report`
 * calls, and the termination hook that `handleRunnerResult` calls for a planning callback
 * (`checkPlanningAdmissionTermination`, `src/runner-callback.ts`). The hook is injected through
 * that input, including usage and the forwarding outcome. Sibling of
 * `createKgRefreshIngressClient` in `kg-refresh-production.ts`.
 */
import { ownedRunReportFingerprint } from "./owned-run-report-fingerprint.js";
import type { RecordedUsage } from "../agent-usage.js";
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
  report(dispatchId: string, body?: { usage?: RecordedUsage }, opts?: { idempotencyKey: string }): Promise<PlanningIngressResult>;
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

  async function invoke(call: () => PromiseLike<unknown>, body?: { usage?: RecordedUsage }): Promise<PlanningIngressResult> {
    try {
      const result = await call() as { fingerprint?: string } | undefined;
      if (body?.usage && !result?.fingerprint) return { status: "unavailable" };
      if (result?.fingerprint && result.fingerprint !== ownedRunReportFingerprint(body ?? {})) return { status: "conflict" };
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
      invoke(() => workflow(dispatchId).workflowSubmit(input, restateClients.rpc.sendOpts({ timeout }))),
    // The SDK RemoveVoidArgument type cannot represent an optional JSON input. The handler
    // accepts undefined at runtime; preserve it so existing callers send an empty HTTP body.
    report: (dispatchId, body, opts) => invoke(() => workflow(dispatchId).report(body!, restateClients.rpc.opts({ timeout, ...(opts ? { idempotencyKey: opts.idempotencyKey } : {}) })), body),
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
 * Returns the ingress outcome to the callback so an unavailable report can be retried.
 */
export function createPlanningAdmissionTerminationHook(
  deps: PlanningAdmissionTerminationHookDeps,
): (dispatchId: string, usage?: RecordedUsage) => Promise<void | PlanningIngressResult> {
  const lookup = deps.readAdmission ?? readAdmission;
  return async (dispatchId, usage) => {
    if (lookup(dispatchId)?.lifecycleOwner.kind !== "restate") {
      await deps.legacy(dispatchId);
      return;
    }
    const result = await (usage ? deps.ingress.report(dispatchId, { usage }, { idempotencyKey: dispatchId }) : deps.ingress.report(dispatchId));
    if (result.status === "accepted") {
      console.log(`[planning-run] report sent dispatch=${dispatchId}`);
    } else {
      console.warn(`[planning-run] report not accepted dispatch=${dispatchId} status=${result.status}`);
    }
    return result;
  };
}
