/**
 * Which admin pages a `user` may see.
 * Admins are unconditional, so a row here only ever widens what a non-admin reaches.
 * Nothing is granted by default.
 */

import { getDb } from "./dedup.js";

export interface PageGrant {
  page: string;
  grantedAt: number;
  grantedBy: string | null;
}

interface PageGrantRow {
  page: string;
  granted_at: number;
  granted_by: string | null;
}

/**
 * Which paths each grantable page may read. A path absent from every entry is Admin-only, so an
 * endpoint added later is closed until someone lists it here.
 */
export const PAGE_ROUTES: Record<string, readonly string[]> = {
  issues: ["/api/issues"],
  jobs: ["/api/log"],
  pulls: ["/api/pulls"],
  blockers: ["/api/blockers"],
  reports: ["/api/report"],
  pipelines: ["/api/pipelines-steps"],
  sessions: ["/api/sessions"],
  reaper: ["/api/reaper/recent", "/api/reaper/summary"],
  audit: ["/api/dedup"],
  customizations: ["/api/customizations"],
};

export function initAccessPageGrantsTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS access_page_grants (
      page       TEXT PRIMARY KEY,
      granted_at INTEGER NOT NULL,
      granted_by TEXT
    )
  `);
}

/** Every granted page, with its provenance. */
export function listPageGrants(): PageGrant[] {
  const rows = getDb()
    .prepare("SELECT page, granted_at, granted_by FROM access_page_grants ORDER BY page")
    .all() as PageGrantRow[];
  return rows.map((r) => ({ page: r.page, grantedAt: r.granted_at, grantedBy: r.granted_by }));
}

/** The granted page keys alone — what a session needs to know. */
export function listGrantedPages(): string[] {
  return listPageGrants().map((g) => g.page);
}

/** Replace the grant set. Callers validate the keys; this stores what it is given. */
export function savePageGrants(pages: string[], actor: string | null): void {
  const db = getDb();
  const now = Date.now();
  const keep = new Set(pages);

  db.transaction(() => {
    for (const existing of listPageGrants()) {
      if (!keep.has(existing.page)) {
        db.prepare("DELETE FROM access_page_grants WHERE page = ?").run(existing.page);
      }
    }
    // Provenance survives a re-save, so a page granted once keeps who granted it and when.
    const insert = db.prepare(
      "INSERT INTO access_page_grants (page, granted_at, granted_by) VALUES (?, ?, ?) ON CONFLICT(page) DO NOTHING",
    );
    for (const page of keep) insert.run(page, now, actor);
  })();
}
