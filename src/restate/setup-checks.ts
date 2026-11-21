/**
 * `SetupChecks` — a Virtual Object, one key (`orchestrator`), that runs the setup-check list inside the orchestrator
 * and keeps the last run (AII-1538). `run` (exclusive) runs every check in one `ctx.run` step and stores the result, so
 * a second run queues behind the first. `runProject` (exclusive) runs one project's checks and replaces only that project's rows
 * in the stored run (AII-1543). `runOrchestratorWide` (exclusive) runs every check whose rows no one project owns and replaces only those rows (AII-1544).
 * Every check runs instead when nothing is stored, or when a partial run finds a check every project's rows wait on changed (AII-1543, AII-1544).
 * `get` (shared) answers the stored run, or null before the first.
 * The admin route starts `run` without waiting for it, and reads the run's progress in this process meanwhile (AII-1541).
 * The poll's change detector sends whichever of the three a saved change needs (AII-1544). `recheck` (exclusive) re-runs one check a runtime
 * failure names, with the checks its rows wait on, and replaces their rows, at most once an hour for the same rows (AII-1544).
 * The stored run and the journal hold each check's detail and fix, which by contract carry no secret value (ADR 047),
 * because Restate journals every handler's output.
 */
import * as restate from "@restatedev/restate-sdk";
import type { ObjectContext, ObjectSharedContext } from "@restatedev/restate-sdk";
import * as restateClients from "@restatedev/restate-sdk-clients";
import { getMappings, type RepoMapping } from "../config.js";
import { whenDeployHoldClears } from "../deploy-hold.js";
import { cacheSetupCheckRun, claimSetupCheckRun, createBootSetupChecks, createSetupCheckContext, endSetupCheckProgress, getCachedSetupCheckRun, mergeSetupCheckRun, partialRunNeedsFullRun, recheckHeld, recheckScope, recheckChecksWaitedOn, runOrchestratorWideSetupChecks, runProjectSetupChecks, runSetupChecks, runSetupChecksBeforeRestate, runSetupChecksInScope, runSetupChecksWithProgress, SETUP_CHECKS, type SetupCheckContext, type SetupCheckRunKind, type SetupCheckScope, type SetupCheckRun } from "../setup-checks/index.js";
import { recheckKey, rememberRecheck, type SetupCheckRecheck } from "../setup-checks/recheck.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";
import { getRestateStatus, restateCanServe, restateCanStartWork } from "./status.js";

export interface SetupChecksDeps {
  /** Runs every check and answers the run. Called inside `run`'s one `ctx.run` step. */
  runChecks(): Promise<SetupCheckRun>;
  /** Runs every check without showing its progress, for a partial run the stored run cannot take. Called inside every handler that stores a partial run. */
  runChecksQuietly(): Promise<SetupCheckRun>;
  /** Runs one saved project's checks alone, or answers null when no project has that key. Called inside `runProject`'s one `ctx.run` step. */
  runProjectChecks(project: string): Promise<SetupCheckRun | null>;
  /** Runs every check whose rows no one project owns. Called inside `runOrchestratorWide`. */
  runOrchestratorWideChecks(): Promise<SetupCheckRun>;
  /** The keys of every saved project, so a merge drops a deleted project's rows. Read inside a step of its own. */
  mappedProjects(): string[];
  /** Runs the checks a scope names, for its one saved project when it names one, or answers null when no project has that key. Called inside `recheck`. */
  runScope(scope: SetupCheckScope): Promise<SetupCheckRun | null>;
}

/** For tests: the ingress address, its fetch, whether Restate can serve, and whether a deploy holds new work back. */
export interface SetupChecksIngressDeps {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  canServe?: () => boolean;
  deployHeld?: () => boolean;
}

/** An ingress call's answer, or `unavailable` when Restate could not take it or did not answer. */
export type SetupChecksIngressResult<T> = { status: "ok"; value: T } | { status: "unavailable" };

export const SETUP_CHECKS_KEY = "orchestrator";

