import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import type { AppConfig } from "../index.js";
import { getInstallationToken } from "../github-app-auth.js";
import { defaultFetchSignal } from "../github.js";

export const MAX_PUBLICATION_BYTES = 48_000;
export const MAX_PUBLICATION_COMMENTS = 100;
const lookupSchema = z.object({
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  iteration: z.number().int().nonnegative(),
});
export const reviewPublicationInputSchema = z.object({
  owner: z.string().regex(/^[\w.-]+$/), repo: z.string().regex(/^[\w.-]+$/),
  prNumber: z.number().int().positive(), headSha: z.string().regex(/^[a-f0-9]{40}$/),
  iteration: z.number().int().nonnegative(), body: z.string(),
  comments: z.array(z.object({ path: z.string().min(1).max(1024), line: z.number().int().positive(), side: z.enum(["LEFT", "RIGHT"]), body: z.string().min(1) })).max(MAX_PUBLICATION_COMMENTS),
});
export type PostPushReviewPublicationInput = z.infer<typeof reviewPublicationInputSchema>;
type Review = { id: number; html_url: string; body: string | null };
type Comment = { id: number; path: string; line: number | null; original_line?: number | null };
export type PostPushReviewPublicationResult = { status: "stale-head" } | {
  status: "posted"; reviewId: number; reviewUrl: string;
  comments: { path: string; line: number; commentId: number }[]; inlineFallback: boolean;
};
export interface PostPushReviewPublicationDependencies {
  mintToken(owner: string): Promise<string>;
  readHead(token: string, input: PostPushReviewPublicationInput): Promise<string>;
  listReviews(token: string, input: PostPushReviewPublicationInput): Promise<Review[]>;
  postReview(token: string, input: PostPushReviewPublicationInput, review: { event: "COMMENT"; commit_id: string; body: string; comments: PostPushReviewPublicationInput["comments"] }): Promise<Review>;
  listComments(token: string, input: PostPushReviewPublicationInput, reviewId: number): Promise<Comment[]>;
}
const fallbackMarker = "<!-- ai-implement review-publication inline-fallback -->";
export const publicationMarker = (headSha: string, iteration: number) => `<!-- ai-implement review-publication head=${headSha} iteration=${iteration} -->`;

// GitHub returns validation errors as either strings or structured field errors.
// Keep unrelated 422s on the normal failure path rather than dropping inline comments.
function invalidPosition(error: unknown): boolean {
  const e = error as { status?: number; errors?: unknown } | null;
  if (e?.status !== 422 || !Array.isArray(e.errors)) return false;
  const positionMessage = (message: unknown) => typeof message === "string"
    && /diff|position|line.*(invalid|part)/i.test(message);
  return e.errors.some((value: unknown) => {
    if (typeof value === "string") return positionMessage(value);
    if (!value || typeof value !== "object") return false;
    const detail = value as { field?: unknown; message?: unknown };
    return (typeof detail.field === "string" && /^(position|line|side|start_line|start_side)$/.test(detail.field))
      || positionMessage(detail.message);
  });
}
export function createPostPushReviewPublication(deps: PostPushReviewPublicationDependencies) {
  return restate.object({ name: "PostPushReviewPublication", handlers: {
    publish: restate.handlers.object.exclusive(async (ctx: restate.ObjectContext, raw: PostPushReviewPublicationInput): Promise<PostPushReviewPublicationResult> => {
      const parsed = reviewPublicationInputSchema.safeParse(raw);
      if (!parsed.success || Buffer.byteLength(JSON.stringify(raw), "utf8") > MAX_PUBLICATION_BYTES) throw new restate.TerminalError("Invalid or oversized review publication", { errorCode: 400 });
      const input = parsed.data;
      if (ctx.key !== `${input.owner}/${input.repo}#${input.prNumber}`) throw new restate.TerminalError("Publication key mismatch", { errorCode: 400 });
      const key = `${input.headSha}:${input.iteration}`;
      const cached = await ctx.get<PostPushReviewPublicationResult>(key);
      if (cached) return cached;
      const result = await ctx.run("publish-review", async (): Promise<PostPushReviewPublicationResult> => {
        try {
          const token = await deps.mintToken(input.owner);
          if (await deps.readHead(token, input) !== input.headSha) return { status: "stale-head" };
          const marker = publicationMarker(input.headSha, input.iteration);
          let review = (await deps.listReviews(token, input)).find((r) => r.body?.endsWith(marker));
          if (!review) {
            try {
              review = await deps.postReview(token, input, { event: "COMMENT", commit_id: input.headSha, body: `${input.body}\n\n${marker}`, comments: input.comments });
            } catch (error) {
              if (!input.comments.length || !invalidPosition(error)) throw error;
              const body = `${input.body}\n\n${input.comments.map((c) => `### ${c.path}:${c.line} (${c.side})\n\n${c.body}`).join("\n\n")}\n\n${fallbackMarker}\n${marker}`;
              review = await deps.postReview(token, input, { event: "COMMENT", commit_id: input.headSha, body, comments: [] });
            }
          }
          const comments = await deps.listComments(token, input, review.id);
          return { status: "posted", reviewId: review.id, reviewUrl: review.html_url,
            comments: comments.map((c) => ({ path: c.path, line: c.line ?? c.original_line ?? 0, commentId: c.id })), inlineFallback: !!review.body?.includes(fallbackMarker) };
        } catch {
          // Never journal dependency exceptions: request headers and error bodies can contain the token.
          throw new Error("GitHub review publication failed");
        }
      }, { maxRetryAttempts: 5, initialRetryInterval: 100, maxRetryInterval: 1000 });
      ctx.set(key, result);
      return result;
    }),
    get: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext, raw: z.infer<typeof lookupSchema>): Promise<PostPushReviewPublicationResult | null> => {
      const parsed = lookupSchema.safeParse(raw);
      if (!parsed.success) throw new restate.TerminalError("Invalid publication lookup", { errorCode: 400 });
      const input = parsed.data;
      return ctx.get<PostPushReviewPublicationResult>(`${input.headSha}:${input.iteration}`);
    }),
  } });
}

export function createProductionPostPushReviewPublicationDependencies(config: Pick<AppConfig, "githubAppId" | "githubAppPrivateKey">): PostPushReviewPublicationDependencies {
  async function request<T>(token: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "X-GitHub-Api-Version": "2022-11-28" }, signal: defaultFetchSignal(), ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { errors?: unknown };
      throw { status: response.status, errors: data.errors };
    }
    return await response.json() as T;
  }
  const base = (i: PostPushReviewPublicationInput) => `/repos/${i.owner}/${i.repo}/pulls/${i.prNumber}`;
  async function pages<T>(token: string, path: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const rows = await request<T[]>(token, `${path}?per_page=100&page=${page}`);
      all.push(...rows);
      if (rows.length < 100) return all;
    }
  }
  return {
    mintToken: (owner) => getInstallationToken(config.githubAppId, config.githubAppPrivateKey, owner),
    readHead: async (token, i) => (await request<{ head: { sha: string } }>(token, base(i))).head.sha,
    listReviews: (token, i) => pages<Review>(token, `${base(i)}/reviews`),
    postReview: (token, i, review) => request<Review>(token, `${base(i)}/reviews`, review),
    listComments: (token, i, id) => pages<Comment>(token, `${base(i)}/reviews/${id}/comments`),
  };
}
