import http from "node:http";
import https from "node:https";

export interface MemoryProviderCapabilities {
  hybridSearch: boolean;
  neighbors: boolean;
  path: boolean;
  provenance: boolean;
  stalenessStamp: boolean;
}

export interface MemoryProvider {
  readonly id: string;
  readonly capabilities: MemoryProviderCapabilities;
  /** Return the list of MCP tool definitions this provider can serve. */
  listTools(body: Buffer, headers: http.IncomingHttpHeaders): Promise<unknown[]>;
  /** Forward a tool call to the provider, writing the response directly to `res`. */
  proxyCall(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void;
}

/**
 * Maps each KG MCP tool name to the capability flag that must be true for
 * the tool to be advertised and served. Tools absent from this map are passed
 * through to the provider without a capability check.
 */
export const KG_TOOL_CAPABILITY: Readonly<Record<string, keyof MemoryProviderCapabilities>> = {
  kg_hybrid_search: "hybridSearch",
  kg_search: "hybridSearch",
  kg_semantic_search: "hybridSearch",
  kg_neighbors: "neighbors",
  kg_path: "path",
  kg_provenance: "provenance",
};

interface SidecarRpcResponse {
  result?: { tools?: unknown[] };
  error?: unknown;
}

/**
 * Extract the JSON-RPC response from a sidecar reply. The Python MCP SDK's
 * streamable-HTTP transport frames responses as SSE (`event:`/`data:` lines)
 * rather than a bare JSON body, so both encodings must be handled. Returns
 * the first event carrying a `result` (falling back to one carrying an
 * `error`), or null if nothing in the reply is a JSON-RPC response.
 */
export function parseSidecarRpcResponse(raw: string, contentType: string | undefined): SidecarRpcResponse | null {
  if (contentType?.includes("text/event-stream")) {
    let errorReply: SidecarRpcResponse | null = null;
    // Events are separated by blank lines; one event's data may span several
    // data: lines, joined with newlines before parsing.
    for (const event of raw.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      try {
        const parsed = JSON.parse(data) as SidecarRpcResponse;
        if (!parsed || typeof parsed !== "object") continue;
        if ("result" in parsed) return parsed;
        if ("error" in parsed) errorReply ??= parsed;
      } catch {
        // keep scanning; other events (pings, notifications) may share the stream
      }
    }
    return errorReply;
  }
  try {
    return JSON.parse(raw) as SidecarRpcResponse;
  } catch {
    return null;
  }
}

function writeJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Wraps the existing KG sidecar at `kgSidecarUrl` as the default provider. */
export class SidecarMemoryProvider implements MemoryProvider {
  readonly id = "sidecar";
  readonly capabilities: MemoryProviderCapabilities = {
    hybridSearch: true,
    neighbors: true,
    path: true,
    provenance: true,
    stalenessStamp: true,
  };

  constructor(private readonly kgSidecarUrl: string) {}

  listTools(body: Buffer, headers: http.IncomingHttpHeaders): Promise<unknown[]> {
    return new Promise((resolve) => {
      const target = new URL(this.kgSidecarUrl);
      const transport = target.protocol === "https:" ? https : http;
      const forwardHeaders = { ...headers };
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
          } else if (!parsed.result) {
            console.error(
              `[mcp] KG sidecar tools/list returned no result (status ${proxyRes.statusCode}): ${JSON.stringify(parsed.error ?? parsed).slice(0, 200)}`,
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

  proxyCall(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void {
    const target = new URL(this.kgSidecarUrl);
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
          writeJson(res, 502, { error: "KG sidecar error" });
        } else {
          res.destroy(err);
        }
      });
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err: NodeJS.ErrnoException) => {
      if (res.headersSent) return;
      if (err.code === "ECONNREFUSED") {
        console.error(`[mcp] KG sidecar connection refused at ${this.kgSidecarUrl}`);
        writeJson(res, 502, { error: "KG sidecar unavailable: connection refused" });
      } else {
        console.error("[mcp] KG sidecar error:", err);
        writeJson(res, 502, { error: "KG sidecar error" });
      }
    });

    if (body.length > 0) proxyReq.write(body);
    proxyReq.end();
  }
}

export class UnknownMemoryProviderError extends Error {
  constructor(id: string) {
    super(`Unknown memory provider: ${id}`);
    this.name = "UnknownMemoryProviderError";
  }
}

/**
 * Constructs a MemoryProvider from the given provider ID and sidecar URL.
 *
 * - Returns `null` when the sidecar provider is requested but no sidecar URL
 *   is configured — matching the current 503 behaviour for unauthenticated
 *   probes of `/mcp`.
 * - Throws `UnknownMemoryProviderError` for unrecognised provider IDs so
 *   misconfiguration is loud at boot rather than silent at query time.
 */
export function resolveMemoryProvider(
  kgSidecarUrl: string | null,
  providerId?: string | null,
): MemoryProvider | null {
  const id = providerId ?? "sidecar";
  if (id === "sidecar") {
    return kgSidecarUrl ? new SidecarMemoryProvider(kgSidecarUrl) : null;
  }
  throw new UnknownMemoryProviderError(id);
}
