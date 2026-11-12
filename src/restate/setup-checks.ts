/**
 * `SetupChecks` — a Virtual Object, one key (`orchestrator`), that runs the setup-check list inside the orchestrator
 * and keeps the last run (AII-1538). `run` (exclusive) runs every check in one `ctx.run` step and stores the result, so
 * a second run queues behind the first. `get` (shared) answers the stored run, or null before the first.
 * The admin route starts `run` without waiting for it, and reads the run's progress in this process meanwhile (AII-1541).
 * The stored run and the journal hold each check's detail and fix, which by contract carry no secret value (ADR 047),
 * because Restate journals every handler's output.
 */
import * as restate from "@restatedev/restate-sdk";
import type { ObjectContext, ObjectSharedContext } from "@restatedev/restate-sdk";
import * as restateClients from "@restatedev/restate-sdk-clients";
import { claimSetupCheckRun, createSetupCheckContext, endSetupCheckProgress, getLastSetupCheckRun, recordSetupCheckRun, runSetupChecksWithProgress, type SetupCheckRun } from "../setup-checks/index.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";
import { getRestateStatus, restateCanServe } from "./status.js";

export interface SetupChecksDeps {
  /** Runs every check and answers the run. Called inside `run`'s one `ctx.run` step. */
  runChecks(): Promise<SetupCheckRun>;
}

/** For tests: the ingress address, its fetch, and whether Restate can serve. */
export interface SetupChecksIngressDeps {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  canServe?: () => boolean;
}

/** An ingress call's answer, or `unavailable` when Restate could not take it or did not answer. */
export type SetupChecksIngressResult<T> = { status: "ok"; value: T } | { status: "unavailable" };

export const SETUP_CHECKS_KEY = "orchestrator";

const LAST_RUN = "lastRun";
/** Bounds a read of the stored run, and the ingress's acceptance of a new run, which never waits for the run itself. */
const INGRESS_TIMEOUT_MS = 10_000;

export function createSetupChecks(deps: SetupChecksDeps) {
  return restate.object({
    name: "SetupChecks",
    handlers: {
      run: restate.handlers.object.exclusive(async (ctx: ObjectContext): Promise<SetupCheckRun> => {
        try {
          const run = await ctx.run("run checks", () => deps.runChecks());
          recordSetupCheckRun(run);
          ctx.set<SetupCheckRun>(LAST_RUN, run);
          return run;
        } finally {
          endSetupCheckProgress();
        }
      }),
      get: restate.handlers.object.shared(
        async (ctx: ObjectSharedContext): Promise<SetupCheckRun | null> => (await ctx.get<SetupCheckRun>(LAST_RUN)) ?? null,
      ),
    },
  });
}

export const setupChecks = createSetupChecks({
  runChecks: () => runSetupChecksWithProgress(createSetupCheckContext({ restateStatus: getRestateStatus })),
});

export type SetupChecksDefinition = typeof setupChecks;
/** A typed client handle for callers outside this module: the health tool and the admin routes' ingress functions. */
export const SetupChecks: SetupChecksDefinition = { name: "SetupChecks" } as SetupChecksDefinition;

function ingress(deps: SetupChecksIngressDeps) {
  const base = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  return restateClients.connect({
    url: deps.baseUrl ?? RESTATE_INGRESS_BASE_URL,
    fetch: (input, init) => base(input as never, { ...init, signal: AbortSignal.timeout(INGRESS_TIMEOUT_MS) }),
  });
}

async function viaIngress<T>(deps: SetupChecksIngressDeps, call: () => PromiseLike<T>): Promise<SetupChecksIngressResult<T>> {
  if (!(deps.canServe ?? restateCanServe)()) return { status: "unavailable" };
  try {
    return { status: "ok", value: await call() };
  } catch (err) {
    console.warn(`[setup-checks] the SetupChecks object did not answer: ${err instanceof Error ? err.message : String(err)}`);
    return { status: "unavailable" };
  }
}

/** The stored run, read through the ingress for the admin route. */
export function readSetupChecksViaObject(deps: SetupChecksIngressDeps = {}): Promise<SetupChecksIngressResult<SetupCheckRun | null>> {
  return viaIngress(deps, () => ingress(deps).objectClient<SetupChecksDefinition>({ name: "SetupChecks" }, SETUP_CHECKS_KEY).get());
}

/** A start's answer: the invocation it sent, `busy` with when the run already going began, or `unavailable`. */
export type SetupChecksStart = SetupChecksIngressResult<{ invocationId: string }> | { status: "busy"; startedAt: number };

/**
 * Starts a run without waiting for it, unless one is already going. The run reports its progress in this process meanwhile.
 * The claim is taken before the send, since the run's own progress appears only once its handler begins.
 */
export async function startSetupChecksViaObject(deps: SetupChecksIngressDeps = {}): Promise<SetupChecksStart> {
  const going = claimSetupCheckRun();
  if (going) return { status: "busy", startedAt: going.startedAt };
  const sent = await viaIngress(deps, async () => {
    const send = await ingress(deps).objectSendClient<SetupChecksDefinition>({ name: "SetupChecks" }, SETUP_CHECKS_KEY).run();
    return { invocationId: send.invocationId };
  });
  // No handler will end a claim whose run was never sent.
  if (sent.status !== "ok") endSetupCheckProgress();
  return sent;
}

/** Called once after successful boot registration, never from the public health request. */
export function createSetupChecksHydration(read = readSetupChecksViaObject): () => Promise<void> {
  let started = false;
  return async () => {
    if (started) return;
    started = true;
    const result = await read();
    // A run completed in this process is fresher than the boot read, even if the clock moved back.
    if (result.status === "ok" && result.value && getLastSetupCheckRun() === null) recordSetupCheckRun(result.value);
  };
}
