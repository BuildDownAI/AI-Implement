// One accounting record per finished job (AII-1564), pulled by the control plane through the
// `list_job_accounting` read tool. Every record is built from an explicit field allowlist — never a
// spread of a row — so task snapshots, results, failure text and usage extras cannot leak.
import type { RepoMapping } from "./config.js";
import type { TicketingProvider } from "./providers/types.js";
import { z } from "zod";
import { getDb } from "./dedup.js";
import { INVOCATION_RECORDS_MAX } from "./pipeline/types.js";

/** The tracker facts a job row saves at dispatch time, since the mapping can change after the job. */
export interface TrackerAccounting {
  trackerKind: string;
  issueUrl: string | null;
}

/** Tracker kind and issue URL for a job whose issue is known only by id, identifier and title (a gap-fill run). */
export function trackerAccounting(
  mapping: RepoMapping,
  provider: TicketingProvider | null,
  issue: { id: string; identifier?: string | null; title?: string | null },
): TrackerAccounting {
  let issueUrl: string | null = null;
  if (provider) {
    try {
      issueUrl = provider.issueUrl({
        id: issue.id,
        identifier: issue.identifier ?? issue.id,
        title: issue.title ?? "",
        description: null,
        scopeKey: "",
        nativeStatus: "",
      });
    } catch {
      issueUrl = null;
    }
  }
  return { trackerKind: mapping.ticketingProvider, issueUrl };
}

/** A record is returned only this long after its last change (`changed_at`), so a burst of late writes settles first. */
export const JOB_ACCOUNTING_SETTLE_MS = 10 * 60 * 1000;
export const JOB_ACCOUNTING_DEFAULT_PAGE_SIZE = 100;
export const JOB_ACCOUNTING_MAX_PAGE_SIZE = 200;
/** The longest text (UTF-16 units, as zod measures it) a served record string may have; longer text is cut. Published in record.schema.json. */
export const RECORD_TEXT_MAX = 2000;

/** Longest dispatch id served: the cursor and the record schema share it. */
const DISPATCH_ID_MAX = 200;

/** Position in the walk: records are ordered by `(changedAt, dispatchId)`; a changed job comes back after the cursor. */
export const JobAccountingCursorSchema = z.object({
  changedAt: z.number().int().nonnegative().safe(),
  dispatchId: z.string().min(1).max(DISPATCH_ID_MAX),
}).strict();
export type JobAccountingCursor = z.infer<typeof JobAccountingCursorSchema>;

export const JobAccountingArgsSchema = z.object({
  cursor: JobAccountingCursorSchema.optional(),
  pageSize: z.number().int().min(1).max(JOB_ACCOUNTING_MAX_PAGE_SIZE).optional(),
  /** Serve finished jobs that have not settled too. Only a caller about to lose the orchestrator should send it. */
  includeUnsettled: z.boolean().optional(),
}).strict();

const count = z.number().int().nonnegative();
const nullableInt = count.nullable();
/** Text a served record may hold: at most RECORD_TEXT_MAX units and no NUL (Postgres `text` cannot store it). */
const text = z.string().max(RECORD_TEXT_MAX).regex(/^[^\u0000]*$/);
const nullableString = text.nullable();

export const JobAccountingInvocationSchema = z.object({
  stage: text,
  agent: text,
  provider: text,
  model: text,
  status: text,
  tokensIn: nullableInt,
  tokensOut: nullableInt,
  cacheReadTokens: nullableInt,
  cacheCreationTokens: nullableInt,
  costUsd: z.number().nullable(),
  /** `reported` only when the executor reported a cost; otherwise `unavailable` with `costUsd` null. */
  costStatus: z.enum(["reported", "unavailable"]),
  /** Spawn attempts for this one invocation; minimum 1. */
  attempts: count.min(1),
});

