import http from "node:http";
import { verifyMcpToken, resolveClientPath } from "./mcp-oauth.js";
import { recordAuthEvent, type AuthEventCause } from "./mcp-auth-events.js";
import { VALID_RUNNER_MODES } from "./runner-mode.js";
import { recheckIdentity, type AccessRole } from "./access-entries.js";
import type { MemoryProvider } from "./kg-provider.js";
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
const RESTATE_TOOL_NAMES = new Set([
  "get_tenant_health",
  "get_runner_mode",
  "list_projects",
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
]);

// ---- Orchestrator-native write tools ----
// The entire write surface of /mcp: a tool is a write only if it is declared here, and each
// declaration names the role required to call it. See docs/adr/015-mcp-reads-open-writes-declared.md.

interface WriteToolContext {
  triggerKgRefresh?: (dryRun?: boolean, acceptNewBaseline?: boolean, actorEmail?: string) => Promise<{ status: number; body: Record<string, unknown> }>;
  /** Caller's email, for write tools (trigger_kg_refresh's acceptNewBaseline) that need to attribute a consequential action. */
  actorEmail?: string;
  setRunnerMode?: (patch: { mode?: string }) => { status: number; body: Record<string, unknown> };
  pauseProject?: (teamKey: string, paused: boolean) => { status: number; body: Record<string, unknown> };
  addProject?: (body: Record<string, unknown>) => { status: number; body: Record<string, unknown> };
  triggerWorkflowSync?: (teamKey: string) => { status: number; body: Record<string, unknown> };
  clearDispatchDedup?: (issueId: string) => { status: number; body: Record<string, unknown> };
}

export interface WriteTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  role: AccessRole;
  run: (
    args: Record<string, unknown>,
    context: WriteToolContext,
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
}

// admin is a strict superset of user (docs/access-model.md § Roles): an entry's role satisfies
// a requirement when it matches exactly or is admin.
const roleAllows = (have: AccessRole | null, need: AccessRole): boolean =>
  have === "admin" || have === need;

