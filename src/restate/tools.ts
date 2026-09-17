// The tools service skeleton (AII-710): a tool() wrapper that attaches a zod input
// schema, the fixed ToolResponse output shape, and the "mcp.type"/"mcp.role" metadata
// Restate's admin API surfaces to src/restate/tools-client.ts's discoverTools(). The
// wrapper is the trust boundary — the role assertion runs inside it, before the handler
// body, so a caller that reaches a tool any other way (a raw ingress POST, not just
// tools/call on /mcp) is still checked (docs/mcp-server.md § "Reads are open" no longer
// depends solely on the /mcp adapter).
//
// get_tenant_health was the first migrated handler (AII-710) — moved verbatim from
// src/mcp.ts's callDiagnosticTool. AII-711 migrates the rest of the read surface,
// including the six kg_* tools (built on kg-provider.ts's non-streaming callKgTool
// rather than the HTTP-response-writing proxyCall), and deletes DIAG_TOOLS/
// callDiagnosticTool from src/mcp.ts entirely — every remaining handler here is a
// verbatim port of a former DIAG_TOOLS case body.
import * as restate from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import type { AccessRole } from "../access-entries.js";
import { getRunnerMode } from "../runner-mode.js";
import { getMappings } from "../config.js";
import { getInFlightJobs, getRunRecordMergeVerdict } from "../log.js";
import { getDb } from "../dedup.js";
import { isKgDegraded } from "../deploy-notify.js";
import { sidecarHealthFields, getKgMemoryProvider, KG_TOOL_CAPABILITY } from "../kg-provider.js";
import { readKgSourceRepo } from "../deploy.js";
import { runKgRefreshPreflight, getActiveKgRefresh } from "../kg-refresh.js";
import { getOrchestratorSettings } from "../orchestrator-settings.js";
import { getIssueReportCard, getFleetReport } from "../report-card.js";
import { getDeployPosture } from "../deploy-posture.js";

const CallerSchema = z.object({
  kind: z.enum(["human", "system"]),
  email: z.string().nullable(),
  role: z.enum(["user", "admin"]).nullable(),
});

const ToolResponse = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string() })),
  isError: z.boolean().optional(),
});

export type ToolResponse = z.infer<typeof ToolResponse>;

// admin is a strict superset of user (docs/access-model.md § Roles) — same rule as
// mcp.ts's roleAllows, kept local here so this module has no downward dependency on the
// transport layer.
const roleAllows = (have: AccessRole | null, need: AccessRole): boolean =>
  have === "admin" || have === need;

interface ToolOptions<I extends z.ZodType> {
  description: string;
  input: I;
  role: AccessRole;
}

function wireInputSchema<I extends z.ZodType>(input: I) {
  return z.object({ caller: CallerSchema, args: input });
}

/**
 * The wire shape a tool handler is invoked with — `{ caller, args }` — inferred straight
 * from `wireInputSchema` so it matches what `serde.zod` actually produces. `caller` is
 * structurally the `Caller` interface (src/mcp-identity.ts); it isn't spelled that way
 * because zod's generated type doesn't reduce to a plain object type that unifies with a
 * hand-written interface.
 */
export type WireInput<I extends z.ZodType> = z.infer<ReturnType<typeof wireInputSchema<I>>>;

/**
 * Wraps `restate.handlers.handler` with a zod input/output serde and the discovery
 * metadata (`mcp.type`, `mcp.role`) tools-client.ts's discoverTools() reads back. The
 * wire input is `{ caller, args }` — the credential never travels with the request
 * (the ingress journals bodies), only the already-verified `Caller`. A caller whose role
 * doesn't satisfy `role` (equal, or admin) is refused before `handler` runs. A handler
 * that throws is caught here and returned as an `isError` result rather than rethrown —
 * Restate retries a thrown non-terminal error indefinitely, which would turn a bug or a
 * transient failure into a hanging `tools/call` instead of the error result `/mcp` expects.
 * Restate's own suspension signal (thrown internally while an attempt awaits e.g.
 * `ctx.sleep()`/`ctx.call()`/`ctx.get()` across a not-yet-resolved journal entry, or a
 * dropped connection) is not a handler error — `restate.internal.isSuspendedError` detects
 * it and it is rethrown unconverted so the SDK can suspend and resume the invocation.
 */
