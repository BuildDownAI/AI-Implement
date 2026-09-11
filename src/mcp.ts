import http from "node:http";
import type { PreflightCheckResult, KgRefreshStatus } from "./kg-refresh.js";
import { verifyMcpToken } from "./mcp-oauth.js";
import { getRunnerMode } from "./runner-mode.js";
import { getMappings } from "./config.js";
import { getInFlightJobs, getRunRecordMergeVerdict } from "./log.js";
import { getDb } from "./dedup.js";
import { getIssueReportCard, getFleetReport } from "./report-card.js";
import { isKgDegraded } from "./deploy-notify.js";
import { recheckIdentity, type AccessRole } from "./access-entries.js";
import { type MemoryProvider, KG_TOOL_CAPABILITY } from "./kg-provider.js";
import { getDeployPosture } from "./deploy-posture.js";

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

const DIAG_TOOLS = [
  {
    name: "get_tenant_health",
    description:
      "Returns an orchestrator health summary: runner mode, in-flight job count, pending gap-fill queue count, project count, and (when a KG source repo is configured) a live credential preflight for the kg-refresh rail (`kgRefreshPreflight` with one row per repo and grant). Use as a first-pass check before digging deeper.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_runner_mode",
    description:
      "Returns the current global runner mode (default/gha/fly/local/shadow) and whether it came from an env var, database setting, or built-in default.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_projects",
    description:
      "Lists all configured project mappings: team key, repo, execution mode, provider, paused state, and per-project capacity cap.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_in_flight_jobs",
    description:
      "Lists all currently dispatching or running jobs with their issue identifier, repo, phase, and elapsed seconds since dispatch.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_issue_dispatch_status",
    description:
      "Returns the dispatch status for a specific issue identifier (e.g. 'AII-123'): in-flight flag, dedup-window flag, and the last five dispatch log entries. Use this to diagnose why a ticket is not being picked up.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Issue identifier, e.g. 'AII-123'" },
      },
      required: ["identifier"],
    },
  },
  {
    name: "get_issue_report_card",
    description:
      "Returns a full report card for a specific issue: all dispatch runs with per-pass telemetry, totals (dispatches, passes, cost), approval/merge/escape status, gap-fill rounds, and review-fix rounds. Use this to understand the full history and outcome of an issue.",
    inputSchema: {
      type: "object",
      properties: {
        issue: { type: "string", description: "Issue identifier, e.g. 'AII-123'" },
      },
      required: ["issue"],
    },
  },
  {
    name: "get_fleet_report",
    description:
      "Returns an aggregated fleet report: per-repo job/issue/cost/pass counts, one-shot and eventual approval rates, planning A/B cohort comparison, review escape rate, and a ranked list of runaway issues. Optional `days` parameter (default 30) controls the look-back window.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Look-back window in days (default 30)" },
      },
    },
  },
  {
    name: "get_deploy_posture",
    description:
      "Returns the current deploy posture: whether autoDeploy is on, the watched repo/branch, running vs head commit, deploy hold and in-flight state, runner channel image and commit, and a mergeCost field summarising the landing cost of a merge (deploy+image / image / none). Use this before filing or merging to understand the blast radius.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_kg_status",
    description:
      "Returns the KG refresh rail state: stage (idle | staging | ingest-running | serving | reverted | failed), the served snapshot stamp, the materialize path the next refresh will stage (rdflib | direct), and the last refresh outcome with its gate. Poll it after `POST /api/kg/refresh`.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_session_identity",
    description:
      "Returns the caller's email, sign-in provider, and role (user | admin | null when the identity has no allowlist entry) as the allowlist resolves them now. Admin-only skills call this first.",
    inputSchema: { type: "object", properties: {} },
  },
];

const DIAG_TOOL_NAMES = new Set(DIAG_TOOLS.map((t) => t.name));

// ---- Orchestrator-native write tools ----
// The entire write surface of /mcp: a tool is a write only if it is declared here, and each
// declaration names the role required to call it. See docs/adr/015-mcp-reads-open-writes-declared.md.

