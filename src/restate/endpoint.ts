// The SDK endpoint for the run lifecycle's durable-execution engine (ADR 017, ADR 018).
// No run kind has migrated onto Restate yet, so the service set stays empty until the
// first workflow module registers here. The Restate server (RestateSidecar, ../restate/server.ts,
// AII-627) reaches this endpoint by push, over HTTP/2 — nothing else calls it, which is
// why the bind address defaults to loopback and never leaves it (ADR 023).
import * as http2 from "node:http2";
import { createEndpointHandler } from "@restatedev/restate-sdk/node";
import type {
  ServiceDefinition,
  VirtualObjectDefinition,
  WorkflowDefinition,
} from "@restatedev/restate-sdk";
import { getInFlightJobs as defaultGetInFlightJobs } from "../log.js";
import { RESTATE_ADMIN_BASE_URL } from "./server.js";
import { operatorObject } from "./operator-object.js";

export type RestateService =
  | ServiceDefinition<string, unknown>
  | VirtualObjectDefinition<string, unknown>
  | WorkflowDefinition<string, unknown>;

// No run kind's workflow has migrated here yet (ADR 018 case 1: kg-refresh); `Operator`
// (AII-709) is the first bound object, ahead of any workflow module.
export const RESTATE_SERVICES: RestateService[] = [operatorObject];

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9080;

export interface RestateBindAddress {
  host: string;
  port: number;
}

export function restateBindAddress(): RestateBindAddress {
  const host = process.env.RESTATE_ENDPOINT_HOST?.trim() || DEFAULT_HOST;
  const rawPort = process.env.RESTATE_ENDPOINT_PORT?.trim();
  const parsedPort = rawPort === undefined || rawPort === "" ? NaN : Number(rawPort);
  const port = Number.isFinite(parsedPort) ? parsedPort : DEFAULT_PORT;
  return { host, port };
}

export function createRestateEndpointHandler(services: RestateService[] = RESTATE_SERVICES) {
  return createEndpointHandler({ services });
}

// Starts the SDK endpoint as an HTTP/2 server. Called from orchestrator boot
// (src/index.ts) once the RestateSidecar reports readiness, then followed by register().
export function startRestateEndpoint(
  services: RestateService[] = RESTATE_SERVICES,
): Promise<http2.Http2Server> {
  const { host, port } = restateBindAddress();
  const server = http2.createServer(createRestateEndpointHandler(services));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

export type RestateRegisterOutcome =
  | "registered-no-force"
  | "registered-drained-force"
  | "declined-conflict"
  | "unreachable";

export interface RestateRegisterResult {
  outcome: RestateRegisterOutcome;
  detail?: string;
}

/** For testing: override the admin API base URL, the fetch implementation, and the drain check. */
export interface RegisterDeps {
  adminBaseUrl?: string;
  fetchImpl?: typeof fetch;
  getInFlightJobs?: () => unknown[];
}

const META0004_CONFLICT = "META0004";

/**
 * Registers the SDK endpoint with the Restate admin API's POST /deployments, once,
 * at boot, without `force`. Verified against the Restate admin API (2026-09-14): an
 * unchanged endpoint at the same URI answers 200/201, which is success — the server
 * does not require a diff for that to happen. A changed service set at the same URI
 * that the server refuses to apply outright answers a META0004 conflict; `force: true`
 * overrides the deployment at that URI and "can lead inflight invocations to an
 * unrecoverable error state" per Restate's own guidance, so `register()` only retries
 * with `force` after confirming zero in-flight kg-refresh rows via getInFlightJobs()
 * (src/log.ts) — the self-deploy interlock has already drained them before a redeploy
 * replaces this process, so the check is a guard against calling this function outside
 * that path, not against a race it needs to win. Every path is logged once. Boot never
 * fails on the result: the kg-refresh trigger seam (AII-683) answers 503 restate-unavailable
 * while no successful registration has completed.
 */
export async function register(deps: RegisterDeps = {}): Promise<RestateRegisterResult> {
  const adminBaseUrl = deps.adminBaseUrl ?? RESTATE_ADMIN_BASE_URL;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getInFlight = deps.getInFlightJobs ?? defaultGetInFlightJobs;
  const { host, port } = restateBindAddress();
  const uri = `http://${host}:${port}`;

  let response: Response;
  try {
    response = await postDeployment(fetchImpl, adminBaseUrl, uri, false);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[restate] endpoint registration: admin API unreachable (${message})`);
    return { outcome: "unreachable", detail: message };
  }

  if (response.ok) {
    console.error(`[restate] endpoint registered at ${uri} (no-force, HTTP ${response.status})`);
    return { outcome: "registered-no-force" };
  }

  const body = await safeJson(response);
  const code = typeof body?.restate_code === "string" ? body.restate_code : undefined;

  if (code !== META0004_CONFLICT) {
    const message = typeof body?.message === "string" ? body.message : `HTTP ${response.status}`;
    console.error(`[restate] endpoint registration failed: ${message}`);
    return { outcome: "unreachable", detail: message };
  }

  const inFlight = getInFlight();
  if (inFlight.length > 0) {
    console.error(
      `[restate] endpoint registration conflict at ${uri} — ${inFlight.length} in-flight kg-refresh job(s), declining force`,
    );
    return { outcome: "declined-conflict", detail: `${inFlight.length} in-flight job(s)` };
  }

  let forced: Response;
  try {
    forced = await postDeployment(fetchImpl, adminBaseUrl, uri, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[restate] endpoint registration: admin API unreachable on forced retry (${message})`);
    return { outcome: "unreachable", detail: message };
  }

  if (!forced.ok) {
    const forcedBody = await safeJson(forced);
    const message = typeof forcedBody?.message === "string" ? forcedBody.message : `HTTP ${forced.status}`;
    console.error(`[restate] forced endpoint registration failed: ${message}`);
    return { outcome: "unreachable", detail: message };
  }

  console.error(`[restate] endpoint registered at ${uri} (drained-force, zero in-flight jobs, HTTP ${forced.status})`);
  return { outcome: "registered-drained-force" };
}

function postDeployment(
  fetchImpl: typeof fetch,
  adminBaseUrl: string,
  uri: string,
  force: boolean,
): Promise<Response> {
  return fetchImpl(`${adminBaseUrl}/deployments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(force ? { uri, force: true } : { uri }),
  });
}

async function safeJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
