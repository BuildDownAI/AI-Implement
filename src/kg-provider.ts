import http from "node:http";
import https from "node:https";
import { getServedNamespace } from "./kg-sidecar.js";

export interface MemoryProviderCapabilities {
  hybridSearch: boolean;
  neighbors: boolean;
  path: boolean;
  provenance: boolean;
  stalenessStamp: boolean;
}

/**
 * Outcome of a non-streaming `callKgTool`: either the sidecar's own JSON-RPC `result`
 * (whatever shape that tool returns — e.g. kg_hybrid_search's `degraded` flag travels
 * inside it untouched), or a human-readable error string. The error text matches what
 * `proxyCall`'s `writeConnectionError` used to write into a 502 body, or the sidecar's
 * own JSON-RPC error message, so a caller migrating off `/mcp`'s raw proxy sees the same
 * wording it always has.
 */
export type KgToolResult = { ok: true; result: unknown } | { ok: false; error: string };

export interface MemoryProvider {
  readonly id: string;
  readonly capabilities: MemoryProviderCapabilities;
  /** Return the list of MCP tool definitions this provider can serve. */
  listTools(body: Buffer, headers: http.IncomingHttpHeaders): Promise<unknown[]>;
  /** Forward a tool call to the provider, writing the response directly to `res`. */
  proxyCall(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void;
  /**
   * Calls a single `kg_*` tool and returns its parsed result rather than writing to an
   * HTTP response — the path a Restate tool handler (src/restate/tools.ts) uses, since it
   * has no `res` to stream into.
   */
  callKgTool(name: string, args: Record<string, unknown>): Promise<KgToolResult>;
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
 * Result of the sidecar liveness probe (AII-648): a session-tolerant `tools/list`
 * that must return the six `kg_*` tools, followed by one cheap `kg_neighbors`
 * call that must return a JSON-RPC result rather than an error.
 */
export interface SidecarHealth {
  reachable: boolean;
  toolsListed: boolean;
  lastError: string | null;
  checkedAt: number | null;
}

/**
 * Module-level record of the last probe outcome. Mutable and shared across every
 * SidecarMemoryProvider instance in the process — there is only ever one sidecar.
 * `checkedAt: null` means no probe has run yet, distinct from a failed probe.
 */
export const sidecarHealth: SidecarHealth = {
  reachable: false,
  toolsListed: false,
  lastError: null,
  checkedAt: null,
};

/** True when the last completed probe failed. A never-probed sidecar is not "unavailable". */
export function isKgUnavailable(): boolean {
  return sidecarHealth.lastError !== null;
}

/** The `kgUnavailable` + `sidecar` pair surfaced identically at every read site (AII-650). */
export interface SidecarHealthFields {
  kgUnavailable: boolean;
  sidecar: SidecarHealth;
}

export function sidecarHealthFields(): SidecarHealthFields {
  return { kgUnavailable: isKgUnavailable(), sidecar: { ...sidecarHealth } };
}

function recordSidecarHealth(patch: Omit<SidecarHealth, "checkedAt">): SidecarHealth {
  sidecarHealth.reachable = patch.reachable;
  sidecarHealth.toolsListed = patch.toolsListed;
  sidecarHealth.lastError = patch.lastError;
  sidecarHealth.checkedAt = Date.now();
  return { ...sidecarHealth };
}

/** Re-probes triggered by a failed listTools/proxyCall are throttled to this interval. */
const PROBE_THROTTLE_MS = 60_000;

/**
 * Bounds every buffered `sendToSidecar` call (the session handshake, `listTools`, and
 * both probe steps). Mirrors the 2s-timeout pattern `KgSidecar`'s own readiness poll
 * uses in src/kg-sidecar.ts, scaled up because these calls run a real query rather than
 * checking whether the port accepts connections. Without this bound, a sidecar that
 * accepts the connection but never answers — e.g. `[kg] sidecar ready` already logged,
 * then a deadlock or a cold-start query hang — leaves the boot-time probe in main()
 * unresolved forever, which stalls startServer() and postBootNotice() along with it.
 * Deliberately not applied to `sendOrStream` (proxyCall's real-traffic path): a
 * legitimate hybrid-search or embedding query can run longer than this.
 */
const SIDECAR_REQUEST_TIMEOUT_MS = 10_000;

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

/** A proxyCall outcome whose response was relayed to the client as it arrived. */
type StreamedOutcome = { ok: true; streamed: true };
type SendOutcome = SidecarPostResult | StreamedOutcome;

/** Wraps the existing KG sidecar at `kgSidecarUrl` as the default provider. */
/**
 * Headers every probe request carries. The Python MCP SDK's streamable-HTTP transport
 * answers 406 ("Client must accept application/json" / "... and text/event-stream") when
 * the Accept header is missing — found live on the first probe smoke against a healthy
 * stateless sidecar, which the probe then reported as unavailable.
 */
const PROBE_HEADERS: SidecarHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };

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

