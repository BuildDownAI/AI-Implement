import http from "node:http";
import { authenticateAdminRequest } from "../admin-session.js";
import { getOperatorLegacyScrubCompletedAt, isOperatorLegacyCheckConfirmed } from "./operator-legacy-scrub.js";
import { RESTATE_ADMIN_BASE_URL, RESTATE_INGRESS_BASE_URL, RESTATE_UI_INGRESS_PREFIX } from "./server.js";

/**
 * Admin-only door to the Restate UI (AII-1261, ADR 040). The UI cannot live under a path
 * prefix, so this module owns an allowlist of root paths on the orchestrator origin plus
 * `/admin/restate/ingress/` for the playground's ingress calls.
 */

export interface RestateUiProxyDeps {
  /** False when neither SSO nor ADMIN_ACCESS_CODE is configured: handled paths answer 503. */
  adminConfigured: boolean;
  adminBaseUrl?: string;
  ingressBaseUrl?: string;
}

function matchRoute(method: string, pathname: string): { target: "admin" | "ingress" | "refused"; strip: number } | null {
  if (pathname === RESTATE_UI_INGRESS_PREFIX || pathname.startsWith(`${RESTATE_UI_INGRESS_PREFIX}/`)) {
    return { target: "ingress", strip: RESTATE_UI_INGRESS_PREFIX.length };
  }
  const admin = { target: "admin" as const, strip: 0 };
  if (pathname === "/ui" || pathname.startsWith("/ui/")) return admin;
  if (pathname === "/invocations" || pathname.startsWith("/invocations/")) return admin;
  const read = method === "GET" || method === "HEAD";
  if (read && (pathname === "/health" || pathname === "/version")) return admin;
  if (read && (pathname === "/services" || pathname.startsWith("/services/"))) return admin;
  if (read && (pathname === "/deployments" || pathname.startsWith("/deployments/"))) return admin;
  // "refused" until the AII-1287 scrub row exists and this process confirmed no legacy token (AII-1286, AII-1299, AII-1306); then forwarded to the admin upstream.
  if (method === "POST" && pathname === "/query") return { target: "refused", strip: 0 };
  if (method === "POST" && pathname === "/deployments") return admin;
  return null;
}

const UNSAFE_PATH = /\.\.|\/\/|%2e|%2f|%5c/i;

/**
 * Deny-by-default ingress allowlist (AII-1283): only the KgRefresh decision gate. `Operator`'s
 * `issue` and other write handlers could plant a token family for any client id, and
 * `KgRefresh.report/progress/cancel` rely on the runner token the callback route verifies, so
 * neither may be reached through this door.
 */
const KEY = "[A-Za-z0-9._-]{1,128}";
const INGRESS_ALLOWED = new RegExp(
  `^(?:/restate/(?:call|send))?/KgRefresh/${KEY}/(?:decide|status)(?:/send(?:/[0-9A-Za-z]{1,32})?)?$`,
);

const STRIPPED_REQUEST_HEADERS = ["cookie", "authorization", "connection", "upgrade", "keep-alive", "te", "trailer"];

export function handleRestateUiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: RestateUiProxyDeps,
): boolean {
  const rawUrl = req.url ?? "/";
  const q = rawUrl.indexOf("?");
  const pathname = q === -1 ? rawUrl : rawUrl.slice(0, q);
  const search = q === -1 ? "" : rawUrl.slice(q);
  const method = req.method ?? "GET";
  const match = matchRoute(method, pathname);
  if (!match) return false;

  const json = (status: number, error: string) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error }));
  };

  if (!deps.adminConfigured) {
    json(503, "Admin UI is disabled. Configure SSO or set ADMIN_ACCESS_CODE.");
    return true;
  }
  const gate = authenticateAdminRequest(req);
  if (!gate.ok) {
    json(gate.status, gate.error);
    return true;
  }
  if (gate.role !== "admin") {
    json(403, "This action requires an admin");
    return true;
  }

  const who = gate.identity?.email ?? "access-code";
  const isRead = method === "GET" || method === "HEAD";
  if (match.target === "ingress" || !isRead) {
    console.log(`[restate-ui] ${who} ${method} ${pathname}`);
  }

  if (UNSAFE_PATH.test(pathname)) {
    json(400, "Bad request path");
    return true;
  }
  // Read per request, uncached, so the gate opens without a restart. An unreadable row reads as null: closed.
  // The row can predate a rollback, so this process must also have confirmed no legacy token (AII-1306).
  if (match.target === "refused" && (getOperatorLegacyScrubCompletedAt() === null || !isOperatorLegacyCheckConfirmed())) {
    json(403, "/query is disabled until the MCP refresh-token cleanup check has run in this process (AII-1287, AII-1306), or while its record is unreadable");
    return true;
  }
  if (match.target === "ingress") {
    if (method !== "POST" || !INGRESS_ALLOWED.test(pathname.slice(match.strip))) {
      json(403, "This ingress path is not available through the proxy");
      return true;
    }
  } else if ((pathname === "/ui" || pathname.startsWith("/ui/")) && !isRead) {
    json(405, "Method not allowed");
    return true;
  }

  const base = new URL(match.target !== "ingress" ? (deps.adminBaseUrl ?? RESTATE_ADMIN_BASE_URL) : (deps.ingressBaseUrl ?? RESTATE_INGRESS_BASE_URL));
  const upstreamPath = (pathname.slice(match.strip) || "/") + search;

  // The ingress journals request headers and bodies; a session token must never reach a journal.
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: base.host };
  for (const name of Object.keys(headers)) {
    if (STRIPPED_REQUEST_HEADERS.includes(name) || name.startsWith("proxy-") || name.startsWith("x-forwarded-")) {
      delete headers[name];
    }
  }

  const proxyReq = http.request(
    { hostname: base.hostname, port: base.port || "80", path: upstreamPath, method, headers },
    (proxyRes) => {
      const outHeaders = { ...proxyRes.headers } as http.OutgoingHttpHeaders;
      for (const name of Object.keys(outHeaders)) {
        if (name === "transfer-encoding" || name === "set-cookie" || name.startsWith("access-control-")) delete outHeaders[name];
      }
      outHeaders["x-content-type-options"] = "nosniff";
      res.writeHead(proxyRes.statusCode ?? 502, outHeaders);
      proxyRes.on("data", (chunk: Buffer) => res.write(chunk));
      proxyRes.on("end", () => res.end());
      proxyRes.on("error", (err) => res.destroy(err));
    },
  );
  proxyReq.on("error", () => {
    if (res.headersSent) res.destroy();
    else json(502, "Restate is unreachable");
  });
  res.on("close", () => { if (!res.writableEnded) proxyReq.destroy(); });
  req.pipe(proxyReq);
  return true;
}
