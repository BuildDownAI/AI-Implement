/**
 * `SetupChecks` — a Virtual Object, one key (`orchestrator`), that runs the setup-check list inside the orchestrator
 * and keeps the last run (AII-1538). `run` (exclusive) runs every check in one `ctx.run` step and stores the result, so
 * a second run queues behind the first. `get` (shared) answers the stored run, or null before the first.
 * The stored run and the journal hold each check's detail and fix, which by contract carry no secret value (ADR 047),
 * because Restate journals every handler's output.
 */
import * as restate from "@restatedev/restate-sdk";
import type { ObjectContext, ObjectSharedContext } from "@restatedev/restate-sdk";
import * as restateClients from "@restatedev/restate-sdk-clients";
import { createSetupCheckContext, runSetupChecks, type SetupCheckRun } from "../setup-checks/index.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";
import { getRestateStatus, restateCanServe } from "./status.js";
import { CALL_TOOL_TIMEOUT_MS } from "./tools-client.js";

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
const READ_TIMEOUT_MS = 10_000;
/** A run reads Linear, and later GitHub, for every project while an admin waits, as a tool call does, so it shares that bound. */
const RUN_TIMEOUT_MS = CALL_TOOL_TIMEOUT_MS;

export function createSetupChecks(deps: SetupChecksDeps) {
  return restate.object({
    name: "SetupChecks",
    handlers: {
      run: restate.handlers.object.exclusive(async (ctx: ObjectContext): Promise<SetupCheckRun> => {
        const run = await ctx.run("run checks", () => deps.runChecks());
        ctx.set<SetupCheckRun>(LAST_RUN, run);
        return run;
      }),
      get: restate.handlers.object.shared(
        async (ctx: ObjectSharedContext): Promise<SetupCheckRun | null> => (await ctx.get<SetupCheckRun>(LAST_RUN)) ?? null,
      ),
    },
  });
}

export const setupChecks = createSetupChecks({
  runChecks: () => runSetupChecks(createSetupCheckContext({ restateStatus: getRestateStatus })),
});

export type SetupChecksDefinition = typeof setupChecks;
/** A typed client handle for callers outside this module: the health tool and the admin routes' ingress functions. */
export const SetupChecks: SetupChecksDefinition = { name: "SetupChecks" } as SetupChecksDefinition;

function ingressClient(timeoutMs: number, deps: SetupChecksIngressDeps) {
  const base = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  return restateClients
    .connect({
      url: deps.baseUrl ?? RESTATE_INGRESS_BASE_URL,
      fetch: (input, init) => base(input as never, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
    })
    .objectClient<SetupChecksDefinition>({ name: "SetupChecks" }, SETUP_CHECKS_KEY);
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
  return viaIngress(deps, () => ingressClient(READ_TIMEOUT_MS, deps).get());
}

/** A new run, started and awaited through the ingress for the admin route. */
export function runSetupChecksViaObject(deps: SetupChecksIngressDeps = {}): Promise<SetupChecksIngressResult<SetupCheckRun>> {
  return viaIngress(deps, () => ingressClient(RUN_TIMEOUT_MS, deps).run());
}