  constructor(
    private readonly kgSidecarUrl: string,
    private readonly resolveServedNamespace: () => Promise<string | null> = getServedNamespace,
  ) {}

  /**
   * POSTs `body` to the sidecar and buffers the full response. Never throws.
   * Bounded by SIDECAR_REQUEST_TIMEOUT_MS: a connection that accepts but never answers
   * resolves `ok: false` instead of hanging the caller (and, via probe(), boot) forever.
   */
  private sendToSidecar(target: URL, transport: typeof http | typeof https, method: string, headers: SidecarHeaders, body: Buffer): Promise<SidecarPostResult> {
    return new Promise((resolve) => {
      const options: http.RequestOptions = {
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? "443" : "80"),
        path: target.pathname + target.search,
        method,
        headers: { ...headers, host: target.host },
        timeout: SIDECAR_REQUEST_TIMEOUT_MS,
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
      proxyReq.on("timeout", () => {
        proxyReq.destroy();
        const err = new Error(`KG sidecar request timed out after ${SIDECAR_REQUEST_TIMEOUT_MS}ms`) as NodeJS.ErrnoException;
        err.code = "ETIMEDOUT";
        resolve({ ok: false, error: err });
      });
      if (body.length > 0) proxyReq.write(body);
      proxyReq.end();
    });
  }