const LAST_RUN = "lastRun";
/** When each check last ran by a recheck, keyed by check and project, pruned to the hold. */
const RECHECKED_AT = "recheckedAt";
// The setup checks' times in this module, kept together. The change detector's is in src/setup-checks/change-detector.ts, the recheck hold in src/setup-checks/recheck.ts.
/** Bounds a read of the stored run, and the ingress's acceptance of a new run, which never waits for the run itself. */
const INGRESS_TIMEOUT_MS = 10_000;
/** Bounds a run its caller waits for, which waits for its own checks and for any run ahead of it in the object's queue. */
const WAITED_RUN_TIMEOUT_MS = 60_000;

export function createSetupChecks(deps: SetupChecksDeps) {
  /** Stores a run as the stored run, in the object and in this process's cache of it. */
  function storeRun(ctx: ObjectContext, run: SetupCheckRun): SetupCheckRun {
    cacheSetupCheckRun(run);
    ctx.set<SetupCheckRun>(LAST_RUN, run);
    return run;
  }

  /**
   * Merges a partial run into the stored run and stores the result. A partial run the stored run
   * cannot take (`partialRunNeedsFullRun`) is answered by every check instead, run in a step of its own and stored whole.
   */
  async function storeMerged(ctx: ObjectContext, run: SetupCheckRun): Promise<SetupCheckRun> {
    const stored = (await ctx.get<SetupCheckRun>(LAST_RUN)) ?? null;
    return storeRun(ctx, partialRunNeedsFullRun(run, stored)
      ? await ctx.run("run checks", () => deps.runChecksQuietly())
      : mergeSetupCheckRun(stored, run, await ctx.run("mapped projects", () => deps.mappedProjects())));
  }

  return restate.object({
    name: "SetupChecks",
    handlers: {
      run: restate.handlers.object.exclusive(async (ctx: ObjectContext): Promise<SetupCheckRun> => {
        try {
          return storeRun(ctx, await ctx.run("run checks", () => deps.runChecks()));
        } finally {
          endSetupCheckProgress();
        }
      }),
      // Exclusive, so it merges into the run a full run stored, never into one a full run is about to replace.
      runProject: restate.handlers.object.exclusive(async (ctx: ObjectContext, { project }: { project: string }): Promise<SetupCheckRun | null> => {
        const run = await ctx.run("run project checks", () => deps.runProjectChecks(project));
        if (run === null) return null;
        // A full run it is answered by leaves the progress record alone, which a start may hold for a run queued behind this one.
        return storeMerged(ctx, run);
      }),
      // Exclusive like the others, so it never merges into a run another handler is about to replace.
      runOrchestratorWide: restate.handlers.object.exclusive(
        async (ctx: ObjectContext): Promise<SetupCheckRun> => storeMerged(ctx, await ctx.run("run orchestrator-wide checks", () => deps.runOrchestratorWideChecks())),
      ),
      // Exclusive like the others, so it queues behind any run on the key. A request for a check not on the list, or a project no mapping holds,
      // answers null rather than throwing, which Restate would retry without end.
      recheck: restate.handlers.object.exclusive(async (ctx: ObjectContext, { id, project, cause }: SetupCheckRecheck): Promise<SetupCheckRun | null> => {
        const scope = recheckScope(id, project);
        if (scope === null) return null;
        const now = await ctx.date.now();
        let recheckedAt = (await ctx.get<Record<string, number>>(RECHECKED_AT)) ?? {};
        let stored = (await ctx.get<SetupCheckRun>(LAST_RUN)) ?? null;
        // Runs one scope unless the hour holds it, in a step named for it, and answers its run, or null when it did not run.
        const rerun = async (rerunScope: SetupCheckScope, step: string): Promise<SetupCheckRun | null> => {
          const key = recheckKey(rerunScope);
          if (recheckHeld(stored, rerunScope, recheckedAt[key], now)) return null;
          const run = await ctx.run(step, () => deps.runScope(rerunScope));
          if (run === null) return null;
          recheckedAt = rememberRecheck(recheckedAt, key, now);
          ctx.set<Record<string, number>>(RECHECKED_AT, recheckedAt);
          return run;
        };
        const run = await rerun(scope, "recheck");
        if (run === null) return null;
        stored = await storeMerged(ctx, cause === undefined ? run : { ...run, results: run.results.map((row) => ({ ...row, cause })) });
        // The checks its rows wait on are rechecked with it, so the stored run never shows a row waiting on an older one.
        await recheckChecksWaitedOn(scope, run, async (dependency, waited) => {
          const answered = await rerun(dependency, `recheck ${waited}`);
          if (answered !== null) stored = await storeMerged(ctx, answered);
          return answered;
        });
        return stored;
      }),
      get: restate.handlers.object.shared(
        async (ctx: ObjectSharedContext): Promise<SetupCheckRun | null> => (await ctx.get<SetupCheckRun>(LAST_RUN)) ?? null,
      ),
    },
  });
}

