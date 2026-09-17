import http from "node:http";
import { verifyMcpToken, resolveClientPath, getRefreshExpiry } from "./mcp-oauth.js";
import { recordAuthEvent, type AuthEventCause } from "./mcp-auth-events.js";
import { recheckIdentity, type AccessRole } from "./access-entries.js";
import { type MemoryProvider, KG_TOOL_CAPABILITY } from "./kg-provider.js";
import type { Caller } from "./mcp-identity.js";
import { discoverTools, callTool } from "./restate/tools-client.js";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function bufferBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---- Orchestrator-native diagnostic tools ----

// get_session_identity is the one read tool that stays here rather than moving onto the
// orchestratorTools Restate service (AII-711): it reports the door's own state (the
// identity/role this very request resolved to), which only exists at this layer.
const GET_SESSION_IDENTITY_TOOL = {
  name: "get_session_identity",
  description:
    "Returns the caller's email, sign-in provider, and role (user | admin | null when the identity has no allowlist entry) as the allowlist resolves them now. Admin-only skills call this first.",
  inputSchema: { type: "object", properties: {} },
};

// Tool names bound to the orchestratorTools Restate service (src/restate/tools.ts).
// tools/call routes a name in this set through callTool(); tools/list sources every
// discoverable tool's description/schema live from discoverTools() rather than duplicating
// it here — get_session_identity above is the sole read tool that isn't in this set (AII-711).
// The six writes joined this set in AII-713: their role ("admin"), schema, and run body now
// live on the handler itself (src/restate/tools.ts), not in this file — see
// docs/adr/015-mcp-reads-open-writes-declared.md.
const RESTATE_TOOL_NAMES = new Set([
  "get_tenant_health",
  "get_runner_mode",
  "list_projects",
  "get_project_binding",
  "list_in_flight_jobs",
  "get_issue_dispatch_status",
  "get_issue_report_card",
  "get_fleet_report",
  "get_deploy_posture",
  "get_kg_status",
  "kg_hybrid_search",
  "kg_search",
  "kg_semantic_search",
  "kg_neighbors",
  "kg_provenance",
  "kg_path",
  "trigger_kg_refresh",
  "set_runner_mode",
  "pause_project",
  "add_project",
  "trigger_workflow_sync",
  "clear_dispatch_dedup",
]);

// The subset of RESTATE_TOOL_NAMES that mutates state. Not a role declaration — that lives on
// each handler's own `mcp.role` metadata and is asserted inside the tool() wrapper regardless
// of how a call reaches it. This list exists only to decide which calls carry an idempotency
// key (below): attaching one to a read would make a client's identical retry of a genuine
// re-poll return a stale cached answer instead of running again, which reads never wanted.
const RESTATE_WRITE_TOOL_NAMES = new Set([
  "trigger_kg_refresh",
  "set_runner_mode",
  "pause_project",
  "add_project",
  "trigger_workflow_sync",
  "clear_dispatch_dedup",
]);

// admin is a strict superset of user (docs/access-model.md § Roles): an entry's role satisfies
// a requirement when it matches exactly or is admin. Used only for the tools/list courtesy
// filter below — the boundary itself is the tool() wrapper's own copy (src/restate/tools.ts).
const roleAllows = (have: AccessRole | null, need: AccessRole): boolean =>
  have === "admin" || have === need;

// ---- Main handler ----