  /**
   * proxyCall's sender. A 400 or 404 from the sidecar may be a session signal, so those
   * small JSON bodies are buffered and returned for classification. Any other status is
   * relayed as it arrives — headers first, then each chunk — so a long or SSE response is
   * never held in memory and never waits for the sidecar to close the stream (review of
   * AII-649: the first version buffered every response, which would have stalled a GET
   * event stream proxied through the "everything else" path in src/mcp.ts).
   */
  private sendOrStream(
    target: URL,
    transport: typeof http | typeof https,
    method: string,
    headers: SidecarHeaders,
    body: Buffer,
    res: http.ServerResponse,
  ): Promise<SendOutcome> {
    return new Promise((resolve) => {
      const options: http.RequestOptions = {
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? "443" : "80"),
        path: target.pathname + target.search,
        method,
        headers: { ...headers, host: target.host },
      };
      const proxyReq = transport.request(options, (proxyRes) => {
        const status = proxyRes.statusCode ?? 0;
        if (status === 400 || status === 404) {
          const chunks: Buffer[] = [];
          proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
          proxyRes.on("end", () => resolve({ ok: true, status, headers: proxyRes.headers, raw: Buffer.concat(chunks) }));
          proxyRes.on("error", (err) => resolve({ ok: false, error: err as NodeJS.ErrnoException }));
          return;
        }
        const outHeaders = { ...proxyRes.headers } as http.OutgoingHttpHeaders;
        delete outHeaders["transfer-encoding"];
        res.writeHead(status, outHeaders);
        proxyRes.on("data", (chunk: Buffer) => res.write(chunk));
        proxyRes.on("end", () => res.end());
        proxyRes.on("error", (err) => res.destroy(err));
        resolve({ ok: true, streamed: true });
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
    const notified = await this.sendToSidecar(
      target,
      transport,
      "POST",
      { ...forwardHeaders, "mcp-session-id": sessionHeader, "content-length": String(notifyBody.length) },
      notifyBody,
    );
    if (!notified.ok || notified.status >= 400) {
      console.error(
        `[mcp] KG sidecar notifications/initialized was not accepted (${notified.ok ? `status ${notified.status}` : notified.error.code ?? notified.error.message}); continuing with the session`,
      );
    }

    return sessionHeader;
  }

  /**
   * Sends via `send`, and if the sidecar reports a session error, runs the
   * handshake once and retries `send` with the negotiated session id. Shared
   * by `listTools` and `proxyCall`, which differ only in how they consume the
   * result (parsed tool list vs. raw response forwarding).
   *
   * On success `handshakeError` is absent and `result`/`parsed` reflect the
   * final attempt. If the handshake itself throws, `result`/`parsed` reflect
   * the *original* rejection (before the handshake), and `handshakeError`
   * carries the thrown error — callers decide whether to report the original
   * rejection or the handshake failure.
   */
  private async sendWithSessionRetry(
    target: URL,
    transport: typeof http | typeof https,
    forwardHeaders: SidecarHeaders,
    send: (sessionId: string | null) => Promise<SendOutcome>,
  ): Promise<{ result: SendOutcome; parsed: SidecarRpcResponse | null; handshakeError?: unknown }> {
    const first = await send(this.sessionId);
    if (!first.ok || "streamed" in first) return { result: first, parsed: null };

    let result: SendOutcome = first;
    let parsed = parseSidecarRpcResponse(first.raw.toString(), first.headers["content-type"]);
    const kind = classifySessionError(first.status, parsed, this.sessionId);
    if (kind) {
      if (kind === "stale-session") this.sessionId = null;
      try {
        const sessionId = await this.initializeSession(target, transport, forwardHeaders);
        this.sessionId = sessionId;
        console.error(`[mcp] KG sidecar demanded a session; initialized (id ${sessionId}) and retried`);
        const retry = await send(sessionId);
        result = retry;
        parsed = retry.ok && !("streamed" in retry) ? parseSidecarRpcResponse(retry.raw.toString(), retry.headers["content-type"]) : null;
      } catch (err) {
        return { result, parsed, handshakeError: err };
      }
    }
    return { result, parsed };
  }

  /**
   * Describes why a probe send failed, or null when it succeeded with a JSON-RPC
   * result. Shared by both probe steps (tools/list and the kg_neighbors call).
   */
  private describeSendFailure(
    outcome: { result: SendOutcome; parsed: SidecarRpcResponse | null; handshakeError?: unknown },
    label: string,
  ): string | null {
    const { result, parsed, handshakeError } = outcome;
    if (!result.ok) return `${label} failed: ${result.error.message}`;
    if ("streamed" in result) return `${label} returned a streamed response instead of JSON`;
    if (handshakeError) {
      const msg = handshakeError instanceof Error ? handshakeError.message : String(handshakeError);
      return `${label} session handshake failed: ${msg}`;
    }
    if (!parsed) {
      return `${label} returned an unparseable response (status ${result.status})`;
    }
    if (parsed.error) return `${label} error: ${JSON.stringify(parsed.error).slice(0, 200)}`;
    if (!parsed.result) return `${label} returned no result (status ${result.status})`;
    return null;
  }

  /**
   * Liveness probe (AII-648): a session-tolerant `tools/list` that must return the
   * six `kg_*` tools, then one cheap `kg_neighbors` call on the served graph's spine
   * IRI that must come back a JSON-RPC result rather than an error. Updates the
   * module-level `sidecarHealth` record and always runs to completion — unlike
   * `scheduleReprobe`, this method itself is never throttled, so the first boot-time
   * call is never skipped.
   */
  async probe(): Promise<SidecarHealth> {
    const target = new URL(this.kgSidecarUrl);
    const transport = target.protocol === "https:" ? https : http;
    const forwardHeaders: SidecarHeaders = { ...PROBE_HEADERS };

    const listBody = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: "probe-tools-list", method: "tools/list", params: {} }));
    const sendList = (sessionId: string | null) => {
      const reqHeaders: SidecarHeaders = { ...PROBE_HEADERS, "content-length": String(listBody.length) };
      if (sessionId) reqHeaders["mcp-session-id"] = sessionId;
      return this.sendToSidecar(target, transport, "POST", reqHeaders, listBody);
    };
    const listOutcome = await this.sendWithSessionRetry(target, transport, forwardHeaders, sendList);
    const listError = this.describeSendFailure(listOutcome, "tools/list");
    if (listError) {
      // `result.ok` is true whenever an HTTP response came back at all — including a 4xx
      // carrying a JSON-RPC error, or one this class couldn't parse — so it alone answers
      // "reachable"; only a transport-level failure (connection refused, timeout) leaves it
      // false. Tightened per the AII-648 review: this used to hardcode `false` here, which
      // misreported a sidecar that answered with an error as unreachable (AII-650 refinement #1).
      return recordSidecarHealth({ reachable: listOutcome.result.ok, toolsListed: false, lastError: listError });
    }

    const tools = (listOutcome.parsed?.result?.tools ?? []) as Array<{ name?: unknown }>;
    const names = new Set(tools.map((t) => t.name).filter((n): n is string => typeof n === "string"));
    const missing = Object.keys(KG_TOOL_CAPABILITY).filter((name) => !names.has(name));
    if (missing.length > 0) {
      return recordSidecarHealth({
        reachable: true,
        toolsListed: false,
        lastError: `tools/list is missing: ${missing.join(", ")}`,
      });
    }

    const namespace = await this.resolveServedNamespace().catch(() => null);
    if (!namespace) {
      return recordSidecarHealth({
        reachable: true,
        toolsListed: true,
        lastError: "cannot determine the served graph namespace for a kg_neighbors probe query",
      });
    }
    const spineIri = `${namespace.replace(/\/?$/, "/")}resource/graph/spine`;

    const callBody = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "probe-kg-neighbors",
        method: "tools/call",
        params: { name: "kg_neighbors", arguments: { iri: spineIri, limit: 1 } },
      }),
    );
    const sendCall = (sessionId: string | null) => {
      const reqHeaders: SidecarHeaders = { ...PROBE_HEADERS, "content-length": String(callBody.length) };
      if (sessionId) reqHeaders["mcp-session-id"] = sessionId;
      return this.sendToSidecar(target, transport, "POST", reqHeaders, callBody);
    };
    const callOutcome = await this.sendWithSessionRetry(target, transport, forwardHeaders, sendCall);
    const callError = this.describeSendFailure(callOutcome, "kg_neighbors probe call");
    if (callError) return recordSidecarHealth({ reachable: true, toolsListed: true, lastError: callError });

    return recordSidecarHealth({ reachable: true, toolsListed: true, lastError: null });
  }

  /**
   * Re-probes when `listTools`/`proxyCall` hits a failure, throttled to one real
   * sidecar round-trip per PROBE_THROTTLE_MS. Callers fire this and move on rather than
   * awaiting it (AII-650 refinement #2): awaiting made the first failing call after an
   * outage pay for a full extra probe (up to two more 10s-bounded sidecar round trips)
   * before its own caller saw the original error. This method never throws — every
   * internal failure resolves to a recorded health rather than a rejection — so a
   * detached call cannot produce an unhandled rejection.
   */
  private async maybeReprobe(): Promise<void> {
    const last = sidecarHealth.checkedAt;
    if (last !== null && Date.now() - last < PROBE_THROTTLE_MS) return;
    try {
      await this.probe();
    } catch (err) {
      // probe() itself never throws in practice (every internal failure resolves to a
      // recorded health rather than a rejection) — this is a last-resort backstop so an
      // unexpected exception still stamps checkedAt, rather than defeating the throttle
      // and re-attempting on every single subsequent failure.
      console.error("[mcp] KG sidecar re-probe failed:", err);
      recordSidecarHealth({
        reachable: false,
        toolsListed: false,
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
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

    const { result, parsed } = await this.sendWithSessionRetry(target, transport, forwardHeaders, send);
    if (!result.ok || "streamed" in result) {
      void this.maybeReprobe();
      return [];
    }

    if (!parsed) {
      console.error(
        `[mcp] KG sidecar tools/list unparseable (status ${result.status}, content-type ${result.headers["content-type"]}): ${result.raw.toString().slice(0, 200)}`,
      );
      void this.maybeReprobe();
    } else if (!parsed.result) {
      console.error(
        `[mcp] KG sidecar tools/list returned no result (status ${result.status}): ${JSON.stringify(parsed.error ?? parsed).slice(0, 200)}`,
      );
      void this.maybeReprobe();
    }
    return parsed?.result?.tools ?? [];
  }

  /**
   * Shared by `proxyCall`'s `writeConnectionError` and `callKgTool`: classifies a transport
   * failure into the same wording both paths have always used, logging as a side effect.
   */
  private describeConnectionFailure(err: NodeJS.ErrnoException): string {
    if (err.code === "ECONNREFUSED") {
      console.error(`[mcp] KG sidecar connection refused at ${this.kgSidecarUrl}`);
      return "KG sidecar unavailable: connection refused";
    }
    console.error("[mcp] KG sidecar error:", err);
    return "KG sidecar error";
  }

  /**
   * Calls a single `kg_*` tool and returns its parsed JSON-RPC result rather than writing
   * to an HTTP response — built on the same session-tolerant send path and probe headers
   * `probe()` uses, so a Restate handler (src/restate/tools.ts) with no `res` to stream into
   * can still call the sidecar. Never throws: every failure resolves to `{ ok: false }` with
   * the same wording `proxyCall` has always produced for the same failure.
   */
  async callKgTool(name: string, args: Record<string, unknown>): Promise<KgToolResult> {
    const target = new URL(this.kgSidecarUrl);
    const transport = target.protocol === "https:" ? https : http;
    const callBody = Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", id: `call-${name}`, method: "tools/call", params: { name, arguments: args } }),
    );
    const send = (sessionId: string | null) => {
      const reqHeaders: SidecarHeaders = { ...PROBE_HEADERS, "content-length": String(callBody.length) };
      if (sessionId) reqHeaders["mcp-session-id"] = sessionId;
      return this.sendToSidecar(target, transport, "POST", reqHeaders, callBody);
    };

    const { result, parsed, handshakeError } = await this.sendWithSessionRetry(target, transport, PROBE_HEADERS, send);
    if (!result.ok) {
      void this.maybeReprobe();
      return { ok: false, error: this.describeConnectionFailure(result.error) };
    }
    if ("streamed" in result) {
      // sendToSidecar (unlike sendOrStream) never streams; unreachable in practice.
      return { ok: false, error: "KG sidecar error" };
    }
    if (handshakeError) {
      console.error(`[mcp] KG sidecar session initialize failed calling ${name}; forwarding the original rejection:`, handshakeError);
      void this.maybeReprobe();
    }
    if (!parsed) {
      console.error(
        `[mcp] KG sidecar ${name} returned an unparseable response (status ${result.status}): ${result.raw.toString().slice(0, 200)}`,
      );
      void this.maybeReprobe();
      return { ok: false, error: "KG sidecar error" };
    }
    if (parsed.error) {
      const err = parsed.error as { message?: string };
      return { ok: false, error: typeof err.message === "string" ? err.message : JSON.stringify(parsed.error) };
    }
    return { ok: true, result: parsed.result };
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
      return this.sendOrStream(target, transport, req.method ?? "POST", reqHeaders, body, res);
    };

    const writeConnectionError = (err: NodeJS.ErrnoException) => {
      if (res.headersSent) {
        res.destroy(err);
        return;
      }
      writeJson(res, 502, { error: this.describeConnectionFailure(err) });
    };

    void (async () => {
      const { result, handshakeError } = await this.sendWithSessionRetry(target, transport, forwardHeaders, send);
      if (!result.ok) {
        void this.maybeReprobe();
        writeConnectionError(result.error);
        return;
      }
      if ("streamed" in result) return; // relayed to the client as it arrived
      if (handshakeError) {
        // Surface the sidecar's own rejection (status + JSON-RPC error body) rather than a
        // synthetic 502 — parity with listTools and with docs/kg-sidecar.md.
        console.error("[mcp] KG sidecar session initialize failed; forwarding the original rejection:", handshakeError);
        void this.maybeReprobe();
      }

      const outHeaders = { ...result.headers } as http.OutgoingHttpHeaders;
      delete outHeaders["transfer-encoding"];
      outHeaders["content-length"] = String(result.raw.length);
      res.writeHead(result.status, outHeaders);
      res.end(result.raw);
    })();
  }
}

