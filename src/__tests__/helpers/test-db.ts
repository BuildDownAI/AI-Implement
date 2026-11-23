// A fresh database for each test (AII-925). dedup.ts reads DEDUP_DB_PATH once per module copy, at its
// first use, so a test gets its own database only by pointing the path elsewhere and then importing
// every database module again after a registry reset. testDb() does both, in that order, and
// cleans up when the test finishes. See README.md in this directory.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { onTestFinished, vi } from "vitest";
import type * as DedupModule from "../../dedup.js";
import { testDir } from "./test-dir.js";

/** The table-creating functions `main()` in src/index.ts calls at boot, in its order. `harnesses.test.ts`
 *  fails when the two lists differ. Each is called on the real module, never on a test's mock of it: a mock may
 *  lack the function, or carry a copy still bound to the database open when its factory ran. */
const BOOT_TABLE_INITS: ReadonlyArray<() => Promise<void>> = [
  async () => (await vi.importActual<typeof import("../../config.js")>("../../config.js")).initMappingsTable(),
  async () => (await vi.importActual<typeof import("../../log.js")>("../../log.js")).initLogTable(),
  async () => (await vi.importActual<typeof import("../../dispatch-breaker.js")>("../../dispatch-breaker.js")).initDispatchBreakerTable(),
  async () => (await vi.importActual<typeof import("../../runner-mode.js")>("../../runner-mode.js")).initSettingsTable(),
  async () => (await vi.importActual<typeof import("../../access-entries.js")>("../../access-entries.js")).initAccessEntriesTable(),
  async () => (await vi.importActual<typeof import("../../key-bindings.js")>("../../key-bindings.js")).initKeyBindingsTable(),
  async () => (await vi.importActual<typeof import("../../reconciliation.js")>("../../reconciliation.js")).initReconciliationTable(),
  async () => (await vi.importActual<typeof import("../../step-log.js")>("../../step-log.js")).initStepLogTable(),
  async () => (await vi.importActual<typeof import("../../mcp-oauth.js")>("../../mcp-oauth.js")).initMcpOAuthTables(),
  async () => (await vi.importActual<typeof import("../../access-audit.js")>("../../access-audit.js")).initAccessAuditTable(),
  async () => (await vi.importActual<typeof import("../../access-page-grants.js")>("../../access-page-grants.js")).initAccessPageGrantsTable(),
  async () => (await vi.importActual<typeof import("../../mcp-auth-events.js")>("../../mcp-auth-events.js")).initAuthEventsTable(),
  async () => (await vi.importActual<typeof import("../../review-fix-evidence.js")>("../../review-fix-evidence.js")).initReviewFixEvidenceTable(),
];

const TEMPLATE_KEY = Symbol.for("ai-implement.testDbSchemaTemplate");

async function getSchemaTemplate(): Promise<Buffer> {
  const store = globalThis as Record<symbol, Buffer | undefined>;
  const cached = store[TEMPLATE_KEY];
  if (cached) return cached;

  const dedupActual = await vi.importActual<typeof DedupModule>("../../dedup.js");
  const savedPath = process.env.DEDUP_DB_PATH;
  process.env.DEDUP_DB_PATH = ":memory:";
  try {
    dedupActual.setTestDb(null, ":memory:");
    const handle = dedupActual.getDb();
    for (const init of BOOT_TABLE_INITS) await init();
    const buf = handle.serialize();
    dedupActual.setTestDb(null);
    store[TEMPLATE_KEY] = buf;
    return buf;
  } finally {
    if (savedPath === undefined) delete process.env.DEDUP_DB_PATH;
    else process.env.DEDUP_DB_PATH = savedPath;
  }
}

type Loaders = Record<string, () => Promise<unknown>>;

/** Each loader's module, as its `import()` resolved. */
export type LoadedModules<L extends Loaders> = { [K in keyof L]: Awaited<ReturnType<L[K]>> };

