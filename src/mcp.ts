import crypto from "node:crypto";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function tokenMatches(submitted: string, configured: string): boolean {
  const a = crypto.createHash("sha256").update(submitted).digest();
  const b = crypto.createHash("sha256").update(configured).digest();
  return crypto.timingSafeEqual(a, b);
}

export async function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mcpAccessToken: string | null,
): Promise<void> {
  if (!mcpAccessToken) {
    json(res, 503, { error: "MCP endpoint not configured: MCP_ACCESS_TOKEN is not set" });
    return;
  }

  const auth = req.headers.authorization;
  const submitted = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!tokenMatches(submitted, mcpAccessToken)) {
    json(res, 401, { error: "unauthorized" });
    return;
  }

  const server = new McpServer({ name: "ai-implement-orchestrator", version: "1.0.0" });
  server.registerTool("ping", { description: "Returns pong" }, async () => ({
    content: [{ type: "text" as const, text: "pong" }],
  }));

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}
