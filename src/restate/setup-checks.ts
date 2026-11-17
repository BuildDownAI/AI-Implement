/**
 * `SetupChecks` — a Virtual Object, one key (`orchestrator`), that runs the setup-check list inside the orchestrator
 * and keeps the last run (AII-1538). `run` (exclusive) runs every check in one `ctx.run` step and stores the result, so
 * a second run queues behind the first. `runProject` (exclusive) runs one project's checks and replaces only that project's rows
 * in the stored run, or runs every check when a check all projects share fails (AII-1543). `get` (shared) answers the stored run, or null before the first.
 * The admin route starts `run` without waiting for it, and reads the run's progress in this process meanwhile (AII-1541).
 * The stored run and the journal hold each check's detail and fix, which by contract carry no secret value (ADR 047),
 * because Restate journals every handler's output.
 */
import * as restate from "@restatedev/restate-sdk";
import type { ObjectContext, ObjectSharedContext } from "@restatedev/restate-sdk";
import * as restateClients from "@restatedev/restate-sdk-clients";
import { getMappings } from "../config.js";
import { claimSetupCheckRun, createSetupCheckContext, endSetupCheckProgress, getLastSetupCheckRun, mergeProjectRun, projectRunNeedsFullRun, recordSetupCheckRun, runProjectSetupChecks, runSetupChecks, runSetupChecksWithProgress, SETUP_CHECKS, type SetupCheckRun } from "../setup-checks/index.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";
import { getRestateStatus, restateCanServe } from "./status.js";

export interface SetupChecksDeps {
  /** Runs every check and answers the run. Called inside `run`'s one `ctx.run` step. */
  runChecks(): Promise<SetupCheckRun>;
  /** Runs every check without showing its progress, for a project run that found a shared check failing. Called inside `runProject`. */
  runChecksQuietly(): Promise<SetupCheckRun>;
  /** Runs one saved project's checks alone, or answers null when no project has that key. Called inside `runProject`'s one `ctx.run` step. */
  runProjectChecks(project: string): Promise<SetupCheckRun | null>;
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
/** Bounds a project run, which waits for its own checks and for any run ahead of it in the object's queue. */
const PROJECT_RUN_TIMEOUT_MS = 60_000;

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
      // Exclusive, so it merges into the run a full run stored, never into one a full run is about to replace.
      runProject: restate.handlers.object.exclusive(async (ctx: ObjectContext, { project }: { project: string }): Promise<SetupCheckRun | null> => {
        const run = await ctx.run("run project checks", () => deps.runProjectChecks(project));
        if (run === null) return null;
        // The full run leaves the progress record alone, which a start may hold for a run queued behind this one.
        const merged = projectRunNeedsFullRun(run)
          ? await ctx.run("run checks", () => deps.runChecksQuietly())
          : mergeProjectRun((await ctx.get<SetupCheckRun>(LAST_RUN)) ?? null, project, run);
        recordSetupCheckRun(merged);
        ctx.set<SetupCheckRun>(LAST_RUN, merged);
        return merged;
      }),
      get: restate.handlers.object.shared(
        async (ctx: ObjectSharedContext): Promise<SetupCheckRun | null> => (await ctx.get<SetupCheckRun>(LAST_RUN)) ?? null,
      ),
    },
  });
}

export const setupChecks = createSetupChecks({
  runChecks: () => runSetupChecksWithProgress(createSetupCheckContext({ restateStatus: getRestateStatus })),
  runChecksQuietly: () => runSetupChecks(createSetupCheckContext({ restateStatus: getRestateStatus }), SETUP_CHECKS),
  runProjectChecks: async (project) => {
    const mapping = getMappings()[project];
    if (!mapping) return null;
    return runProjectSetupChecks(createSetupCheckContext({ restateStatus: getRestateStatus, mappings: () => ({ [project]: mapping }) }), project);
  },
});

export type SetupChecksDefinition = typeof setupChecks;
/** A typed client handle for callers outside this module: the health tool and the admin routes' ingress functions. */
export const SetupChecks: SetupChecksDefinition = { name: "SetupChecks" } as SetupChecksDefinition;

function ingress(deps: SetupChecksIngressDeps, timeoutMs = INGRESS_TIMEOUT_MS) {
  const base = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  return restateClients.connect({
    url: deps.baseUrl ?? RESTATE_INGRESS_BASE_URL,
    fetch: (input, init) => base(input as never, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
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

/**
 * Runs one saved project's checks and answers the stored run they were merged into, or null when no project has that key.
 * Waits for the run, so a caller can show its rows, and answers `unavailable` past the bound while the run still lands.
 */
export function runProjectSetupChecksViaObject(project: string, deps: SetupChecksIngressDeps = {}): Promise<SetupChecksIngressResult<SetupCheckRun | null>> {
  return viaIngress(deps, () => ingress(deps, PROJECT_RUN_TIMEOUT_MS).objectClient<SetupChecksDefinition>({ name: "SetupChecks" }, SETUP_CHECKS_KEY).runProject({ project }));
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
