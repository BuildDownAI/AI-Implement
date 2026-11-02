import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostPushReviewPublication, MAX_PUBLICATION_BYTES, MAX_PUBLICATION_COMMENTS, publicationMarker, type PostPushReviewPublicationDependencies, type PostPushReviewPublicationInput, type PostPushReviewPublicationResult } from "../../restate/post-push-review-publication.js";
import { AI_IMPLEMENT_NATIVE_REVIEW_MARKER } from "../../pipeline/review-ledger.js";
import { callObject, callService, journalEntries, journalText, queryInvocations, startVariants, stopAll, VARIANTS, type RestateEnvironment } from "./harness.js";

const TOKEN = "SENTINEL-PUBLICATION-INSTALLATION-TOKEN";
const SHA = "a".repeat(40);
type Payload = Parameters<PostPushReviewPublicationDependencies["postReview"]>[2];
type Review = Awaited<ReturnType<PostPushReviewPublicationDependencies["postReview"]>>;
type Scenario = { head: string; reviews: Review[]; attempts: Payload[]; mints: number; crash?: boolean; fallback?: boolean; stringError?: boolean; unrelated?: boolean };
const scenarios = new Map<string, Scenario>();
const scenario = (i: PostPushReviewPublicationInput) => scenarios.get(i.repo)!;
const deps: PostPushReviewPublicationDependencies = {
  mintToken: async () => TOKEN,
  readHead: async (token, i) => { expect(token).toBe(TOKEN); scenario(i).mints++; return scenario(i).head; },
  listReviews: async (_, i) => scenario(i).reviews,
  postReview: async (_, i, payload) => {
    const s = scenario(i);
    s.attempts.push(payload);
    if (s.unrelated) throw { status: 422, errors: [TOKEN, { field: "body", message: TOKEN }] };
    if (s.fallback && payload.comments.length) throw { status: 422, errors: s.stringError ? ["Pull request review thread line must be part of the diff"] : [{ field: "line" }] };
    const review = { id: s.reviews.length + 12, html_url: "https://github.com/o/r/pull/1#pullrequestreview-12", body: payload.body };
    s.reviews.push(review);
    if (s.crash) { s.crash = false; throw new Error(TOKEN); }
    return review;
  },
  listComments: async (_, i, id) => {
    const payload = scenario(i).attempts.find((p) => p.body === scenario(i).reviews.find((r) => r.id === id)!.body)!;
    return payload.comments.map((c, n) => ({ id: 100 + n, path: c.path, line: c.line }));
  },
};