interface WriteToolContext {
  triggerKgRefresh?: () => Promise<{ status: number; body: Record<string, unknown> }>;
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
      "Trigger the KG refresh rail (admin role). Same handler as POST /api/kg/refresh: runs the credential preflight, then dispatches the refresh. Poll get_kg_status afterwards.",
    inputSchema: { type: "object", properties: {} },
    role: "admin",
    run: async (_args, context) => {
      if (!context.triggerKgRefresh) {
        throw new Error("KG refresh is not configured");
      }
      return context.triggerKgRefresh();
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
          enum: ["default", "gha", "fly", "shadow"],
          description: "Global runner mode: default restores per-project modes, gha/fly force that execution path, shadow dispatches to both without acting on either result.",
        },
      },
      required: ["mode"],
    },
    role: "admin",
    run: async (args, context) => {
      if (!context.setRunnerMode) {
        throw new Error("set_runner_mode is not configured");
      }
      const validModes = ["default", "gha", "fly", "shadow"];
      if (typeof args.mode !== "string" || !validModes.includes(args.mode)) {
        return { status: 400, body: { error: `mode is required and must be one of: ${validModes.join(", ")}` } };
      }
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

async function callDiagnosticTool(
  name: string,
  args: Record<string, unknown>,
  context: {
    defaultRunnerImage?: string;
    runKgRefreshPreflight?: () => Promise<PreflightCheckResult>;
    getKgStatus?: () => Promise<KgRefreshStatus>;
    sessionIdentity?: { email: string; provider: string; role: AccessRole | null };
  } = {},
): Promise<unknown> {
  switch (name) {
    case "get_tenant_health": {
      const { mode, source } = getRunnerMode();
      const inFlight = getInFlightJobs();
      const db = getDb();
      const { n: pendingGapfillCount } = db
        .prepare("SELECT COUNT(*) as n FROM comment_gapfill_queue WHERE status = 'pending'")
        .get() as { n: number };
      const projectCount = Object.keys(getMappings()).length;
      const kgRefreshPreflight = context.runKgRefreshPreflight
        ? await context.runKgRefreshPreflight()
        : null;
      return { runnerMode: { mode, source }, inFlightJobCount: inFlight.length, pendingGapfillCount, projectCount, kgDegraded: isKgDegraded(), kgRefreshPreflight };
    }

    case "get_runner_mode": {
      const { mode, source } = getRunnerMode();
      return { mode, source };
    }

    case "list_projects": {
      const mappings = getMappings();
      return Object.entries(mappings).map(([key, m]) => ({
        teamKey: key,
        repo: `${m.owner}/${m.repo}`,
        executionMode: m.executionMode,
        provider: m.provider,
        paused: m.paused,
        planningEnabled: m.planningEnabled,
        maxInProgressAiIssues: m.maxInProgressAiIssues,
        defaultBranch: m.defaultBranch,
        workflowFile: m.workflowFile,
        sessionMode: m.sessionMode,
        autoMerge: m.autoMerge,
        maxTurns: m.maxTurns,
        maxIterations: m.maxIterations,
        maxJobMinutes: m.maxJobMinutes,
        branchPrefix: m.branchPrefix,
        skillsRepo: m.skillsRepo,
        referenceRepos: m.referenceRepos,
        dependencyTokenScope: m.dependencyTokenScope,
        sensitiveAddPatterns: m.sensitiveAddPatterns,
        sensitiveAllowPatterns: m.sensitiveAllowPatterns,
        machineCpus: m.machineCpus,
        machineMemoryMb: m.machineMemoryMb,
        awsRegion: m.awsRegion,
        planningWorkflowFile: m.planningWorkflowFile,
        autoApprovePlans: m.autoApprovePlans,
      }));
    }

    case "list_in_flight_jobs": {
      const now = Date.now();
      return getInFlightJobs().map((j) => ({
        id: j.id,
        issueIdentifier: j.issueIdentifier,
        issueTitle: j.issueTitle,
        repo: j.repo,
        phase: j.phase,
        status: j.status,
        dispatchedAt: j.dispatchedAt,
        elapsedSeconds: Math.round((now - j.dispatchedAt) / 1000),
      }));
    }

    case "get_issue_dispatch_status": {
      const identifier = args.identifier;
      if (typeof identifier !== "string" || !identifier) {
        return { error: "identifier is required and must be a non-empty string" };
      }
      const db = getDb();
      const recentRows = db
        .prepare(
          "SELECT id, status, dispatched_at, repo, phase, pr_url, conclusion FROM dispatch_log WHERE issue_identifier = ? ORDER BY dispatched_at DESC LIMIT 5",
        )
        .all(identifier) as Array<{
          id: number;
          status: string | null;
          dispatched_at: number;
          repo: string | null;
          phase: string | null;
          pr_url: string | null;
          conclusion: string | null;
        }>;
      const dedupRow = db
        .prepare("SELECT issue_id, dispatched_at FROM dispatched WHERE issue_identifier = ?")
        .get(identifier) as { issue_id: string; dispatched_at: number } | undefined;
      const inFlight = recentRows.some(
        (j) => j.status === "dispatched" || j.status === "running",
      );
      const latestPrUrl = recentRows.find((j) => j.pr_url)?.pr_url ?? null;
      const mergeVerdict = latestPrUrl
        ? { verdict: getRunRecordMergeVerdict(identifier, latestPrUrl), prUrl: latestPrUrl }
        : null;
      return {
        identifier,
        inFlight,
        inDedupWindow: !!dedupRow,
        dedupEntry: dedupRow ?? null,
        mergeVerdict,
        recentDispatches: recentRows.map((j) => ({
          id: j.id,
          status: j.status,
          dispatchedAt: j.dispatched_at,
          repo: j.repo,
          phase: j.phase,
          prUrl: j.pr_url,
          conclusion: j.conclusion,
        })),
      };
    }

    case "get_issue_report_card": {
      const issue = args.issue;
      if (typeof issue !== "string" || !issue) {
        return { error: "issue is required and must be a non-empty string" };
      }
      const card = getIssueReportCard(issue);
      if (!card) return { error: `No dispatch records found for issue: ${issue}` };
      return card;
    }

    case "get_fleet_report": {
      const days = typeof args.days === "number" ? args.days : undefined;
      return getFleetReport({ days });
    }

    case "get_deploy_posture":
      return getDeployPosture({ defaultImage: context.defaultRunnerImage });

    case "get_kg_status":
      return context.getKgStatus ? await context.getKgStatus() : { error: "KG refresh is not configured" };

    case "get_session_identity":
      return context.sessionIdentity ?? { email: null, provider: null, role: null };

    default:
      return { error: `Unknown diagnostic tool: ${name}` };
  }
}

// ---- Main handler ----

export async function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  provider: MemoryProvider | null,
  baseUrl: string | null,
  providerDiagnostic?: string | null,
  defaultRunnerImage?: string,
  runKgRefreshPreflight?: () => Promise<PreflightCheckResult>,
  getKgStatus?: () => Promise<KgRefreshStatus>,
  triggerKgRefresh?: () => Promise<{ status: number; body: Record<string, unknown> }>,
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

  const auth = req.headers.authorization;
  const submitted = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
  const unauthorized = (): void => {
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer realm="MCP", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
    });
    res.end(JSON.stringify({ error: "unauthorized" }));
  };

  const identity = verifyMcpToken(submitted);
  if (!identity) return unauthorized();

  // An access token outlives a removal by up to an hour; re-checking closes that window.
  const recheck = recheckIdentity(identity);
  if (recheck.status === "unavailable") {
    json(res, 503, { error: "access control is unavailable" });
    return;
  }
  if (recheck.status === "denied") return unauthorized();

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

  if (rpc?.method === "tools/list") {
    // Merge native diagnostic tools with kg_* tools from the provider. Hiding a write tool the
    // caller's role cannot use is a courtesy — the check in tools/call below is the boundary.
    const kgTools = provider ? await provider.listTools(body, req.headers) : [];
    json(res, 200, {
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      result: { tools: [...DIAG_TOOLS, ...WRITE_TOOLS.filter((t) => roleAllows(role, t.role)), ...kgTools] },
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
        console.log(`[mcp] write tool=${toolName} actor=${actor} role=${role ?? "null"} result=forbidden`);
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
          setRunnerMode,
          pauseProject,
          addProject,
          triggerWorkflowSync,
          clearDispatchDedup,
        });
        console.log(`[mcp] write tool=${toolName} actor=${actor} role=${role} result=${result.status}`);
        json(res, 200, {
          jsonrpc: "2.0",
          id: rpc.id ?? null,
          result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
        });
      } catch (err) {
        console.log(`[mcp] write tool=${toolName} actor=${actor} role=${role} result=error`);
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

    if (DIAG_TOOL_NAMES.has(toolName)) {
      try {
        const result = await callDiagnosticTool(toolName, toolArgs, {
          defaultRunnerImage,
          runKgRefreshPreflight,
          getKgStatus,
          sessionIdentity: { email: identity.email, provider: identity.provider, role },
        });
        json(res, 200, {
          jsonrpc: "2.0",
          id: rpc.id ?? null,
          result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
        });
      } catch (err) {
        json(res, 200, {
          jsonrpc: "2.0",
          id: rpc.id ?? null,
          result: {
            content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
            isError: true,
          },
        });
      }
      return;
    }

    // KG tool call — check provider availability and capability
    if (!provider) {
      const detail = providerDiagnostic ? ` (${providerDiagnostic})` : "";
      json(res, 503, { error: `no memory provider is configured${detail}` });
      return;
    }
    const capKey = KG_TOOL_CAPABILITY[toolName];
    if (capKey !== undefined && !provider.capabilities[capKey]) {
      json(res, 200, {
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        error: { code: -32601, message: `Tool not supported by this memory provider: ${toolName}` },
      });
      return;
    }
    provider.proxyCall(req, res, body);
    return;
  }

  // Proxy everything else to the provider
  if (!provider) {
    const detail = providerDiagnostic ? ` (${providerDiagnostic})` : "";
    json(res, 503, { error: `no memory provider is configured${detail}` });
    return;
  }

  provider.proxyCall(req, res, body);
}
