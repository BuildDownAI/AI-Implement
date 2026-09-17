/**
 * One structured event for every MCP 401 and every refresh grant call.
 *
 * Mirrors src/access-audit.ts: an init function plus record/list/summarize, all
 * going through getDb() from src/dedup.ts. Deliberately excludes the token, the
 * refresh token, and the code — this table lives on the same volume as the
 * SQLite tokens, and carrying one would double the blast radius of a leak.
 */

import { isIP } from "node:net";
import { getDb } from "./dedup.js";
import type { IdentityKind } from "./mcp-identity.js";

export type AuthEventKind = "401" | "refresh";

export type AuthEventCause =
  | "expired"
  | "invalid"
  | "revoked"
  | "allowlist"
  | "replay"
  | "ok"
  | "unavailable";

export type ClientPath = "loopback" | "https" | "unknown";

export interface AuthEvent {
  at: number;
  kind: AuthEventKind;
  cause: AuthEventCause;
  clientId: string | null;
  clientPath: ClientPath;
  identityKind: IdentityKind | null;
  email: string | null;
  familyId: string | null;
  latencyMs: number;
}

interface AuthEventRow {
  id: number;
  at: number;
  kind: string;
  cause: string;
  client_id: string | null;
  client_path: string;
  identity_kind: string | null;
  email: string | null;
  family_id: string | null;
  latency_ms: number;
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function initAuthEventsTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_auth_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      at            INTEGER NOT NULL,
      kind          TEXT NOT NULL,
      cause         TEXT NOT NULL,
      client_id     TEXT,
      client_path   TEXT NOT NULL,
      identity_kind TEXT,
      email         TEXT,
      family_id     TEXT,
      latency_ms    INTEGER NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_mcp_auth_events_at ON mcp_auth_events(at)");
}

/** Writes the console line, the row, and prunes rows older than 30 days — every call, not just some. */
export function recordAuthEvent(event: AuthEvent): void {
  const db = getDb();
  console.log(
    `[mcp-auth] kind=${event.kind} cause=${event.cause} clientId=${event.clientId ?? "unknown"} ` +
      `clientPath=${event.clientPath} identityKind=${event.identityKind ?? "unknown"} ` +
      `email=${event.email ?? "unknown"} familyId=${event.familyId ?? "none"} latencyMs=${event.latencyMs}`,
  );
  db.prepare(
    `INSERT INTO mcp_auth_events
      (at, kind, cause, client_id, client_path, identity_kind, email, family_id, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.at,
    event.kind,
    event.cause,
    event.clientId,
    event.clientPath,
    event.identityKind,
    event.email,
    event.familyId,
    event.latencyMs,
  );
  db.prepare("DELETE FROM mcp_auth_events WHERE at < ?").run(Date.now() - RETENTION_MS);
}

export interface ListAuthEventsOptions {
  since?: number;
  limit?: number;
}

export function listAuthEvents(options: ListAuthEventsOptions = {}): AuthEvent[] {
  const { since, limit = 100 } = options;
  const db = getDb();
  const rows = (
    since !== undefined
      ? db
          .prepare(
            "SELECT * FROM mcp_auth_events WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?",
          )
          .all(since, limit)
      : db.prepare("SELECT * FROM mcp_auth_events ORDER BY at DESC, id DESC LIMIT ?").all(limit)
  ) as AuthEventRow[];
  return rows.map(rowToEvent);
}

export interface AuthEventSummary {
  totalEvents: number;
  byCause: Record<string, number>;
  byClientPath: Record<string, number>;
}

export function summarizeAuthEvents(since: number): AuthEventSummary {
  const rows = getDb()
    .prepare("SELECT cause, client_path FROM mcp_auth_events WHERE at >= ?")
    .all(since) as Array<{ cause: string; client_path: string }>;

  const byCause: Record<string, number> = {};
  const byClientPath: Record<string, number> = {};
  for (const row of rows) {
    byCause[row.cause] = (byCause[row.cause] ?? 0) + 1;
    byClientPath[row.client_path] = (byClientPath[row.client_path] ?? 0) + 1;
  }
  return { totalEvents: rows.length, byCause, byClientPath };
}

/** Loopback IP literal or `localhost` — the client-path split used by `resolveClientPath` and mcp-oauth.ts's redirect-uri check. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost") {
    return true;
  }
  const ipVersion = isIP(host);
  return ipVersion === 6 ? host === "::1" : ipVersion === 4 && host.startsWith("127.");
}

/**
 * Which client path a registered client belongs to, for the auth-event `clientPath` field:
 * a loopback IP literal (or `localhost`) redirect means the Claude Code loopback flow,
 * anything else means an HTTPS-registered client (e.g. claude.ai). `null`/unregistered
 * resolves to `"unknown"` rather than guessing — a forged token traces to no client at all.
 */
export function resolveClientPath(clientId: string | null | undefined): ClientPath {
  if (!clientId) return "unknown";
  const row = getDb()
    .prepare("SELECT redirect_uris FROM mcp_clients WHERE client_id = ?")
    .get(clientId) as { redirect_uris: string } | undefined;
  if (!row) return "unknown";
  let uris: unknown;
  try {
    uris = JSON.parse(row.redirect_uris);
  } catch {
    return "unknown";
  }
  const first = Array.isArray(uris) ? uris[0] : undefined;
  if (typeof first !== "string") return "unknown";
  try {
    return isLoopbackHost(new URL(first).hostname) ? "loopback" : "https";
  } catch {
    return "unknown";
  }
}

function rowToEvent(row: AuthEventRow): AuthEvent {
  return {
    at: row.at,
    kind: row.kind === "refresh" ? "refresh" : "401",
    cause: row.cause as AuthEventCause,
    clientId: row.client_id,
    clientPath: row.client_path as ClientPath,
    identityKind: row.identity_kind === "human" || row.identity_kind === "system" ? row.identity_kind : null,
    email: row.email,
    familyId: row.family_id,
    latencyMs: row.latency_ms,
  };
}