export const JobAccountingRecordSchema = z.object({
  dispatchId: z.string().min(1).max(DISPATCH_ID_MAX),
  phase: text,
  status: text,
  conclusion: nullableString,
  lifecycleOwner: z.enum(["legacy", "restate"]),
  dispatchedAt: count,
  completedAt: count,
  /** When this record last changed (epoch ms). A job that changes is served again; the newest copy replaces older ones. */
  changedAt: count,
  issue: z.object({
    identifier: nullableString,
    title: nullableString,
    repo: nullableString,
    trackerKind: nullableString,
    url: nullableString,
  }),
  pr: z.object({ url: nullableString, number: nullableInt }),
  /** Null when the runner never reported the pushed SHAs; `[]` when it reported that nothing was pushed. */
  pushedShas: z.array(text).nullable(),
  /**
   * `reported` only when the runner's `invocations` list arrived whole (none dropped or cut by the runner); `partial` when some invocation rows exist
   * without that (cost may be too low); `unknown` when none exist — an empty `invocations` list must never be read as $0.
   */
  usage: z.enum(["unknown", "partial", "reported"]),
  invocations: z.array(JobAccountingInvocationSchema).max(INVOCATION_RECORDS_MAX),
  compute: z.object({
    backend: nullableString,
    cpuKind: nullableString,
    cpus: nullableInt,
    memoryMb: nullableInt,
    startedAt: nullableInt,
    stoppedAt: nullableInt,
  }),
});
export type JobAccountingRecord = z.infer<typeof JobAccountingRecordSchema>;

export const JobAccountingPageSchema = z.object({
  records: z.array(JobAccountingRecordSchema),
  /** The cursor to pass for the next page; null when this page was not full (the walk is at the end). */
  nextCursor: JobAccountingCursorSchema.nullable(),
  /** The oldest finished job the orchestrator still holds (settled or not); null when it holds none. Information only. */
  oldestRetainedCompletedAt: nullableInt,
  /** The newest `(changedAt, dispatchId)` of any finished job that was pruned; null when none was. A cursor behind it may have missed records. */
  prunedThrough: JobAccountingCursorSchema.nullable(),
});
export type JobAccountingPage = z.infer<typeof JobAccountingPageSchema>;

// The union of the two finished-job sources, keyed by (changed_at, dispatch_id); a row with no changed_at
// (inserted already finished) is keyed by completed_at. A dispatch_log row
// without a dispatch_id (old rows) gets the synthetic id `log-<id>`. A review-fix attempt that also has a
// dispatch_log row is reported once, from the dispatch_log side.
const FINISHED_SOURCES = `
  SELECT 'log' AS src, id AS row_id, COALESCE(dispatch_id, 'log-' || id) AS jid, completed_at AS done_at, COALESCE(changed_at, completed_at) AS changed
    FROM dispatch_log WHERE completed_at IS NOT NULL
  UNION ALL
  SELECT 'fix' AS src, 0 AS row_id, dispatch_id AS jid, completed_at AS done_at, COALESCE(changed_at, completed_at) AS changed
    FROM review_fix_attempts a
    WHERE completed_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM dispatch_log l WHERE l.dispatch_id = a.dispatch_id)`;

interface KeyRow { src: "log" | "fix"; row_id: number; jid: string; done_at: number; changed: number }

interface LogRow {
  id: number;
  issue_identifier: string | null;
  issue_title: string | null;
  repo: string | null;
  dispatched_at: number;
  dispatch_id: string | null;
  status: string;
  conclusion: string | null;
  pr_url: string | null;
  completed_at: number;
  execution_mode: string | null;
  phase: string | null;
  tracker_kind: string | null;
  issue_url: string | null;
  machine_cpu_kind: string | null;
  machine_cpus: number | null;
  machine_memory_mb: number | null;
  compute_started_at: number | null;
  compute_stopped_at: number | null;
}

interface FixRow {
  dispatch_id: string;
  repository: string;
  pr_number: number;
  state: string;
  created_at: number;
  completed_at: number;
}

interface InvocationRow {
  dispatch_id: string;
  stage: string;
  agent: string;
  provider: string;
  model: string;
  status: string;
  usage_json: string;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

/** Removes every NUL, then cuts text to RECORD_TEXT_MAX without leaving half a surrogate pair at the end. */
function cut(v: string): string;
function cut(v: string | null): string | null;
function cut(v: string | null): string | null {
  if (v === null) return v;
  v = v.replaceAll("\u0000", "");
  if (v.length <= RECORD_TEXT_MAX) return v;
  const end = RECORD_TEXT_MAX - ((v.charCodeAt(RECORD_TEXT_MAX - 1) & 0xfc00) === 0xd800 ? 1 : 0);
  return v.slice(0, end);
}

function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function toInvocation(row: InvocationRow): z.infer<typeof JobAccountingInvocationSchema> {
  let u: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.usage_json);
    if (parsed && typeof parsed === "object") u = parsed as Record<string, unknown>;
  } catch {
    // unreadable usage reads as no usage
  }
  const costUsd = typeof u.costUsd === "number" && Number.isFinite(u.costUsd) && u.costUsd >= 0 ? u.costUsd : null;
  const attempts = typeof u.attempts === "number" && Number.isSafeInteger(u.attempts) && u.attempts >= 1 ? u.attempts : 1;
  return {
    stage: cut(row.stage),
    agent: cut(row.agent),
    provider: cut(row.provider),
    model: cut(row.model),
    status: cut(row.status),
    tokensIn: intOrNull(u.tokensIn),
    tokensOut: intOrNull(u.tokensOut),
    cacheReadTokens: intOrNull(u.cacheReadTokens),
    cacheCreationTokens: intOrNull(u.cacheCreationTokens),
    costUsd,
    costStatus: costUsd !== null && u.costStatus === "reported" ? "reported" : "unavailable",
    attempts,
  };
}

