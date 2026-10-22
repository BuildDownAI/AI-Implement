/**
 * The sign-in allowlist: who may authenticate, and as what.
 *
 * One row per entry — a whole email domain, or one address.
 * - A domain admits as`user`; only a listed address may carry `admin`
 * - An address binds once per sign-in provider, on first successful sign-in through it (`access_entry_bindings`,
 * written by the `AccessBinding` Restate object). A bound provider matches on its subject alone, so a rename
 * keeps its role and a reassigned address inherits nothing; an unbound provider matches on the email.
 */

import { recordAccessChange, type AccessAuditAction } from "./access-audit.js";
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
  bindings: AccessBinding[];
  addedAt: number;
  addedBy: string | null;
}

export interface AccessBinding {
  provider: string;
  subject: string;
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
  added_at: number;
  added_by: string | null;
}

const MAX_ACCESS_ENTRIES = 200;
const ADDRESS_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_SHAPE = /^[^\s@.]+(\.[^\s@.]+)+$/;

let cached: EffectiveAllowlist | null = null;
let cachedAt = 0;

/**
 * How long a cached list serves before it is re-read: one poll interval, so a write from another
 * process — the recovery command — takes effect without a restart. Writes made in this process
 * refresh immediately, so removing someone still takes effect on their next request.
 *
 * Parsed strictly: a NaN would make every freshness comparison false and silently stop the re-read.
 */
