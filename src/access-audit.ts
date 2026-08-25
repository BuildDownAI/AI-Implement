/**
 * A record of every change to who may sign in.
 * Append-only: it says what the list was, what it became, and who did it — 
 * never why, and never anything the allowlist decides.
 */

import { getDb } from "./dedup.js";
import type { AccessEntryInput } from "./access-entries.js";

/** How the change was made. An access-code save and a host recovery both have no attributable person. */
export type AccessAuditAction = "save" | "recover";

export interface AccessChange {
  id: number;
  createdAt: number;
  actor: string | null;
  action: AccessAuditAction;
  before: AccessEntryInput[];
  after: AccessEntryInput[];
}

interface AccessChangeRow {
  id: number;
  created_at: number;
  actor: string | null;
  action: string;
  before_json: string;
  after_json: string;
}

/** An audit snapshot is what an operator edited — never the binding or provenance they didn't. */
const snapshot = (entries: AccessEntryInput[]): AccessEntryInput[] =>
  entries.map(({ kind, value, role }) => ({ kind, value, role }));

export function initAccessAuditTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_audit (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  INTEGER NOT NULL,
      actor       TEXT,
      action      TEXT NOT NULL,
      before_json TEXT NOT NULL,
      after_json  TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_access_audit_created_at ON access_audit(created_at)");
}

export function recordAccessChange(change: Omit<AccessChange, "id" | "createdAt">): void {
  getDb()
    .prepare("INSERT INTO access_audit (created_at, actor, action, before_json, after_json) VALUES (?, ?, ?, ?, ?)")
    .run(
      Date.now(),
      change.actor,
      change.action,
      JSON.stringify(snapshot(change.before)),
      JSON.stringify(snapshot(change.after)),
    );
}

export function listAccessChanges(limit = 20): AccessChange[] {
  const rows = getDb()
    .prepare(
      "SELECT id, created_at, actor, action, before_json, after_json FROM access_audit ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .all(limit) as AccessChangeRow[];
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    actor: r.actor,
    action: r.action === "recover" ? "recover" : "save",
    before: parseSnapshot(r.before_json),
    after: parseSnapshot(r.after_json),
  }));
}

function parseSnapshot(raw: string): AccessEntryInput[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AccessEntryInput[]) : [];
  } catch {
    // A row we cannot read is still evidence a change happened — keep it, show it empty.
    return [];
  }
}