export interface TestDbOptions<L extends Loaders> {
  /** Modules to import after the reset, keyed by the name the test uses for each. Write each
   *  loader as `() => import("../module.js")` in the test file, so the path resolves from there. */
  modules?: L;
  /** `"all"` (the default) creates every table boot creates. `"none"` leaves the file unopened,
   *  for a test of a missing table or of upgrading an older schema. */
  tables?: "all" | "none";
  /** `"disk"` (the default) creates a fresh SQLite file in a temp dir and resets the Vitest module
   *  registry. `"memory"` swaps a fresh `:memory:` clone of the boot schema into `dedup.ts` without
   *  calling `vi.resetModules()` or touching the filesystem, which is orders of magnitude faster
   *  for suites whose modules keep state in SQLite rather than module globals. */
  mode?: "disk" | "memory";
}

export interface TestDb<L extends Loaders> {
  /** The database file, or `":memory:"` when `mode: "memory"` is used. */
  path: string;
  /** The requested modules, imported after the reset (or from cache in `mode: "memory"`). */
  modules: LoadedModules<L>;
  /** A process restart against the same database: closes the handle, resets the registry, creates
   *  tables as the first call did, and returns freshly imported modules. */
  reopen(): Promise<LoadedModules<L>>;
}

/** Points the database at a fresh isolated SQLite instance and imports the requested modules.
 *  When the test finishes, the database is closed, `DEDUP_DB_PATH` restored, and any temp directory
 *  removed. Call it from a test or a `beforeEach`. */
export async function testDb<L extends Loaders = Record<never, never>>(
  options: TestDbOptions<L> = {},
): Promise<TestDb<L>> {
  const mode = options.mode ?? "disk";
  const path = mode === "memory" ? ":memory:" : join(testDir("db"), "dedup.sqlite");

  const previousPath = process.env.DEDUP_DB_PATH;
  onTestFinished(() => {
    if (previousPath === undefined) delete process.env.DEDUP_DB_PATH;
    else process.env.DEDUP_DB_PATH = previousPath;
  });
  process.env.DEDUP_DB_PATH = path;

  // Reassigned by reopen(), so the cleanup closes whichever instance is current when the test ends.
  let dedup: typeof DedupModule | undefined;
  onTestFinished(() => {
    if (mode === "memory") dedup?.setTestDb(null);
    else dedup?.closeDb();
  });

  async function importRequested(): Promise<LoadedModules<L>> {
    const loaded: Record<string, unknown> = {};
    for (const [name, loader] of Object.entries(options.modules ?? {})) loaded[name] = await loader();
    // Built key by key from L's own entries, so the mapped type describes it exactly.
    return loaded as LoadedModules<L>;
  }

  async function loadInitial(): Promise<LoadedModules<L>> {
    if (mode === "memory") {
      const template = options.tables === "none" ? null : await getSchemaTemplate();
      dedup = await import("../../dedup.js");
      if (template) {
        dedup.setTestDb(new Database(template), ":memory:");
      } else {
        dedup.setTestDb(null, ":memory:");
      }
      return importRequested();
    }

    vi.resetModules();
    if (options.tables !== "none") {
      const template = await getSchemaTemplate();
      writeFileSync(path, template);
      dedup = await import("../../dedup.js");
      const handle = new Database(path);
      handle.pragma("journal_mode = WAL");
      dedup.setTestDb(handle, path);
    } else {
      dedup = await import("../../dedup.js");
    }
    return importRequested();
  }

  async function loadReopen(): Promise<LoadedModules<L>> {
    if (mode === "memory") {
      const snapshot = dedup ? dedup.getDb().serialize() : null;
      dedup?.setTestDb(null);
      vi.resetModules();
      dedup = await import("../../dedup.js");
      if (snapshot) {
        dedup.setTestDb(new Database(snapshot), ":memory:");
      } else {
        dedup.setTestDb(null, ":memory:");
      }
      if (options.tables !== "none") for (const init of BOOT_TABLE_INITS) await init();
      return importRequested();
    }

    dedup?.closeDb();
    vi.resetModules();
    dedup = await import("../../dedup.js");
    if (options.tables !== "none") for (const init of BOOT_TABLE_INITS) await init();
    return importRequested();
  }

  return {
    path,
    modules: await loadInitial(),
    async reopen() {
      return loadReopen();
    },
  };
}
