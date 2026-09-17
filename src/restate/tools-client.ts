// Discovers and calls tools bound to the orchestratorTools Restate service (src/restate/tools.ts,
// AII-710), mirroring the admin-API/ingress shim in restatedev/ai-examples' mcp/restate-mcp
// example. Both addresses are fixed sidecar constants (ADR 023) — see src/restate/server.ts.
//
// The credential never enters the request to the ingress: only the already-verified Caller
// does, because the ingress journals request bodies (the trust boundary named in AII-710).
import type { AccessRole } from "../access-entries.js";
import type { Caller } from "../mcp-identity.js";
import { systemCaller } from "../mcp-identity.js";
import { RESTATE_ADMIN_BASE_URL, RESTATE_INGRESS_BASE_URL } from "./server.js";

const ORCHESTRATOR_TOOLS_SERVICE = "orchestratorTools";

export interface DiscoveredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  role: AccessRole;
}

/** Shape of the fields this module reads from the admin API's GET /services/<name> response. */
interface AdminHandlerMetadata {
  name: string;
  documentation?: string;
  metadata?: Record<string, string>;
  input_json_schema?: { properties?: Record<string, unknown> } | null;
}

interface AdminServiceMetadata {
  handlers?: AdminHandlerMetadata[];
}

/** For testing: override the admin API base URL and the fetch implementation. */
export interface DiscoverToolsDeps {
  adminBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Reads the admin API for the orchestratorTools service and returns one entry per handler
 * carrying the "mcp.type" metadata key — the discovery contract src/restate/tools.ts's
 * tool() wrapper writes. `inputSchema` is projected back to the handler's own `args` shape:
 * the wire schema is `{ caller, args }` (tools.ts), but a caller of tools/list should see
 * only the tool's own arguments, matching what the pre-migration DIAG_TOOLS literal showed.
 * A connection failure, a non-2xx response, or an unparsable body all degrade to an empty
 * list — the same silent-omission precedent the kg_* tools already use when their capability
 * doesn't exist for a session (src/mcp.ts's tools/list).
 */
export async function discoverTools(deps: DiscoverToolsDeps = {}): Promise<DiscoveredTool[]> {
  const adminBaseUrl = deps.adminBaseUrl ?? RESTATE_ADMIN_BASE_URL;
  const fetchImpl = deps.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(`${adminBaseUrl}/services/${ORCHESTRATOR_TOOLS_SERVICE}`);
  } catch {
    return [];
  }
  if (!response.ok) return [];

  let body: AdminServiceMetadata;
  try {
    body = (await response.json()) as AdminServiceMetadata;
  } catch {
    return [];
  }

  const tools: DiscoveredTool[] = [];
  for (const handler of body.handlers ?? []) {
    if (handler.metadata?.["mcp.type"] !== "tool") continue;
    const role = handler.metadata["mcp.role"];
    if (role !== "user" && role !== "admin") continue;
    const args = handler.input_json_schema?.properties?.args;
    const inputSchema =
      typeof args === "object" && args !== null
        ? (args as Record<string, unknown>)
        : { type: "object", properties: {} };
    tools.push({
      name: handler.name,
      description: handler.documentation ?? "",
      inputSchema,
      role,
    });
  }
  return tools;
}

/**
 * The discovered tool names and schemas, for in-process agents that supply their own
 * schema rather than a hand-maintained list that can drift from the registry — a thin
 * pass-through over `discoverTools` so this module has one discovery implementation.
 */
export async function toolCatalog(deps: DiscoverToolsDeps = {}): Promise<DiscoveredTool[]> {
  return discoverTools(deps);
}

export type CallToolResult =
  | { status: "ok"; content: Array<{ type: string; text: string }>; isError?: boolean }
  | { status: "unavailable" };

/** For testing: override the ingress base URL and the fetch implementation. */
export interface CallToolDeps {
  ingressBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * Restate's own idempotency key (https://docs.restate.dev/operate/invocation#invoke-a-handler-idempotently),
   * sent as the `idempotency-key` header. Restate scopes it by (service, handler, key), so a
   * second call with the same key attaches to the first invocation's result instead of running
   * the handler again. Set only when the caller supplied a key, and already scoped by the
   * caller's identity (`scopeIdempotencyKey` in src/mcp.ts, applied by both doors) so two
   * callers that reuse one literal key cannot collide (AII-719). Writes only; a read call
   * never passes one.
   */
  idempotencyKey?: string;
}

/**
 * Posts `{ caller, args }` to the ingress at `<service>/<name>` and returns the handler's
 * ToolResponse. A connection failure or a 5xx response answers `{ status: "unavailable" }`
 * — the signal src/mcp.ts maps to `503 { error: "restate-unavailable" }`.
 *
 * `name` is percent-encoded before it reaches the URL: an unencoded `../other-service/x`
 * would let `fetch`'s own dot-segment normalization route the request at a sibling
 * service outside `ORCHESTRATOR_TOOLS_SERVICE`, bypassing every role check this module and
 * `src/restate/tools.ts`'s wrapper enforce. This is defense in depth — the primary guard is
 * the caller-provided name shape check at the route in src/admin.ts.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  caller: Caller,
  deps: CallToolDeps = {},
): Promise<CallToolResult> {
  const ingressBaseUrl = deps.ingressBaseUrl ?? RESTATE_INGRESS_BASE_URL;
  const fetchImpl = deps.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(`${ingressBaseUrl}/${ORCHESTRATOR_TOOLS_SERVICE}/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(deps.idempotencyKey ? { "idempotency-key": deps.idempotencyKey } : {}),
      },
      body: JSON.stringify({ caller, args }),
    });
  } catch {
    return { status: "unavailable" };
  }
  // Only a connection failure or a 5xx means Restate is unavailable. A 4xx from the ingress
  // (unknown handler, an args shape zod rejects) is the caller's error and is answered as a
  // tool error with the real status, so it is not mistaken for a down sidecar (AII-711).
  if (response.status >= 500) return { status: "unavailable" };
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { status: "ok", isError: true, content: [{ type: "text", text: `${response.status} ${text}`.trim() }] };
  }

  try {
    const body = (await response.json()) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    return { status: "ok", content: body.content, isError: body.isError };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * Calls a tool as in-process orchestrator code, unattributed to a person: `Caller`
 * is always `systemCaller()` (`{ kind: "system", email: null, role: "admin" }`), so a
 * tool's own role check never refuses this caller. Same handler, same wrapper, no HTTP
 * hop — the ingress round trip is what makes this "direct" versus `/mcp`'s `tools/call`.
 */
export async function callToolAsSystem(
  name: string,
  args: Record<string, unknown>,
  deps: CallToolDeps = {},
): Promise<CallToolResult> {
  return callTool(name, args, systemCaller(), deps);
}
