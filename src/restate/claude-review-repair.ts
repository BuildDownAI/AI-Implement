/** Durable repair snapshots; the poll remains the clock and GitHub lister. */
import * as restate from "@restatedev/restate-sdk";
import * as clients from "@restatedev/restate-sdk-clients";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import type { ClaudeReviewRepairInput } from "../claude-review-start.js";
import type { ClaudeReviewStartDefinition } from "./claude-review-start.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";

export function createClaudeReviewRepair() {
  return restate.object({ name: "ClaudeReviewRepair", handlers: {
    tick: restate.handlers.object.exclusive({ input: serde.zod(z.object({
      repositories: z.array(z.object({
        repository: z.string().regex(/^[^/#]+\/[^/#]+$/), ref: z.string(),
        pulls: z.array(z.object({ number: z.number(), headSha: z.string() }).strict()),
      }).strict()),
    }).strict()) }, async (ctx: restate.ObjectContext, input: ClaudeReviewRepairInput): Promise<void> => {
      const old = await ctx.get<Record<string, string>>("heads") ?? {};
      const heads: Record<string, string> = {};
      for (const { repository, ref, pulls } of input.repositories) {
        for (const { number, headSha } of pulls) {
          const key = `${repository}#${number}`;
          if (old[key] === headSha) { heads[key] = headSha; continue; }
          try {
            const result = await ctx.objectClient<ClaudeReviewStartDefinition>({ name: "ClaudeReviewStart" }, key)
              .start({ ref, allowDraft: false });
            if (result === "started" || result === "same") heads[key] = headSha;
          } catch (error) {
            if (error instanceof restate.CancelledError || !(error instanceof restate.TerminalError)) throw error;
            ctx.console.warn(`[claude-review-repair] ${key}: start failed`);
          }
        }
      }
      ctx.set("heads", heads);
    }),
  } });
}
export type ClaudeReviewRepairDefinition = ReturnType<typeof createClaudeReviewRepair>;
export function claudeReviewRepairClient() {
  const ingress = clients.connect({ url: RESTATE_INGRESS_BASE_URL });
  return {
    send: async (input: ClaudeReviewRepairInput) =>
      ingress.objectSendClient<ClaudeReviewRepairDefinition>({ name: "ClaudeReviewRepair" }, "orchestrator")
        .tick(input, clients.rpc.sendOpts({ timeout: 5000 })),
  };
}
