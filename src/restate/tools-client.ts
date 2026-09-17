// Discovers and calls tools bound to the orchestratorTools Restate service (src/restate/tools.ts,
// AII-710), mirroring the admin-API/ingress shim in restatedev/ai-examples' mcp/restate-mcp
// example. Both addresses are fixed sidecar constants (ADR 023) — see src/restate/server.ts.
//
// The credential never enters the request to the ingress: only the already-verified Caller
// does, because the ingress journals request bodies (the trust boundary named in AII-710).
import type { AccessRole } from "../access-entries.js";
import type { Caller } from "../mcp-identity.js";
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

export type CallToolResult =
  | { status: "ok"; content: Array<{ type: string; text: string }>; isError?: boolean }
  | { status: "unavailable" };

/** For testing: override the ingress base URL and the fetch implementation. */
export interface CallToolDeps {
  ingressBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Posts `{ caller, args }` to the ingress at `<service>/<name>` and returns the handler's
 * ToolResponse. A connection failure or a 5xx response answers `{ status: "unavailable" }`
 * — the signal src/mcp.ts maps to `503 { error: "restate-unavailable" }`.
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
    response = await fetchImpl(`${ingressBaseUrl}/${ORCHESTRATOR_TOOLS_SERVICE}/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caller, args }),
    });
  } catch {
    return { status: "unavailable" };
  }
  if (response.status >= 500) return { status: "unavailable" };
  if (!response.ok) return { status: "unavailable" };

  try {
    const body = (await response.json()) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    return { status: "ok", content: body.content, isError: body.isError };
  } catch {
    return { status: "unavailable" };
  }
}
