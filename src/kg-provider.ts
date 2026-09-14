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

type SidecarHeaders = Record<string, string | string[] | undefined>;

type SidecarPostResult =
  | { ok: true; status: number; headers: http.IncomingHttpHeaders; raw: Buffer }
  | { ok: false; error: NodeJS.ErrnoException };

/**
 * Classifies a sidecar rejection so the caller knows whether an MCP session
 * handshake would help. `needs-session` covers a sidecar that has never seen
 * this client; `stale-session` covers one that used to recognise `sentSessionId`
 * but no longer does. Anything else passes through unchanged.
 */
function classifySessionError(
  status: number,
  parsed: SidecarRpcResponse | null,
  sentSessionId: string | null,
): "needs-session" | "stale-session" | null {
  const err = parsed?.error as { code?: number; message?: string } | undefined;
  if (status === 400 && err?.code === -32600 && typeof err.message === "string" && err.message.includes("Missing session ID")) {
    return "needs-session";
  }
  if (status === 404 && sentSessionId) {
    return "stale-session";
  }
  return null;
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

  /**
   * MCP session id negotiated with a stateful sidecar, cached for the life of
   * the process. Null means either no handshake has happened yet, or the
   * sidecar is stateless and none is needed.
   */
  private sessionId: string | null = null;

  constructor(private readonly kgSidecarUrl: string) {}

  /** POSTs `body` to the sidecar and buffers the full response. Never throws. */
  private sendToSidecar(target: URL, transport: typeof http | typeof https, method: string, headers: SidecarHeaders, body: Buffer): Promise<SidecarPostResult> {
    return new Promise((resolve) => {
      const options: http.RequestOptions = {
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? "443" : "80"),
        path: target.pathname + target.search,
        method,
        headers: { ...headers, host: target.host },
      };
      const proxyReq = transport.request(options, (proxyRes) => {
        const chunks: Buffer[] = [];
        proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on("end", () => {
          resolve({ ok: true, status: proxyRes.statusCode ?? 0, headers: proxyRes.headers, raw: Buffer.concat(chunks) });
        });
        proxyRes.on("error", (err) => resolve({ ok: false, error: err as NodeJS.ErrnoException }));
      });
      proxyReq.on("error", (err: NodeJS.ErrnoException) => resolve({ ok: false, error: err }));
      if (body.length > 0) proxyReq.write(body);
      proxyReq.end();
    });
  }

  /**
   * Performs the MCP `initialize` → `notifications/initialized` handshake
   * against the sidecar and returns the negotiated `mcp-session-id`. Throws
   * when the sidecar doesn't answer with a session header, so callers can
   * surface the original rejection instead of retrying into a second failure.
   */
  private async initializeSession(target: URL, transport: typeof http | typeof https, forwardHeaders: SidecarHeaders): Promise<string> {
    const initBody = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "ai-implement-orchestrator", version: "1.0" },
        },
      }),
    );
    const initResult = await this.sendToSidecar(target, transport, "POST", { ...forwardHeaders, "content-length": String(initBody.length) }, initBody);
    const sessionHeader = initResult.ok ? initResult.headers["mcp-session-id"] : undefined;
    if (!initResult.ok || !sessionHeader || Array.isArray(sessionHeader)) {
      const reason = initResult.ok ? `status ${initResult.status}` : initResult.error.message;
      throw new Error(`KG sidecar initialize failed (${reason})`);
    }

    const notifyBody = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    await this.sendToSidecar(
      target,
      transport,
      "POST",
      { ...forwardHeaders, "mcp-session-id": sessionHeader, "content-length": String(notifyBody.length) },
      notifyBody,
    );

    return sessionHeader;
  }

  async listTools(body: Buffer, headers: http.IncomingHttpHeaders): Promise<unknown[]> {
    const target = new URL(this.kgSidecarUrl);
    const transport = target.protocol === "https:" ? https : http;
    const forwardHeaders: SidecarHeaders = { ...headers };
    delete forwardHeaders.authorization;
    delete forwardHeaders.host;
    delete forwardHeaders["transfer-encoding"];

    const send = (sessionId: string | null) => {
      const reqHeaders: SidecarHeaders = { ...forwardHeaders, "content-length": String(body.length) };
      if (sessionId) reqHeaders["mcp-session-id"] = sessionId;
      return this.sendToSidecar(target, transport, "POST", reqHeaders, body);
    };

    const first = await send(this.sessionId);
    if (!first.ok) return [];
    let okResult = first;

    let parsed = parseSidecarRpcResponse(okResult.raw.toString(), okResult.headers["content-type"]);
    const kind = classifySessionError(okResult.status, parsed, this.sessionId);
    if (kind) {
      if (kind === "stale-session") this.sessionId = null;
      try {
        const sessionId = await this.initializeSession(target, transport, forwardHeaders);
        this.sessionId = sessionId;
        console.error(`[mcp] KG sidecar demanded a session; initialized (id ${sessionId}) and retried`);
        const retry = await send(sessionId);
        if (!retry.ok) return [];
        okResult = retry;
        parsed = parseSidecarRpcResponse(okResult.raw.toString(), okResult.headers["content-type"]);
      } catch {
        // Handshake itself failed — fall through and report the original rejection below.
      }
    }

    if (!parsed) {
      console.error(
        `[mcp] KG sidecar tools/list unparseable (status ${okResult.status}, content-type ${okResult.headers["content-type"]}): ${okResult.raw.toString().slice(0, 200)}`,
      );
    } else if (!parsed.result) {
      console.error(
        `[mcp] KG sidecar tools/list returned no result (status ${okResult.status}): ${JSON.stringify(parsed.error ?? parsed).slice(0, 200)}`,
      );
    }
    return parsed?.result?.tools ?? [];
  }

  proxyCall(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void {
    const target = new URL(this.kgSidecarUrl);
    const transport = target.protocol === "https:" ? https : http;

    const forwardHeaders: SidecarHeaders = { ...req.headers };
    delete forwardHeaders.authorization;
    delete forwardHeaders.host;
    delete forwardHeaders.cookie;
    delete forwardHeaders["transfer-encoding"];

    const send = (sessionId: string | null) => {
      const reqHeaders: SidecarHeaders = { ...forwardHeaders };
      if (sessionId) reqHeaders["mcp-session-id"] = sessionId;
      if (body.length > 0) {
        reqHeaders["content-length"] = String(body.length);
      } else {
        delete reqHeaders["content-length"];
      }
      return this.sendToSidecar(target, transport, req.method ?? "POST", reqHeaders, body);
    };

    const writeConnectionError = (err: NodeJS.ErrnoException) => {
      if (res.headersSent) {
        res.destroy(err);
        return;
      }
      if (err.code === "ECONNREFUSED") {
        console.error(`[mcp] KG sidecar connection refused at ${this.kgSidecarUrl}`);
        writeJson(res, 502, { error: "KG sidecar unavailable: connection refused" });
      } else {
        console.error("[mcp] KG sidecar error:", err);
        writeJson(res, 502, { error: "KG sidecar error" });
      }
    };

    const forward = (result: Extract<SidecarPostResult, { ok: true }>) => {
      const outHeaders = { ...result.headers } as http.OutgoingHttpHeaders;
      delete outHeaders["transfer-encoding"];
      outHeaders["content-length"] = String(result.raw.length);
      res.writeHead(result.status, outHeaders);
      res.end(result.raw);
    };

    void (async () => {
      let result = await send(this.sessionId);
      if (!result.ok) {
        writeConnectionError(result.error);
        return;
      }

      const parsed = parseSidecarRpcResponse(result.raw.toString(), result.headers["content-type"]);
      const kind = classifySessionError(result.status, parsed, this.sessionId);
      if (kind) {
        if (kind === "stale-session") this.sessionId = null;
        try {
          const sessionId = await this.initializeSession(target, transport, forwardHeaders);
          this.sessionId = sessionId;
          console.error(`[mcp] KG sidecar demanded a session; initialized (id ${sessionId}) and retried`);
          const retryResult = await send(sessionId);
          if (!retryResult.ok) {
            writeConnectionError(retryResult.error);
            return;
          }
          result = retryResult;
        } catch (err) {
          console.error("[mcp] KG sidecar session initialize failed:", err);
          writeJson(res, 502, { error: "KG sidecar error" });
          return;
        }
      }

      forward(result);
    })();
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

/**
 * Returns a human-readable reason when `resolveMemoryProvider` would return
 * `null`, suitable for inclusion in 503 error bodies to make them
 * operator-actionable. Returns `null` when the provider is configured.
 */
export function providerUnconfiguredReason(
  kgSidecarUrl: string | null,
  providerId?: string | null,
): string | null {
  const id = providerId ?? "sidecar";
  if (id === "sidecar" && !kgSidecarUrl) {
    return "sidecar: KG_SIDECAR_URL unset";
  }
  return null;
}
