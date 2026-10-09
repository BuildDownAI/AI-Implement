// testDb creates every boot table through the real modules, whatever the test file mocks. vi.mock applies to a
// whole file, so these cases live apart from harnesses.test.ts.
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "./test-db.js";

// Spreads the real module: its functions keep the dedup.js instance loaded when the factory ran.
vi.mock("../../runner-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runner-mode.js")>()),
}));
// Replaces the module outright: it has no init function at all.
vi.mock("../../access-audit.js", () => ({}));

// Loaded at file load, as a static import in a test file would be, so the factory runs before any testDb call.
await import("../../runner-mode.js");

const tableNames = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);

describe("testDb with boot-table modules mocked", () => {
  it.each([1, 2])("creates their tables in test %i's own database", async () => {
    const { modules } = await testDb({ modules: { dedup: () => import("../../dedup.js") } });

    expect(tableNames(modules.dedup.getDb())).toEqual(expect.arrayContaining(["settings", "access_audit"]));
  });
});
