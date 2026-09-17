// The tools service skeleton (AII-710): a tool() wrapper that attaches a zod input
// schema, the fixed ToolResponse output shape, and the "mcp.type"/"mcp.role" metadata
// Restate's admin API surfaces to src/restate/tools-client.ts's discoverTools(). The
// wrapper is the trust boundary — the role assertion runs inside it, before the handler
// body, so a caller that reaches a tool any other way (a raw ingress POST, not just
// tools/call on /mcp) is still checked (docs/mcp-server.md § "Reads are open" no longer
// depends solely on the /mcp adapter).
//
// get_tenant_health is the first (and, for this issue, only) migrated handler — moved
// verbatim from src/mcp.ts's callDiagnosticTool. The read/write migration children that
// follow add more handlers to `orchestratorTools` and remove the corresponding
// DIAG_TOOLS/WRITE_TOOLS entry in src/mcp.ts.
import * as restate from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import type { AccessRole } from "../access-entries.js";
import { getRunnerMode } from "../runner-mode.js";
import { getMappings } from "../config.js";
import { getInFlightJobs } from "../log.js";
import { getDb } from "../dedup.js";
import { isKgDegraded } from "../deploy-notify.js";
import { sidecarHealthFields } from "../kg-provider.js";
import { readKgSourceRepo } from "../deploy.js";
import { runKgRefreshPreflight } from "../kg-refresh.js";
import { getOrchestratorSettings } from "../orchestrator-settings.js";

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
 * doesn't satisfy `role` (equal, or admin) is refused before `handler` runs.
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
      if (!roleAllows(input.caller.role, opts.role)) {
        const name = ctx.request().target.handler;
        return {
          isError: true,
          content: [{ type: "text", text: `forbidden: ${name} requires the ${opts.role} role` }],
        };
      }
      return handler(ctx, input);
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

export const orchestratorTools = restate.service({
  name: "orchestratorTools",
  handlers: {
    get_tenant_health: getTenantHealth,
  },
});
