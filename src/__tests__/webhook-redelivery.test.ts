import { describe, it, expect, vi, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { listRecentAppDeliveries, redeliverFailedAppDeliveries, sweepOnRegistered, type AppDelivery } from "../webhook-redelivery.js";
import { GitHubApiError } from "../github-errors.js";
import { fakeFetch, type FakeFetch, type Reply, type Routes } from "./helpers/fake-fetch.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const APP_ID = "123456";
const NOW = Date.parse("2026-10-09T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();

type D = AppDelivery;
// GitHub sends `status_code` with every delivery: 200 beside "OK", else the code its failure text names.
const d = (id: number, guid: string, h: number, status: string, event = "pull_request_review"): D => ({
  id, guid, delivered_at: ago(h), status, status_code: status === "OK" ? 200 : Number(/\d{3}/.exec(status)?.[0] ?? 0), event,
});

const FAILED = "Invalid HTTP Response: 503";

/** GitHub's App deliveries API: the listing served page by page, each but the last linking to the next, and a
 *  redelivery attempt (202) for every listed delivery unless `attempts` answers one otherwise. */
function deliveriesApi(pages: D[][], opts: { list?: Reply; attempts?: Record<number, Reply> } = {}): FakeFetch {
  const routes: Routes = {
    "GET /app/hook/deliveries": opts.list ?? pages.map((page, i) => ({
      json: page,
      ...(i + 1 < pages.length
        ? { headers: { link: `<https://api.github.com/app/hook/deliveries?per_page=100&cursor=c${i + 1}>; rel="next"` } }
        : {}),
    })),
  };
  for (const delivery of pages.flat()) {
    routes[`POST /app/hook/deliveries/${delivery.id}/attempts`] = opts.attempts?.[delivery.id] ?? { status: 202, json: {} };
  }
  return fakeFetch(routes);
}

const run = (f: FakeFetch) => redeliverFailedAppDeliveries({ appId: APP_ID, privateKey, fetchImpl: f.fetch, now: () => NOW });
const posts = (f: FakeFetch) => f.calls.filter((c) => c.method === "POST").map((c) => c.url.href);

afterEach(() => vi.restoreAllMocks());

describe("redeliverFailedAppDeliveries", () => {
  it("does not redeliver when the newest attempt is OK, in either order", async () => {
    for (const rows of [
      [d(2, "g", 1, "OK"), d(1, "g", 2, FAILED)],
      [d(1, "g", 2, FAILED), d(2, "g", 1, "OK")],
    ]) {
      const f = deliveriesApi([rows]);
      expect(await run(f)).toEqual({ scanned: 1, redelivered: 0, skipped: 0 });
      expect(posts(f)).toEqual([]);
    }
  });

  it("redelivers when the newest attempt failed", async () => {
    const f = deliveriesApi([[d(2, "g", 1, FAILED), d(1, "g", 2, "OK")]]);
    expect(await run(f)).toEqual({ scanned: 1, redelivered: 1, skipped: 0 });
    expect(posts(f)).toEqual(["https://api.github.com/app/hook/deliveries/2/attempts"]);
  });

  it("redelivers the four review events, skips others, and stops at the window", async () => {
    const events = ["pull_request_review", "pull_request_review_comment", "issue_comment", "pull_request"];
    const f = deliveriesApi([
      [...events.map((e, i) => d(i + 1, `g${i}`, 1, FAILED, e)), d(10, "gp", 1, FAILED, "push"), d(11, "old", 30, FAILED)],
      [d(12, "never", 31, FAILED)],
    ]);
    expect(await run(f)).toEqual({ scanned: 5, redelivered: 4, skipped: 1 });
    expect(posts(f)).toHaveLength(4);
    expect(f.calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });

  it("follows the cursor to the next page", async () => {
    const f = deliveriesApi([[d(1, "a", 1, FAILED)], [d(2, "b", 2, FAILED)]]);
    expect(await run(f)).toMatchObject({ scanned: 2, redelivered: 2 });
    expect(f.calls[1].url.searchParams.get("cursor")).toBe("c1");
  });

  it("returns zeros and logs once on a 500 list response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = deliveriesApi([], { list: { status: 500, json: { message: "Server Error" } } });
    expect(await run(f)).toEqual({ scanned: 0, redelivered: 0, skipped: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not throw when fetch rejects", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = deliveriesApi([], { list: () => { throw new Error("net"); } });
    expect(await run(f)).toEqual({ scanned: 0, redelivered: 0, skipped: 0 });
  });

  it("logs and continues past a failed redelivery", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = deliveriesApi([[d(1, "a", 1, FAILED), d(2, "b", 1, FAILED)]], {
      attempts: { 1: { status: 500, json: { message: "Server Error" } } },
    });
    expect(await run(f)).toEqual({ scanned: 2, redelivered: 1, skipped: 1 });
  });

  it("logs a refused first page as a failed list and redelivers nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = deliveriesApi([], { list: { status: 401, json: { message: "Bad credentials" } } });
    expect(await run(f)).toEqual({ scanned: 0, redelivered: 0, skipped: 0 });
    expect(warn).toHaveBeenCalledWith("[webhook-redelivery] list failed (401)");
  });

  it("logs a refused later page as a failed list and still redelivers what was listed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fakeFetch({
      "GET /app/hook/deliveries": [
        { json: [d(7, "a", 1, FAILED)], headers: { link: `<https://api.github.com/app/hook/deliveries?per_page=100&cursor=c1>; rel="next"` } },
        { status: 502, json: {} },
      ],
      "POST /app/hook/deliveries/7/attempts": { status: 202, json: {} },
    });
    expect(await run(f)).toEqual({ scanned: 1, redelivered: 1, skipped: 0 });
    expect(warn).toHaveBeenCalledWith("[webhook-redelivery] list failed (502)");
  });

  it("authenticates with the App JWT only", async () => {
    const f = deliveriesApi([[d(1, "a", 1, FAILED)]]);
    await run(f);
    for (const c of f.calls) {
      const jwt = (c.headers.get("authorization") ?? "").replace("Bearer ", "");
      expect(JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).iss).toBe(APP_ID);
      expect(c.path).not.toContain("access_tokens");
    }
  });
});

