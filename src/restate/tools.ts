// The tools service skeleton (AII-710): a tool() wrapper that attaches a zod input
// schema, the fixed ToolResponse output shape, and the "mcp.type"/"mcp.role" metadata
// Restate's admin API surfaces to src/restate/tools-client.ts's discoverTools(). The
// wrapper is the trust boundary — the role assertion runs inside it, before the handler
// body, so a caller that reaches a tool any other way (a raw ingress POST, not just
// tools/call on /mcp) is still checked (docs/mcp-server.md § "Identity: kind, role and
// the caller" — the check no longer depends solely on the /mcp adapter).
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
import { getMappings, type RepoMapping } from "../config.js";
import { getInFlightJobs, getRunRecordMergeVerdict } from "../log.js";
import { getDb } from "../dedup.js";
import { isKgDegraded } from "../deploy-notify.js";
import { sidecarHealthFields, getKgMemoryProvider, KG_TOOL_CAPABILITY } from "../kg-provider.js";
import { readKgSourceRepo } from "../deploy.js";
import { runKgRefreshPreflight, getActiveKgRefresh } from "../kg-refresh.js";
import { getOrchestratorSettings, getLinearPickupLabel } from "../orchestrator-settings.js";
import { getIssueReportCard, getFleetReport } from "../report-card.js";
import { getDeployPosture } from "../deploy-posture.js";
import {
  setRunnerModeAction,
  pauseProjectAction,
  upsertMappingAction,
  triggerWorkflowSyncAction,
  clearDedupEntryAction,
  type AdminConfig,
  type UpsertMappingBody,
} from "../admin.js";
import { providerConfigFromEnv, ProviderRegistry } from "../providers/index.js";

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
  /**
   * Only a write (`role: "admin"`) handler sets this — `{ maxAttempts: 1, onMaxAttempts: "kill" }`
   * (AII-717, ADR 025 amendment). An attempt that dies with the orchestrator process is killed
   * rather than re-delivered, so a crash can never cause Restate to run the handler body a
   * second time. Paired with `ctx.run` around the handler's own side effect (docs/restate.md
   * § "Every side effect in a handler goes inside `ctx.run`, and a tool handler never retries").
   */
  retryPolicy?: restate.RetryPolicy;
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
 *
 * A `role: "admin"` tool is a declared write (ADR 015): every call to one, allowed or
 * refused, is logged here — inside the wrapper, not the `/mcp` adapter — so a call that
 * reaches a handler through `POST /api/tools/<name>` or `callToolAsSystem` (AII-712),
 * which never passes through the adapter, is still audited. `WRITE_TOOLS` in `src/mcp.ts`
 * used to be the only place this line was written (AII-713 retired it).
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
      retryPolicy: opts.retryPolicy,
    },
    async (ctx: restate.Context, input: WireInput<I>): Promise<ToolResponse> => {
      const name = ctx.request().target.handler;
      const audit = (result: "forbidden" | "ok" | "error"): void => {
        if (opts.role !== "admin") return;
        const actor = input.caller.email ?? "system";
        console.log(
          `[mcp] write tool=${name} actor=${actor} role=${input.caller.role ?? "null"} result=${result} kind=${input.caller.kind}`,
        );
      };
      if (!roleAllows(input.caller.role, opts.role)) {
        audit("forbidden");
        return {
          isError: true,
          content: [{ type: "text", text: `forbidden: ${name} requires the ${opts.role} role` }],
        };
      }
      try {
        const result = await handler(ctx, input);
        audit(result.isError ? "error" : "ok");
        return result;
      } catch (err) {
        if (restate.internal.isSuspendedError(err)) {
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        audit("error");
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

export const GET_PROJECT_BINDING_DESCRIPTION =
  "Returns the binding a skill needs for its own project: team key, repo, default branch, tracker kind, the effective pickup label (the live ADR 022 settings value, not a hardcoded default), and the knowledge-graph binding (present, orchestratorUrl, sourceRepo, baseRepo, searchTool). Pass `repo` (owner/repo) or `team` to select one project, returned as a single object; omit both to list every mapping as an array. Never includes extraEnv or a token.";

export const getProjectBinding = tool(
  {
    description: GET_PROJECT_BINDING_DESCRIPTION,
    input: z.object({
      repo: z.string().optional().describe("owner/repo of the target repo, e.g. \"BuildDownAI/skills\""),
      team: z.string().optional().describe("Team key of the mapping"),
    }),
    role: "user",
  },
  async (_ctx, input): Promise<ToolResponse> => {
    const mappings = getMappings();
    // kg.* reflects orchestrator-wide config, not the mapping — the KG is one graph, not
    // per-project, so every result shares the same kg object regardless of which project
    // (or how many) matched.
    const kgSourceRepo = readKgSourceRepo(process.env.KG_SOURCE_REPO);
    const kg = {
      present: kgSourceRepo !== null,
      orchestratorUrl: process.env.RUNNER_CALLBACK_BASE_URL || null,
      sourceRepo: kgSourceRepo,
      baseRepo: getOrchestratorSettings().kgBaseRepo,
      searchTool: "kg_hybrid_search" as const,
    };
    // Read fresh on every call (no caching, per ADR 022 / getLinearPickupLabel) so a
    // settings-page change takes effect on the next call with no restart. The setting is
    // a Linear-only row: a Jira or filesystem tracker's pickup signal is its own
    // `AI-Implement-Status` field, so a non-Linear mapping gets null rather than a value
    // that doesn't apply to it.
    const binding = (key: string, m: RepoMapping) => ({
      team: key,
      repo: `${m.owner}/${m.repo}`,
      defaultBranch: m.defaultBranch,
      tracker: { kind: m.ticketingConfig.kind, team: key },
      pickupLabel: m.ticketingConfig.kind === "linear" ? getLinearPickupLabel() : null,
      kg,
    });

    const repo = input.args.repo;
    if (typeof repo === "string" && repo) {
      const match = Object.entries(mappings).find(([, m]) => `${m.owner}/${m.repo}` === repo);
      if (!match) {
        return { isError: true, content: [{ type: "text", text: `No project mapping found for repo: ${repo}` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(binding(match[0], match[1]), null, 2) }] };
    }
    const team = input.args.team;
    if (typeof team === "string" && team) {
      const match = Object.entries(mappings).find(([key]) => key === team);
      if (!match) {
        return { isError: true, content: [{ type: "text", text: `No project mapping found for team: ${team}` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(binding(match[0], match[1]), null, 2) }] };
    }
    const result = Object.entries(mappings).map(([key, m]) => binding(key, m));
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

// ---- Writes (AII-713): moved verbatim off WRITE_TOOLS in src/mcp.ts. Each admin action
// call, its args validation, and its status-to-text mapping are unchanged — only the caller
// (this handler, reached via /mcp, POST /api/tools/<name>, or callToolAsSystem) and the
// audit line (now in tool()'s wrapper, above) moved. `docs/adr/015-...md` amendment.

/**
 * The `AdminConfig` subset the five non-kg-refresh writes need, re-derived from process.env
 * on every call rather than injected — the same "no per-request injection" tradeoff
 * getDeployPostureTool and getTenantHealth already make (both comment on it above). This is
 * deliberately *not* the orchestrator's own `loadConfig()` (src/index.ts): that function logs
 * boot warnings and configures OAuth/Linear auth as a side effect and must run exactly once.
 */
function mcpAdminConfig(): AdminConfig {
  return {
    adminAccessCode: process.env.ADMIN_ACCESS_CODE || null,
    flySessionsToken: process.env.FLY_SESSIONS_TOKEN || null,
    flySessionsApp: process.env.FLY_SESSIONS_APP || getOrchestratorSettings().flySessionsApp,
    flySessionsRegion: process.env.FLY_SESSIONS_REGION || getOrchestratorSettings().flySessionsRegion,
    githubAppId: process.env.GITHUB_APP_ID ?? "",
    githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY ?? "",
    notifyWebhookUrl: process.env.NOTIFY_WEBHOOK_URL || null,
    kgSourceRepo: readKgSourceRepo(process.env.KG_SOURCE_REPO),
  };
}

// One registry for add_project's upsertMappingAction call, built the same way the orchestrator's
// own boot-time registry is (src/index.ts) — env config plus a live getMappings() closure — and
// kept as a module singleton so its per-provider caching (src/providers/registry.ts) isn't
// discarded between calls.
let sharedProviderRegistry: ProviderRegistry | null = null;

/**
 * Set once at boot (src/index.ts's main()) to the same `ProviderRegistry` the poll loop, the
 * reconciler and the admin HTTP routes share, so `add_project` over MCP invalidates the
 * registry the orchestrator actually reads — the "same as POST /api/mappings" claim in the
 * tool's description holds only when it is the same instance. Restate handlers have no
 * per-request injection, hence the setter (same pattern as setKgMemoryProvider). A process
 * that never calls it (tests, a boot that failed before the registry existed) falls back to a
 * local instance so the handler still answers.
 */
export function setProviderRegistry(registry: ProviderRegistry | null): void {
  sharedProviderRegistry = registry;
}

function providerRegistryForTools(): ProviderRegistry {
  return sharedProviderRegistry ?? new ProviderRegistry(providerConfigFromEnv(), () => getMappings());
}

export const TRIGGER_KG_REFRESH_DESCRIPTION =
  "Trigger the KG refresh rail (admin role). Same handler as POST /api/kg/refresh: runs the credential preflight, then dispatches the refresh. Poll get_kg_status afterwards. dryRun=true runs the same runner job with kg-snapshot-push's push skipped — all guards run and the guard verdict plus per-part table are reported via get_kg_status, but nothing is pushed, no PR opens, and the served graph never changes. acceptNewBaseline=true downgrades the zero-shrink and 50%-shrink content guards to warnings for this one dispatch and pushes anyway — use only after reviewing a guard refusal's part table and confirming the shrink is an intentional reclassification, not data loss; the accepting identity's email is logged and written into the refresh PR's ### Baseline section.";

export const triggerKgRefreshTool = tool(
  {
    description: TRIGGER_KG_REFRESH_DESCRIPTION,
    input: z.object({
      dryRun: z.boolean().optional().describe(
        "Run the rail without pushing the snapshot or touching the served graph; reports the guard table via get_kg_status.",
      ),
      acceptNewBaseline: z.boolean().optional().describe(
        "Push even though a tracked part (issue.nt/comment.nt) shrank or a part dropped below 50% of its previous size — a one-shot override of the zero-shrink guard, applied to this dispatch only.",
      ),
    }),
    role: "admin",
    retryPolicy: { maxAttempts: 1, onMaxAttempts: "kill" },
  },
  async (ctx, input): Promise<ToolResponse> => {
    const handle = getActiveKgRefresh();
    if (!handle) {
      throw new Error("KG refresh is not configured");
    }
    const dryRun = input.args.dryRun === true;
    const acceptNewBaseline = input.args.acceptNewBaseline === true;
    const actorEmail = input.caller.email ?? undefined;
    const result = await ctx.run(
      "kg-refresh-trigger",
      () => handle.trigger({ dryRun, acceptNewBaseline, actorEmail }),
      { maxRetryAttempts: 1 },
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

export const SET_RUNNER_MODE_DESCRIPTION =
  "Set the global runner mode (admin role). Same handler as POST /api/runner-mode: forces all new dispatches onto the given execution path.";

export const setRunnerModeTool = tool(
  {
    description: SET_RUNNER_MODE_DESCRIPTION,
    input: z.object({
      mode: z.string().optional().describe(
        "Global runner mode: default restores per-project modes, gha/fly force that execution path, shadow dispatches to both without acting on either result, local runs dispatches in local Docker (a developer-machine mode the admin UI does not offer). Validated by the same check as POST /api/runner-mode.",
      ),
    }),
    role: "admin",
    retryPolicy: { maxAttempts: 1, onMaxAttempts: "kill" },
  },
  async (ctx, input): Promise<ToolResponse> => {
    if (typeof input.args.mode !== "string") {
      return { content: [{ type: "text", text: JSON.stringify({ status: 400, body: { error: "mode is required" } }, null, 2) }] };
    }
    // The mode set is not repeated here: setRunnerModeAction validates with isRunnerMode, the
    // same check POST /api/runner-mode runs, so the tool answers what the route answers.
    const config = mcpAdminConfig();
    const mode = input.args.mode;
    const result = await ctx.run("set-runner-mode", () => setRunnerModeAction(config, { mode }), { maxRetryAttempts: 1 });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

export const PAUSE_PROJECT_DESCRIPTION =
  "Pause or resume a project mapping (admin role). Same as the paused update of PATCH /api/mappings/<teamKey>.";

export const pauseProjectTool = tool(
  {
    description: PAUSE_PROJECT_DESCRIPTION,
    input: z.object({
      teamKey: z.string().optional().describe("Team key of the mapping"),
      paused: z.boolean().optional().describe("Whether dispatch for this project should be paused"),
    }),
    role: "admin",
    retryPolicy: { maxAttempts: 1, onMaxAttempts: "kill" },
  },
  async (ctx, input): Promise<ToolResponse> => {
    if (typeof input.args.teamKey !== "string" || !input.args.teamKey) {
      return { content: [{ type: "text", text: JSON.stringify({ status: 400, body: { error: "teamKey is required" } }, null, 2) }] };
    }
    if (typeof input.args.paused !== "boolean") {
      return { content: [{ type: "text", text: JSON.stringify({ status: 400, body: { error: "paused is required" } }, null, 2) }] };
    }
    const teamKey = input.args.teamKey;
    const paused = input.args.paused;
    const result = await ctx.run("pause-project", () => pauseProjectAction(teamKey, paused), { maxRetryAttempts: 1 });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

export const ADD_PROJECT_DESCRIPTION =
  "Create or update a project mapping (admin role). Same as POST /api/mappings, the mapping upsert behind the admin UI's New project stepper.";

/**
 * Exported so the unit tier can `safeParse` the documented "pass null to reset" contract
 * without going through the Restate ingress (AII-720). The nullable fields here must match
 * `upsertMappingAction`'s null-accepting set exactly (src/admin.ts) — reviewers and the three
 * caps, branchPrefix, skillsRepo, dependencyTokenScope, and the two sensitive-glob fields.
 */
export const addProjectArgsSchema = z.object({
  teamKey: z.string().optional().describe("Team key, e.g. the Linear team key or Jira project key"),
  owner: z.string().optional().describe("GitHub repo owner/org"),
  repo: z.string().optional().describe("GitHub repo name"),
  defaultBranch: z.string().optional().describe("Base branch PRs are opened against"),
  workflowFile: z.string().optional(),
  maxInProgressAiIssues: z.number().optional(),
  executionMode: z.enum(["github-actions", "fly-machines"]).optional(),
  sessionMode: z.enum(["autonomous", "interactive", "hybrid"]).optional(),
  machineCpus: z.number().optional(),
  machineMemoryMb: z.number().optional(),
  planningEnabled: z.boolean().optional(),
  planningWorkflowFile: z.string().optional(),
  autoApprovePlans: z.boolean().optional(),
  autoMerge: z.boolean().optional(),
  extraEnv: z.record(z.string(), z.string()).optional().describe("Passed through to the model process; visible to the agent"),
  provider: z.enum(["anthropic", "bedrock"]).optional(),
  awsRegion: z.string().optional().describe("Required when provider is 'bedrock'"),
  ticketingProvider: z.string().optional(),
  ticketingConfig: z.record(z.string(), z.unknown()).optional(),
  paused: z.boolean().optional(),
  maxTurns: z.number().nullable().optional(),
  maxIterations: z.number().nullable().optional(),
  maxJobMinutes: z.number().nullable().optional(),
  branchPrefix: z.string().nullable().optional(),
  skillsRepo: z.string().nullable().optional(),
  referenceRepos: z.array(z.unknown()).optional(),
  sensitiveAddPatterns: z.union([z.string(), z.array(z.string())]).nullable().optional().describe("String or array of glob strings; pass null to reset to the default (none)"),
  sensitiveAllowPatterns: z.union([z.string(), z.array(z.string())]).nullable().optional().describe("String or array of glob strings; pass null to reset to the default (none)"),
  dependencyTokenScope: z.enum(["installation"]).nullable().optional(),
  reviewers: z.array(z.object({
    id: z.string(),
    gates: z.boolean(),
    maxTurns: z.number().int().min(1).max(200).optional().describe(
      "Optional per-reviewer turn cap. Omit to inherit the reviewer default or global limit.",
    ),
  })).nullable().optional().describe(
    "Which reviewers run on this project's PRs. Omit to keep the stored value; pass null to reset to the default (gap-analysis and code-review, both gating).",
  ),
});

export const addProjectTool = tool(
  {
    description: ADD_PROJECT_DESCRIPTION,
    input: addProjectArgsSchema,
    role: "admin",
    retryPolicy: { maxAttempts: 1, onMaxAttempts: "kill" },
  },
  async (ctx, input): Promise<ToolResponse> => {
    // teamKey/owner/repo/defaultBranch are validated by upsertMappingAction itself (the same
    // 400 text) — no separate pre-check here, unlike the other four writes, whose actions
    // don't validate their own required fields.
    const args = input.args as UpsertMappingBody;
    const config = mcpAdminConfig();
    const registry = providerRegistryForTools();
    const result = await ctx.run("upsert-mapping", () => upsertMappingAction(args, config, registry), { maxRetryAttempts: 1 });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

export const TRIGGER_WORKFLOW_SYNC_DESCRIPTION =
  "Trigger a workflow-template sync for a project (admin role). Same as POST /api/mappings/<teamKey>/sync-workflows.";

export const triggerWorkflowSyncTool = tool(
  {
    description: TRIGGER_WORKFLOW_SYNC_DESCRIPTION,
    input: z.object({
      teamKey: z.string().optional().describe("Team key of the mapping"),
    }),
    role: "admin",
    retryPolicy: { maxAttempts: 1, onMaxAttempts: "kill" },
  },
  async (ctx, input): Promise<ToolResponse> => {
    if (typeof input.args.teamKey !== "string" || !input.args.teamKey) {
      return { content: [{ type: "text", text: JSON.stringify({ status: 400, body: { error: "teamKey is required" } }, null, 2) }] };
    }
    const config = mcpAdminConfig();
    const teamKey = input.args.teamKey;
    const result = await ctx.run("trigger-workflow-sync", () => triggerWorkflowSyncAction(config, teamKey), { maxRetryAttempts: 1 });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

export const CLEAR_DISPATCH_DEDUP_DESCRIPTION =
  "Clear a dedup entry so the issue can be re-dispatched (admin role). Same as DELETE /api/dedup/<issueId>.";

export const clearDispatchDedupTool = tool(
  {
    description: CLEAR_DISPATCH_DEDUP_DESCRIPTION,
    input: z.object({
      issueId: z.string().optional().describe("The tracker issue id (not the human identifier) of the dedup entry"),
    }),
    role: "admin",
    retryPolicy: { maxAttempts: 1, onMaxAttempts: "kill" },
  },
  async (ctx, input): Promise<ToolResponse> => {
    if (typeof input.args.issueId !== "string" || !input.args.issueId) {
      return { content: [{ type: "text", text: JSON.stringify({ status: 400, body: { error: "issueId is required" } }, null, 2) }] };
    }
    const issueId = input.args.issueId;
    const result = await ctx.run("clear-dedup-entry", () => clearDedupEntryAction(issueId), { maxRetryAttempts: 1 });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

export const orchestratorTools = restate.service({
  name: "orchestratorTools",
  handlers: {
    get_tenant_health: getTenantHealth,
    get_runner_mode: getRunnerModeTool,
    list_projects: listProjects,
    get_project_binding: getProjectBinding,
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
    trigger_kg_refresh: triggerKgRefreshTool,
    set_runner_mode: setRunnerModeTool,
    pause_project: pauseProjectTool,
    add_project: addProjectTool,
    trigger_workflow_sync: triggerWorkflowSyncTool,
    clear_dispatch_dedup: clearDispatchDedupTool,
  },
});
