import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

const gate = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../admin-session.js", () => ({ authenticateAdminRequest: () => gate.current }));
const scrub = vi.hoisted(() => ({ completedAt: null as string | null, confirmed: false }));
vi.mock("../restate/operator-legacy-scrub.js", () => ({
  getOperatorLegacyScrubCompletedAt: () => scrub.completedAt,
  isOperatorLegacyCheckConfirmed: () => scrub.confirmed,
}));

import { handleRestateUiRequest } from "../restate/ui-proxy.js";

interface Hit { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

function stub(hits: Hit[], onReq?: (res: http.ServerResponse) => void) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      hits.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (onReq) return onReq(res);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  return new Promise<http.Server>((r) => server.listen(0, "127.0.0.1", () => r(server)));
}
const urlOf = (s: http.Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

const adminOk = { ok: true, identity: { email: "a@x.com" }, entry: null, role: "admin" };

describe("handleRestateUiRequest", () => {
  let adminHits: Hit[], ingressHits: Hit[];
  let adminStub: http.Server, ingressStub: http.Server, front: http.Server;
  let handled: boolean[];
  let adminUrl = "", ingressUrl = "";
  let adminOnReq: ((res: http.ServerResponse) => void) | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    adminHits = []; ingressHits = []; handled = []; adminOnReq = undefined;
    gate.current = adminOk;
    scrub.completedAt = null;
    scrub.confirmed = true;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    adminStub = await stub(adminHits, (res) => (adminOnReq ? adminOnReq(res) : (res.writeHead(200, { "content-type": "text/plain" }), res.end("ok"))));
    ingressStub = await stub(ingressHits);
    adminUrl = urlOf(adminStub); ingressUrl = urlOf(ingressStub);
    front = http.createServer((req, res) => {
      const h = handleRestateUiRequest(req, res, { adminConfigured: true, adminBaseUrl: adminUrl, ingressBaseUrl: ingressUrl });
      handled.push(h);
      if (!h) { res.writeHead(418); res.end("fallthrough"); }
    });
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", () => r()));
  });
  afterEach(async () => {
    for (const s of [front, adminStub, ingressStub]) { s.closeAllConnections(); if (s.listening) await new Promise((r) => s.close(r)); }
    logSpy.mockRestore();
  });

  const call = (method: string, path: string, body?: string, headers: Record<string, string> = {}) =>
    fetch(`${urlOf(front)}${path}`, { method, body, headers });

  it("401 without a session and 403 for a user role; no upstream is hit", async () => {
    gate.current = { ok: false, status: 401, error: "Unauthorized" };
    expect((await call("GET", "/ui/")).status).toBe(401);
    gate.current = { ok: true, identity: { email: "u@x.com" }, entry: null, role: "user" };
    expect((await call("GET", "/services")).status).toBe(403);
    expect((await call("POST", "/admin/restate/ingress/KgRefresh/abc/decide")).status).toBe(403);
    expect(adminHits).toHaveLength(0);
    expect(ingressHits).toHaveLength(0);
  });

  it("routes each allowlist row to the right upstream and path", async () => {
    const admin: Array<[string, string]> = [
      ["GET", "/ui"], ["GET", "/ui/assets/x.js"], ["GET", "/health"], ["GET", "/version"],
      ["GET", "/services"], ["GET", "/services/x/openapi"], ["GET", "/deployments"], ["GET", "/deployments/d1"],
      ["PATCH", "/invocations/x/cancel"], ["DELETE", "/invocations/x/purge"], ["POST", "/deployments"],
    ];
    for (const [m, p] of admin) expect((await call(m, `${p}?a=1`)).status).toBe(200);
    expect(adminHits.map((h) => `${h.method} ${h.url}`)).toEqual(admin.map(([m, p]) => `${m} ${p}?a=1`));
    expect(ingressHits).toHaveLength(0);

    await call("POST", "/admin/restate/ingress/KgRefresh/abc/decide?x=y", "{}");
    expect(ingressHits.map((h) => `${h.method} ${h.url} ${h.body}`)).toEqual(["POST /KgRefresh/abc/decide?x=y {}"]);
  });

  it("does not handle other paths or methods and reaches no upstream", async () => {
    for (const [m, p] of [["GET", "/api/kg/status"], ["GET", "/"], ["POST", "/mcp"], ["GET", "/uix"], ["POST", "/health"], ["DELETE", "/services"], ["GET", "/query"]]) {
      const r = await call(m, p);
      expect(r.status).toBe(418);
    }
    expect(handled.every((h) => h === false)).toBe(true);
    expect(adminHits).toHaveLength(0);
    expect(ingressHits).toHaveLength(0);
  });

  it("strips cookie and authorization but forwards other headers", async () => {
    await call("POST", "/admin/restate/ingress/KgRefresh/abc/decide", "{}", { cookie: "s=1", authorization: "Bearer t", "content-type": "application/json" });
    await call("GET", "/services", undefined, { cookie: "s=1", authorization: "Bearer t" });
    for (const h of [...ingressHits, ...adminHits]) {
      expect(h.headers.cookie).toBeUndefined();
      expect(h.headers.authorization).toBeUndefined();
    }
    expect(ingressHits[0].headers["content-type"]).toBe("application/json");
  });

  it("refuses POST /query with 403 until the scrub row exists and reaches no upstream", async () => {
    scrub.completedAt = null;
    for (const p of ["/query", "/query?a=1"]) {
      const r = await call("POST", p, "{}");
      expect(r.status).toBe(403);
      expect(JSON.parse(await r.text()).error).toContain("cleanup check has run in this process");
    }
    expect(adminHits).toHaveLength(0);
    expect(ingressHits).toHaveLength(0);
  });

  it("refuses POST /query when the row exists but this process has not confirmed the check", async () => {
    scrub.completedAt = "2026-10-13T00:00:00.000Z";
    scrub.confirmed = false;
    const r = await call("POST", "/query", "{}");
    expect(r.status).toBe(403);
    expect(JSON.parse(await r.text()).error).toContain("has run in this process");
    expect(adminHits).toHaveLength(0);
    scrub.confirmed = true;
    expect((await call("POST", "/query", "{}")).status).toBe(200);
    expect(adminHits).toHaveLength(1);
  });

  it("refuses POST /query when the check is confirmed but the row is absent", async () => {
    scrub.completedAt = null;
    scrub.confirmed = true;
    expect((await call("POST", "/query", "{}")).status).toBe(403);
    expect(adminHits).toHaveLength(0);
  });

  it("forwards admin POST /query to the admin upstream once the row exists, read per request", async () => {
    scrub.completedAt = null;
    expect((await call("POST", "/query?a=1", "{\"query\":\"x\"}")).status).toBe(403);
    scrub.completedAt = "2026-10-13T00:00:00.000Z";
    expect((await call("POST", "/query?a=1", "{\"query\":\"x\"}")).status).toBe(200);
    expect(adminHits.map((h) => `${h.method} ${h.url} ${h.body}`)).toEqual(["POST /query?a=1 {\"query\":\"x\"}"]);
    expect(ingressHits).toHaveLength(0);
  });

  it("answers 403 to a user and 401 to no session on /query whatever the row says", async () => {
    for (const row of [null, "2026-10-13T00:00:00.000Z"]) {
      scrub.completedAt = row;
      gate.current = { ok: true, identity: { email: "u@x.com" }, entry: null, role: "user" };
      expect((await call("POST", "/query", "{}")).status).toBe(403);
      gate.current = { ok: false, status: 401, error: "Unauthorized" };
      expect((await call("POST", "/query", "{}")).status).toBe(401);
    }
    expect(adminHits).toHaveLength(0);
    expect(ingressHits).toHaveLength(0);
  });

  it("logs non-read requests, including POST /query in both gate states", async () => {
    await call("PATCH", "/invocations/x/cancel");
    await call("GET", "/services");
    scrub.completedAt = null;
    await call("POST", "/query", "{}");
    scrub.completedAt = "2026-10-13T00:00:00.000Z";
    await call("POST", "/query", "{}");
    const lines = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith("[restate-ui]"));
    expect(lines).toEqual(["[restate-ui] a@x.com PATCH /invocations/x/cancel", "[restate-ui] a@x.com POST /query", "[restate-ui] a@x.com POST /query"]);
  });

  it("allows only KgRefresh decide/status on the ingress and answers 403 otherwise", async () => {
    const base = "/admin/restate/ingress";
    for (const p of ["/KgRefresh/abc/status", "/restate/call/KgRefresh/abc/decide", "/restate/send/KgRefresh/abc/decide", "/KgRefresh/abc/decide/send"]) {
      expect((await call("POST", base + p)).status).toBe(200);
    }
    expect(ingressHits).toHaveLength(4);
    ingressHits.length = 0;
    for (const p of ["/Operator/x/issue", "/KgRefresh/abc/report", "/KgRefresh/abc/cancel", "/ReviewFixAttempt/x/result", "", "/", `/KgRefresh/${"a".repeat(129)}/decide`, "/KgRefresh/a b/decide", "/KgRefresh/a%20b/decide"]) {
      expect((await call("POST", base + p)).status).toBe(403);
    }
    expect((await call("GET", `${base}/KgRefresh/abc/decide`)).status).toBe(403);
    expect(ingressHits).toHaveLength(0);
  });

  it("rejects dot segments, double slashes and encoded separators with 400", async () => {
    const raw = (path: string) => new Promise<number>((resolve, reject) => {
      const u = new URL(urlOf(front));
      http.request({ hostname: u.hostname, port: u.port, path, method: "GET" }, (r) => { r.resume(); resolve(r.statusCode!); }).on("error", reject).end();
    });
    for (const p of ["/ui/../deployments/x", "/invocations/%2e%2e/services/X", "/ui//x", "/ui/%2F", "/ui/%5C", "/ui/%2E", "/admin/restate/ingress/KgRefresh/%2fx/decide"]) {
      expect(await raw(p)).toBe(400);
    }
    expect(adminHits).toHaveLength(0);
    expect(ingressHits).toHaveLength(0);
    expect(await raw("/api//x")).toBe(418);
  });

  it("allows only GET and HEAD on /ui", async () => {
    expect((await call("DELETE", "/ui/x")).status).toBe(405);
    expect((await call("POST", "/ui")).status).toBe(405);
    expect((await call("GET", "/ui/x")).status).toBe(200);
    expect((await call("HEAD", "/ui/x")).status).toBe(200);
    expect(adminHits).toHaveLength(2);
  });

  it("drops hop-by-hop and forwarded request headers", async () => {
    await new Promise<void>((resolve, reject) => {
      const u = new URL(urlOf(front));
      http.request({ hostname: u.hostname, port: u.port, path: "/services", method: "GET", headers: {
        connection: "upgrade", upgrade: "websocket", "keep-alive": "5", te: "trailers", "proxy-authorization": "x", "x-forwarded-for": "1.2.3.4", "x-keep": "1",
      } }, (r) => { r.resume(); r.on("end", resolve); }).on("error", reject).end();
    });
    const h = adminHits[0].headers;
    for (const n of ["upgrade", "keep-alive", "te", "proxy-authorization", "x-forwarded-for"]) expect(h[n]).toBeUndefined();
    expect(h.connection).not.toBe("upgrade");
    expect(h["x-keep"]).toBe("1");
  });

  it("drops set-cookie and access-control-* from responses and adds nosniff", async () => {
    adminOnReq = (res) => {
      res.writeHead(200, { "set-cookie": "a=1", "access-control-allow-origin": "*", "content-type": "text/plain" });
      res.end("ok");
    };
    const r = await call("GET", "/services");
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("logs every ingress request, including denied ones", async () => {
    await call("GET", "/admin/restate/ingress/KgRefresh/abc/decide");
    await call("POST", "/admin/restate/ingress/Operator/x/issue");
    const lines = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith("[restate-ui]"));
    expect(lines).toEqual([
      "[restate-ui] a@x.com GET /admin/restate/ingress/KgRefresh/abc/decide",
      "[restate-ui] a@x.com POST /admin/restate/ingress/Operator/x/issue",
    ]);
  });

  it("does not throw for an access-code session (no identity)", async () => {
    gate.current = { ok: true, identity: null, entry: null, role: "admin" };
    expect((await call("PATCH", "/invocations/x/cancel")).status).toBe(200);
  });

  it("streams the upstream body chunk by chunk and drops transfer-encoding", async () => {
    let finish!: () => void;
    adminOnReq = (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("first");
      finish = () => res.end("second");
    };
    const r = await call("GET", "/services");
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const reader = r.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("first");
    finish();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe("second");
  });

  it("answers 502 when the upstream is unreachable", async () => {
    await new Promise((r) => { adminStub.closeAllConnections(); adminStub.close(r); });
    expect((await call("GET", "/health")).status).toBe(502);
  });
});
