/**
 * Read-only view of one Restate invocation's journal (AII-1128), served by GET /api/restate/journal.
 * The admin API binds loopback, so the orchestrator reads `/query` on the operator's behalf. The
 * lookup is the only input: `/query` itself is never exposed.
 */

import { RESTATE_ADMIN_BASE_URL } from "./server.js";
import { runIntrospectionQuery, sqlQuote } from "./endpoint.js";

export type JournalLookup = { service: string; key: string } | { id: string };

const LOOKUP_VALUE = /^[A-Za-z0-9._:-]{1,128}$/;

/** `entry_json` over this many characters is dropped (`entry: null`): cutting JSON mid-string would leave it unparseable. */
const ENTRY_JSON_MAX_CHARS = 4096;

export function validateJournalLookup(query: Record<string, string>): JournalLookup | { error: string } {
  const { service, key, id } = query;
  if (service !== undefined || key !== undefined) {
    if (id !== undefined) return { error: "id: give either id or service and key, not both" };
    if (service === undefined || !LOOKUP_VALUE.test(service)) return { error: "service: 1-128 characters of [A-Za-z0-9._:-] required" };
    if (key === undefined || !LOOKUP_VALUE.test(key)) return { error: "key: 1-128 characters of [A-Za-z0-9._:-] required" };
    return { service, key };
  }
  if (id === undefined || !LOOKUP_VALUE.test(id)) return { error: "id: 1-128 characters of [A-Za-z0-9._:-] required (or service and key)" };
  return { id };
}

export function buildJournalQueries(lookup: JournalLookup): { invocation: string; journal: (invocationId: string) => string; promises: (service: string, key: string) => string } {
  // A key owns one invocation per handler call; the run handler's journal is the largest, so shared calls never shadow it.
  const where = "id" in lookup
    ? `WHERE id = '${sqlQuote(lookup.id)}' ORDER BY created_at DESC`
    : `WHERE target_service_name = '${sqlQuote(lookup.service)}' AND target_service_key = '${sqlQuote(lookup.key)}' ORDER BY journal_size DESC, created_at DESC`;
  return {
    invocation:
      "SELECT id, target_service_name, target_service_key, target_handler_name, status, journal_size, created_at, modified_at, completed_at, " +
      `last_failure, last_failure_error_code, last_failure_related_entry_name FROM sys_invocation ${where} LIMIT 1`,
    journal: (invocationId) =>
      "SELECT id, index, entry_type, name, completed, promise_name, entry_json, appended_at, sleep_wakeup_at FROM sys_journal " +
      `WHERE id = '${sqlQuote(invocationId)}' ORDER BY index`,
    promises: (service, key) =>
      "SELECT service_name, service_key, key, completed, completion_success_value_utf8, completion_failure FROM sys_promise " +
      `WHERE service_name = '${sqlQuote(service)}' AND service_key = '${sqlQuote(key)}'`,
  };
}

export interface JournalEntry {
  index: unknown;
  entryType: unknown;
  name: unknown;
  completed: unknown;
  promiseName: unknown;
  appendedAt: unknown;
  sleepWakeupAt: unknown;
  entry: unknown;
}

export interface JournalResult {
  invocation: Record<string, unknown>;
  entries: JournalEntry[];
  promises: Record<string, unknown>[];
}

function parseEntry(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length > ENTRY_JSON_MAX_CHARS) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function readJournal(
  lookup: JournalLookup,
  deps: { fetchImpl?: typeof fetch; adminBaseUrl?: string } = {},
): Promise<JournalResult | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const adminBaseUrl = deps.adminBaseUrl ?? RESTATE_ADMIN_BASE_URL;
  const queries = buildJournalQueries(lookup);

  const [invocation] = await runIntrospectionQuery(fetchImpl, adminBaseUrl, queries.invocation);
  if (!invocation) return null;

  const journalRows = await runIntrospectionQuery(fetchImpl, adminBaseUrl, queries.journal(String(invocation.id)));
  // Scoped by the row's own service and key, so the { id } form resolves the same promises.
  // A keyless service has a NULL key and no promises; skip the query rather than match the string 'null'.
  const promiseKey = invocation.target_service_key;
  const promises =
    typeof promiseKey === "string" && promiseKey !== ""
      ? await runIntrospectionQuery(fetchImpl, adminBaseUrl, queries.promises(String(invocation.target_service_name), promiseKey))
      : [];

  return {
    invocation,
    entries: journalRows.map((r) => ({
      index: r.index,
      entryType: r.entry_type,
      name: r.name,
      completed: r.completed,
      promiseName: r.promise_name,
      appendedAt: r.appended_at,
      sleepWakeupAt: r.sleep_wakeup_at,
      entry: parseEntry(r.entry_json),
    })),
    promises,
  };
}

/** The route body for GET /api/restate/journal: 400 on a bad lookup, 404 when nothing matches, 503 when the admin API throws. */
export async function handleJournalRequest(
  query: Record<string, string>,
  deps: { fetchImpl?: typeof fetch; adminBaseUrl?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const lookup = validateJournalLookup(query);
  if ("error" in lookup) return { status: 400, body: { error: lookup.error } };
  try {
    const result = await readJournal(lookup, deps);
    if (!result) return { status: 404, body: { error: "no invocation" } };
    return { status: 200, body: result };
  } catch (err) {
    console.error(`[restate] journal read failed: ${err instanceof Error ? err.message : String(err)}`);
    return { status: 503, body: { error: "restate unavailable" } };
  }
}