export function tool<I extends z.ZodType>(
  opts: ToolOptions<I>,
  handler: (ctx: restate.Context, input: WireInput<I>) => Promise<ToolResponse>,
) {
  const wireInput = wireInputSchema(opts.input);
  return restate.handlers.handler(
    {
      description: opts.description,
      input: serde.zod(wireInput),
      output: serde.zod(ToolResponse),
      metadata: { "mcp.type": "tool", "mcp.role": opts.role },
    },
    async (ctx: restate.Context, input: WireInput<I>): Promise<ToolResponse> => {
      const name = ctx.request().target.handler;
      if (!roleAllows(input.caller.role, opts.role)) {
        return {
          isError: true,
          content: [{ type: "text", text: `forbidden: ${name} requires the ${opts.role} role` }],
        };
      }
      try {
        return await handler(ctx, input);
      } catch (err) {
        if (restate.internal.isSuspendedError(err)) {
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `${name} failed: ${message}` }],
        };
      }
    },
  );
}

export const GET_TENANT_HEALTH_DESCRIPTION =
  "Returns an orchestrator health summary: runner mode, in-flight job count, pending gap-fill queue count, project count, and (when a KG source repo is configured) a live credential preflight for the kg-refresh rail (`kgRefreshPreflight` with one row per repo and grant). Use as a first-pass check before digging deeper.";