const CONFIGURED_POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || "", 10);
const ALLOWLIST_TTL_MS =
  Number.isFinite(CONFIGURED_POLL_MS) && CONFIGURED_POLL_MS > 0 ? CONFIGURED_POLL_MS : 60_000;

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
  // No foreign key: access_entries is keyed (kind, value), and an env-seeded address has no row there.
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS access_entry_bindings (
      value    TEXT NOT NULL,
      provider TEXT NOT NULL,
      subject  TEXT NOT NULL,
      bound_at INTEGER NOT NULL,
      PRIMARY KEY (value, provider)
    )
  `);
  // The legacy columns stay for rollback but are read only here, once per entry.
  getDb().exec(`
    INSERT OR IGNORE INTO access_entry_bindings (value, provider, subject, bound_at)
    SELECT value, provider, subject, added_at FROM access_entries
    WHERE kind = 'address' AND provider IS NOT NULL AND subject IS NOT NULL
  `);
}

/** Re-check a persisted identity against the list in force. */
export function recheckIdentity(identity: MatchableIdentity): RecheckResult {
  const allowlist = getEffectiveAllowlist();
  if (!allowlist) return { status: "unavailable" };
  const entry = matchAccessEntry(identity, allowlist.entries);
  return entry ? { status: "ok", entry } : { status: "denied" };
}

/** True when the entry already holds this identity's binding, so a sign-in needs no write (and no Restate). */
export function isBoundTo(entry: AccessEntry, identity: { provider: string; sub: string }): boolean {
  return entry.bindings.some((b) => b.provider === identity.provider && b.subject === identity.sub);
}

/** The entry admitting this identity, or null. Entries arrive normalized; only the identity is folded here. */
export function matchAccessEntry(identity: MatchableIdentity, entries: AccessEntry[]): AccessEntry | null {
  const email = (identity.email ?? "").trim().toLowerCase();
  const domain = email.split("@").pop() ?? "";

  // An address outranks a domain: it is the more specific grant and the only one carrying a role.
  for (const entry of entries) {
    if (entry.kind !== "address") continue;
    const bound = entry.bindings.find((b) => b.provider === identity.provider);
    if (bound) {
      // A bound provider matches on its subject alone, so a reassigned address inherits nothing there.
      if (bound.subject === identity.sub) return entry;
    } else if (entry.value === email) {
      // Unbound for this provider: the caller binds it through AccessBinding.
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

/** The list in force admits people but nobody as admin: sign-in works, administering it does not. */
export function allowlistHasNoAdmin(): boolean {
  const list = getEffectiveAllowlist();
  if (!list) return false;
  // Checked, not assumed: only the env seed reaches this while the last-admin guard holds, which is
  // why callers name OAUTH_ALLOWED_EMAILS — reword them if a stored list ever can.
  return list.entries.length > 0 && !list.entries.some((e) => e.kind === "address" && e.role === "admin");
}

/** The list in force. Null only when no list has ever loaded — callers must deny. */
export function getEffectiveAllowlist(): EffectiveAllowlist | null {
  if (!cached || Date.now() - cachedAt >= ALLOWLIST_TTL_MS) refreshEffectiveAllowlist();
  return cached;
}

/** Re-read after a write, or once the cached list has aged out. */
export function refreshEffectiveAllowlist(): void {
  try {
    const stored = listAccessEntries();
    cached = stored.length > 0
      ? { entries: stored, source: "db" }
      : { entries: withBindings(allowlistFromEnv(process.env), loadBindings()), source: "env" };
    cachedAt = Date.now();
  } catch (err) {
    if (cached) {
      // Back off to one attempt per window: the last good list serves correctly meanwhile, and
      // retrying per request would warn on every one.
      cachedAt = Date.now();
      console.warn("[access] allowlist read failed; serving the last good list, will retry shortly:", err);
    } else {
      // cachedAt stays 0 so the next request retries — nothing is being served yet.
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
      kind: "domain", value, role: "user", bindings: [], addedAt: 0, addedBy: null,
    })),
    ...split(env.OAUTH_ALLOWED_EMAILS).map((value): AccessEntry => ({
      kind: "address", value, role: "admin", bindings: [], addedAt: 0, addedBy: null,
    })),
  ];
}

/** What the env supplies, whether or not it is still in force. The page shows it as stale after handover. */
export function getEnvAllowlist(): AccessEntry[] {
  return allowlistFromEnv(process.env);
}

function loadBindings(): Map<string, AccessBinding[]> {
  const rows = getDb()
    .prepare("SELECT value, provider, subject FROM access_entry_bindings ORDER BY provider")
    .all() as { value: string; provider: string; subject: string }[];
  const map = new Map<string, AccessBinding[]>();
  for (const r of rows) {
    const list = map.get(r.value) ?? [];
    list.push({ provider: r.provider, subject: r.subject });
    map.set(r.value, list);
  }
  return map;
}

function withBindings(entries: AccessEntry[], map: Map<string, AccessBinding[]>): AccessEntry[] {
  return entries.map((e) => (e.kind === "address" ? { ...e, bindings: map.get(e.value) ?? [] } : e));
}

/** Every stored entry. Zero rows means the env->DB handover has not happened and the env list still applies. */
export function listAccessEntries(): AccessEntry[] {
  const rows = getDb()
    .prepare("SELECT kind, value, role, added_at, added_by FROM access_entries ORDER BY kind, value")
    .all() as AccessEntryRow[];
  const bindings = loadBindings();
  // Both checks name the permissive value, so an unreadable row falls back to the restrictive one
  // ('domain' admits a whole company, 'address' admits one person)
  return rows.map((r) => ({
    kind: r.kind === "domain" ? "domain" : "address",
    value: r.value,
    role: r.role === "admin" ? "admin" : "user",
    bindings: r.kind === "domain" ? [] : bindings.get(r.value) ?? [],
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
  opts: { mustAdmit?: MatchableIdentity | null; action?: AccessAuditAction } = {},
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
        // A re-added address must start unbound, or it inherits the previous holder's subjects.
        if (entry.kind === "address") db.prepare("DELETE FROM access_entry_bindings WHERE value = ?").run(entry.value);
      }
    }
    const upsert = db.prepare(
      `INSERT INTO access_entries (kind, value, role, provider, subject, added_at, added_by)
       VALUES (?, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(kind, value) DO UPDATE SET role = excluded.role`,
    );
    for (const e of normalized) upsert.run(e.kind, e.value, e.role, now, actor);

    // Both guards read the real post-write result, and a throw rolls the whole save back.
    const after = listAccessEntries();
    if (opts.mustAdmit && !matchAccessEntry(opts.mustAdmit, after)) {
      throw new Error("this change would remove your own access");
    }
    // An empty list is not adminless — it hands authority back to the environment.
    if (after.length > 0 && !after.some((e) => e.kind === "address" && e.role === "admin")) {
      throw new Error("this change would leave nobody able to administer this orchestrator");
    }

    recordAccessChange({ actor, action: opts.action ?? "save", before, after: normalized });
  })();
  // After the transaction, never inside it — the lockout guard above rolls the save back by
  // throwing, and a refresh from within would cache what was rolled back.
  refreshEffectiveAllowlist();
}

/** Delete every binding of an address, so its next sign-in through each provider binds afresh. */
export function clearAccessBindings(value: string, actor: string | null): number {
  const key = value.trim().toLowerCase();
  const db = getDb();
  const removed = db.transaction(() => {
    const result = db.prepare("DELETE FROM access_entry_bindings WHERE value = ?").run(key);
    // The startup migration copies the legacy columns; null them so a cleared binding cannot return on restart.
    db.prepare("UPDATE access_entries SET provider = NULL, subject = NULL WHERE kind = 'address' AND value = ?").run(key);
    if (result.changes > 0) {
      const entries = listAccessEntries().map(({ kind, value: v, role }) => ({ kind, value: v, role }));
      recordAccessChange({ actor, action: "clear-bindings", before: entries, after: entries, address: key });
    }
    return result.changes;
  })();
  refreshEffectiveAllowlist();
  return removed;
}

/** Test hook: drop the cached list. */
export function __resetAllowlistCacheForTest(): void {
  cached = null;
  cachedAt = 0;
}
