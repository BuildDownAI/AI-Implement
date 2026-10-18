/**
 * `TrackerExport` (AII-1462, ADR 043): one Restate service call reads one page of a team's issues from
 * its tracker. The provider method runs inside `ctx.run` with a bounded retry policy; the handler stamps
 * `sourceSystem` and `team` on every record, so a provider cannot forget them.
 *
 * Shape follows `LateExternalReview` (`late-external-review.ts`): injected dependencies, a production
 * factory, and a typed ingress client that never throws. Not an MCP tool; registered at boot and called by the two KG tracker-data routes.
 */
import * as restate from "@restatedev/restate-sdk";
import * as restateClients from "@restatedev/restate-sdk-clients";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import { getMappings, type RepoMapping } from "../config.js";
import { providerConfigFromEnv, ProviderRegistry } from "../providers/index.js";
import { TrackerUnavailableError, type TicketingProvider, type TrackerIssuePage } from "../providers/types.js";
import type { RestateService } from "./endpoint.js";
import { RESTATE_INGRESS_BASE_URL } from "./server.js";

/** The handler input. A credential never belongs here: Restate journals inputs. */
export const trackerExportInputSchema = z.object({
  team: z.string().min(1),
  cursor: z.string().nullable(),
}).strict();

export type TrackerExportInput = z.infer<typeof trackerExportInputSchema>;

export type TrackerExportErrorCode = "tracker-unavailable" | "tracker-failed";

/** `TerminalError.code` is the HTTP status; the string code travels as the message prefix. */
const ERROR_STATUS: Record<TrackerExportErrorCode, number> = { "tracker-unavailable": 503, "tracker-failed": 502 };

function terminal(code: TrackerExportErrorCode, detail: string): restate.TerminalError {
  return new restate.TerminalError(`${code}: ${detail}`, { errorCode: ERROR_STATUS[code] });
}

/** The page read: 5 attempts, 1 s to 10 s between them. */
export const TRACKER_EXPORT_RETRY_POLICY = {
  maxRetryAttempts: 5,
  initialRetryInterval: { seconds: 1 },
  maxRetryInterval: { seconds: 10 },
} as const;

export interface TrackerExportDependencies {
  /** The mapping keyed by `team`, or `undefined` when there is none. */
  getMapping(team: string): RepoMapping | undefined;
  /** May throw (an unconfigured provider); the handler answers `tracker-unavailable`. */
  providerFor(mapping: RepoMapping): Promise<TicketingProvider> | TicketingProvider;
  /** Test seam; production leaves it unset. */
  retryPolicy?: typeof TRACKER_EXPORT_RETRY_POLICY | { maxRetryAttempts: number; initialRetryInterval: { milliseconds: number }; maxRetryInterval: { milliseconds: number } };
}

export function createTrackerExport(deps: TrackerExportDependencies) {
  const retryPolicy = deps.retryPolicy ?? TRACKER_EXPORT_RETRY_POLICY;

  async function page(ctx: restate.Context, input: TrackerExportInput): Promise<TrackerIssuePage> {
    const mapping = deps.getMapping(input.team);
    if (!mapping) throw terminal("tracker-unavailable", `no mapping for team ${input.team}`);
    let provider: TicketingProvider;
    try {
      provider = await deps.providerFor(mapping);
    } catch (err) {
      throw terminal("tracker-unavailable", `no provider for team ${input.team}: ${(err as Error).message}`);
    }
    const listIssuesPage = provider.listIssuesPage?.bind(provider);
    if (!listIssuesPage) throw terminal("tracker-unavailable", `provider ${provider.id} cannot list issues`);

    let result: TrackerIssuePage;
    try {
      result = await ctx.run("page", async () => {
        try {
          return await listIssuesPage({ ...mapping, teamKey: input.team }, input.cursor);
        } catch (err) {
          // A missing credential is not retried: it would only delay the hold.
          if (err instanceof TrackerUnavailableError) throw terminal("tracker-unavailable", err.message);
          throw err;
        }
      }, retryPolicy);
    } catch (err) {
      if (!(err instanceof restate.TerminalError)) throw err;
      if (err.code === ERROR_STATUS["tracker-unavailable"]) throw err;
      throw terminal("tracker-failed", err.message);
    }

    // One place for these two fields keeps every provider identical.
    const issues = result.issues.map((issue) => ({ ...issue, sourceSystem: provider.id, team: input.team }));
    ctx.console.log(`[TrackerExport] team ${input.team} (${provider.id}): ${issues.length} issues`);
    return { issues, pageInfo: result.pageInfo };
  }

  return restate.service({
    name: "TrackerExport",
    handlers: {
      page: restate.handlers.handler({ input: serde.zod(trackerExportInputSchema) }, page),
    },
  });
}

export type TrackerExportDefinition = ReturnType<typeof createTrackerExport>;

/** Production deps: the real mappings and `ProviderRegistry`. Credentials are read by the provider at call time, never journaled. */
export function createProductionTrackerExportServices(): { services: RestateService[] } {
  const registry = new ProviderRegistry(providerConfigFromEnv(), () => getMappings());
  return {
    services: [createTrackerExport({
      getMapping: (team) => getMappings()[team],
      providerFor: (mapping) => registry.forMapping(mapping),
    })],
  };
}

export type TrackerExportResult =
  | { ok: true; page: TrackerIssuePage }
  | { ok: false; code: TrackerExportErrorCode | "unavailable" };

export interface TrackerExportIngressClient {
  page(input: TrackerExportInput): Promise<TrackerExportResult>;
}

/** Longer than the retry window (5 attempts, up to 10 s apart, each read bounded by the provider's own fetch timeout). */
const INGRESS_TIMEOUT_MS = 120_000;

/** Never throws: a terminal answer maps to its code; a connection error, timeout or anything else resolves `unavailable`. */
export function createTrackerExportIngressClient(
  baseUrl: string = RESTATE_INGRESS_BASE_URL,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): TrackerExportIngressClient {
  const ingress = restateClients.connect({ url: baseUrl, ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}) });
  const timeout = opts.timeoutMs ?? INGRESS_TIMEOUT_MS;
  return {
    async page(input) {
      try {
        const page = await ingress
          .serviceClient<TrackerExportDefinition>({ name: "TrackerExport" })
          .page(input, restateClients.rpc.opts({ timeout }));
        return { ok: true, page };
      } catch (err) {
        if (err instanceof restateClients.HttpCallError) {
          const text = err.responseText || err.message;
          if (text.includes("tracker-unavailable")) return { ok: false, code: "tracker-unavailable" };
          if (text.includes("tracker-failed")) return { ok: false, code: "tracker-failed" };
        }
        return { ok: false, code: "unavailable" };
      }
    },
  };
}