export const getTenantHealth = tool(
  {
    description: GET_TENANT_HEALTH_DESCRIPTION,
    input: z.object({}),
    role: "user",
  },
  async (): Promise<ToolResponse> => {
    const { mode, source } = getRunnerMode();
    const inFlight = getInFlightJobs();
    const db = getDb();
    const { n: pendingGapfillCount } = db
      .prepare("SELECT COUNT(*) as n FROM comment_gapfill_queue WHERE status = 'pending'")
      .get() as { n: number };
    const projectCount = Object.keys(getMappings()).length;
    const kgSourceRepo = readKgSourceRepo(process.env.KG_SOURCE_REPO);
    const kgRefreshPreflight = kgSourceRepo
      ? await runKgRefreshPreflight({
          githubAppId: process.env.GITHUB_APP_ID ?? "",
          githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY ?? "",
          kgSourceRepo,
          kgBaseRepo: getOrchestratorSettings().kgBaseRepo,
        })
      : null;
    const result = {
      runnerMode: { mode, source },
      inFlightJobCount: inFlight.length,
      pendingGapfillCount,
      projectCount,
      kgDegraded: isKgDegraded(),
      ...sidecarHealthFields(),
      kgRefreshPreflight,
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

export const GET_RUNNER_MODE_DESCRIPTION =
  "Returns the current global runner mode (default/gha/fly/local/shadow) and whether it came from an env var, database setting, or built-in default.";

export const getRunnerModeTool = tool(
  { description: GET_RUNNER_MODE_DESCRIPTION, input: z.object({}), role: "user" },
  async (): Promise<ToolResponse> => {
    const { mode, source } = getRunnerMode();
    return { content: [{ type: "text", text: JSON.stringify({ mode, source }, null, 2) }] };
  },
);

export const LIST_PROJECTS_DESCRIPTION =
  "Lists all configured project mappings: team key, repo, execution mode, provider, paused state, and per-project capacity cap.";

export const listProjects = tool(
  { description: LIST_PROJECTS_DESCRIPTION, input: z.object({}), role: "user" },
  async (): Promise<ToolResponse> => {
    const mappings = getMappings();
    // Named fields only, deliberately excluding extraEnv — a mapping row carries runner
    // environment values that must never leak through a read tool. Project this list from
    // the Mapping type and the field list must be re-audited, not regenerated (AII-711).
    const result = Object.entries(mappings).map(([key, m]) => ({
      teamKey: key,
      repo: `${m.owner}/${m.repo}`,
      executionMode: m.executionMode,
      provider: m.provider,
      paused: m.paused,
      planningEnabled: m.planningEnabled,
      maxInProgressAiIssues: m.maxInProgressAiIssues,
      defaultBranch: m.defaultBranch,
      workflowFile: m.workflowFile,
      sessionMode: m.sessionMode,
      autoMerge: m.autoMerge,
      maxTurns: m.maxTurns,
      maxIterations: m.maxIterations,
      maxJobMinutes: m.maxJobMinutes,
      branchPrefix: m.branchPrefix,
      skillsRepo: m.skillsRepo,
      referenceRepos: m.referenceRepos,
      dependencyTokenScope: m.dependencyTokenScope,
      sensitiveAddPatterns: m.sensitiveAddPatterns,
      sensitiveAllowPatterns: m.sensitiveAllowPatterns,
      machineCpus: m.machineCpus,
      machineMemoryMb: m.machineMemoryMb,
      awsRegion: m.awsRegion,
      planningWorkflowFile: m.planningWorkflowFile,
      autoApprovePlans: m.autoApprovePlans,
      reviewers: m.reviewers,
    }));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

export const LIST_IN_FLIGHT_JOBS_DESCRIPTION =
  "Lists all currently dispatching or running jobs with their issue identifier, repo, phase, and elapsed seconds since dispatch.";

export const listInFlightJobs = tool(
  { description: LIST_IN_FLIGHT_JOBS_DESCRIPTION, input: z.object({}), role: "user" },
  async (): Promise<ToolResponse> => {
    const now = Date.now();
    const result = getInFlightJobs().map((j) => ({
      id: j.id,
      issueIdentifier: j.issueIdentifier,
      issueTitle: j.issueTitle,
      repo: j.repo,
      phase: j.phase,
      status: j.status,
      dispatchedAt: j.dispatchedAt,
      elapsedSeconds: Math.round((now - j.dispatchedAt) / 1000),
    }));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

export const GET_ISSUE_DISPATCH_STATUS_DESCRIPTION =
  "Returns the dispatch status for a specific issue identifier (e.g. 'AII-123'): in-flight flag, dedup-window flag, and the last five dispatch log entries. Use this to diagnose why a ticket is not being picked up.";

export const getIssueDispatchStatus = tool(
  {
    description: GET_ISSUE_DISPATCH_STATUS_DESCRIPTION,
    input: z.object({ identifier: z.string().optional() }),
    role: "user",
  },
  async (_ctx, input): Promise<ToolResponse> => {
    const identifier = input.args.identifier;
    if (typeof identifier !== "string" || !identifier) {
      const result = { error: "identifier is required and must be a non-empty string" };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    const db = getDb();
    const recentRows = db
      .prepare(
        "SELECT id, status, dispatched_at, repo, phase, pr_url, conclusion FROM dispatch_log WHERE issue_identifier = ? ORDER BY dispatched_at DESC LIMIT 5",
      )
      .all(identifier) as Array<{
        id: number;
        status: string | null;
        dispatched_at: number;
        repo: string | null;
        phase: string | null;
        pr_url: string | null;
        conclusion: string | null;
      }>;
    const dedupRow = db
      .prepare("SELECT issue_id, dispatched_at FROM dispatched WHERE issue_identifier = ?")
      .get(identifier) as { issue_id: string; dispatched_at: number } | undefined;
    const inFlight = recentRows.some((j) => j.status === "dispatched" || j.status === "running");
    const latestPrUrl = recentRows.find((j) => j.pr_url)?.pr_url ?? null;
    const mergeVerdict = latestPrUrl
      ? { verdict: getRunRecordMergeVerdict(identifier, latestPrUrl), prUrl: latestPrUrl }
      : null;
    const result = {
      identifier,
      inFlight,
      inDedupWindow: !!dedupRow,
      dedupEntry: dedupRow ?? null,
      mergeVerdict,
      recentDispatches: recentRows.map((j) => ({
        id: j.id,
        status: j.status,
        dispatchedAt: j.dispatched_at,
        repo: j.repo,
        phase: j.phase,
        prUrl: j.pr_url,
        conclusion: j.conclusion,
      })),
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

export const GET_ISSUE_REPORT_CARD_DESCRIPTION =
  "Returns a full report card for a specific issue: all dispatch runs with per-pass telemetry, totals (dispatches, passes, cost), approval/merge/escape status, gap-fill rounds, and review-fix rounds. Use this to understand the full history and outcome of an issue.";

export const getIssueReportCardTool = tool(
  {
    description: GET_ISSUE_REPORT_CARD_DESCRIPTION,
    input: z.object({ issue: z.string().optional() }),
    role: "user",
  },
  async (_ctx, input): Promise<ToolResponse> => {
    const issue = input.args.issue;
    if (typeof issue !== "string" || !issue) {
      const result = { error: "issue is required and must be a non-empty string" };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    const card = getIssueReportCard(issue);
    const result = card ?? { error: `No dispatch records found for issue: ${issue}` };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

export const GET_FLEET_REPORT_DESCRIPTION =
  "Returns an aggregated fleet report: per-repo job/issue/cost/pass counts, one-shot and eventual approval rates, planning A/B cohort comparison, review escape rate, and a ranked list of runaway issues. Optional `days` parameter (default 30) controls the look-back window.";

export const getFleetReportTool = tool(
  {
    description: GET_FLEET_REPORT_DESCRIPTION,
    input: z.object({ days: z.number().optional() }),
    role: "user",
  },
  async (_ctx, input): Promise<ToolResponse> => {
    const days = typeof input.args.days === "number" ? input.args.days : undefined;
    const result = getFleetReport({ days });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

export const GET_DEPLOY_POSTURE_DESCRIPTION =
  "Returns the current deploy posture: whether autoDeploy is on, the watched repo/branch, running vs head commit, deploy hold and in-flight state, runner channel image and commit, and a mergeCost field summarising the landing cost of a merge (deploy+image / image / none). Use this before filing or merging to understand the blast radius.";

export const getDeployPostureTool = tool(
  { description: GET_DEPLOY_POSTURE_DESCRIPTION, input: z.object({}), role: "user" },
  async (): Promise<ToolResponse> => {
    // No defaultImage passed: getDeployPosture's own fallback re-derives it from
    // process.env the same way config.sessionImage was computed at boot (AII-711) — a
    // Restate handler has no per-request injection the way handleMcpRequest did.
    const result = await getDeployPosture({});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

export const GET_KG_STATUS_DESCRIPTION =
  "Returns the KG refresh rail state: stage (idle | staging | ingest-running | serving | reverted | failed), the served snapshot stamp, the materialize path the next refresh will stage (rdflib | direct), and the last refresh outcome with its gate. Poll it after `POST /api/kg/refresh`.";

export const getKgStatusTool = tool(
  { description: GET_KG_STATUS_DESCRIPTION, input: z.object({}), role: "user" },
  async (): Promise<ToolResponse> => {
    const handle = getActiveKgRefresh();
    const result = handle ? await handle.status() : { error: "KG refresh is not configured" };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

const KG_TOOL_DESCRIPTIONS: Record<string, string> = {
  kg_hybrid_search: "Hybrid (lexical + vector) search over the knowledge graph. Falls back to lexical-only when embeddings are degraded (see get_tenant_health's kgDegraded).",
  kg_search: "Lexical search over the knowledge graph.",
  kg_semantic_search: "Vector similarity search over the knowledge graph.",
  kg_neighbors: "Returns the immediate neighbors of a graph node by IRI.",
  kg_path: "Returns a path between two graph nodes by IRI.",
  kg_provenance: "Returns the provenance (source commit/file) of a graph node by IRI.",
};

/**
 * Builds one Restate handler per `kg_*` tool name. Each forwards its raw `args` to
 * `SidecarMemoryProvider.callKgTool` (src/kg-provider.ts) — the non-streaming counterpart
 * to the HTTP-response-writing `proxyCall` src/mcp.ts used before AII-711 — after the same
 * `KG_TOOL_CAPABILITY` gate `/mcp` used to run itself. Absent a configured provider or an
 * unsupported capability, the handler answers `isError` with the same wording `/mcp` always
 * has, rather than the JSON-RPC `-32601` envelope that wording used to travel in: a Restate
 * tool's response is always `{ content, isError }` (the `tool()` wrapper's fixed contract),
 * never a top-level JSON-RPC `error`.
 */
function kgTool(name: string) {
  return tool(
    { description: KG_TOOL_DESCRIPTIONS[name] ?? name, input: z.record(z.string(), z.unknown()), role: "user" },
    async (_ctx, input): Promise<ToolResponse> => {
      const provider = getKgMemoryProvider();
      if (!provider) {
        return { isError: true, content: [{ type: "text", text: "no memory provider is configured" }] };
      }
      const capKey = KG_TOOL_CAPABILITY[name];
      if (capKey !== undefined && !provider.capabilities[capKey]) {
        return { isError: true, content: [{ type: "text", text: `Tool not supported by this memory provider: ${name}` }] };
      }
      const outcome = await provider.callKgTool(name, input.args);
      if (!outcome.ok) {
        return { isError: true, content: [{ type: "text", text: outcome.error }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(outcome.result, null, 2) }] };
    },
  );
}

export const kgHybridSearch = kgTool("kg_hybrid_search");
export const kgSearch = kgTool("kg_search");
export const kgSemanticSearch = kgTool("kg_semantic_search");
export const kgNeighbors = kgTool("kg_neighbors");
export const kgPath = kgTool("kg_path");
export const kgProvenance = kgTool("kg_provenance");

export const orchestratorTools = restate.service({
  name: "orchestratorTools",
  handlers: {
    get_tenant_health: getTenantHealth,
    get_runner_mode: getRunnerModeTool,
    list_projects: listProjects,
    list_in_flight_jobs: listInFlightJobs,
    get_issue_dispatch_status: getIssueDispatchStatus,
    get_issue_report_card: getIssueReportCardTool,
    get_fleet_report: getFleetReportTool,
    get_deploy_posture: getDeployPostureTool,
    get_kg_status: getKgStatusTool,
    kg_hybrid_search: kgHybridSearch,
    kg_search: kgSearch,
    kg_semantic_search: kgSemanticSearch,
    kg_neighbors: kgNeighbors,
    kg_path: kgPath,
    kg_provenance: kgProvenance,
  },
});
