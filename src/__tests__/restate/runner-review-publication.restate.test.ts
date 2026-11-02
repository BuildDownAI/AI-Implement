import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleReviewPublicationRequest } from "../../index.js";
import { postPushReviewStep } from "../../pipeline/steps/post-push-review.js";
import { makeContext } from "../helpers/builders.js";
import { testDir } from "../helpers/test-dir.js";
import { getDb } from "../../dedup.js";
import { appendLog, initLogTable } from "../../log.js";
import { mintRunToken, verifyRunToken } from "../../runner-tokens.js";
import { createReviewPublicationIngressClient } from "../../runner-callback.js";
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
    server = createServer((request, response) => {
      handleReviewPublicationRequest(request, response, {
        secret,
        restateReady: () => ready && registered,
        ingress: createReviewPublicationIngressClient(baseUrl, { fetchImpl: async (input, init) => {
          if (fail) throw new Error("injected ingress failure");
          forwarded.push({ input: String(init?.body), key: new Headers(init?.headers).get("idempotency-key"), url: String(input) });
          return fetch(input, init);
        } }),
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/runner/review-publication`;
  }, 120_000);
  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await stopAll(environments);
  });
  function token(options: { repo?: string; missingRun?: boolean; audience?: "progress" | "result"; ttlSeconds?: number; phase?: "implementation" | "gap-analysis" | "planning" | "kg-refresh" } = {}) {
    const dispatchId = randomUUID();
    if (!options.missingRun) appendLog({ dispatchId, issueId: dispatchId, teamKey: "ENG", phase: options.phase ?? "implementation", repo: options.repo ?? "o/r" });
    return mintRunToken({ dispatchId, issueId: dispatchId, mappingTeamKey: "ENG", phase: options.phase ?? "implementation", audience: options.audience ?? "progress", ttlSeconds: options.ttlSeconds ?? 3600, secret }).token;
  }
  async function request(bearer?: string, data: unknown = body) {
    return fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(data) });
  }
  it("rejects malformed JSON and oversized HTTP bodies before ingress", async () => {
    const before = forwarded.length;
    for (const [payload, status, error] of [
      ["{", 400, "Invalid JSON"],
      ["x".repeat(MAX_PUBLICATION_BYTES + 1025), 413, "Review publication too large"],
    ] as const) {
      const response = await fetch(url, {
        method: "POST", headers: { authorization: `Bearer ${token()}` }, body: payload,
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
    }
    expect(forwarded).toHaveLength(before);
  });
  for (const [variant] of VARIANTS) {
    it(`${variant}: publishes mapped findings through the step and preserves the full report during an outage`, async () => {
      baseUrl = environments.get(variant)!.baseUrl();
      const summary = "Checked both findings against the implementation.";
      const evidence = "Inspected src/a.ts and the omitted diff lines.";
      const findings = [
        { severity: "blocking", body: "Mapped defect. Repair the added line.", path: "src/a.ts", line: 2 },
        { severity: "blocking", body: "Unmapped defect. Repair the omitted line.", path: "src/a.ts", line: 99 },
      ];
      const runStep = async (prNumber: string) => {
        const statusComments: string[] = [];
        const ghSpawn = (args: string[]) => {
          if (args[0] === "pr" && args[1] === "diff") return {
            stdout: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n old\n+new\n", exitCode: 0,
          };
          if (args.includes("POST") && args.some(arg => /\/reviews$/.test(arg))) throw new Error("Runner must not post reviews");
          if (args.includes(`repos/:owner/:repo/pulls/${prNumber}`)) return { stdout: JSON.stringify({ state: "open", head: { sha: headSha } }), exitCode: 0 };
          if (args[0] === "pr" && args[1] === "comment") statusComments.push(args[args.indexOf("--body") + 1]!);
          return { stdout: "[]", exitCode: 0 };
        };
        const context = makeContext({ callbackUrl: url.replace("/runner/review-publication", ""), progressToken: token(), githubOwner: "o", githubRepo: "r" }, {
          invoke: async () => ({ stdout: "", exitCode: 0, tokensUsed: 100, structuredOutput: {
            approved: false, findings, summary, checks: [{ check: "Diff inspection", result: "passed", evidence }],
          }, terminalStatus: { subtype: "success", isError: false } }),
        });
        const result = await postPushReviewStep.run(context, {
          prNumber, workspaceDir: testDir(`publication-${variant}-${prNumber}`), maxIterations: 1,
          pushedSha: headSha, ghSpawn, gitSpawn: () => ({ stdout: headSha, exitCode: 0 }), reviewProviders: [],
          reviewers: [{ id: "code-review", gates: true }],
          trustedReviewerDefinitions: new Map([["code-review", { id: "code-review", buildPrompt: () => "Review", outputSchema: { type: "object" } }]]),
        }, { report: async () => {} });
        expect(result.terminationReason).toBe("iterations_exhausted");
        return statusComments.join("\n");
      };
      const before = posts.length;
      const status = await runStep("43");
      expect(posts).toHaveLength(before + 1);
      expect(posts.at(-1)!.comments).toEqual([expect.objectContaining({ path: "src/a.ts", line: 2, side: "RIGHT", body: expect.stringContaining("Mapped defect.") })]);
      expect(posts.at(-1)!.comments[0]!.body).toContain("<!-- ai-implement");
      expect(posts.at(-1)!.body).toContain("Findings outside the diff");
      expect(posts.at(-1)!.body).toContain("Unmapped defect.");
      expect(status).toContain("Full reviewer report");
      for (const outage of ["readiness", "ingress"] as const) {
        ready = outage !== "readiness";
        fail = outage === "ingress";
        try {
          const fallback = await runStep("44");
          for (const text of [summary, evidence, ...findings.map(finding => finding.body)]) expect(fallback).toContain(text);
          expect(fallback).not.toContain("Full reviewer report");
          expect(posts).toHaveLength(before + 1);
        } finally {
          ready = true;
          fail = false;
        }
      }
    });
    it(`${variant}: authenticates, scopes, deduplicates and excludes credentials from Restate`, async () => {
      const env = environments.get(variant)!;
      baseUrl = env.baseUrl();
      const invocations = () => queryInvocations(env.adminAPIBaseUrl(), "target_service_name = 'PostPushReviewPublication' AND target_handler_name = 'publish' AND target_service_key = 'o/r#42'");
      for (const bearer of [undefined, "invalid", `${token()}x`, token({ audience: "result" }), token({ ttlSeconds: -1 })]) {
        expect((await request(bearer)).status).toBe(401);
      }
      for (const bearer of [token({ missingRun: true }), token({ repo: "" })]) expect((await request(bearer)).status).toBe(403);
      expect(await invocations()).toHaveLength(0);
      const beforeRejected = forwarded.length;
      for (const phase of ["planning", "kg-refresh"] as const) {
        for (const missingRun of [false, true]) {
          const rejected = await request(token({ phase, missingRun }));
          expect(rejected.status).toBe(403);
          expect(await rejected.json()).toEqual({ error: "phase_not_allowed" });
        }
      }
      expect(forwarded).toHaveLength(beforeRejected);
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
      for (const sent of forwarded.slice(beforeForwarded)) {
        expect(sent.input).not.toContain(bearer);
        expect(sent.input).not.toContain("authorization");
        expect(sent.key).toBe(`o/r#42:${headSha}:0`);
        expect(decodeURIComponent(sent.url)).toContain("PostPushReviewPublication/o/r#42/publish");
      }
      const gapBearer = token({ phase: "gap-analysis" });
      const gapResult = await request(gapBearer, { ...body, iteration: 1 });
      expect(gapResult.status).toBe(200);
      expect(await gapResult.json()).toMatchObject({ status: "posted" });
      expect(posts.length - beforePosts).toBe(2);
      expect(await invocations()).toHaveLength(2);
      expect(verifyRunToken(gapBearer, secret, "progress", { consume: false }).ok).toBe(true);
    });
  }
  it("logs an unexpected route rejection once and returns 500", async () => {
    const error = new Error("unexpected readiness failure");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const routeServer = createServer((req, res) => {
      handleReviewPublicationRequest(req, res, {
        secret, ingress: { publish: async () => { throw new Error("must not publish"); } },
        restateReady: () => { throw error; },
      });
    });
    try {
      await new Promise<void>((resolve) => routeServer.listen(0, "127.0.0.1", resolve));
      const response = await fetch(`http://127.0.0.1:${(routeServer.address() as AddressInfo).port}/runner/review-publication`, {
        method: "POST", headers: { authorization: `Bearer ${token()}` }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Internal server error" });
      expect(log).toHaveBeenCalledExactlyOnceWith("[runner-review-publication] Unhandled error:", error);
    } finally {
      log.mockRestore();
      await new Promise<void>((resolve) => routeServer.close(() => resolve()));
    }
  });
});