/** This process's setup-check context, as every production run reads it, holding only the project given, so every read is that project's. */
export function productionSetupCheckContext(project?: { key: string; mapping: RepoMapping }): SetupCheckContext {
  return createSetupCheckContext({ restateStatus: getRestateStatus, ...(project && { mappings: () => ({ [project.key]: project.mapping }) }) });
}

/** This process's context holding one saved project, or null when no mapping holds it. */
function savedProjectContext(project: string): SetupCheckContext | null {
  const mapping = getMappings()[project];
  return mapping ? productionSetupCheckContext({ key: project, mapping }) : null;
}

/** The object's dependencies in production: every run reads this process's configuration, narrowed to the one saved project a run names. */
export const createProductionSetupChecksDependencies = (): SetupChecksDeps => ({
  runChecks: () => runSetupChecksWithProgress(productionSetupCheckContext()),
  runChecksQuietly: () => runSetupChecks(productionSetupCheckContext(), SETUP_CHECKS),
  runProjectChecks: async (project) => {
    const ctx = savedProjectContext(project);
    return ctx && runProjectSetupChecks(ctx, project);
  },
  runOrchestratorWideChecks: () => runOrchestratorWideSetupChecks(productionSetupCheckContext()),
  mappedProjects: () => Object.keys(getMappings()),
  runScope: async (scope) => {
    const project = scope.projects?.[0];
    const ctx = project === undefined ? productionSetupCheckContext() : savedProjectContext(project);
    return ctx && runSetupChecksInScope(ctx, scope);
  },
});

export const setupChecks = createSetupChecks(createProductionSetupChecksDependencies());

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

/** Makes one ingress call, unless Restate cannot take it: every call starts an invocation, and so waits out a deploy hold, but a read. */
async function viaIngress<T>(deps: SetupChecksIngressDeps, call: () => PromiseLike<T>, startsWork = true): Promise<SetupChecksIngressResult<T>> {
  const canServe = deps.canServe ?? restateCanServe;
  if (!(startsWork ? restateCanStartWork({ deployHeld: deps.deployHeld, canServe }) : canServe())) return { status: "unavailable" };
  try {
    return { status: "ok", value: await call() };
  } catch (err) {
    console.warn(`[setup-checks] the SetupChecks object did not answer: ${err instanceof Error ? err.message : String(err)}`);
    return { status: "unavailable" };
  }
}

/** A start's answer: the invocation it sent, `busy` with when the run already going began, or `unavailable`. */
export type SetupChecksStart = SetupChecksIngressResult<{ invocationId: string }> | { status: "busy"; startedAt: number };

