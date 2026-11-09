import { getDb } from "../dedup.js";

/** Private recovery data, never returned from a Restate effect. No launch credentials belong here. */
export function implementationIntentStore() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS implementation_launch_intent (
    dispatch_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, bookkeeping_done INTEGER NOT NULL DEFAULT 0
  )`);
  return {
    read<T>(dispatchId: string): { snapshot: T; done: boolean } | null {
      const row = db.prepare("SELECT snapshot, bookkeeping_done FROM implementation_launch_intent WHERE dispatch_id = ?").get(dispatchId) as { snapshot: string; bookkeeping_done: number } | undefined;
      return row ? { snapshot: JSON.parse(row.snapshot) as T, done: Boolean(row.bookkeeping_done) } : null;
    },
    write(dispatchId: string, snapshot: unknown) {
      db.prepare("INSERT OR IGNORE INTO implementation_launch_intent (dispatch_id, snapshot) VALUES (?, ?)").run(dispatchId, JSON.stringify(snapshot));
    },
    accept(dispatchId: string) {
      db.prepare("UPDATE implementation_launch_intent SET snapshot = json_set(snapshot, '$.accepted', json('true')) WHERE dispatch_id = ?").run(dispatchId);
    },
    complete(dispatchId: string) {
      db.prepare("UPDATE implementation_launch_intent SET bookkeeping_done = 1 WHERE dispatch_id = ?").run(dispatchId);
    },
    remove(dispatchId: string) {
      db.prepare("DELETE FROM implementation_launch_intent WHERE dispatch_id = ?").run(dispatchId);
    },
  };
}
