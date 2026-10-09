// A fresh database for each test (AII-925). dedup.ts reads DEDUP_DB_PATH once, when it is first
// imported, so a test gets its own database only by pointing the path elsewhere and then importing
// every database module again after a registry reset. testDb() does both, in that order, and
// cleans up when the test finishes. See docs/unit-tests.md § Harnesses.
import { join } from "node:path";
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
  async () => (await vi.importActual<typeof import("../../reconciliation.js")>("../../reconciliation.js")).initReconciliationTable(),
  async () => (await vi.importActual<typeof import("../../step-log.js")>("../../step-log.js")).initStepLogTable(),
  async () => (await vi.importActual<typeof import("../../mcp-oauth.js")>("../../mcp-oauth.js")).initMcpOAuthTables(),
  async () => (await vi.importActual<typeof import("../../access-audit.js")>("../../access-audit.js")).initAccessAuditTable(),
  async () => (await vi.importActual<typeof import("../../access-page-grants.js")>("../../access-page-grants.js")).initAccessPageGrantsTable(),
  async () => (await vi.importActual<typeof import("../../mcp-auth-events.js")>("../../mcp-auth-events.js")).initAuthEventsTable(),
  async () => (await vi.importActual<typeof import("../../review-fix-evidence.js")>("../../review-fix-evidence.js")).initReviewFixEvidenceTable(),
];

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
}

export interface TestDb<L extends Loaders> {
  /** The database file. Nothing exists at this path until a module opens it. */
  path: string;
  /** The requested modules, imported after the reset, so each reads this database. */
  modules: LoadedModules<L>;
  /** A process restart against the same file: closes the database, resets the registry, creates
   *  tables as the first call did, and returns freshly imported modules. */
  reopen(): Promise<LoadedModules<L>>;
}

/** Points the database at a new file in a temporary directory, resets the module registry, and
 *  imports the requested modules. When the test finishes, the database is closed, the previous
 *  `DEDUP_DB_PATH` restored, and the directory removed. Call it from a test or a `beforeEach`. */
export async function testDb<L extends Loaders = Record<never, never>>(
  options: TestDbOptions<L> = {},
): Promise<TestDb<L>> {
  // Cleanups run last-registered first: close the database, restore the path, then remove the directory.
  const path = join(testDir("db"), "dedup.sqlite");

  const previousPath = process.env.DEDUP_DB_PATH;
  onTestFinished(() => {
    if (previousPath === undefined) delete process.env.DEDUP_DB_PATH;
    else process.env.DEDUP_DB_PATH = previousPath;
  });
  process.env.DEDUP_DB_PATH = path;

  // Reassigned by reopen(), so the cleanup closes whichever instance is current when the test ends.
  let dedup: typeof DedupModule | undefined;
  onTestFinished(() => dedup?.closeDb());

  async function load(): Promise<LoadedModules<L>> {
    vi.resetModules();
    dedup = await import("../../dedup.js");
    if (options.tables !== "none") for (const init of BOOT_TABLE_INITS) await init();
    const loaded: Record<string, unknown> = {};
    for (const [name, loader] of Object.entries(options.modules ?? {})) loaded[name] = await loader();
    // Built key by key from L's own entries, so the mapped type describes it exactly.
    return loaded as LoadedModules<L>;
  }

  return {
    path,
    modules: await load(),
    async reopen() {
      dedup?.closeDb();
      return load();
    },
  };
}