/** The ingress surface the SetupChecks object's callers depend on, a method per handler, as SelfDeploy's is. */
export interface SetupChecksClient {
  /** The stored run, for the admin route and for hydration. */
  read(): Promise<SetupChecksIngressResult<SetupCheckRun | null>>;
  /**
   * Starts a full run without waiting for it, unless one is already going. The run reports its progress in this process meanwhile.
   * The claim is taken before the send, since the run's own progress appears only once its handler begins.
   */
  start(): Promise<SetupChecksStart>;
  /**
   * Runs one saved project's checks and answers the stored run they were merged into, or null when no project has that key.
   * Waits for the run, so a caller can show its rows, and answers `unavailable` past the bound while the run still lands.
   */
  runProject(project: string): Promise<SetupChecksIngressResult<SetupCheckRun | null>>;
  /** Runs every orchestrator-wide check and answers the stored run they were merged into, for boot to log once Restate serves. */
  runOrchestratorWide(): Promise<SetupChecksIngressResult<SetupCheckRun>>;
  /**
   * Sends a run without waiting for it, and answers whether Restate accepted it. A full run starts as the Setup page's does,
   * so a full run already going answers false and the caller sends another once it ends, which reads what the going run may have read too early.
   */
  send(run: SetupCheckRunKind): Promise<boolean>;
  /** Sends a recheck without waiting for it, and answers whether Restate accepted it. A held recheck is accepted and does nothing. */
  recheck(request: SetupCheckRecheck): Promise<boolean>;
}

export function createSetupChecksIngressClient(deps: SetupChecksIngressDeps = {}): SetupChecksClient {
  const call = (timeoutMs?: number) => ingress(deps, timeoutMs).objectClient<SetupChecksDefinition>({ name: "SetupChecks" }, SETUP_CHECKS_KEY);
  const send = () => ingress(deps).objectSendClient<SetupChecksDefinition>({ name: "SetupChecks" }, SETUP_CHECKS_KEY);
  const client: SetupChecksClient = {
    read: () => viaIngress(deps, () => call().get(), false),
    start: async () => {
      const going = claimSetupCheckRun();
      if (going) return { status: "busy", startedAt: going.startedAt };
      const sent = await viaIngress(deps, async () => ({ invocationId: (await send().run()).invocationId }));
      // No handler will end a claim whose run was never sent.
      if (sent.status !== "ok") endSetupCheckProgress();
      return sent;
    },
    runProject: (project) => viaIngress(deps, () => call(WAITED_RUN_TIMEOUT_MS).runProject({ project })),
    runOrchestratorWide: () => viaIngress(deps, () => call(WAITED_RUN_TIMEOUT_MS).runOrchestratorWide()),
    send: async (run) => {
      if (run.kind === "full") return (await client.start()).status === "ok";
      const sent = await viaIngress(deps, () => (run.kind === "project" ? send().runProject({ project: run.project }) : send().runOrchestratorWide()));
      return sent.status === "ok";
    },
    recheck: async (request) => (await viaIngress(deps, () => send().recheck(request))).status === "ok",
  };
  return client;
}

/** Boot's two runs in production, over this process's server and the object. Each answers once its work ends, and boot never waits for either. */
export function createProductionBootSetupChecks(client = createSetupChecksIngressClient()): ReturnType<typeof createBootSetupChecks> {
  return createBootSetupChecks({
    runBeforeRestate: () => runSetupChecksBeforeRestate(productionSetupCheckContext()),
    // A boot after a self-deploy runs while the deploy still holds new work back, so the run waits for the hold to clear.
    storeOrchestratorWide: async () => {
      await whenDeployHoldClears();
      const stored = await client.runOrchestratorWide();
      return stored.status === "ok" ? stored.value : null;
    },
    log: (line) => { console.warn(line); },
  });
}

/**
 * Fills this process's cache of the stored run once, from the first read that answers, so a read that fails is tried again at the next call.
 * Called after boot registration and again on every poll until it has answered, never from the public health request.
 */
export function createSetupChecksHydration(read = () => createSetupChecksIngressClient().read()): () => Promise<void> {
  let answered = false;
  let reading: Promise<void> | null = null;
  return () => {
    if (answered) return Promise.resolve();
    reading ??= (async () => {
      try {
        const result = await read();
        if (result.status !== "ok") return;
        answered = true;
        // A run completed in this process while the read waited is fresher than the stored one, even if the clock moved back.
        if (result.value && getCachedSetupCheckRun() === null) cacheSetupCheckRun(result.value);
      } finally {
        reading = null;
      }
    })();
    return reading;
  };
}
