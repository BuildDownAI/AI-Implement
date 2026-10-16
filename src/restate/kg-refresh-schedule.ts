/**
 * The `kg-refresh` pipeline on the `PipelineSchedule` kit (AII-1432, ADR 042). `busy` reads the
 * `KgRepo` lease and, for its holder, whether `KgRefresh` waits at the decision gate; `replace` ends a
 * run this schedule started that still waits there; `fire` is the same door `POST /api/kg/refresh`
 * uses (`trigger_kg_refresh` as the system caller), so the credential preflight is not copied.
 *
 * `busy` does not read the deploy hold: the tool answers 409 `deploy-in-progress`, which maps to a
 * `busy` fire answer and leaves the occurrence due. `KgRepo`, `KgRefresh` and `orchestratorTools` are
 * imported as types only, so this module adds no runtime import cycle.
 */
import type { ObjectContext } from "@restatedev/restate-sdk";
import { systemCaller } from "../mcp-identity.js";
import { KG_REFRESH_SUPERSEDED_REASON } from "./kg-refresh-workflow.js";
import type { KgRefreshDefinition, KgRepoDefinition } from "./kg-refresh-types.js";
import type { BusyRead, FireAnswer, ScheduledPipeline } from "./pipeline-schedule.js";
import type { orchestratorTools } from "./tools.js";

const KG_REFRESH: { name: "KgRefresh" } = { name: "KgRefresh" };
const KG_REPO: { name: "KgRepo" } = { name: "KgRepo" };
const ORCHESTRATOR_TOOLS: { name: "orchestratorTools" } = { name: "orchestratorTools" };

function refused(detail: string): FireAnswer {
  return { outcome: "refused", detail };
}

/** Maps the tool's `{ status, body }` text answer onto a `FireAnswer`. */
function mapToolAnswer(result: { content: Array<{ type: string; text: string }>; isError?: boolean }): FireAnswer {
  const text = result.content.map((c) => c.text).join("\n");
  if (result.isError) return refused(text || "trigger_kg_refresh returned an error");
  let parsed: { status?: unknown; body?: Record<string, unknown> };
  try {
    parsed = JSON.parse(result.content[0]?.text ?? "") as typeof parsed;
  } catch {
    return refused(`unparseable trigger_kg_refresh answer: ${text.slice(0, 200)}`);
  }
  const body = parsed.body ?? {};
  const error = typeof body.error === "string" ? body.error : undefined;
  if (parsed.status === 202 && typeof body.triggerId === "string") return { outcome: "started", runId: body.triggerId };
  if (parsed.status === 409 && (error === "deploy-in-progress" || error === "refresh-in-progress")) {
    return { outcome: "busy", detail: error };
  }
  const detail = typeof body.detail === "string" ? body.detail : undefined;
  return refused([`HTTP ${String(parsed.status)}`, error, detail].filter(Boolean).join(": "));
}

export function createKgRefreshSchedulePipeline(kgSourceRepo: string): ScheduledPipeline {
  return {
    async busy(ctx: ObjectContext): Promise<BusyRead> {
      const lease = await ctx.objectClient<KgRepoDefinition>(KG_REPO, kgSourceRepo).status();
      if (lease === null) return { busy: false };
      const holder = lease.triggerId;
      const run = await ctx.workflowClient<KgRefreshDefinition>(KG_REFRESH, holder).status();
      const awaitingDecision = run.step === "decision" && run.decisions.length > 0;
      return { busy: true, holder, awaitingDecision };
    },

    async replace(ctx: ObjectContext, runId: string): Promise<void> {
      // One-way: a 409 (the run finished meanwhile) or a second send must not fail the check.
      ctx.workflowSendClient<KgRefreshDefinition>(KG_REFRESH, runId).cancel({ reason: KG_REFRESH_SUPERSEDED_REASON });
    },

    async fire(ctx: ObjectContext): Promise<FireAnswer> {
      const result = await ctx
        .serviceClient<typeof orchestratorTools>(ORCHESTRATOR_TOOLS)
        .trigger_kg_refresh({ caller: systemCaller(), args: {} });
      return mapToolAnswer(result);
    },
  };
}