export async function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  // `provider` is still read by tools/list's kg_* courtesy filter (AII-641); the diagnostic
  // string is kept in the signature so the boot wiring (src/index.ts) and the tests keep
  // their positions. AII-715 restructures the door and drops it.
  provider: MemoryProvider | null,
  baseUrl: string | null,
  _providerDiagnostic?: string | null,
): Promise<void> {
  if (!baseUrl) {
    json(res, 503, { error: "MCP endpoint not configured: OAUTH_REDIRECT_BASE_URL is not set" });
    return;
  }

  const requestStart = Date.now();
  const auth = req.headers.authorization;
  const submitted = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
  const unauthorized = (cause: AuthEventCause, clientId: string | null, email: string | null): void => {
    recordAuthEvent({
      at: Date.now(),
      kind: "401",
      cause,
      clientId,
      clientPath: resolveClientPath(clientId),
      identityKind: email ? "human" : null,
      email,
      familyId: null,
      latencyMs: Date.now() - requestStart,
    });
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer realm="MCP", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
    });
    res.end(JSON.stringify({ error: "unauthorized" }));
  };

  const verification = verifyMcpToken(submitted);
  if (!verification.ok) return unauthorized(verification.reason, verification.clientId, null);
  const identity = verification.identity;

  // An access token outlives a removal by up to an hour; re-checking closes that window.
  const recheck = recheckIdentity(identity);
  if (recheck.status === "unavailable") {
    json(res, 503, { error: "access control is unavailable" });
    return;
  }
  if (recheck.status === "denied") return unauthorized("allowlist", identity.clientId, identity.email);

  const role: AccessRole | null = recheck.status === "ok" ? recheck.entry?.role ?? null : null;

  let body: Buffer;
  try {
    body = await bufferBody(req);
  } catch {
    json(res, 400, { error: "Failed to read request body" });
    return;
  }

  // Parse JSON-RPC to route diagnostic tools vs provider
  let rpc: JsonRpcRequest | null = null;
  if (req.method === "POST" && body.length > 0) {
    try {
      const parsed = JSON.parse(body.toString()) as JsonRpcRequest;
      if (parsed && typeof parsed === "object" && typeof parsed.method === "string") {
        rpc = parsed;
      }
    } catch {
      // not JSON-RPC; proxy verbatim
    }
  }

  // The JSON-RPC handshake (initialize/ping/notifications-initialized) is answered by the
  // orchestrator itself, never proxied: orchestrator-native tools exist regardless of the
  // sidecar, so a real MCP client (not just curl against tools/list) must be able to connect
  // on a sidecar-less boot. A kg_* call without a sidecar configured degrades inside its own
  // handler (src/restate/tools.ts) rather than gating here.
  if (rpc?.method === "initialize") {
    json(res, 200, {
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      result: {
        protocolVersion: (rpc.params?.protocolVersion as string) ?? "2025-03-26",
        serverInfo: { name: "ai-implement", version: "1.0.0" },
        capabilities: { tools: {} },
      },
    });
    return;
  }

  if (rpc?.method === "ping") {
    json(res, 200, { jsonrpc: "2.0", id: rpc.id ?? null, result: {} });
    return;
  }

  if (rpc?.method === "notifications/initialized") {
    // A notification per the JSON-RPC spec (no `id`, no result body expected) — the
    // streamable-HTTP transport acks with an empty 202 rather than a JSON-RPC envelope.
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end();
    return;
  }

  if (rpc?.method === "tools/list") {
    // Every read tool, including the six kg_* proxies, is now a handler on the
    // orchestratorTools Restate service (AII-711) — discovered live rather than duplicated
    // as a literal here. get_session_identity is the one exception: it reports the door's
    // own state, so it's listed unconditionally alongside the discovered set. Hiding a tool
    // the caller's role cannot use is a courtesy — the check in tools/call below is the
    // boundary. The kg_* handlers are discovered like every other tool, but the list keeps
    // the AII-641 courtesy: a kg_* tool is omitted when no KG sidecar is configured, or when
    // the provider lacks that tool's capability, so a client never sees a tool it can never
    // call (tools/call still refuses it inside the handler if called from a stale list). A
    // Restate-backed tool degrades the same way when the admin API itself is unreachable:
    // discoverTools() returns an empty list, so the discovered set drops out until it recovers.
    const kgToolVisible = (name: string): boolean => {
      const capKey = KG_TOOL_CAPABILITY[name];
      if (capKey === undefined && !name.startsWith("kg_")) return true;
      if (!provider) return false;
      return capKey === undefined || provider.capabilities[capKey] === true;
    };
    const discovered = await discoverTools();
    const restateTools = discovered
      .filter((t) => roleAllows(role, t.role) && kgToolVisible(t.name))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    json(res, 200, {
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      result: { tools: [GET_SESSION_IDENTITY_TOOL, ...restateTools] },
    });
    return;
  }

  if (rpc?.method === "tools/call") {
    const toolName = (rpc.params?.name as string) ?? "";
    const toolArgs = (rpc.params?.arguments as Record<string, unknown>) ?? {};

    if (toolName === "get_session_identity") {
      const refreshExpiresAt = await getRefreshExpiry(identity.clientId);
      const result = {
        email: identity.email,
        provider: identity.provider,
        role,
        kind: identity.kind,
        token: verification.token,
        refresh: refreshExpiresAt !== null ? { expiresAt: refreshExpiresAt } : null,
      };
      json(res, 200, {
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
      });
      return;
    }

    if (RESTATE_TOOL_NAMES.has(toolName)) {
      const caller: Caller = { kind: identity.kind, email: identity.email, role };
      // A write is invoked with an idempotency key derived from this MCP request's JSON-RPC
      // id, namespaced by OAuth client so two different clients coincidentally reusing the
      // same id (the JSON-RPC spec only guarantees uniqueness within one client's outstanding
      // requests) can't collide on Restate's dedup store; Restate itself further scopes the
      // key by service+handler, so no tool name needs to be folded in here. A client retry of
      // the same call attaches to the first run instead of re-executing it (AII-713). Reads
      // never carry one — see RESTATE_WRITE_TOOL_NAMES above.
      const idempotencyKey = RESTATE_WRITE_TOOL_NAMES.has(toolName)
        ? `${identity.clientId ?? "no-client"}:${rpc.id ?? "no-id"}`
        : undefined;
      const callResult = await callTool(toolName, toolArgs, caller, idempotencyKey ? { idempotencyKey } : undefined);
      if (callResult.status === "unavailable") {
        json(res, 503, { error: "restate-unavailable" });
        return;
      }
      json(res, 200, {
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        result: { content: callResult.content, isError: callResult.isError },
      });
      return;
    }

    // A tool name that is neither the door's own tool nor a discovered handler is unknown:
    // since AII-711 every read (the kg_* tools included) is a handler, and the six writes
    // joined them in AII-713 — nothing is proxied to the sidecar, and nothing runs inline here.
    json(res, 200, {
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      error: { code: -32602, message: `Unknown tool: ${toolName}` },
    });
    return;
  }

  // The raw sidecar proxy that used to sit here left with AII-711. What remains is the
  // streamable-HTTP contract the door itself implements: POST only (no SSE channel, no
  // server-side session to DELETE), notifications are acknowledged with no body, and any
  // other JSON-RPC method is method-not-found.
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }
  if (rpc && rpc.id === undefined && typeof rpc.method === "string" && rpc.method.startsWith("notifications/")) {
    res.writeHead(202);
    res.end();
    return;
  }
  json(res, 200, {
    jsonrpc: "2.0",
    id: rpc?.id ?? null,
    error: { code: -32601, message: `Method not found: ${rpc?.method ?? "unknown"}` },
  });
}
