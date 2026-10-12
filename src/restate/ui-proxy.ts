import http from "node:http";
import { authenticateAdminRequest } from "../admin-session.js";
import { RESTATE_ADMIN_BASE_URL, RESTATE_INGRESS_BASE_URL, RESTATE_UI_INGRESS_PREFIX } from "./server.js";

/**
 * Admin-only door to the Restate UI (AII-1261, ADR 039). The UI cannot live under a path
 * prefix, so this module owns an allowlist of root paths on the orchestrator origin plus
 * `/admin/restate/ingress/` for the playground's ingress calls.
 */

export interface RestateUiProxyDeps {
  /** False when neither SSO nor ADMIN_ACCESS_CODE is configured: handled paths answer 503. */
  adminConfigured: boolean;
  adminBaseUrl?: string;
  ingressBaseUrl?: string;
}

function matchRoute(method: string, pathname: string): { target: "admin" | "ingress"; strip: number } | null {
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
  if (method === "POST" && (pathname === "/query" || pathname === "/deployments")) return admin;
  return null;
}

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

  const isRead = method === "GET" || method === "HEAD";
  if (!isRead && !(method === "POST" && pathname === "/query")) {
    console.log(`[restate-ui] ${gate.identity?.email ?? "access-code"} ${method} ${pathname}`);
  }

  const base = new URL(match.target === "admin" ? (deps.adminBaseUrl ?? RESTATE_ADMIN_BASE_URL) : (deps.ingressBaseUrl ?? RESTATE_INGRESS_BASE_URL));
  const upstreamPath = (pathname.slice(match.strip) || "/") + search;

  // The ingress journals request headers and bodies; a session token must never reach a journal.
  const headers = { ...req.headers, host: base.host };
  delete headers.cookie;
  delete headers.authorization;

  const proxyReq = http.request(
    { hostname: base.hostname, port: base.port || "80", path: upstreamPath, method, headers },
    (proxyRes) => {
      const outHeaders = { ...proxyRes.headers } as http.OutgoingHttpHeaders;
      delete outHeaders["transfer-encoding"];
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
