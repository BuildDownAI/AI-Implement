import { describe, it, expect, vi, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { redeliverFailedAppDeliveries, sweepOnRegistered } from "../webhook-redelivery.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const APP_ID = "123456";
const NOW = Date.parse("2026-10-09T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();

type D = { id: number; guid: string; delivered_at: string; status: string; event: string };
const d = (id: number, guid: string, h: number, status: string, event = "pull_request_review"): D => ({
  id, guid, delivered_at: ago(h), status, event,
});

function fakeFetch(pages: D[][], opts: { listStatus?: number; postStatus?: (url: string) => number } = {}) {
  let page = 0;
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "POST") {
      const status = opts.postStatus?.(u) ?? 202;
      return new Response(null, { status });
    }
    if (opts.listStatus) return new Response("boom", { status: opts.listStatus });
    const body = pages[page] ?? [];
    const headers: Record<string, string> = {};
    if (page + 1 < pages.length) headers.link = `<https://api.github.com/app/hook/deliveries?per_page=100&cursor=c${page + 1}>; rel="next"`;
    page++;
    return new Response(JSON.stringify(body), { status: 200, headers });
  });
}

const run = (f: ReturnType<typeof fakeFetch>) =>
  redeliverFailedAppDeliveries({ appId: APP_ID, privateKey, fetchImpl: f as unknown as typeof fetch, now: () => NOW });
const posts = (f: ReturnType<typeof fakeFetch>) => f.mock.calls.filter((c) => c[1]?.method === "POST").map((c) => String(c[0]));

afterEach(() => vi.restoreAllMocks());

describe("redeliverFailedAppDeliveries", () => {
  it("does not redeliver when the newest attempt is OK, in either order", async () => {
    for (const rows of [
      [d(2, "g", 1, "OK"), d(1, "g", 2, "Invalid HTTP Response: 503")],
      [d(1, "g", 2, "Invalid HTTP Response: 503"), d(2, "g", 1, "OK")],
    ]) {
      const f = fakeFetch([rows]);
      expect(await run(f)).toEqual({ scanned: 1, redelivered: 0, skipped: 0 });
      expect(posts(f)).toEqual([]);
    }
  });

  it("redelivers when the newest attempt failed", async () => {
    const f = fakeFetch([[d(2, "g", 1, "Invalid HTTP Response: 503"), d(1, "g", 2, "OK")]]);
    expect(await run(f)).toEqual({ scanned: 1, redelivered: 1, skipped: 0 });
    expect(posts(f)).toEqual(["https://api.github.com/app/hook/deliveries/2/attempts"]);
  });

  it("redelivers the four review events, skips others, and stops at the window", async () => {
    const bad = "Invalid HTTP Response: 503";
    const events = ["pull_request_review", "pull_request_review_comment", "issue_comment", "pull_request"];
    const f = fakeFetch([
      [...events.map((e, i) => d(i + 1, `g${i}`, 1, bad, e)), d(10, "gp", 1, bad, "push"), d(11, "old", 30, bad)],
      [d(12, "never", 31, bad)],
    ]);
    expect(await run(f)).toEqual({ scanned: 5, redelivered: 4, skipped: 1 });
    expect(posts(f)).toHaveLength(4);
    expect(f.mock.calls.filter((c) => !c[1]?.method)).toHaveLength(1);
  });

  it("follows the cursor to the next page", async () => {
    const f = fakeFetch([[d(1, "a", 1, "500")], [d(2, "b", 2, "500")]]);
    expect(await run(f)).toMatchObject({ scanned: 2, redelivered: 2 });
    expect(String(f.mock.calls[1][0])).toContain("cursor=c1");
  });

  it("returns zeros and logs once on a 500 list response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fakeFetch([], { listStatus: 500 });
    expect(await run(f)).toEqual({ scanned: 0, redelivered: 0, skipped: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not throw when fetch rejects", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = vi.fn(async () => { throw new Error("net"); });
    expect(await run(f as never)).toEqual({ scanned: 0, redelivered: 0, skipped: 0 });
  });

  it("logs and continues past a failed redelivery", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fakeFetch([[d(1, "a", 1, "500"), d(2, "b", 1, "500")]], { postStatus: (u) => (u.includes("/1/") ? 500 : 202) });
    expect(await run(f)).toEqual({ scanned: 2, redelivered: 1, skipped: 1 });
  });

  it("authenticates with the App JWT only", async () => {
    const f = fakeFetch([[d(1, "a", 1, "500")]]);
    await run(f);
    for (const c of f.mock.calls) {
      const auth = (c[1]?.headers as Record<string, string>).Authorization;
      const jwt = auth.replace("Bearer ", "");
      expect(JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).iss).toBe(APP_ID);
      expect(String(c[0])).not.toContain("access_tokens");
    }
  });
});

describe("sweepOnRegistered", () => {
  const cfg = { githubWebhookSecret: "s", githubAppId: APP_ID, githubAppPrivateKey: privateKey };

  it("sweeps on every call and logs the summary line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const sweep = vi.fn(async () => ({ scanned: 3, redelivered: 2, skipped: 1 }));
    sweepOnRegistered(cfg, sweep);
    sweepOnRegistered(cfg, sweep);
    await new Promise((r) => setImmediate(r));
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith("[webhook-redelivery] scanned 3, redelivered 2, skipped 1");
  });

  it("does not sweep without a webhook secret", () => {
    const sweep = vi.fn(async () => ({ scanned: 0, redelivered: 0, skipped: 0 }));
    sweepOnRegistered({ ...cfg, githubWebhookSecret: null }, sweep);
    expect(sweep).not.toHaveBeenCalled();
  });
});
