/**
 * HTTP adapter for the model-auth handlers (AII-1387).
 *
 * Registers `MODEL_AUTH_ROUTES` on the orchestrator: a Node request goes in, a `ModelAuthRequest` goes to
 * `createModelAuthHandlers`, and its `ModelAuthResponse` is written back. Every method on a matching path is
 * routed to the handler, which answers 405 for non-POST; filtering by method here would turn that into a 404.
 *
 * Transport rule: on Fly the request must have come through Fly's proxy over https (`x-forwarded-proto`);
 * off Fly (local development) it is trusted. The grant bearer is the authentication.
 *
 * The three DB projections read through the shared `getDb` singleton. The log sink receives
 * `SafeModelAuthDiagnostic` only, so no bearer, token or session data reaches stdout.
 */
import type http from "node:http";
import { getDb } from "./dedup.js";
import {
  MODEL_AUTH_AUDIENCE,
  MODEL_AUTH_ROUTES,
  validateModelAuthGrantBinding,
  type ModelAuthBackend,
  type ModelAuthGrantBinding,
  type SafeModelAuthDiagnostic,
} from "./model-auth-contract.js";
import type { ModelAuthRuntime } from "./model-auth-runtime.js";
import {
  createModelAuthHandlers,
  type ModelAuthRequest,
  type PersistedDispatchContext,
  type PersistedModelAuthGrant,
  type SnapshotProfileSelection,
} from "./model-auth-server.js";
import { validateResolvedAgentSnapshot } from "./run-config.js";

const PATHS: ReadonlySet<string> = new Set(Object.values(MODEL_AUTH_ROUTES));

const BACKENDS: Readonly<Record<string, ModelAuthBackend>> = {
  "github-actions": "gha",
  "fly-machines": "fly",
  "local-docker": "local",
};

export interface ModelAuthRoutes {
  matches(path: string): boolean;
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
}

interface GrantRow {
  grant_id: string;
  dispatch_id: string;
  snapshot_id: string;
  project_key: string;
  backend: string;
  audience: string;
  bearer_hash: string;
  scope_json: string;
  expires_at: number;
  revoked_at: number | null;
}

function lookupGrant(bearerHash: string): PersistedModelAuthGrant | undefined {
  const row = getDb().prepare("SELECT * FROM model_credential_grants WHERE bearer_hash = ?").get(bearerHash) as
    | GrantRow
    | undefined;
  if (!row || row.audience !== MODEL_AUTH_AUDIENCE) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(row.scope_json);
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const bindings: ModelAuthGrantBinding[] = [];
  for (const item of raw) {
    const b = validateModelAuthGrantBinding(item);
    if (!b.ok) return undefined;
    bindings.push(b.value);
  }
  return {
    version: 1,
    audience: MODEL_AUTH_AUDIENCE,
    grantId: row.grant_id,
    dispatchId: row.dispatch_id,
    snapshotId: row.snapshot_id,
    projectKey: row.project_key,
    backend: row.backend as ModelAuthBackend,
    expiresAt: row.expires_at,
    bindings,
    bearerHash: row.bearer_hash,
    revokedAt: row.revoked_at,
  };
}

function loadDispatchContext(dispatchId: string): PersistedDispatchContext | undefined {
  const row = getDb()
    .prepare(
      `SELECT s.snapshot_id AS snapshot_id, s.project_key AS project_key, a.backend AS backend, a.released_at AS released_at
         FROM run_agent_config_snapshots s
         JOIN dispatch_admissions a ON a.dispatch_id = s.dispatch_id
        WHERE s.dispatch_id = ?`,
    )
    .get(dispatchId) as
    | { snapshot_id: string; project_key: string; backend: string; released_at: number | null }
    | undefined;
  if (!row || row.released_at !== null) return undefined;
  const backend = BACKENDS[row.backend];
  if (!backend) return undefined;
  return { dispatchId, snapshotId: row.snapshot_id, projectKey: row.project_key, backend };
}

function getSnapshotSelection(snapshotId: string, profileId: string): SnapshotProfileSelection | undefined {
  const row = getDb()
    .prepare(
      "SELECT resolved_config_json, source_map_json, config_revision_ids_json FROM run_agent_config_snapshots WHERE snapshot_id = ?",
    )
    .get(snapshotId) as
    | { resolved_config_json: string; source_map_json: string; config_revision_ids_json: string }
    | undefined;
  if (!row) return undefined;
  try {
    const resolved = JSON.parse(row.resolved_config_json) as { stages: unknown; profiles: unknown };
    // Same reconstruction as `snapshotFromRow` in agent-run-preparation.ts.
    const snapshot = validateResolvedAgentSnapshot({
      version: 1,
      snapshotId,
      configRevisions: JSON.parse(row.config_revision_ids_json),
      stages: resolved.stages,
      sources: JSON.parse(row.source_map_json),
      profiles: resolved.profiles,
    });
    const profile = Object.values(snapshot.profiles).find((p) => p.id === profileId);
    if (!profile) return undefined;
    return { provider: profile.provider, revision: profile.revision, authMode: profile.authMode };
  } catch {
    return undefined;
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function createModelAuthRoutes(input: {
  runtime: ModelAuthRuntime;
  onFly: boolean;
  requestPlanRefresh: (profileId: string) => Promise<void>;
  now?: () => number;
}): ModelAuthRoutes {
  const handlers = createModelAuthHandlers({
    isTrustedTransport: (request) => {
      if (!input.onFly) return true;
      const proto = (request.transport as { forwardedProto?: string } | undefined)?.forwardedProto;
      return typeof proto === "string" && proto.includes("https");
    },
    lookupGrant,
    loadDispatchContext,
    getSnapshotSelection,
    credentials: input.runtime.credentials,
    sessionStore: input.runtime.sessionStore,
    ownership: input.runtime.ownership,
    now: input.now ?? Date.now,
    requestPlanRefresh: input.requestPlanRefresh,
    log: (d: SafeModelAuthDiagnostic) => {
      console.log(
        `[model-auth] ${d.operation} ${d.profileId} ${d.status} ${d.category ?? "-"}`,
      );
    },
  });

  return {
    matches: (path) => PATHS.has(path),
    async handle(req, res) {
      const rawLength = singleHeader(req.headers["content-length"]);
      const parsedLength = rawLength !== undefined && /^\d+$/.test(rawLength) ? Number(rawLength) : undefined;
      const request: ModelAuthRequest = {
        method: req.method ?? "GET",
        path: (req.url ?? "/").split("?")[0]!,
        ...(req.headers.authorization !== undefined ? { authorization: req.headers.authorization } : {}),
        ...(parsedLength !== undefined ? { contentLength: parsedLength } : {}),
        body: req,
        transport: { forwardedProto: String(singleHeader(req.headers["x-forwarded-proto"]) ?? "") },
      };
      const response = await handlers.handle(request);
      res.writeHead(response.status, { ...response.headers });
      res.end(JSON.stringify(response.body));
    },
  };
}
