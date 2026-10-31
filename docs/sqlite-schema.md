# SQLite schema changes

The orchestrator changes its SQLite database at boot. There is no migration tool and no
version table. Each boot runs idempotent statements that bring any older database up to date.
This page explains how that works, what the accounting parts (AII-1561) added, what a
rollback leaves behind, and the rule for a column that a trigger names.

For the `dispatched` table, see [dispatch-dedup.md](dispatch-dedup.md).

## 1. How the schema changes at boot

Each table has an init step that runs at boot. Two of them hold most of the schema:

- `getDb()` (`src/dedup.ts`) opens the one database handle and creates most tables,
  indexes and triggers.
- `initLogTable()` (`src/log.ts`) creates `dispatch_log`. Then it runs `ensureLogColumns()`
  and `ensureAccountingTriggers()`, in that order.

Other modules own their tables and run their own `CREATE TABLE IF NOT EXISTS` and
`ALTER TABLE` statements from an init function that `main()` in `src/index.ts` calls at boot:
`initMappingsTable()`, `initDispatchBreakerTable()`, `initSettingsTable()`,
`initAccessEntriesTable()` (`src/access-entries.ts`), `initReconciliationTable()`,
`initStepLogTable()` (`src/step-log.ts`), `initMcpOAuthTables()` (`src/mcp-oauth.ts`),
`initAccessAuditTable()`, `initAccessPageGrantsTable()`, `initAuthEventsTable()`
(`src/mcp-auth-events.ts`) and `initReviewFixEvidenceTable()` (`src/review-fix-evidence.ts`).
To change a table, find the module that creates it: search for `CREATE TABLE IF NOT EXISTS <name>`.
The rest of this page describes `dispatch_log` and `review_fix_attempts`.

`main()` calls these init functions before `loadConfig()`. They run
before the Restate endpoint opens (`restateRegistration.attempt()` is called later) and before
the first poll.

Every step is idempotent, so a second boot changes nothing:

