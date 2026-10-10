// Unit tests for the review-fix Restate ingress client (src/restate/review-fix-client.ts).
// No Docker, no live Restate server: the client runs against a faked fetch.
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type * as ClientModule from "../restate/review-fix-client.js";
import type { ScopedPrIdentity } from "../review-fix-contract.js";

let client: typeof ClientModule;

beforeEach(async () => {
  vi.resetModules();
  client = await import("../restate/review-fix-client.js");
});

function makeDestination(overrides: Partial<ScopedPrIdentity> = {}): ScopedPrIdentity {
  return { installationId: 7, repository: "acme/app", prNumber: 42, ...overrides };
}

// ADR 034 rule 4 producer proof: the real ingress client ends at the exact request. The receiving
// handler runs inside Restate (covered by the Restate tier), so the contract ends at the request
// and the validator the `result` handler calls first.
describe("createReviewFixIngressClient — producer contract", () => {
  it("contract: ReviewFixAttempt.wake — a result forward posts to the attempt's result handler with a body the handler's validator accepts", async () => {
    const { validateReviewFixResultMetadata } = await import("../review-fix-contract.js");
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push({ url: request.url, headers: request.headers, body: await request.text() });
      return new Response(JSON.stringify({ status: "stored" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const ingress = client.createReviewFixIngressClient("http://ingress.test", { fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = {
      version: 1, attemptId: "attempt-wake", installationId: 7, repository: "acme/app", prNumber: 42,
      deadlineAt: Date.now() + 60_000, githubRunId: 100, githubRunAttempt: 1, outputCommit: "b".repeat(40),
    } as const;

    await ingress.result("attempt-wake", result, { idempotencyKey: client.reviewFixResultForwardKey(result) });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://ingress.test/ReviewFixAttempt/attempt-wake/result");
    const sent = JSON.parse(calls[0]!.body);
    expect(validateReviewFixResultMetadata(sent).ok).toBe(true);
    expect(sent.attemptId).toBe("attempt-wake");
  });
});

describe("no launch/finalize/recovery decisions leak into this module", () => {
  it("imports neither worker/finalizer ports nor dispatch/runner modules", () => {
    const source = fs.readFileSync(path.join(__dirname, "../restate/review-fix-client.ts"), "utf8");
    const forbidden = [
      "review-fix-ports.js",
      "review-fix-attempt.js",
      "fly-machines.js",
      "local-docker.js",
      "github.js",
      "local-gapfill.js",
      "review-fix-queue.js",
      "comment-gapfill-queue.js",
      "providers/",
    ];
    for (const module of forbidden) {
      expect(source).not.toContain(module);
    }
  });
});

describe("createReviewFixIngressClient (AII-1184)", () => {
  const event = {
    eventId: "gh-delivery:d1", deliveryId: "d1", issueId: "i", issueIdentifier: "AII-1",
    repo: "acme/app", prNumber: 42, reason: "review_comment",
  };

  it("posts the event to /ReviewFixPR/<key>/feedback with the idempotency-key and maps a 2xx to accepted", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push({ url: request.url, headers: request.headers });
      return new Response("null", { status: 200, headers: { "content-type": "application/json" } });
    });
    const ingress = client.createReviewFixIngressClient("http://sidecar", { fetchImpl: fetchImpl as unknown as typeof fetch });
    const outcome = await ingress.feedback(makeDestination(), event, { idempotencyKey: "d1" });
    expect(outcome).toEqual({ status: "accepted" });
    expect(calls).toHaveLength(1);
    expect(decodeURIComponent(calls[0]!.url)).toBe(`http://sidecar/ReviewFixPR/${JSON.stringify([7, "acme/app", 42])}/feedback`);
    expect(calls[0]!.headers.get("idempotency-key")).toBe("d1");
  });

  it("sends a nudge with no event under the supplied idempotency-key", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push({ url: request.url, headers: request.headers });
      return new Response("null", { status: 200, headers: { "content-type": "application/json" } });
    });
    const ingress = client.createReviewFixIngressClient("http://sidecar", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await ingress.feedback(makeDestination(), undefined, { idempotencyKey: "9.4.100" })).toEqual({ status: "accepted" });
    expect(calls[0]!.headers.get("idempotency-key")).toBe("9.4.100");
  });

  it("maps a connection error to unavailable", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const ingress = client.createReviewFixIngressClient("http://sidecar", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await ingress.feedback(makeDestination(), event, { idempotencyKey: "d1" })).toEqual({ status: "unavailable" });
  });

  it("maps a timeout to unavailable", async () => {
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const ingress = client.createReviewFixIngressClient("http://sidecar", { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 20 });
    expect(await ingress.feedback(makeDestination(), event, { idempotencyKey: "d1" })).toEqual({ status: "unavailable" });
  });

  it("maps a non-2xx to unavailable", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 503 }));
    const ingress = client.createReviewFixIngressClient("http://sidecar", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await ingress.feedback(makeDestination(), event, { idempotencyKey: "d1" })).toEqual({ status: "unavailable" });
  });

  describe("cancel (AII-1186)", () => {
    const run = async (respond: () => Response | Promise<Response>) => {
      const calls: Array<{ url: string; headers: Headers; body: string }> = [];
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push({ url: request.url, headers: request.headers, body: await request.text() });
        return respond();
      });
      const ingress = client.createReviewFixIngressClient("http://sidecar", { fetchImpl: fetchImpl as unknown as typeof fetch });
      return { calls, outcome: await ingress.cancel("att-1", { idempotencyKey: "att-1.closed" }) };
    };

    it("contract: ReviewFixAttempt.cancel — the ingress client posts { attemptId } to the attempt's cancel handler with the idempotency key and maps a 2xx to accepted", async () => {
      const { calls, outcome } = await run(() => new Response("null", { status: 200, headers: { "content-type": "application/json" } }));
      expect(outcome).toEqual({ status: "accepted" });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("http://sidecar/ReviewFixAttempt/att-1/cancel");
      expect(calls[0]!.headers.get("idempotency-key")).toBe("att-1.closed");
      expect(JSON.parse(calls[0]!.body)).toEqual({ attemptId: "att-1" });
    });

    it("maps a non-2xx and a connection error to unavailable", async () => {
      expect((await run(() => new Response("boom", { status: 503 }))).outcome).toEqual({ status: "unavailable" });
      expect((await run(() => { throw new Error("ECONNREFUSED"); })).outcome).toEqual({ status: "unavailable" });
    });
  });

  describe("result (AII-1185)", () => {
    const stored = { status: "stored", result: { attemptId: "att-1" } };
    const run = async (respond: () => Response | Promise<Response>) => {
      const calls: Array<{ url: string; headers: Headers }> = [];
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push({ url: request.url, headers: request.headers });
        return respond();
      });
      const ingress = client.createReviewFixIngressClient("http://sidecar", { fetchImpl: fetchImpl as unknown as typeof fetch });
      const outcome = await ingress.result("att-1" as never, { attemptId: "att-1" } as never, { idempotencyKey: "att-1.result.k" });
      return { outcome, calls };
    };

    it("posts to /ReviewFixAttempt/<id>/result with the idempotency-key and returns the handler outcome", async () => {
      const { outcome, calls } = await run(() => new Response(JSON.stringify(stored), { status: 200, headers: { "content-type": "application/json" } }));
      expect(outcome).toEqual({ status: "accepted", outcome: stored });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("http://sidecar/ReviewFixAttempt/att-1/result");
      expect(calls[0]!.headers.get("idempotency-key")).toBe("att-1.result.k");
    });

    it("maps 409 to conflict, 404 to not-found, and other failures to unavailable", async () => {
      expect((await run(() => new Response("x", { status: 409 }))).outcome).toEqual({ status: "conflict" });
      expect((await run(() => new Response("x", { status: 404 }))).outcome).toEqual({ status: "not-found" });
      expect((await run(() => new Response("x", { status: 503 }))).outcome).toEqual({ status: "unavailable" });
      expect((await run(() => { throw new Error("ECONNREFUSED"); })).outcome).toEqual({ status: "unavailable" });
    });

    it("keys on attempt and body so a conflicting body never shares a key with the first", () => {
      const a = { attemptId: "att-1", outputCommit: "a" } as never;
      const b = { attemptId: "att-1", outputCommit: "b" } as never;
      expect(client.reviewFixResultForwardKey(a)).toBe(client.reviewFixResultForwardKey({ ...(a as object) } as never));
      expect(client.reviewFixResultForwardKey(a)).not.toBe(client.reviewFixResultForwardKey(b));
      expect(client.reviewFixResultForwardKey(a)).toMatch(/^att-1\.result\.[0-9a-f]{64}$/);
    });
  });
});
