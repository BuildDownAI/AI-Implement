import http from "node:http";
import https from "node:https";
import { verifyMcpToken } from "./mcp-oauth.js";

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export async function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  kgSidecarUrl: string | null,
  baseUrl: string | null,
): Promise<void> {
  // Require both the sidecar and OAuth base URL to be configured
  if (!kgSidecarUrl || !baseUrl) {
    json(res, 503, { error: "MCP endpoint not configured: KG_SIDECAR_URL or OAUTH_REDIRECT_BASE_URL is not set" });
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

  const target = new URL(kgSidecarUrl);
  const transport = target.protocol === "https:" ? https : http;

  const forwardHeaders = { ...req.headers };
  delete forwardHeaders.authorization;
  delete forwardHeaders.host;
  delete forwardHeaders.cookie;

  const options: http.RequestOptions = {
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? "443" : "80"),
    path: target.pathname + target.search,
    method: req.method,
    headers: { ...forwardHeaders, host: target.host },
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

  req.pipe(proxyReq);
}