describe("listRecentAppDeliveries", () => {
  const list = (f: FakeFetch) => listRecentAppDeliveries({ appId: APP_ID, privateKey, fetchImpl: f.fetch, now: () => NOW });

  it("returns the newest attempt per GUID inside the window, across pages, and sends nothing but reads", async () => {
    const f = deliveriesApi([[d(3, "a", 1, "Invalid HTTP Response: 401"), d(2, "a", 2, "OK")], [d(4, "b", 3, "OK"), d(1, "c", 25, FAILED)]]);
    const { deliveries, endedEarlyWith } = await list(f);
    expect(deliveries).toEqual([d(3, "a", 1, "Invalid HTTP Response: 401"), d(4, "b", 3, "OK")]);
    expect(deliveries[0].status_code).toBe(401);
    expect(endedEarlyWith).toBeNull();
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("returns what it listed, with the status that ended it, when a later page is refused", async () => {
    const f = fakeFetch({
      "GET /app/hook/deliveries": [
        { json: [d(1, "a", 1, "OK")], headers: { link: `<https://api.github.com/app/hook/deliveries?per_page=100&cursor=c1>; rel="next"` } },
        { status: 502, json: {} },
      ],
    });
    expect(await list(f)).toEqual({ deliveries: [d(1, "a", 1, "OK")], endedEarlyWith: 502 });
  });

  it("throws GitHub's refusal of the first page", async () => {
    const error = await list(deliveriesApi([], { list: { status: 401, json: { message: "Bad credentials" } } })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ status: 401, path: "/app/hook/deliveries" });
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