- Tables and indexes use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`.
- A new column uses `ALTER TABLE ... ADD COLUMN`, and only when `PRAGMA table_info` shows the
  column is missing. The column is nullable (or has a default), so SQLite does not rewrite the table.
- Triggers use `CREATE TRIGGER IF NOT EXISTS`.
- One trigger is the exception. `trg_dispatch_log_changed_at` is dropped and created at every
  boot, so an older form of it is replaced by the current form.

## 2. The accounting parts (AII-1561)

**Tables** (created in `getDb()`):

- `dispatch_job_report`: what the runner reported about one job (pushed SHAs, and whether the
  invocation list arrived whole).
- `job_accounting_pruned`: one row (`id = 1`). It holds the newest `(changed_at, jid)` of any
  finished job that the prune deleted. It never moves back.

**Columns:**

- `dispatch_log` gets `tracker_kind`, `issue_url`, `machine_cpu_kind`, `machine_cpus`,
  `machine_memory_mb`, `compute_started_at`, `compute_stopped_at` and `changed_at`
  (`ACCOUNTING_COLUMNS` in `src/log.ts`, added by `ensureLogColumns()`).
- `review_fix_attempts` gets `changed_at` (added in `getDb()`).

`changed_at` is epoch milliseconds. SQLite sets it, through the triggers below.

**Backfill.** `ensureAccountingTriggers()` sets `changed_at = completed_at` on rows in
`dispatch_log` and `review_fix_attempts` where `changed_at IS NULL AND completed_at IS NOT NULL`.
This statement runs at every boot. It is idempotent, because it touches only rows with a NULL
`changed_at`. The backfill leaves the NULL of a running row unchanged. A running row can still
get a `changed_at` later, because the triggers below set it when a tracked column changes or an
invocation or report arrives.

**Triggers:**

| Trigger | Table | Fires on | Effect |
|---|---|---|---|
| `trg_dispatch_log_changed_at` | `dispatch_log` | An update of one of the 13 columns in section 5, when `OLD` and `NEW` differ in at least one | Sets `changed_at` to now |
| `trg_invocation_attribution_changed_at` | `model_invocation_attribution` | Insert | Sets `changed_at` on the job row in `dispatch_log` and `review_fix_attempts` |
| `trg_job_report_insert_changed_at` | `dispatch_job_report` | Insert | Same |
| `trg_job_report_update_changed_at` | `dispatch_job_report` | Update that changes `pushed_shas_json` or `invocations_complete` | Same |
| `trg_dispatch_log_pruned` | `dispatch_log` | Delete of a row with `completed_at` set | Raises `job_accounting_pruned`, then deletes the job's `model_invocation_attribution` and `dispatch_job_report` rows (section 4) |
| `trg_review_fix_attempts_changed_at` | `review_fix_attempts` | Update of `state`, `terminal_outcome_json` or `completed_at` | Sets `changed_at` to now |

`changed_at` is not in any `UPDATE OF` list, so these triggers never fire themselves. Bookkeeping
columns such as `notified_at` and `machine_nonce` do not move `changed_at`.

**Prune rule.** `appendLog` (`src/log.ts`) keeps the newest `MAX_LOG_ENTRIES` (500) rows of
`dispatch_log`. A finished row is kept while `COALESCE(changed_at, completed_at)` is less than
7 days old (`FINISHED_JOB_RETENTION_MS`), even above `MAX_LOG_ENTRIES`. The table can therefore
hold more than 500 rows. The older guards (active machine nonce, review-fix attempts) also still apply.

`dispatch_log.callback_lifecycle_completed_at` is nullable callback bookkeeping. It records
completion of owned callback lifecycle handling before the Restate forward, independently
of job closure, and does not move `changed_at`.

## 3. Rollback

Nothing undoes a schema change. If you deploy older code over a newer database:

- Old code ignores the new tables and columns. Its inserts name their columns, and the new
  columns are nullable.
- The triggers stay in the database and keep working under old code.
- The prune trigger's deletes (section 4) stay active.

## 4. The one irreversible change

When a finished `dispatch_log` row is pruned (`completed_at` is set), `trg_dispatch_log_pruned`
also deletes the `model_invocation_attribution` and `dispatch_job_report` rows with the same
`dispatch_id`. Before AII-1561, call rows stayed for ever.

Every reader finds these rows through the job row, so nothing visible is lost. The control plane
keeps the permanent copy for orchestrators it tracks. For an orchestrator it does not track, the
raw per-call rows of pruned jobs are gone. A rollback does not bring them back, because the trigger
stays in the database. This was decided on purpose (user decision, 2026-10-28): once the job row is
gone, no reader can reach its call rows, so keeping them gave no value.

## 5. Rule: changing a column that a trigger names

- SQLite refuses to drop a column that a trigger names. A rename does not fail: SQLite rewrites
  the trigger to use the new name. `trg_dispatch_log_changed_at`
  names 13 `dispatch_log` columns (`DISPATCH_LOG_CHANGE_COLUMNS` in `src/log.ts`): `status`,
  `conclusion`, `completed_at`, `pr_url`, `issue_identifier`, `issue_title`, `tracker_kind`,
  `issue_url`, `machine_cpu_kind`, `machine_cpus`, `machine_memory_mb`, `compute_started_at`
  and `compute_stopped_at`. `trg_dispatch_log_pruned` also names `dispatch_log` columns
  (`id`, `dispatch_id`, `changed_at` and `completed_at`).
- This matters only for a change that removes one of those columns. A rename also needs the
  trigger SQL and `DISPATCH_LOG_CHANGE_COLUMNS` updated to the new name in the same change.
- A removal must first drop every trigger that names the column, then drop the column, then create
  those triggers again with updated references. For `completed_at`, that includes
  `trg_dispatch_log_pruned` as well as `trg_dispatch_log_changed_at`.
- `changed_at` is named too. In `dispatch_log` and `review_fix_attempts`, it is written by
  `trg_invocation_attribution_changed_at`, `trg_job_report_insert_changed_at` and
  `trg_job_report_update_changed_at`. `trg_review_fix_attempts_changed_at` writes it in
  `review_fix_attempts`, and `trg_dispatch_log_pruned` reads it in `dispatch_log`. Removing
  `changed_at` from either table fails while any of these triggers remains.
- The orchestrator already drops and creates `trg_dispatch_log_changed_at` at every boot. So the
  column change only needs to run before that step (before `ensureAccountingTriggers()` in
  `initLogTable()`), and the trigger's column list must be updated in the same change. All other
  triggers are created with `IF NOT EXISTS`, so SQLite does not restore them after a drop. The
  change must drop each affected trigger, update its definition, and create it again in the same
  schema change.
- If someone forgets, the column drop fails at boot, and that orchestrator does not start. The
  test `adds the columns to an old table, leaving old rows null` in `src/__tests__/jobs.test.ts`
  drops the trigger first for exactly this reason. The same rule applies to `review_fix_attempts`
  columns named by `trg_review_fix_attempts_changed_at` (`state`, `terminal_outcome_json`,
  `completed_at`).

One difference for `review_fix_attempts`: `getDb()` creates its trigger with
`CREATE TRIGGER IF NOT EXISTS`, and boot does not recreate it. So the column change must drop
the trigger itself, and the same change must create the trigger again with the new column list.
Running the change before `ensureAccountingTriggers()` is not enough for this table.

## 6. How to add a schema change safely

1. Write the statement so a second boot changes nothing (`IF NOT EXISTS`, or check
   `PRAGMA table_info` before `ADD COLUMN`).
2. Make a new column nullable, or give it a default.
3. Add a test that boots an old database (create the old shape, run `initLogTable()` twice,
   check the result). Use the test named in section 5 as the pattern.
4. If the change drops a column that a trigger names (or renames one), follow section 5.
5. Read the deploy paths in [deployment.md](deployment.md#deploy-paths). Remember that a
   rollback keeps the schema change (section 3).
