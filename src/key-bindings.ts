/** Shared schema and synchronous reads. KeyBinding is the only production row writer. */
import { getDb } from "./dedup.js";

export function initKeyBindingsTable(): void {
  getDb().exec(`CREATE TABLE IF NOT EXISTS key_bindings (
    key_ref TEXT PRIMARY KEY, destination TEXT NOT NULL, bound_at INTEGER NOT NULL
  )`);
  getDb().exec(`CREATE TABLE IF NOT EXISTS key_binding_operations (
    operation_id TEXT PRIMARY KEY, key_ref TEXT NOT NULL
  )`);
}

export function readKeyBinding(keyRef: string): { destination: string; bound_at: number } | undefined {
  return getDb().prepare("SELECT destination, bound_at FROM key_bindings WHERE key_ref = ?").get(keyRef) as
    { destination: string; bound_at: number } | undefined;
}

