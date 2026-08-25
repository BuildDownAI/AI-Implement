/**
 * The sign-in allowlist: who may authenticate, and as what.
 *
 * One row per entry — a whole email domain, or one address.
 * - A domain admits as`user`; only a listed address may carry `admin`
 * - `provider`/`subject` bind on first successful sign-in and match from then on, so a rename keeps its role
 * and a reassigned address inherits nothing.
 */

import { recordAccessChange } from "./access-audit.js";
import { getDb } from "./dedup.js";

/**
 * The identity fields a decision needs. Deliberately not exported and deliberately not a fourth
 * identity type — VerifiedIdentity, SessionIdentity and McpTokenIdentity all satisfy it
 * structurally, and its `email: string | null` is wider than the two persisted shapes.
 */
type MatchableIdentity = { provider: string; sub: string; email: string | null };

export type AccessEntryKind = "domain" | "address";
export type AccessRole = "user" | "admin";
export type RecheckResult =
  | { status: "ok"; entry: AccessEntry }
  | { status: "unavailable" }
  | { status: "denied" };
type ParsedAccess =
  | { ok: true; entries: AccessEntryInput[] }
  | { ok: false; error: string };

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

const MAX_ACCESS_ENTRIES = 200;
const ADDRESS_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_SHAPE = /^[^\s@.]+(\.[^\s@.]+)+$/;

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
export function recheckIdentity(identity: MatchableIdentity): RecheckResult {
  const allowlist = getEffectiveAllowlist();
  if (!allowlist) return { status: "unavailable" };
  const entry = matchAccessEntry(identity, allowlist.entries);
  return entry ? { status: "ok", entry } : { status: "denied" };
}

/** The entry admitting this identity, or null. Entries arrive normalized; only the identity is folded here. */
export function matchAccessEntry(identity: MatchableIdentity, entries: AccessEntry[]): AccessEntry | null {
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

/** What the env supplies, whether or not it is still in force. The page shows it as stale after handover. */
export function getEnvAllowlist(): AccessEntry[] {
  return allowlistFromEnv(process.env);
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

export function parseAccessEntries(raw: unknown): ParsedAccess {
  if (!Array.isArray(raw)) return { ok: false, error: "entries must be an array" };
  if (raw.length > MAX_ACCESS_ENTRIES) {
    // The list is scanned on every authenticated request, so its length is bounded.
    return { ok: false, error: `at most ${MAX_ACCESS_ENTRIES} entries` };
  }

  const entries: AccessEntryInput[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return { ok: false, error: "each entry must be an object" };
    const { kind, value, role } = item as Record<string, unknown>;
    if (kind !== "domain" && kind !== "address") return { ok: false, error: "kind must be 'domain' or 'address'" };
    if (role !== "user" && role !== "admin") return { ok: false, error: "role must be 'user' or 'admin'" };
    if (typeof value !== "string" || !value.trim()) return { ok: false, error: "value must be a non-empty string" };

    const normalized = value.trim().toLowerCase();
    // A shape mismatch would save cleanly and then match nobody — an entry that looks right and is inert.
    if (kind === "address" && !ADDRESS_SHAPE.test(normalized)) {
      return { ok: false, error: `"${normalized}" is not an email address` };
    }
    if (kind === "domain" && !DOMAIN_SHAPE.test(normalized)) {
      return { ok: false, error: `"${normalized}" is not a domain` };
    }
    if (seen.has(`${kind}:${normalized}`)) return { ok: false, error: `"${normalized}" is listed twice` };

    seen.add(`${kind}:${normalized}`);
    entries.push({ kind, value: normalized, role });
  }
  return { ok: true, entries };
}

/** Replace the stored list. Surviving entries keep their binding and provenance. */
export function saveAccessEntries(
  next: AccessEntryInput[],
  actor: string | null,
  mustAdmit?: MatchableIdentity | null,
): void {
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
    const before = listAccessEntries();
    for (const entry of before) {
      if (!keep.has(`${entry.kind}:${entry.value}`)) {
        db.prepare("DELETE FROM access_entries WHERE kind = ? AND value = ?").run(entry.kind, entry.value);
      }
    }
    const upsert = db.prepare(
      `INSERT INTO access_entries (kind, value, role, provider, subject, added_at, added_by)
       VALUES (?, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(kind, value) DO UPDATE SET role = excluded.role`,
    );
    for (const e of normalized) upsert.run(e.kind, e.value, e.role, now, actor);

    // Evaluated against the real result, and a throw rolls the whole save back.
    if (mustAdmit && !matchAccessEntry(mustAdmit, listAccessEntries())) {
      throw new Error("this change would remove your own access");
    }
    recordAccessChange({ actor, action: "save", before, after: normalized });
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
