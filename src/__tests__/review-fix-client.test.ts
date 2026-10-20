// Unit tests for the review-fix Restate ingress client (src/restate/review-fix-client.ts).
// No Docker, no live Restate server: the client runs against a faked fetch.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createReviewFixIngressClient, reviewFixResultForwardKey } from "../restate/review-fix-client.js";
import { validateReviewFixResultMetadata } from "../review-fix-contract.js";
import { makeReviewFixResult, makeScopedPrIdentity } from "./helpers/builders.js";
import { fakeFetch, hangUntilAborted, type FakeFetch, type Reply } from "./helpers/fake-fetch.js";

const destination = makeScopedPrIdentity({ installationId: 7, repository: "acme/app", prNumber: 42 });
const FEEDBACK = `POST /ReviewFixPR/${encodeURIComponent(JSON.stringify([7, "acme/app", 42]))}/feedback` as const;
/** What Restate's ingress answers for a handler that returns nothing. */
const accepted: Reply = { json: null };

const ingressFor = (fake: FakeFetch, timeoutMs?: number) =>
  createReviewFixIngressClient("http://sidecar", { fetchImpl: fake.fetch, ...(timeoutMs ? { timeoutMs } : {}) });

// ADR 034 rule 4 producer proof: the real ingress client ends at the exact request. The receiving
// handler runs inside Restate (covered by the Restate tier), so the contract ends at the request
// and the validator the `result` handler calls first.
describe("createReviewFixIngressClient — producer contract", () => {
  it("contract: ReviewFixAttempt.wake — a result forward posts to the attempt's result handler with a body the handler's validator accepts", async () => {
    const result = makeReviewFixResult({ attemptId: "attempt-wake", installationId: 7, repository: "acme/app", prNumber: 42, githubRunId: 100 });
    const fake = fakeFetch({ "POST /ReviewFixAttempt/attempt-wake/result": { json: { status: "stored", result } } });
    const ingress = createReviewFixIngressClient("http://ingress.test", { fetchImpl: fake.fetch });

    await ingress.result("attempt-wake", result, { idempotencyKey: reviewFixResultForwardKey(result) });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url.href).toBe("http://ingress.test/ReviewFixAttempt/attempt-wake/result");
    const sent = JSON.parse(fake.calls[0]!.body);
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
    const fake = fakeFetch({ [FEEDBACK]: accepted });
    const outcome = await ingressFor(fake).feedback(destination, event, { idempotencyKey: "d1" });
    expect(outcome).toEqual({ status: "accepted" });
    expect(fake.calls).toHaveLength(1);
    expect(decodeURIComponent(fake.calls[0]!.url.href)).toBe(`http://sidecar/ReviewFixPR/${JSON.stringify([7, "acme/app", 42])}/feedback`);
    expect(fake.calls[0]!.headers.get("idempotency-key")).toBe("d1");
  });

  it("sends a nudge with no event under the supplied idempotency-key", async () => {
    const fake = fakeFetch({ [FEEDBACK]: accepted });
    expect(await ingressFor(fake).feedback(destination, undefined, { idempotencyKey: "9.4.100" })).toEqual({ status: "accepted" });
    expect(fake.calls[0]!.headers.get("idempotency-key")).toBe("9.4.100");
  });

  it("maps a connection error to unavailable", async () => {
    const fake = fakeFetch({ [FEEDBACK]: () => { throw new Error("ECONNREFUSED"); } });
    expect(await ingressFor(fake).feedback(destination, event, { idempotencyKey: "d1" })).toEqual({ status: "unavailable" });
  });

  it("maps a timeout to unavailable", async () => {
    const fake = fakeFetch({ [FEEDBACK]: hangUntilAborted });
    expect(await ingressFor(fake, 20).feedback(destination, event, { idempotencyKey: "d1" })).toEqual({ status: "unavailable" });
  });

  it("maps a non-2xx to unavailable", async () => {
    const fake = fakeFetch({ [FEEDBACK]: { status: 503, text: "boom" } });
    expect(await ingressFor(fake).feedback(destination, event, { idempotencyKey: "d1" })).toEqual({ status: "unavailable" });
  });

  describe("cancel (AII-1186)", () => {
    const run = async (reply: Reply) => {
      const fake = fakeFetch({ "POST /ReviewFixAttempt/att-1/cancel": reply });
      return { calls: fake.calls, outcome: await ingressFor(fake).cancel("att-1", { idempotencyKey: "att-1.closed" }) };
    };

    it("contract: ReviewFixAttempt.cancel — the ingress client posts { attemptId } to the attempt's cancel handler with the idempotency key and maps a 2xx to accepted", async () => {
      const { calls, outcome } = await run(accepted);
      expect(outcome).toEqual({ status: "accepted" });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url.href).toBe("http://sidecar/ReviewFixAttempt/att-1/cancel");
      expect(calls[0]!.headers.get("idempotency-key")).toBe("att-1.closed");
      expect(JSON.parse(calls[0]!.body)).toEqual({ attemptId: "att-1" });
    });

    it("maps a non-2xx and a connection error to unavailable", async () => {
      expect((await run({ status: 503, text: "boom" })).outcome).toEqual({ status: "unavailable" });
      expect((await run(() => { throw new Error("ECONNREFUSED"); })).outcome).toEqual({ status: "unavailable" });
    });
  });

  describe("result (AII-1185)", () => {
    const result = makeReviewFixResult({ attemptId: "att-1" });
    const stored = { status: "stored", result };
    const run = async (reply: Reply) => {
      const fake = fakeFetch({ "POST /ReviewFixAttempt/att-1/result": reply });
      const outcome = await ingressFor(fake).result("att-1", result, { idempotencyKey: "att-1.result.k" });
      return { outcome, calls: fake.calls };
    };

    it("posts to /ReviewFixAttempt/<id>/result with the idempotency-key and returns the handler outcome", async () => {
      const { outcome, calls } = await run({ json: stored });
      expect(outcome).toEqual({ status: "accepted", outcome: stored });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url.href).toBe("http://sidecar/ReviewFixAttempt/att-1/result");
      expect(calls[0]!.headers.get("idempotency-key")).toBe("att-1.result.k");
    });

    it("maps 409 to conflict, 404 to not-found, and other failures to unavailable", async () => {
      expect((await run({ status: 409, text: "x" })).outcome).toEqual({ status: "conflict" });
      expect((await run({ status: 404, text: "x" })).outcome).toEqual({ status: "not-found" });
      expect((await run({ status: 503, text: "x" })).outcome).toEqual({ status: "unavailable" });
      expect((await run(() => { throw new Error("ECONNREFUSED"); })).outcome).toEqual({ status: "unavailable" });
    });

    it("keys on attempt and body so a conflicting body never shares a key with the first", () => {
      const a = makeReviewFixResult({ attemptId: "att-1", outputCommit: "a".repeat(40) });
      const b = makeReviewFixResult({ attemptId: "att-1", outputCommit: "b".repeat(40), deadlineAt: a.deadlineAt });
      expect(reviewFixResultForwardKey(a)).toBe(reviewFixResultForwardKey({ ...a }));
      expect(reviewFixResultForwardKey(a)).not.toBe(reviewFixResultForwardKey(b));
      expect(reviewFixResultForwardKey(a)).toMatch(/^att-1\.result\.[0-9a-f]{64}$/);
    });
  });
});
