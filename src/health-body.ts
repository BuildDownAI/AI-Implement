/**
 * The orchestrator's public health endpoint, `GET /`: the body it serves, and the read a caller makes of it.
 * The body reads local state only, including during a Restate outage.
 */
import { randomUUID } from "node:crypto";
import { restateCanServe, type RestateStatus } from "./restate/status.js";

/**
 * This process's identifier, carried on its health body, so a setup check can tell its own health endpoint from another
 * orchestrator's. A run's callback is accepted only by the process holding its dispatch's database and secret.
 */
export const ORCHESTRATOR_INSTANCE_ID = randomUUID();

/** The setup checks as the health body publishes them: counts and, in bootstrap mode, ids, never titles, details or fixes. */
export interface HealthSetupChecks {
  checkedAt: number | null;
  failingCore: number | null;
  failingOnAdminPath?: string[];
}

export interface HealthBodyReaders {
  sourceCommit(): string | null;
  pollStats(): { pollCount: number; lastPollStartedAt: Date | null; lastPollFinishedAt: Date | null };
  kgDegraded(): boolean;
  sidecarHealthFields(): object;
  restateStatus(): RestateStatus;
  deployHealth(): unknown;
  setupChecks(): Promise<HealthSetupChecks>;
}

export async function buildHealthBody(read: HealthBodyReaders) {
  const { pollCount: polls, lastPollStartedAt, lastPollFinishedAt } = read.pollStats();
  const setupChecks = await read.setupChecks();
  const restate = read.restateStatus();
  return {
    status: restateCanServe(restate) ? "ok" : "unavailable",
    sourceCommit: read.sourceCommit(),
    instanceId: ORCHESTRATOR_INSTANCE_ID,
    polls,
    kgDegraded: read.kgDegraded(),
    ...read.sidecarHealthFields(),
    restate,
    deploy: read.deployHealth(),
    lastPollStartedAt: lastPollStartedAt?.toISOString() ?? null,
    lastPollFinishedAt: lastPollFinishedAt?.toISOString() ?? null,
    setupChecks,
  };
}

export const ORCHESTRATOR_HEALTH_TIMEOUT_MS = 5_000;

/**
 * What the orchestrator's health endpoint at a base URL answered. A body carrying `restate` is the health body. Any
 * other response came from whatever the address reaches instead: a proxy, a tunnel, another site, or a path the
 * orchestrator does not serve.
 */
export type OrchestratorHealthRead =
  | { outcome: "health-body"; status: number; restate: unknown; instanceId: unknown }
  | { outcome: "other-response"; status: number }
  | { outcome: "no-response"; timedOut: boolean; error: string };

/** The orchestrator's health endpoint, `GET /`, at a base URL, joined as a run joins its callback paths. */
export async function readOrchestratorHealth(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<OrchestratorHealthRead> {
  let response: Response;
  try {
    response = await fetchImpl(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`, { signal: AbortSignal.timeout(ORCHESTRATOR_HEALTH_TIMEOUT_MS) });
  } catch (err) {
    // fetch rejects with a bare "fetch failed" and keeps the reason (a DNS failure, a refused connection) as its cause.
    const error = err instanceof Error ? (err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message) : String(err);
    return { outcome: "no-response", timedOut: err instanceof Error && err.name === "TimeoutError", error };
  }
  const body = (await response.json().catch(() => null)) as { restate?: unknown; instanceId?: unknown } | null;
  return body?.restate == null
    ? { outcome: "other-response", status: response.status }
    : { outcome: "health-body", status: response.status, restate: body.restate, instanceId: body.instanceId };
}
