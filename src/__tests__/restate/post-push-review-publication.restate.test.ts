import { DEFAULT_REVIEWER_SELECTION } from "../../config.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPostPushReviewPublication, MAX_PUBLICATION_BYTES, MAX_PUBLICATION_COMMENTS, publicationMarker, type PostPushReviewPublicationDependencies, type PostPushReviewPublicationInput, type PostPushReviewPublicationResult } from "../../restate/post-push-review-publication.js";
import { AI_IMPLEMENT_NATIVE_REVIEW_MARKER } from "../../pipeline/review-ledger.js";
import { callObject, callService, journalEntries, journalText, queryInvocations, startVariants, stopAll, VARIANTS, type RestateEnvironment } from "./harness.js";

import { postPushReviewStep } from "../../pipeline/steps/post-push-review.js";
import { createReviewPublicationIngressClient, handleRunnerReviewPublication } from "../../runner-callback.js";
import { mintRunToken } from "../../runner-tokens.js";
import { appendLog, initLogTable } from "../../log.js";
import { makeContext } from "../helpers/builders.js";
import { testDir } from "../helpers/test-dir.js";

function runReview(...[context, inputs, reporter]: Parameters<typeof postPushReviewStep.run>) {
  return postPushReviewStep.run(context, { reviewers: DEFAULT_REVIEWER_SELECTION, ...inputs }, reporter);
}

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
    for (const outcome of ["inline", "fallback", "failure"] as const) it(`publishes mixed runner findings through the callback (${outcome})`, async () => {
      const { input, s, get } = setup({ fallback: outcome === "fallback", unrelated: outcome === "failure" });
      initLogTable();
      const dispatchId = randomUUID();
      const secret = "mixed-findings-secret";
      appendLog({ dispatchId, issueId: dispatchId, teamKey: "ENG", phase: "implementation", repo: `o/${input.repo}` });
      const { token } = mintRunToken({ dispatchId, issueId: dispatchId, mappingTeamKey: "ENG", phase: "implementation", audience: "progress", ttlSeconds: 3600, secret });
      const callbackUrl = "https://runner-callback.test";
      const realFetch = globalThis.fetch;
      const callbackResults: unknown[] = [];
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        if (String(url) !== `${callbackUrl}/runner/review-publication`) return realFetch(url, init);
        const result = await handleRunnerReviewPublication({
          authorization: new Headers(init?.headers).get("authorization") ?? undefined,
          secret, body: JSON.parse(String(init?.body)), restateReady: () => true,
          ingress: createReviewPublicationIngressClient(env().baseUrl(), { fetchImpl: realFetch }),
        });
        callbackResults.push(result);
        return new Response(JSON.stringify(result.body), { status: result.status });
      });
      const statusComments: string[] = [];
      const fullReport = "Complete mixed-finding reviewer evidence. REPORT END";
      const findings = [
        { severity: "blocking", body: "Mapped bug. Fix the new line.", path: "src/a.ts", line: 3 },
        { severity: "minor", body: "Unmapped bug. Preserve this evidence.", path: "src/other.ts", line: 99 },
      ];
      try {
        await runReview(makeContext({
          githubOwner: "o", githubRepo: input.repo, githubToken: "dispatch-token", nonce: "", orchestratorUrl: "",
          callbackUrl, progressToken: token,
        }, { invoke: async () => ({ stdout: "", exitCode: 0, tokensUsed: 1,
          structuredOutput: { approved: false, findings, summary: fullReport }, terminalStatus: { subtype: "success", isError: false },
        }) }), {
          prNumber: "1", workspaceDir: testDir("mixed-publication"), pushedSha: SHA, maxIterations: 1, reviewProviders: [],
          reviewers: [{ id: "code-review", gates: true }],
          trustedReviewerDefinitions: new Map([["code-review", { id: "code-review", buildPrompt: () => "Review", outputSchema: { type: "object" } }]]),
          gitSpawn: () => ({ stdout: "", exitCode: 0 }),
          ghSpawn: (args) => {
            if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3 +3 @@\n-old\n+new", exitCode: 0 };
            if (args[0] === "pr" && args[1] === "comment") statusComments.push(args[args.indexOf("--body") + 1]!);
            if (args.includes("POST") && args.some((arg) => /\/reviews$/.test(arg))) throw new Error("Runner review write forbidden");
            if (args[0] === "api" && args[1] === "repos/:owner/:repo/pulls/1") return { stdout: JSON.stringify({ state: "open", head: { sha: SHA } }), exitCode: 0 };
            return { stdout: "", exitCode: 0 };
          },
        }, { report: async () => undefined });
      } finally { fetchSpy.mockRestore(); }
      expect(callbackResults).toHaveLength(1);
      expect(s.attempts[0]!.comments).toEqual([{ path: "src/a.ts", line: 3, side: "RIGHT", body: expect.stringContaining(findings[0]!.body.split(". ")[0]!) }]);
      expect(s.attempts[0]!.body.split("### Findings outside the diff")[1]).toContain("Unmapped bug.");
      expect(s.attempts[0]!.body).toContain(fullReport);
      if (outcome === "failure") {
        expect(callbackResults[0]).toMatchObject({ status: 503 });
        expect(await get()).toBeNull();
        for (const evidence of [fullReport, "Mapped bug.", "Unmapped bug."]) expect(statusComments.join("\n")).toContain(evidence);
      } else {
        const result = await get();
        expect(callbackResults[0]).toMatchObject({ status: 200, body: result });
        expect(result).toMatchObject({ status: "posted", reviewId: 12, inlineFallback: outcome === "fallback",
          comments: outcome === "inline" ? [{ path: "src/a.ts", line: 3, commentId: 100 }] : [] });
        const published = s.reviews[0]!.body;
        for (const evidence of [fullReport, "Unmapped bug."]) expect(published).toContain(evidence);
        if (outcome === "fallback") {
          expect(s.attempts).toHaveLength(2);
          expect(s.attempts[1]!.comments).toEqual([]);
          expect(published).toContain("Mapped bug.");
        }
      }
    });
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
    it("terminally rejects malformed lookups before GitHub", async () => {
      const { key, s } = setup();
      for (const input of [null, [], "lookup", {}, { headSha: null, iteration: 1 }, { headSha: SHA, iteration: -1 }, { headSha: SHA, iteration: 1.5 }, { headSha: SHA, iteration: "1" }, { headSha: SHA, iteration: Number.MAX_SAFE_INTEGER + 1 }]) {
        await expect(callObject(env().baseUrl(), "PostPushReviewPublication", key, "get", input)).rejects.toThrow(/400.*Invalid publication lookup/);
      }
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
