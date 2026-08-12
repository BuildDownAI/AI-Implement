import http from "node:http";
import https from "node:https";
import { verifyMcpToken } from "./mcp-oauth.js";
import { getRunnerMode } from "./runner-mode.js";
import { getMappings } from "./config.js";
import { getInFlightJobs } from "./log.js";
import { getDb } from "./dedup.js";

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
      "Returns an orchestrator health summary: runner mode, in-flight job count, pending gap-fill queue count, and project count. Use as a first-pass check before digging deeper.",
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
];

const DIAG_TOOL_NAMES = new Set(DIAG_TOOLS.map((t) => t.name));

function callDiagnosticTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "get_tenant_health": {
      const { mode, source } = getRunnerMode();
      const inFlight = getInFlightJobs();
      const db = getDb();
      const { n: pendingGapfillCount } = db
        .prepare("SELECT COUNT(*) as n FROM comment_gapfill_queue WHERE status = 'pending'")
        .get() as { n: number };
      const projectCount = Object.keys(getMappings()).length;
      return { runnerMode: { mode, source }, inFlightJobCount: inFlight.length, pendingGapfillCount, projectCount };
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
      return {
        identifier,
        inFlight,
        inDedupWindow: !!dedupRow,
        dedupEntry: dedupRow ?? null,
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

    default:
      return { error: `Unknown diagnostic tool: ${name}` };
  }
}

// ---- Sidecar proxy helpers ----

/**
 * Extract the JSON-RPC response from a sidecar reply. The Python MCP SDK's
 * streamable-HTTP transport frames responses as SSE (`event:`/`data:` lines)
 * rather than a bare JSON body, so both encodings must be handled.
 */
function parseSidecarRpcResponse(
  raw: string,
  contentType: string | undefined,
): { result?: { tools?: unknown[] } } | null {
  if (contentType?.includes("text/event-stream")) {
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const parsed = JSON.parse(line.slice(5).trim()) as { result?: { tools?: unknown[] } };
        if (parsed && typeof parsed === "object" && "result" in parsed) return parsed;
      } catch {
        // keep scanning; other events (pings, notifications) may share the stream
      }
    }
    return null;
  }
  try {
    return JSON.parse(raw) as { result?: { tools?: unknown[] } };
  } catch {
    return null;
  }
}

function fetchSidecarToolsList(
  kgSidecarUrl: string,
  body: Buffer,
  reqHeaders: http.IncomingHttpHeaders,
): Promise<unknown[]> {
  return new Promise((resolve) => {
    const target = new URL(kgSidecarUrl);
    const transport = target.protocol === "https:" ? https : http;
    const forwardHeaders = { ...reqHeaders };
    delete forwardHeaders.authorization;
    delete forwardHeaders.host;
    delete forwardHeaders["transfer-encoding"];
    const options: http.RequestOptions = {
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? "443" : "80"),
      path: target.pathname + target.search,
      method: "POST",
      headers: { ...forwardHeaders, host: target.host, "content-length": String(body.length) },
    };
    const proxyReq = transport.request(options, (proxyRes) => {
      const chunks: Buffer[] = [];
      proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
      proxyRes.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        const parsed = parseSidecarRpcResponse(raw, proxyRes.headers["content-type"]);
        if (!parsed) {
          console.error(
            `[mcp] KG sidecar tools/list unparseable (status ${proxyRes.statusCode}, content-type ${proxyRes.headers["content-type"]}): ${raw.slice(0, 200)}`,
          );
        }
        resolve(parsed?.result?.tools ?? []);
      });
      proxyRes.on("error", () => resolve([]));
    });
    proxyReq.on("error", () => resolve([]));
    proxyReq.write(body);
    proxyReq.end();
  });
}

function proxyBuffered(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  kgSidecarUrl: string,
  body: Buffer,
): void {
  const target = new URL(kgSidecarUrl);
  const transport = target.protocol === "https:" ? https : http;

  const forwardHeaders = { ...req.headers };
  delete forwardHeaders.authorization;
  delete forwardHeaders.host;
  delete forwardHeaders.cookie;
  delete forwardHeaders["transfer-encoding"];

  const headers: Record<string, string | string[] | undefined> = {
    ...forwardHeaders,
    host: target.host,
  };
  if (body.length > 0) {
    headers["content-length"] = String(body.length);
  } else {
    delete headers["content-length"];
  }

  const options: http.RequestOptions = {
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? "443" : "80"),
    path: target.pathname + target.search,
    method: req.method,
    headers,
  };

  const proxyReq = transport.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers as http.OutgoingHttpHeaders);
    proxyRes.on("error", (err) => {
      console.error("[mcp] KG sidecar response error:", err);
      if (!res.headersSent) {
        json(res, 502, { error: "KG sidecar error" });
      } else {
        res.destroy(err);
      }
    });
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err: NodeJS.ErrnoException) => {
    if (res.headersSent) return;
    if (err.code === "ECONNREFUSED") {
      console.error(`[mcp] KG sidecar connection refused at ${kgSidecarUrl}`);
      json(res, 502, { error: "KG sidecar unavailable: connection refused" });
    } else {
      console.error("[mcp] KG sidecar error:", err);
      json(res, 502, { error: "KG sidecar error" });
    }
  });

  if (body.length > 0) proxyReq.write(body);
  proxyReq.end();
}

// ---- Main handler ----

export async function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  kgSidecarUrl: string | null,
  baseUrl: string | null,
): Promise<void> {
  if (!baseUrl) {
    json(res, 503, { error: "MCP endpoint not configured: OAUTH_REDIRECT_BASE_URL is not set" });
    return;
  }

  const auth = req.headers.authorization;
  const submitted = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!verifyMcpToken(submitted)) {
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer realm="MCP", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
    });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  let body: Buffer;
  try {
    body = await bufferBody(req);
  } catch {
    json(res, 400, { error: "Failed to read request body" });
    return;
  }

  // Parse JSON-RPC to route diagnostic tools vs sidecar proxy
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
    // Merge native diagnostic tools with kg_* tools from the sidecar
    const kgTools = kgSidecarUrl
      ? await fetchSidecarToolsList(kgSidecarUrl, body, req.headers)
      : [];
    json(res, 200, {
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      result: { tools: [...DIAG_TOOLS, ...kgTools] },
    });
    return;
  }

  if (rpc?.method === "tools/call") {
    const toolName = (rpc.params?.name as string) ?? "";
    if (DIAG_TOOL_NAMES.has(toolName)) {
      const toolArgs = (rpc.params?.arguments as Record<string, unknown>) ?? {};
      try {
        const result = callDiagnosticTool(toolName, toolArgs);
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
  }

  // Proxy everything else to the KG sidecar
  if (!kgSidecarUrl) {
    json(res, 503, { error: "KG sidecar not configured" });
    return;
  }

  proxyBuffered(req, res, kgSidecarUrl, body);
}