/**
 * Caps the boot-time probe (AII-650 refinement #3): `main()`'s `await memoryProvider.probe()`
 * had no overall deadline, so a slow-but-answering sidecar — each of probe()'s two sequential
 * calls individually bounded by SIDECAR_REQUEST_TIMEOUT_MS, more once a session handshake is
 * needed — could push boot well past that before startServer() ran. Matches KgSidecar's own
 * pollTimeoutMs default (src/kg-sidecar.ts).
 */
export const BOOT_PROBE_TIMEOUT_MS = 30_000;

/**
 * Races `provider.probe()` against an overall cap, resolving to a recorded timeout failure if
 * the cap wins. The real probe keeps running afterward and still updates the shared
 * `sidecarHealth` record whenever it eventually finishes — this only stamps a failure in the
 * meantime so a caller awaiting this doesn't hang.
 *
 * The timer is cleared as soon as the probe settles: a bare `Promise.race` would leave it armed,
 * and 30 s after every healthy boot it would overwrite the good record with a fabricated timeout
 * (caught by the PR #561 review).
 */
export function probeWithTimeout(
  provider: SidecarMemoryProvider,
  timeoutMs: number = BOOT_PROBE_TIMEOUT_MS,
): Promise<SidecarHealth> {
  return new Promise<SidecarHealth>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(recordSidecarHealth({ reachable: false, toolsListed: false, lastError: `KG sidecar probe timed out after ${timeoutMs}ms` }));
    }, timeoutMs);
    timer.unref();
    provider.probe().then(
      (health) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve(health);
      },
      (err: unknown) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve(recordSidecarHealth({ reachable: false, toolsListed: false, lastError: `KG sidecar probe threw: ${err instanceof Error ? err.message : String(err)}` }));
      },
    );
  });
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

let sharedKgMemoryProvider: MemoryProvider | null = null;

/**
 * Set once at boot (src/index.ts's main()) to the same instance passed into
 * `handleMcpRequest`. A Restate tool handler (src/restate/tools.ts) has no per-request
 * dependency injection the way `handleMcpRequest` does, so its kg_* handlers reach the
 * provider through this getter instead — sharing the negotiated MCP session rather than
 * starting a second, independent one.
 */
export function setKgMemoryProvider(provider: MemoryProvider | null): void {
  sharedKgMemoryProvider = provider;
}

export function getKgMemoryProvider(): MemoryProvider | null {
  return sharedKgMemoryProvider;
}
