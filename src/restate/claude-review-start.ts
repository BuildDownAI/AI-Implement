/** One exclusive durable owner of review starts for owner/repo#PR. */
import * as restate from "@restatedev/restate-sdk";
import * as clients from "@restatedev/restate-sdk-clients";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import { getInstallationToken } from "../github-app-auth.js";
import { getClaudeReviewPullRequest, postWorkflowDispatch } from "../github.js";
import type { ClaudeReviewStartInput, ClaudeReviewStartResult } from "../claude-review-start.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";

export interface ClaudeReviewStartDeps {
  appId: string;
  privateKey: string;
  getInstallationToken: typeof getInstallationToken;
  getPullRequest: typeof getClaudeReviewPullRequest;
  postWorkflowDispatch: typeof postWorkflowDispatch;
}
export function createClaudeReviewStart(deps: ClaudeReviewStartDeps) {
  return restate.object({ name: "ClaudeReviewStart", handlers: {
    start: restate.handlers.object.exclusive({ input: serde.zod(z.object({ ref: z.string(), allowDraft: z.boolean() }).strict()) },
      async (ctx: restate.ObjectContext, input: ClaudeReviewStartInput): Promise<ClaudeReviewStartResult> => {
        const match = /^([^/]+)\/([^/#]+)#(\d+)$/.exec(ctx.key);
        if (!match) return "failed";
        const [, owner, repo, number] = match;
        const pr = await ctx.run("read review PR", async () => {
          try {
            const token = await deps.getInstallationToken(deps.appId, deps.privateKey, owner);
            return await deps.getPullRequest(token, owner, repo, Number(number));
          } catch { return null; }
        });
        if (!pr) return "failed";
        if (pr.state !== "open" || !pr.sameRepository || (pr.draft && !input.allowDraft)) return "skipped";
        if (await ctx.get<string>("head") === pr.headSha) return "same";
        const result = await ctx.run("dispatch Claude review", async () => {
          try {
            const token = await deps.getInstallationToken(deps.appId, deps.privateKey, owner);
            const response = await deps.postWorkflowDispatch({ token, owner, repo,
              workflowFile: "claude-review.yml", ref: input.ref,
              inputs: { pr_number: number, head_sha: pr.headSha } });
            return { success: response.success, status: response.status };
          } catch { return { success: false, status: 0 }; }
        });
        if (result.success || result.status === 404 || result.status === 422) ctx.set("head", pr.headSha);
        if (result.success) {
          ctx.console.info(`[claude-review-start] ${ctx.key} ${pr.headSha} started`);
          return "started";
        }
        ctx.console.warn(`[claude-review-start] ${ctx.key} dispatch failed HTTP ${result.status}`);
        return "failed";
      }),
  } });
}
export type ClaudeReviewStartDefinition = ReturnType<typeof createClaudeReviewStart>;
export function claudeReviewStartClient() {
  const ingress = clients.connect({ url: RESTATE_INGRESS_BASE_URL });
  return {
    send: async (key: string, input: ClaudeReviewStartInput, opts?: { idempotencyKey?: string }) =>
      ingress.objectSendClient<ClaudeReviewStartDefinition>({ name: "ClaudeReviewStart" }, key)
        .start(input, clients.rpc.sendOpts(opts ?? {})),
    call: async (key: string, input: ClaudeReviewStartInput) =>
      ingress.objectClient<ClaudeReviewStartDefinition>({ name: "ClaudeReviewStart" }, key).start(input),
  };
}
