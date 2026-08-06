import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";

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
  kgSidecarUrl: string | null,
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

  if (!kgSidecarUrl) {
    json(res, 503, { error: "MCP endpoint not configured: KG_SIDECAR_URL is not set" });
    return;
  }

  const target = new URL(kgSidecarUrl);
  const transport = target.protocol === "https:" ? https : http;

  const forwardHeaders = { ...req.headers };
  delete forwardHeaders.authorization;
  delete forwardHeaders.host;

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
