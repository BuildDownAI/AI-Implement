// The SDK endpoint for the run lifecycle's durable-execution engine (ADR 017, ADR 018),
// the `Operator` Virtual Object (AII-709), and the `orchestratorTools` service /mcp
// discovers and calls tools through (AII-710). No run kind has migrated onto Restate yet,
// so a workflow module joins the service set here once one does. The Restate server
// (RestateSidecar, ../restate/server.ts, AII-627) reaches this endpoint by push, over
// HTTP/2 — nothing else calls it, which is why the bind address defaults to loopback and
// never leaves it (ADR 023).
import * as http2 from "node:http2";
import { createEndpointHandler } from "@restatedev/restate-sdk/node";
import type {
  ServiceDefinition,
  VirtualObjectDefinition,
  WorkflowDefinition,
} from "@restatedev/restate-sdk";
import { RESTATE_ADMIN_BASE_URL } from "./server.js";
import { operatorObject } from "./operator-object.js";
import { orchestratorTools } from "./tools.js";

export type RestateService =
  | ServiceDefinition<string, unknown>
  | VirtualObjectDefinition<string, unknown>
  | WorkflowDefinition<string, unknown>;

// `Operator` (AII-709) is the first bound object, `orchestratorTools` (AII-710) the first
// bound service; a run kind's workflow module joins them here once one migrates (ADR 018
// case 1: kg-refresh).
export const RESTATE_SERVICES: RestateService[] = [operatorObject, orchestratorTools];

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

/** Signature of the drain check `register()` runs on a META0004 conflict before forcing. */
export type QueryNonCompletedInvocations = (
  fetchImpl: typeof fetch,
  adminBaseUrl: string,
  uri: string,
) => Promise<number | null>;

/** For testing: override the admin API base URL, the fetch implementation, and the drain check. */
export interface RegisterDeps {
  adminBaseUrl?: string;
  fetchImpl?: typeof fetch;
  queryNonCompletedInvocations?: QueryNonCompletedInvocations;
}

const META0004_CONFLICT = "META0004";

/** Registration bound (AII-728): a hung admin API must not hang boot indefinitely. Applies to both the no-force call and the forced retry, and (AII-721) the invocation-count query run in between. */
const REGISTER_TIMEOUT_MS = 10_000;

interface IntrospectionRow {
  [column: string]: unknown;
}

async function runIntrospectionQuery(
  fetchImpl: typeof fetch,
  adminBaseUrl: string,
  sql: string,
): Promise<IntrospectionRow[]> {
  const response = await fetchImpl(`${adminBaseUrl}/query`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`admin API query failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { rows?: unknown };
  if (!Array.isArray(body.rows)) {
    throw new Error("unexpected admin API query response shape (no rows array)");
  }
  return body.rows as IntrospectionRow[];
}

function sqlQuote(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Counts non-completed invocations pinned to the deployment currently registered at `uri` —
 * the deployment a forced re-registration would replace. Verified against the pinned 1.7.10
 * admin API (2026-09-25, spawned locally from the @restatedev/restate-server platform binary
 * this repo already depends on): `POST {adminBaseUrl}/query` with an `Accept: application/json`
 * header runs a DataFusion SQL statement over the server's introspection tables and answers
 * `{ rows: [...] }` as plain JSON — omitting that header answers Arrow IPC instead, which would
 * need `apache-arrow`, an undeclared transitive dependency (pulled in only by the testcontainers
 * devDependency) this production module has no business on.
 *
 * `sys_deployment.endpoint` holds the registered URI with a trailing slash this module's own
 * `uri` never carries, so both forms are matched. `sys_deployment.id` is the value
 * `sys_invocation.pinned_deployment_id` carries once an invocation is first dispatched to that
 * deployment; pinning survives suspension (an in-progress `ctx.sleep`, an unresolved `ctx.run`),
 * so a suspended invocation still counts, and `status != 'completed'` covers every other
 * non-terminal state (pending, scheduled, ready, running, backing-off) with one comparison
 * rather than an enumerated allowlist. Persistent Virtual Object state lives in the separate
 * `state` table and never appears in `sys_invocation`, so it is never counted — durable state
 * alone is not active work (AII-721).
 *
 * A query error, a non-2xx response, or a response shape this function doesn't recognize all
 * resolve to `null` ("unknown"); `register()` treats that the same as a nonzero count and
 * declines the force. No deployment registered yet at `uri` resolves to `0` — nothing to drain.
 */
export async function queryNonCompletedInvocations(
  fetchImpl: typeof fetch,
  adminBaseUrl: string,
  uri: string,
): Promise<number | null> {
  try {
    const normalized = uri.replace(/\/+$/, "");
    const escaped = sqlQuote(normalized);
    const rows = await runIntrospectionQuery(
      fetchImpl,
      adminBaseUrl,
      "SELECT COUNT(*) AS count FROM sys_invocation WHERE status != 'completed' AND pinned_deployment_id IN " +
        `(SELECT id FROM sys_deployment WHERE endpoint = '${escaped}' OR endpoint = '${escaped}/')`,
    );
    const count = rows[0]?.count;
    return typeof count === "number" ? count : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[restate] invocation-count query failed (${message}) — treating as unknown`);
    return null;
  }
}

/**
 * Registers the SDK endpoint with the Restate admin API's POST /deployments, once,
 * at boot, without `force`. Verified against the Restate admin API (2026-09-14): an
 * unchanged endpoint at the same URI answers 200/201, which is success — the server
 * does not require a diff for that to happen. A changed service set at the same URI
 * that the server refuses to apply outright answers a META0004 conflict; `force: true`
 * overrides the deployment at that URI and "can lead inflight invocations to an
 * unrecoverable error state" per Restate's own guidance, so `register()` only retries
 * with `force` after confirming zero non-completed invocations on the deployment it
 * would replace, via queryNonCompletedInvocations() above (AII-721) — the self-deploy
 * interlock has already drained them before a redeploy replaces this process, so the
 * check is a guard against calling this function outside that path, not against a race
 * it needs to win. A caller that finds registration declined should retry on a timer
 * (createRestateRegistrationGate, src/index.ts) rather than treat the decline as final.
 * Every path is logged once. Boot never fails on the result: the kg-refresh trigger seam
 * (AII-683) answers 503 restate-unavailable while no successful registration has completed.
 */
export async function register(deps: RegisterDeps = {}): Promise<RestateRegisterResult> {
  const adminBaseUrl = deps.adminBaseUrl ?? RESTATE_ADMIN_BASE_URL;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const queryInvocations = deps.queryNonCompletedInvocations ?? queryNonCompletedInvocations;
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

  let nonCompleted: number | null;
  try {
    nonCompleted = await queryInvocations(fetchImpl, adminBaseUrl, uri);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[restate] endpoint registration conflict at ${uri} — invocation query threw (${message}), declining force`,
    );
    return { outcome: "declined-conflict", detail: "invocation count unknown" };
  }

  if (nonCompleted === null) {
    console.error(
      `[restate] endpoint registration conflict at ${uri} — could not determine non-completed invocations on the old deployment, declining force`,
    );
    return { outcome: "declined-conflict", detail: "invocation count unknown" };
  }

  if (nonCompleted > 0) {
    console.error(
      `[restate] endpoint registration conflict at ${uri} — ${nonCompleted} non-completed invocation(s) on the old deployment, declining force`,
    );
    return { outcome: "declined-conflict", detail: `${nonCompleted} non-completed invocation(s)` };
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

  console.error(`[restate] endpoint registered at ${uri} (drained-force, zero non-completed invocations, HTTP ${forced.status})`);
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
    signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
  });
}

async function safeJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
