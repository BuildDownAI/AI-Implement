/**
 * The sign-in allowlist: who may authenticate, and as what.
 *
 * One row per entry — a whole email domain, or one address.
 * - A domain admits as`user`; only a listed address may carry `admin`
 * - `provider`/`subject` bind on first successful sign-in and match from then on, so a rename keeps its role
 * and a reassigned address inherits nothing.
 */

import { getDb } from "./dedup.js";

export type AccessEntryKind = "domain" | "address";
export type AccessRole = "user" | "admin";
export type RecheckResult =
  | { status: "ok"; entry: AccessEntry }
  | { status: "unavailable" }
  | { status: "denied" };

export interface EffectiveAllowlist {
  entries: AccessEntry[];
  source: "env" | "db";
}

export interface AccessEntry {
  kind: AccessEntryKind;
  value: string;
  role: AccessRole;
  provider: string | null;
  subject: string | null;
  addedAt: number;
  addedBy: string | null;
}

export interface AccessEntryInput {
  kind: AccessEntryKind;
  value: string;
  role: AccessRole;
}

interface AccessEntryRow {
  kind: string;
  value: string;
  role: string;
  provider: string | null;
  subject: string | null;
  added_at: number;
  added_by: string | null;
}

let cached: EffectiveAllowlist | null = null;

export function initAccessEntriesTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS access_entries (
      kind     TEXT NOT NULL,
      value    TEXT NOT NULL,
      role     TEXT NOT NULL,
      provider TEXT,
      subject  TEXT,
      added_at INTEGER NOT NULL,
      added_by TEXT,
      PRIMARY KEY (kind, value)
    )
  `);
}

/** Re-check a persisted identity against the list in force. */
export function recheckIdentity(identity: { provider: string; sub: string; email: string | null }): RecheckResult {
  const allowlist = getEffectiveAllowlist();
  if (!allowlist) return { status: "unavailable" };
  const entry = matchAccessEntry(identity, allowlist.entries);
  return entry ? { status: "ok", entry } : { status: "denied" };
}

/**
 * The entry admitting this identity, or null. Takes the three fields every identity shape
 * in the codebase carries, so a session row and an MCP token row both fit without adapting.
 */
export function matchAccessEntry(
  identity: { provider: string; sub: string; email: string | null },
  entries: AccessEntry[],
): AccessEntry | null {
  const email = (identity.email ?? "").trim().toLowerCase();
  const domain = email.split("@").pop() ?? "";

  // An address outranks a domain: it is the more specific grant and the only one carrying a role.
  for (const entry of entries) {
    if (entry.kind !== "address") continue;
    if (entry.provider && entry.subject) {
      // Bound entries match on the provider identity alone, so a reassigned address inherits nothing.
      if (entry.provider === identity.provider && entry.subject === identity.sub) return entry;
    } else if (entry.value === email) {
      return entry;
    }
  }

  // A malformed, @-less identifier has domain === email and must not match a domain entry.
  if (domain && domain !== email) {
    for (const entry of entries) {
      if (entry.kind === "domain" && entry.value === domain) return entry;
    }
  }
  return null;
}

/** The list in force. Null only when no list has ever loaded — callers must deny. */
export function getEffectiveAllowlist(): EffectiveAllowlist | null {
  if (!cached) refreshEffectiveAllowlist();
  return cached;
}

/** Re-read after a write, so a change applies without a restart. */
export function refreshEffectiveAllowlist(): void {
  try {
    const stored = listAccessEntries();
    cached = stored.length > 0
      ? { entries: stored, source: "db" }
      : { entries: allowlistFromEnv(process.env), source: "env" };
  } catch (err) {
    if (cached) {
      console.warn("[access] allowlist read failed; serving the last good list, will retry on the next request:", err);
    } else {
      console.error("[access] allowlist unreadable with none cached. admin and MCP denied, will retry on the next request:", err);
    }
  }
}

/** The env values, which apply until the first save hands authority to the stored list. */
function allowlistFromEnv(env: NodeJS.ProcessEnv): AccessEntry[] {
  const split = (raw: string | undefined) =>
    (raw || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  // addedAt 0: env entries are synthesized per read and carry no provenance.
  return [
    ...split(env.OAUTH_ALLOWED_DOMAINS).map((value): AccessEntry => ({
      kind: "domain", value, role: "user", provider: null, subject: null, addedAt: 0, addedBy: null,
    })),
    ...split(env.OAUTH_ALLOWED_EMAILS).map((value): AccessEntry => ({
      kind: "address", value, role: "admin", provider: null, subject: null, addedAt: 0, addedBy: null,
    })),
  ];
}

/** Every stored entry. Zero rows means the env->DB handover has not happened and the env list still applies. */
export function listAccessEntries(): AccessEntry[] {
  const rows = getDb()
    .prepare("SELECT kind, value, role, provider, subject, added_at, added_by FROM access_entries ORDER BY kind, value")
    .all() as AccessEntryRow[];
  // Both checks name the permissive value, so an unreadable row falls back to the restrictive one
  // ('domain' admits a whole company, 'address' admits one person)
  return rows.map((r) => ({
    kind: r.kind === "domain" ? "domain" : "address",
    value: r.value,
    role: r.role === "admin" ? "admin" : "user",
    provider: r.provider,
    subject: r.subject,
    addedAt: r.added_at,
    addedBy: r.added_by,
  }));
}

/** Replace the stored list. Surviving entries keep their binding and provenance. */
export function saveAccessEntries(next: AccessEntryInput[], actor: string | null): void {
  const normalized = next.map((e) => ({ ...e, value: e.value.trim().toLowerCase() }));

  for (const e of normalized) {
    if (!e.value) throw new Error("an access entry cannot be empty");
    if (e.kind === "domain" && e.role === "admin") {
      throw new Error("a domain entry cannot carry the admin role");
    }
  }

  const db = getDb();
  const now = Date.now();
  const keep = new Set(normalized.map((e) => `${e.kind}:${e.value}`));

  db.transaction(() => {
    for (const existing of listAccessEntries()) {
      if (!keep.has(`${existing.kind}:${existing.value}`)) {
        db.prepare("DELETE FROM access_entries WHERE kind = ? AND value = ?").run(existing.kind, existing.value);
      }
    }
    const upsert = db.prepare(
      `INSERT INTO access_entries (kind, value, role, provider, subject, added_at, added_by)
       VALUES (?, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(kind, value) DO UPDATE SET role = excluded.role`,
    );
    for (const e of normalized) upsert.run(e.kind, e.value, e.role, now, actor);
  })();
}

/** Record the provider identity an address resolved to, the first time it signs in. */
export function bindAccessEntry(value: string, provider: string, subject: string): void {
  getDb()
    .prepare(
      "UPDATE access_entries SET provider = ?, subject = ? WHERE kind = 'address' AND value = ? AND provider IS NULL",
    )
    .run(provider, subject, value.trim().toLowerCase());
}

/** Test hook: drop the cached list. */
export function __resetAllowlistCacheForTest(): void {
  cached = null;
}
