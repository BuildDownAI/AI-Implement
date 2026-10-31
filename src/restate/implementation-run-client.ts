/**
 * The sender side of `ImplementationRun` (AII-1553): an ingress client for the `submit` and `report`
 * calls, and a termination hook for the runner callback to call for an implementation result. The
 * hook is not wired here: `src/runner-callback.ts` and `src/index.ts` are AII-1557's. `report`
 * carries optional model usage: the callback keeps writing the outcome to SQLite and the workflow reads the row.
 * Sibling of `planning-run-client.ts`.
 */
import { ownedRunReportFingerprint } from "./owned-run-report-fingerprint.js";
import type { RecordedUsage } from "../agent-usage.js";
import * as restateClients from "@restatedev/restate-sdk-clients";
import { read as readAdmission, type DispatchAdmissionRecord } from "../dispatch-admission.js";
import type { ImplementationRunDefinition, ImplementationRunInput } from "./implementation-run-workflow.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";

export type ImplementationIngressResult =
  | { readonly status: "accepted" }
  | { readonly status: "conflict" }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

export interface ImplementationRunIngressClient {
  /** Starts the workflow keyed by `dispatchId`; the workflow key is the idempotency (Restate rejects an idempotency key on a workflow handler with HTTP 400). */
  submit(dispatchId: string, input: ImplementationRunInput): Promise<ImplementationIngressResult>;
  /** Resolves the workflow's `report` promise. */
  report(dispatchId: string, body?: { usage?: RecordedUsage }, opts?: { idempotencyKey: string }): Promise<ImplementationIngressResult>;
}

export interface ImplementationRunIngressClientDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const INGRESS_TIMEOUT_MS = 10_000;

/** Real client on the SDK's typed client. Never throws: a connection error or timeout resolves `unavailable`. */
export function createImplementationRunIngressClient(
  baseUrl: string = RESTATE_INGRESS_BASE_URL,
  deps: ImplementationRunIngressClientDeps = {},
): ImplementationRunIngressClient {
  const ingress = restateClients.connect({ url: baseUrl, ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}) });
  const timeout = deps.timeoutMs ?? INGRESS_TIMEOUT_MS;
  const workflow = (dispatchId: string) => ingress.workflowClient<ImplementationRunDefinition>({ name: "ImplementationRun" }, dispatchId);

  async function invoke(call: () => PromiseLike<unknown>, body?: { usage?: RecordedUsage }): Promise<ImplementationIngressResult> {
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

export interface ImplementationAdmissionTerminationHookDeps {
  ingress: Pick<ImplementationRunIngressClient, "report">;
  /** The Legacy path for a reservation no workflow owns. */
  legacy: (dispatchId: string) => Promise<void>;
  /** Defaults to `dispatch-admission.read`; a seam for a caller with no database. */
  readAdmission?: (dispatchId: string) => Pick<DispatchAdmissionRecord, "lifecycleOwner"> | null;
}

/**
 * Has the signature of `checkImplementationAdmissionTermination`. A Restate-owned reservation gets a
 * `report` to its workflow (the workflow key is the dispatch id); anything else is Legacy-owned and left to the monitors.
 * Returns the ingress outcome to the callback so an unavailable report can be retried.
 */
export function createImplementationAdmissionTerminationHook(
  deps: ImplementationAdmissionTerminationHookDeps,
): (dispatchId: string, usage?: RecordedUsage) => Promise<void | ImplementationIngressResult> {
  const lookup = deps.readAdmission ?? readAdmission;
  return async (dispatchId, usage) => {
    if (lookup(dispatchId)?.lifecycleOwner.kind !== "restate") {
      await deps.legacy(dispatchId);
      return;
    }
    const result = await (usage ? deps.ingress.report(dispatchId, { usage }, { idempotencyKey: dispatchId }) : deps.ingress.report(dispatchId));
    if (result.status === "accepted") {
      console.log(`[implementation-run] report sent dispatch=${dispatchId}`);
    } else {
      console.warn(`[implementation-run] report not accepted dispatch=${dispatchId} status=${result.status}`);
    }
    return result;
  };
}
