import * as restate from "@restatedev/restate-sdk";
import * as restateClients from "@restatedev/restate-sdk-clients";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";

export type ModelAbTestRow = "first" | "second";

/** One project owns its next turn and each issue's permanent row. */
export const modelAbTest = restate.object({
  name: "ModelAbTest",
  handlers: {
    assign: restate.handlers.object.exclusive(
      { input: serde.zod(z.object({ issueId: z.string() })) },
      async (ctx: restate.ObjectContext, { issueId }: { issueId: string }): Promise<ModelAbTestRow> => {
        const issueKey = `issue:${issueId}`;
        const existing = await ctx.get<ModelAbTestRow>(issueKey);
        if (existing !== null) return existing;

        const turn = (await ctx.get<number>("turn")) ?? 0;
        const row = turn % 2 === 0 ? "first" : "second";
        ctx.set(issueKey, row);
        ctx.set("turn", turn + 1);
        return row;
      },
    ),
  },
});

export type ModelAbTestDefinition = typeof modelAbTest;

/** Waits for assignment; ingress failures and the 10 s call timeout propagate to the caller. */
export async function assignModelAbTestRow(
  projectKey: string,
  issueId: string,
  deps: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<ModelAbTestRow> {
  const ingress = restateClients.connect({
    url: deps.baseUrl ?? RESTATE_INGRESS_BASE_URL,
    ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}),
  });
  return ingress.objectClient<ModelAbTestDefinition>({ name: "ModelAbTest" }, projectKey)
    .assign({ issueId }, restateClients.rpc.opts({ timeout: 10_000 }));
}