// Exported so tests can verify the admin-superset rule against a role: "user" entry without a
// second write tool existing in production — see mcp.test.ts's "admin is a superset of user" case.
export const WRITE_TOOLS: WriteTool[] = [
  {
    name: "trigger_kg_refresh",
    description:
      "Trigger the KG refresh rail (admin role). Same handler as POST /api/kg/refresh: runs the credential preflight, then dispatches the refresh. Poll get_kg_status afterwards. dryRun=true runs the same runner job with kg-snapshot-push's push skipped — all guards run and the guard verdict plus per-part table are reported via get_kg_status, but nothing is pushed, no PR opens, and the served graph never changes. acceptNewBaseline=true downgrades the zero-shrink and 50%-shrink content guards to warnings for this one dispatch and pushes anyway — use only after reviewing a guard refusal's part table and confirming the shrink is an intentional reclassification, not data loss; the accepting identity's email is logged and written into the refresh PR's ### Baseline section.",
    inputSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", description: "Run the rail without pushing the snapshot or touching the served graph; reports the guard table via get_kg_status." },
        acceptNewBaseline: { type: "boolean", description: "Push even though a tracked part (issue.nt/comment.nt) shrank or a part dropped below 50% of its previous size — a one-shot override of the zero-shrink guard, applied to this dispatch only." },
      },
    },
    role: "admin",
    run: async (args, context) => {
      if (!context.triggerKgRefresh) {
        throw new Error("KG refresh is not configured");
      }
      return context.triggerKgRefresh(args.dryRun === true, args.acceptNewBaseline === true, context.actorEmail);
    },
  },
  {
    name: "set_runner_mode",
    description:
      "Set the global runner mode (admin role). Same handler as POST /api/runner-mode: forces all new dispatches onto the given execution path.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: [...VALID_RUNNER_MODES],
          description: "Global runner mode: default restores per-project modes, gha/fly force that execution path, shadow dispatches to both without acting on either result, local runs dispatches in local Docker (a developer-machine mode the admin UI does not offer). Validated by the same check as POST /api/runner-mode.",
        },
      },
      required: ["mode"],
    },
    role: "admin",
    run: async (args, context) => {
      if (!context.setRunnerMode) {
        throw new Error("set_runner_mode is not configured");
      }
      if (typeof args.mode !== "string") {
        return { status: 400, body: { error: "mode is required" } };
      }
      // The mode set is not repeated here: setRunnerModeAction validates with isRunnerMode,
      // the same check POST /api/runner-mode runs, so the tool answers what the route answers.
      return context.setRunnerMode({ mode: args.mode });
    },
  },
  {
    name: "pause_project",
    description:
      "Pause or resume a project mapping (admin role). Same as the paused update of PATCH /api/mappings/<teamKey>.",
    inputSchema: {
      type: "object",
      properties: {
        teamKey: { type: "string", description: "Team key of the mapping" },
        paused: { type: "boolean", description: "Whether dispatch for this project should be paused" },
      },
      required: ["teamKey", "paused"],
    },
    role: "admin",
    run: async (args, context) => {
      if (!context.pauseProject) {
        throw new Error("pause_project is not configured");
      }
      if (typeof args.teamKey !== "string" || !args.teamKey) {
        return { status: 400, body: { error: "teamKey is required" } };
      }
      if (typeof args.paused !== "boolean") {
        return { status: 400, body: { error: "paused is required" } };
      }
      return context.pauseProject(args.teamKey, args.paused);
    },
  },
  {
    name: "add_project",
    description:
      "Create or update a project mapping (admin role). Same as POST /api/mappings, the mapping upsert behind the admin UI's New project stepper.",
    inputSchema: {
      type: "object",
      properties: {
        teamKey: { type: "string", description: "Team key, e.g. the Linear team key or Jira project key" },
        owner: { type: "string", description: "GitHub repo owner/org" },
        repo: { type: "string", description: "GitHub repo name" },
        defaultBranch: { type: "string", description: "Base branch PRs are opened against" },
        workflowFile: { type: "string" },
        maxInProgressAiIssues: { type: "number" },
        executionMode: { type: "string", enum: ["github-actions", "fly-machines"] },
        sessionMode: { type: "string", enum: ["autonomous", "interactive", "hybrid"] },
        machineCpus: { type: "number" },
        machineMemoryMb: { type: "number" },
        planningEnabled: { type: "boolean" },
        planningWorkflowFile: { type: "string" },
        autoApprovePlans: { type: "boolean" },
        autoMerge: { type: "boolean" },
        extraEnv: { type: "object", description: "Passed through to the model process; visible to the agent" },
        provider: { type: "string", enum: ["anthropic", "bedrock"] },
        awsRegion: { type: "string", description: "Required when provider is 'bedrock'" },
        ticketingProvider: { type: "string" },
        ticketingConfig: { type: "object" },
        paused: { type: "boolean" },
        maxTurns: { type: "number" },
        maxIterations: { type: "number" },
        maxJobMinutes: { type: "number" },
        branchPrefix: { type: "string" },
        skillsRepo: { type: "string" },
        referenceRepos: { type: "array" },
        sensitiveAddPatterns: {
          description: "String or array of glob strings",
        },
        sensitiveAllowPatterns: {
          description: "String or array of glob strings",
        },
        dependencyTokenScope: { type: "string", enum: ["installation"] },
        reviewers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              gates: { type: "boolean" },
              maxTurns: {
                type: "integer",
                minimum: 1,
                maximum: 200,
                description: "Optional per-reviewer turn cap. Omit to inherit the reviewer default or global limit.",
              },
            },
            required: ["id", "gates"],
          },
          description: "Which reviewers run on this project's PRs. Omit to keep the stored value; pass null to reset to the default (gap-analysis and code-review, both gating).",
        },
      },
      required: ["teamKey", "owner", "repo", "defaultBranch"],
    },
    role: "admin",
    run: async (args, context) => {
      if (!context.addProject) {
        throw new Error("add_project is not configured");
      }
      if (
        typeof args.teamKey !== "string" || !args.teamKey ||
        typeof args.owner !== "string" || !args.owner ||
        typeof args.repo !== "string" || !args.repo
      ) {
        return { status: 400, body: { error: "teamKey, owner, and repo are required" } };
      }
      if (typeof args.defaultBranch !== "string" || !args.defaultBranch) {
        return { status: 400, body: { error: "defaultBranch is required" } };
      }
      return context.addProject(args);
    },
  },
  {
    name: "trigger_workflow_sync",
    description:
      "Trigger a workflow-template sync for a project (admin role). Same as POST /api/mappings/<teamKey>/sync-workflows.",
    inputSchema: {
      type: "object",
      properties: {
        teamKey: { type: "string", description: "Team key of the mapping" },
      },
      required: ["teamKey"],
    },
    role: "admin",
    run: async (args, context) => {
      if (!context.triggerWorkflowSync) {
        throw new Error("trigger_workflow_sync is not configured");
      }
      if (typeof args.teamKey !== "string" || !args.teamKey) {
        return { status: 400, body: { error: "teamKey is required" } };
      }
      return context.triggerWorkflowSync(args.teamKey);
    },
  },
  {
    name: "clear_dispatch_dedup",
    description:
      "Clear a dedup entry so the issue can be re-dispatched (admin role). Same as DELETE /api/dedup/<issueId>.",
    inputSchema: {
      type: "object",
      properties: {
        issueId: { type: "string", description: "The tracker issue id (not the human identifier) of the dedup entry" },
      },
      required: ["issueId"],
    },
    role: "admin",
    run: async (args, context) => {
      if (!context.clearDispatchDedup) {
        throw new Error("clear_dispatch_dedup is not configured");
      }
      if (typeof args.issueId !== "string" || !args.issueId) {
        return { status: 400, body: { error: "issueId is required" } };
      }
      return context.clearDispatchDedup(args.issueId);
    },
  },
];