describe("PostPushReviewPublication", () => {
  let environments: Map<string, RestateEnvironment>;
  beforeAll(async () => { environments = await startVariants([createPostPushReviewPublication(deps)]); });
  afterAll(async () => { await stopAll(environments); });
  for (const [variant] of VARIANTS) describe(variant, () => {
    const env = () => environments.get(variant)!;
    function setup(options: Partial<Scenario> = {}) {
      const input: PostPushReviewPublicationInput = { owner: "o", repo: randomUUID(), prNumber: 1, headSha: SHA, iteration: 1, body: `${AI_IMPLEMENT_NATIVE_REVIEW_MARKER}\nReview`, comments: [{ path: "src/a.ts", line: 3, side: "RIGHT", body: "Fix this" }] };
      const s: Scenario = { head: SHA, reviews: [], attempts: [], mints: 0, ...options };
      scenarios.set(input.repo, s);
      const key = `o/${input.repo}#1`;
      const publish = (value = input) => callObject<PostPushReviewPublicationResult>(env().baseUrl(), "PostPushReviewPublication", key, "publish", value);
      const get = (iteration = 1) => callObject<PostPushReviewPublicationResult | null>(env().baseUrl(), "PostPushReviewPublication", key, "get", { headSha: SHA, iteration });
      return { input, s, key, publish, get };
    }
    async function assertSecretAbsent(key: string) {
      const rows = await queryInvocations(env().adminAPIBaseUrl(), `target_service_name = 'PostPushReviewPublication' AND target_service_key = '${key}'`);
      expect(rows.length).toBeGreaterThan(0);
      const journals = await Promise.all(rows.map(async (r) => journalText(await journalEntries(env().adminAPIBaseUrl(), String(r.id)))));
      expect(journals.join()).toContain("publish-review");
      expect(JSON.stringify([rows, journals])).not.toContain(TOKEN);
      const response = await fetch(`${env().adminAPIBaseUrl()}/query`, { // restate-test-allow: raw object state secrecy assertion
        method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query: `SELECT * FROM state WHERE service_name = 'PostPushReviewPublication' AND service_key = '${key}'` }),
      });
      expect(response.ok).toBe(true);
      const state = await response.json() as { rows: unknown[] };
      expect(state.rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(state)).not.toContain(TOKEN);
    }
    it("posts inline IDs, caches per pass, and deduplicates an invocation retry", async () => {
      const { input, s, key, publish, get } = setup();
      const headers = { "idempotency-key": randomUUID() };
      const invoke = () => callService<PostPushReviewPublicationResult>(env().baseUrl(), `PostPushReviewPublication/${encodeURIComponent(key)}`, "publish", input, headers);
      const result = await invoke();
      expect(result).toEqual({ status: "posted", reviewId: 12, reviewUrl: s.reviews[0]!.html_url, comments: [{ path: "src/a.ts", line: 3, commentId: 100 }], inlineFallback: false });
      expect(await invoke()).toEqual(result);
      expect(await publish()).toEqual(result);
      expect(await get()).toEqual(result);
      expect(await get(99)).toBeNull();
      expect(s.attempts).toEqual([{ event: "COMMENT", commit_id: SHA, body: `${input.body}\n\n${publicationMarker(SHA, 1)}`, comments: input.comments }]);
      await assertSecretAbsent(key);
      await publish({ ...input, iteration: 2 });
      expect(s.reviews).toHaveLength(2);
    });
    for (const fallback of [false, true]) it(`recovers IDs after GitHub succeeds then throws (fallback=${fallback})`, async () => {
      const { s, publish, key, get } = setup({ crash: true, fallback });
      const result = await publish();
      expect(result.status).toBe("posted");
      expect(result).toEqual({ status: "posted", reviewId: 12, reviewUrl: s.reviews[0]!.html_url,
        comments: fallback ? [] : [{ path: "src/a.ts", line: 3, commentId: 100 }], inlineFallback: fallback });
      expect(await get()).toEqual(result);
      expect(s.reviews).toHaveLength(1);
      expect(s.mints).toBe(2);
      expect(s.attempts).toHaveLength(fallback ? 2 : 1);
      await assertSecretAbsent(key);
    });
    it("returns stale-head without posting", async () => {
      const { s, publish, get } = setup({ head: "b".repeat(40) });
      expect(await publish()).toEqual({ status: "stale-head" });
      expect(await get()).toEqual({ status: "stale-head" });
      expect(s.attempts).toEqual([]);
    });
    for (const stringError of [false, true]) it(`falls back once with comment text and the original prefix (stringError=${stringError})`, async () => {
      const { input, s, publish, get } = setup({ fallback: true, stringError });
      const result = await publish();
      expect(result).toMatchObject({ status: "posted", inlineFallback: true, comments: [] });
      expect(await get()).toEqual(result);
      expect(s.attempts).toHaveLength(2);
      const payload = s.attempts[1]!;
      expect(payload.comments).toEqual([]);
      expect(payload.body.startsWith(input.body)).toBe(true);
      expect(payload.body).toContain("Fix this");
      expect(payload.body.endsWith(publicationMarker(SHA, 1))).toBe(true);
    });
    it("does not fall back for unrelated validation errors or journal their token", async () => {
      const { s, key, publish } = setup({ unrelated: true });
      await expect(publish()).rejects.toThrow();
      expect(s.attempts).toHaveLength(5);
      expect(s.attempts.every((p) => p.comments.length === 1)).toBe(true);
      const rows = await queryInvocations(env().adminAPIBaseUrl(), `target_service_key = '${key}'`);
      const journals = await Promise.all(rows.map(async (r) => journalText(await journalEntries(env().adminAPIBaseUrl(), String(r.id)))));
      expect(JSON.stringify([rows, journals])).not.toContain(TOKEN);
    });
    it("rejects oversized payloads, too many comments and mismatched keys before GitHub", async () => {
      const { input, s, publish } = setup();
      await expect(publish({ ...input, body: "x".repeat(MAX_PUBLICATION_BYTES) })).rejects.toThrow(/400/);
      await expect(publish({ ...input, comments: Array.from({ length: MAX_PUBLICATION_COMMENTS + 1 }, () => input.comments[0]!) })).rejects.toThrow(/400/);
      await expect(publish({ ...input, owner: "different" })).rejects.toThrow(/400/);
      expect(s.mints).toBe(0);
    });
    it("accepts payload and comment count boundaries", async () => {
      const { input, s, publish } = setup();
      input.comments = Array.from({ length: MAX_PUBLICATION_COMMENTS }, () => input.comments[0]!);
      input.body = "";
      input.body = "x".repeat(MAX_PUBLICATION_BYTES - Buffer.byteLength(JSON.stringify(input)));
      expect(Buffer.byteLength(JSON.stringify(input))).toBe(MAX_PUBLICATION_BYTES);
      expect(await publish()).toMatchObject({ status: "posted" });
      expect(s.attempts[0]!.comments).toHaveLength(MAX_PUBLICATION_COMMENTS);
    });
  });
});
