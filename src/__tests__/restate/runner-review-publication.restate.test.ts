import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../dedup.js";
import { appendLog, initLogTable } from "../../log.js";
import { mintRunToken, verifyRunToken } from "../../runner-tokens.js";
import { createReviewPublicationIngressClient, handleRunnerReviewPublication } from "../../runner-callback.js";
import { MAX_PUBLICATION_BYTES, createPostPushReviewPublication, type PostPushReviewPublicationInput } from "../../restate/post-push-review-publication.js";
import { VARIANTS, journalEntries, journalText, queryInvocations, startVariants, stopAll, type RestateEnvironment } from "./harness.js";

const secret = "review-publication-test-secret";
const headSha = "a".repeat(40);
const body = { prNumber: 42, headSha, iteration: 0, body: "Review", comments: [{ path: "src/a.ts", line: 2, side: "RIGHT", body: "Finding" }], repo: "attacker/repo" };

describe("runner review publication", () => {
  let environments: Map<string, RestateEnvironment>;
  let server: Server;
  let url: string;
  let baseUrl: string;
  let ready = true;
  let registered = true;
  let fail = false;
  const posts: PostPushReviewPublicationInput[] = [];
  const forwarded: { input: string; key: string | null; url: string }[] = [];
  beforeAll(async () => {
    getDb();
    initLogTable();
    environments = await startVariants([createPostPushReviewPublication({
      mintToken: async () => "fake-github-token",
      readHead: async () => headSha,
      listReviews: async () => [],
      postReview: async (_token, input, review) => {
        posts.push(input);
        return { id: 123, html_url: "https://github.com/o/r/pull/42#pullrequestreview-123", body: review.body };
      },
      listComments: async () => [{ id: 456, path: "src/a.ts", line: 2 }],
    })]);
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const result = await handleRunnerReviewPublication({
        authorization: request.headers.authorization, secret,
        body: JSON.parse(Buffer.concat(chunks).toString()),
        restateReady: () => ready && registered,
        ingress: createReviewPublicationIngressClient(baseUrl, { fetchImpl: async (input, init) => {
          if (fail) throw new Error("injected ingress failure");
          forwarded.push({ input: String(init?.body), key: new Headers(init?.headers).get("idempotency-key"), url: String(input) });
          return fetch(input, init);
        } }),
      });
      response.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(result.body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/runner/review-publication`;
  }, 120_000);
  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await stopAll(environments);
  });
  function token(options: { repo?: string; missingRun?: boolean; audience?: "progress" | "result"; ttlSeconds?: number } = {}) {
    const dispatchId = randomUUID();
    if (!options.missingRun) appendLog({ dispatchId, issueId: dispatchId, teamKey: "ENG", phase: "implementation", repo: options.repo ?? "o/r" });
    return mintRunToken({ dispatchId, issueId: dispatchId, mappingTeamKey: "ENG", phase: "implementation", audience: options.audience ?? "progress", ttlSeconds: options.ttlSeconds ?? 3600, secret }).token;
  }
  async function request(bearer?: string, data: unknown = body) {
    return fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(data) });
  }
  for (const [variant] of VARIANTS) {
    it(`${variant}: authenticates, scopes, deduplicates and excludes credentials from Restate`, async () => {
      const env = environments.get(variant)!;
      baseUrl = env.baseUrl();
      const invocations = () => queryInvocations(env.adminAPIBaseUrl(), "target_service_name = 'PostPushReviewPublication' AND target_handler_name = 'publish'");
      for (const bearer of [undefined, "invalid", `${token()}x`, token({ audience: "result" }), token({ ttlSeconds: -1 })]) {
        expect((await request(bearer)).status).toBe(401);
      }
      for (const bearer of [token({ missingRun: true }), token({ repo: "" })]) expect((await request(bearer)).status).toBe(403);
      expect(await invocations()).toHaveLength(0);
      const bearer = token();
      ready = false;
      const unavailable = await request(bearer);
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toMatchObject({ error: "restate-unavailable" });
      ready = true;
      registered = false;
      expect((await request(bearer)).status).toBe(503);
      registered = true;
      fail = true;
      expect((await request(bearer)).status).toBe(503);
      fail = false;
      expect(await invocations()).toHaveLength(0);
      const beforeForwarded = forwarded.length;
      const malformed = [
        null, [], {},
        ...["prNumber", "headSha", "iteration", "body", "comments"].map((field) =>
          Object.fromEntries(Object.entries(body).filter(([key]) => key !== field))),
        ...[undefined, null, {}, "comments", [null]].map((comments) => ({ ...body, comments })),
        ...[0, -1, 1.5, "42"].map((prNumber) => ({ ...body, prNumber })),
        ...[null, "bad", "A".repeat(40)].map((headSha) => ({ ...body, headSha })),
        ...[-1, 0.5, "0"].map((iteration) => ({ ...body, iteration })),
        { ...body, body: null },
        { ...body, body: "é".repeat(MAX_PUBLICATION_BYTES / 2) },
        { ...body, comments: Array.from({ length: 101 }, () => body.comments[0]) },
        ...[{ line: 0 }, { line: -1 }, { line: 1.5 }, { line: "2" },
          { path: "" }, { path: "a".repeat(1025) }, { side: "right" }, { body: "" },
        ].map((comment) => ({ ...body, comments: [{ ...body.comments[0], ...comment }] })),
      ];
      for (const invalid of malformed) {
        const response = await request(bearer, invalid);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "invalid_review_publication" });
      }
      expect(forwarded).toHaveLength(beforeForwarded);
      expect(await invocations()).toHaveLength(0);
      // These corrected fields use the same PR/head/iteration as the rejected requests.
      const beforePosts = posts.length;
      const data = { ...body, authorization: bearer, comments: body.comments.map((comment) => ({ ...comment, authorization: bearer })) };
      const first = await request(bearer, data);
      expect(first.status).toBe(200);
      const result = await first.json();
      expect(result).toEqual({ status: "posted", reviewId: 123, reviewUrl: "https://github.com/o/r/pull/42#pullrequestreview-123", comments: [{ path: "src/a.ts", line: 2, commentId: 456 }], inlineFallback: false });
      const second = await request(bearer, data);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(result);
      expect(posts.length - beforePosts).toBe(1);
      expect(posts.at(-1)).toMatchObject({ owner: "o", repo: "r" });
      expect(verifyRunToken(bearer, secret, "progress", { consume: false })).toMatchObject({ ok: true, consumedAt: null });
      const rows = await invocations();
      expect(rows).toHaveLength(1);
      expect(rows[0].target_service_key).toBe("o/r#42");
      const journal = journalText(await journalEntries(env.adminAPIBaseUrl(), String(rows[0].id)));
      expect(journal).not.toContain(bearer);
      expect(journal).not.toContain("authorization");
      for (const sent of forwarded) {
        expect(sent.input).not.toContain(bearer);
        expect(sent.input).not.toContain("authorization");
        expect(sent.key).toBe(`o/r#42:${headSha}:0`);
        expect(decodeURIComponent(sent.url)).toContain("PostPushReviewPublication/o/r#42/publish");
      }
    });
  }
});