// ---- Main handler ----

export async function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  provider: MemoryProvider | null,
  baseUrl: string | null,
  providerDiagnostic?: string | null,
  triggerKgRefresh?: (dryRun?: boolean, acceptNewBaseline?: boolean, actorEmail?: string) => Promise<{ status: number; body: Record<string, unknown> }>,
  setRunnerMode?: (patch: { mode?: string }) => { status: number; body: Record<string, unknown> },
  pauseProject?: (teamKey: string, paused: boolean) => { status: number; body: Record<string, unknown> },
  addProject?: (body: Record<string, unknown>) => { status: number; body: Record<string, unknown> },
  triggerWorkflowSync?: (teamKey: string) => { status: number; body: Record<string, unknown> },
  clearDispatchDedup?: (issueId: string) => { status: number; body: Record<string, unknown> },
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
    // boundary. A kg_* tool now appears regardless of whether a KG sidecar is actually
    // configured (discovery no longer depends on `provider`); calling one without a sidecar
    // degrades to an isError result rather than disappearing from the list. A Restate-backed
    // tool degrades the same way when the admin API itself is unreachable: discoverTools()
    // returns an empty list, so the whole discovered set simply drops out until it recovers.
    const discovered = await discoverTools();
    const restateTools = discovered
      .filter((t) => roleAllows(role, t.role))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    json(res, 200, {
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      result: { tools: [GET_SESSION_IDENTITY_TOOL, ...WRITE_TOOLS.filter((t) => roleAllows(role, t.role)), ...restateTools] },
    });
    return;
  }

  if (rpc?.method === "tools/call") {
    const toolName = (rpc.params?.name as string) ?? "";
    const toolArgs = (rpc.params?.arguments as Record<string, unknown>) ?? {};

    const writeTool = WRITE_TOOLS.find((t) => t.name === toolName);
    if (writeTool) {
      const actor = identity.email;
      if (!roleAllows(role, writeTool.role)) {
        console.log(`[mcp] write tool=${toolName} actor=${actor} role=${role ?? "null"} result=forbidden kind=${identity.kind}`);
        json(res, 200, {
          jsonrpc: "2.0",
          id: rpc.id ?? null,
          result: {
            content: [{ type: "text", text: `forbidden: ${toolName} requires the ${writeTool.role} role` }],
            isError: true,
          },
        });
        return;
      }
      try {
        const result = await writeTool.run(toolArgs, {
          triggerKgRefresh,
          actorEmail: actor,
          setRunnerMode,
          pauseProject,
          addProject,
          triggerWorkflowSync,
          clearDispatchDedup,
        });
        console.log(`[mcp] write tool=${toolName} actor=${actor} role=${role} result=${result.status} kind=${identity.kind}`);
        json(res, 200, {
          jsonrpc: "2.0",
          id: rpc.id ?? null,
          result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
        });
      } catch (err) {
        console.log(`[mcp] write tool=${toolName} actor=${actor} role=${role} result=error kind=${identity.kind}`);
        json(res, 200, {
          jsonrpc: "2.0",
          id: rpc.id ?? null,
          result: {
            content: [{ type: "text", text: (err as Error).message }],
            isError: true,
          },
        });
      }
      return;
    }

    if (toolName === "get_session_identity") {
      const result = { kind: identity.kind, email: identity.email, provider: identity.provider, role };
      json(res, 200, {
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
      });
      return;
    }

    if (RESTATE_TOOL_NAMES.has(toolName)) {
      const caller: Caller = { kind: identity.kind, email: identity.email, role };
      const callResult = await callTool(toolName, toolArgs, caller);
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

    // A tool name that is neither the door's own tool nor a discovered handler is unknown
    // here: since AII-711 every read (the kg_* tools included) is a handler, so nothing is
    // proxied to the sidecar any more.
  }

  // Every other JSON-RPC method, and every unknown tool name, is a method-not-found error.
  // The raw sidecar proxy that used to sit here left with AII-711.
  json(res, 200, {
    jsonrpc: "2.0",
    id: rpc?.id ?? null,
    error: { code: -32601, message: `Method not found: ${rpc?.method ?? "unknown"}` },
  });
}