function prNumber(url: string | null): number | null {
  const m = url ? /\/pull\/(\d+)(?:[/?#].*)?$/.exec(url) : null;
  return m ? intOrNull(Number(m[1])) : null;
}

function parseShas(raw: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((v) => typeof v === "string") ? (parsed as string[]).map((v) => cut(v)) : null;
  } catch {
    return null;
  }
}

/** One page of finished-job accounting records by last change, oldest first, strictly after `cursor`. A changed job is served again.
 * `includeUnsettled` skips the settle filter, so a job that changed in the last 10 minutes is served too. */
export function listJobAccounting(
  opts: { cursor?: JobAccountingCursor; pageSize?: number; now?: number; includeUnsettled?: boolean } = {},
): JobAccountingPage {
  const db = getDb();
  const now = opts.now ?? Date.now();
  const pageSize = Math.min(Math.max(opts.pageSize ?? JOB_ACCOUNTING_DEFAULT_PAGE_SIZE, 1), JOB_ACCOUNTING_MAX_PAGE_SIZE);
  const settledBefore = now - JOB_ACCOUNTING_SETTLE_MS;

  const oldest = db.prepare(`SELECT MIN(done_at) AS oldest FROM (${FINISHED_SOURCES})`).get() as { oldest: number | null };

  const pruned = db.prepare(`SELECT changed_at, jid FROM job_accounting_pruned WHERE id = 1`).get() as
    | { changed_at: number; jid: string }
    | undefined;

  const params: unknown[] = [];
  let settled = "";
  if (!opts.includeUnsettled) {
    settled = "AND changed <= ?";
    params.push(settledBefore);
  }
  let after = "";
  if (opts.cursor) {
    after = "AND (changed > ? OR (changed = ? AND jid > ?))";
    params.push(opts.cursor.changedAt, opts.cursor.changedAt, opts.cursor.dispatchId);
  }
  const keys = db
    .prepare(
      `SELECT src, row_id, jid, done_at, changed FROM (${FINISHED_SOURCES})
       WHERE length(CAST(jid AS BLOB)) BETWEEN 1 AND ${DISPATCH_ID_MAX} ${settled} ${after} ORDER BY changed ASC, jid ASC LIMIT ?`,
    )
    .all(...params, pageSize) as KeyRow[];

  const logIds = keys.filter((k) => k.src === "log").map((k) => k.row_id);
  const fixIds = keys.filter((k) => k.src === "fix").map((k) => k.jid);
  const jids = keys.map((k) => k.jid);

  const logRows = new Map<number, LogRow>();
  if (logIds.length > 0) {
    const rows = db
      .prepare(
        `SELECT id, issue_identifier, issue_title, repo, dispatched_at, dispatch_id, status, conclusion, pr_url,
                completed_at, execution_mode, phase, tracker_kind, issue_url, machine_cpu_kind, machine_cpus,
                machine_memory_mb, compute_started_at, compute_stopped_at
         FROM dispatch_log WHERE id IN (${placeholders(logIds.length)})`,
      )
      .all(...logIds) as LogRow[];
    for (const r of rows) logRows.set(r.id, r);
  }
  const fixRows = new Map<string, FixRow>();
  if (fixIds.length > 0) {
    const rows = db
      .prepare(
        `SELECT dispatch_id, repository, pr_number, state, created_at, completed_at
         FROM review_fix_attempts WHERE dispatch_id IN (${placeholders(fixIds.length)})`,
      )
      .all(...fixIds) as FixRow[];
    for (const r of rows) fixRows.set(r.dispatch_id, r);
  }

  const invocations = new Map<string, InvocationRow[]>();
  const owners = new Map<string, string>();
  const reports = new Map<string, { shas: string[] | null; complete: boolean }>();
  if (jids.length > 0) {
    const marks = placeholders(jids.length);
    for (const r of db
      .prepare(
        `SELECT dispatch_id, stage, agent, provider, model, status, usage_json
         FROM model_invocation_attribution WHERE dispatch_id IN (${marks}) ORDER BY rowid`,
      )
      .all(...jids) as InvocationRow[]) {
      const list = invocations.get(r.dispatch_id) ?? [];
      list.push(r);
      invocations.set(r.dispatch_id, list);
    }
    for (const r of db
      .prepare(`SELECT dispatch_id, lifecycle_owner FROM dispatch_admissions WHERE dispatch_id IN (${marks})`)
      .all(...jids) as Array<{ dispatch_id: string; lifecycle_owner: string }>) {
      owners.set(r.dispatch_id, r.lifecycle_owner);
    }
    for (const r of db
      .prepare(`SELECT dispatch_id, pushed_shas_json, invocations_complete FROM dispatch_job_report WHERE dispatch_id IN (${marks})`)
      .all(...jids) as Array<{ dispatch_id: string; pushed_shas_json: string | null; invocations_complete: number }>) {
      reports.set(r.dispatch_id, {
        shas: r.pushed_shas_json === null ? null : parseShas(r.pushed_shas_json),
        complete: r.invocations_complete === 1,
      });
    }
  }

  const records: JobAccountingRecord[] = [];
  for (const key of keys) {
    const stored = invocations.get(key.jid) ?? [];
    // A published limit is enforced where the record is served: the first INVOCATION_RECORDS_MAX rows, `partial` if any were left out.
    const rows = stored.slice(0, INVOCATION_RECORDS_MAX).map(toInvocation);
    const truncated = stored.length > rows.length;
    const report = reports.get(key.jid);
    const common = {
      dispatchId: key.jid,
      completedAt: key.done_at,
      changedAt: key.changed,
      usage: rows.length === 0 ? ("unknown" as const) : report?.complete && !truncated ? ("reported" as const) : ("partial" as const),
      invocations: rows,
      pushedShas: report?.shas ?? null,
    };
    if (key.src === "log") {
      const r = logRows.get(key.row_id);
      if (!r) continue;
      const owner = owners.get(key.jid) ?? "legacy";
      records.push({
        ...common,
        phase: cut(r.phase ?? "implementation"),
        status: cut(r.status),
        conclusion: cut(r.conclusion),
        lifecycleOwner: owner.startsWith("restate") ? "restate" : "legacy",
        dispatchedAt: r.dispatched_at,
        issue: {
          identifier: cut(r.issue_identifier),
          title: cut(r.issue_title),
          repo: cut(r.repo),
          trackerKind: cut(r.tracker_kind),
          url: cut(r.issue_url),
        },
        pr: { url: cut(r.pr_url), number: prNumber(r.pr_url) },
        compute: {
          backend: cut(r.execution_mode),
          cpuKind: cut(r.machine_cpu_kind),
          cpus: intOrNull(r.machine_cpus),
          memoryMb: intOrNull(r.machine_memory_mb),
          startedAt: intOrNull(r.compute_started_at),
          stoppedAt: intOrNull(r.compute_stopped_at),
        },
      });
    } else {
      const r = fixRows.get(key.jid);
      if (!r) continue;
      records.push({
        ...common,
        phase: "review-fix",
        status: "completed",
        conclusion: cut(r.state),
        lifecycleOwner: "restate",
        dispatchedAt: r.created_at,
        issue: { identifier: null, title: null, repo: cut(r.repository), trackerKind: null, url: null },
        pr: { url: cut(`https://github.com/${r.repository}/pull/${r.pr_number}`), number: intOrNull(r.pr_number) },
        // Run start/end are not stored for an attempt: created_at and completed_at stand in (queue time included).
        compute: {
          backend: "github-actions",
          cpuKind: null,
          cpus: null,
          memoryMb: null,
          startedAt: r.created_at,
          stoppedAt: r.completed_at,
        },
      });
    }
  }

  const lastKey = keys[keys.length - 1];
  return {
    records,
    nextCursor: lastKey && keys.length === pageSize ? { changedAt: lastKey.changed, dispatchId: lastKey.jid } : null,
    oldestRetainedCompletedAt: oldest.oldest,
    prunedThrough: pruned ? { changedAt: pruned.changed_at, dispatchId: pruned.jid } : null,
  };
}
