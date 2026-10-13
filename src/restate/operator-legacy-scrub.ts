/**
 * Scrub of the raw refresh tokens the pre-AII-1287 `Operator` kept in Restate (family
 * state `currentToken`, plus journaled `refresh` inputs/outputs). Runs after the endpoint
 * registers: drop `currentToken` from every family, purge every completed `Operator`
 * invocation, then write the `operator_legacy_scrub_completed_at` settings row. A failure
 * writes no row, so the next boot retries. AII-1299 reads the row to reopen `POST /query`.
 * AII-1301: the state check runs on every boot, because a rollback to a pre-AII-1287 image
 * writes raw tokens again. When one is found the row is deleted first (closing `/query`),
 * and rewritten only after the scrub and purge succeed.
 * AII-1305: the step runs only while the sidecar is `ready` and registration `registered`
 * (the callTool rule). `onRegistered` also fires for `unreachable`, where an old deployment
 * without `dropLegacyToken` could pin the call, hold the Operator key and deadlock (AII-1281).
 */
import { getDb } from "../dedup.js";
import { purgeInvocation, runIntrospectionQuery } from "./endpoint.js";
import { RESTATE_ADMIN_BASE_URL, RESTATE_INGRESS_BIND_ADDRESS } from "./server.js";
import { getRestateStatus } from "./status.js";

const SCRUB_KEY = "operator_legacy_scrub_completed_at";
const CALL_TIMEOUT_MS = 10_000;

/** ISO time the scrub finished, or null when it has not (or the settings table is unreadable). */
export function getOperatorLegacyScrubCompletedAt(): string | null {
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(SCRUB_KEY) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export interface OperatorLegacyScrubDeps {
  fetchImpl?: typeof fetch;
  adminBaseUrl?: string;
  ingressBaseUrl?: string;
  now?: () => Date;
  /** Defaults to sidecar `ready` and registration `registered`, the same rule as `callTool`. */
  restateReady?: () => boolean;
  /** Skips the settings row (read and write) — for the Restate test, which has no dedup DB. */
  rowStore?: { read: () => string | null; write: (iso: string) => void; clear: () => void };
}

export interface OperatorLegacyScrubResult {
  ran: boolean;
  scrubbed: number;
  purged: number;
}

function hasLegacyToken(valueUtf8: unknown): boolean {
  try {
    const parsed = JSON.parse(String(valueUtf8)) as { currentToken?: unknown } | null;
    return typeof parsed?.currentToken === "string" && parsed.currentToken !== "";
  } catch {
    return false;
  }
}

export async function scrubOperatorLegacyTokens(deps: OperatorLegacyScrubDeps = {}): Promise<OperatorLegacyScrubResult> {
  const restateReady =
    deps.restateReady ??
    (() => {
      const restate = getRestateStatus();
      return restate.sidecar.state === "ready" && restate.registration.state === "registered";
    });
  if (!restateReady()) {
    console.log("[restate] Operator legacy-token scrub skipped: Restate is not ready and registered (next boot or registration retries)");
    return { ran: false, scrubbed: 0, purged: 0 };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const adminBaseUrl = deps.adminBaseUrl ?? RESTATE_ADMIN_BASE_URL;
  const ingressBaseUrl = deps.ingressBaseUrl ?? `http://${RESTATE_INGRESS_BIND_ADDRESS}`;
  const store = deps.rowStore ?? {
    read: getOperatorLegacyScrubCompletedAt,
    write: (iso: string) => {
      getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(SCRUB_KEY, iso);
    },
    clear: () => {
      getDb().prepare("DELETE FROM settings WHERE key = ?").run(SCRUB_KEY);
    },
  };

  try {
    // (a) families that still hold a raw token.
    const stateRows = await runIntrospectionQuery(
      fetchImpl,
      adminBaseUrl,
      "SELECT service_key, value_utf8 FROM state WHERE service_name = 'Operator' AND key = 'family'",
    );
    const legacyRows = stateRows.filter((row) => hasLegacyToken(row.value_utf8));
    const rowExisted = store.read() !== null;
    if (legacyRows.length === 0 && rowExisted) {
      return { ran: false, scrubbed: 0, purged: 0 };
    }
    // Close `POST /query` first: the proxy reads the row on every request.
    if (rowExisted) store.clear();
    let scrubbed = 0;
    for (const row of legacyRows) {
      const response = await fetchImpl(`${ingressBaseUrl}/Operator/${encodeURIComponent(String(row.service_key))}/dropLegacyToken`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`dropLegacyToken failed: HTTP ${response.status}`);
      }
      scrubbed++;
    }

    // (b) every completed Operator invocation (journals hold the old raw tokens).
    const invocations = await runIntrospectionQuery(
      fetchImpl,
      adminBaseUrl,
      "SELECT id FROM sys_invocation WHERE target_service_name = 'Operator' AND status = 'completed'",
    );
    let purged = 0;
    for (const row of invocations) {
      await purgeInvocation(fetchImpl, adminBaseUrl, String(row.id));
      purged++;
    }

    // (c) only now, record completion.
    store.write((deps.now?.() ?? new Date()).toISOString());
    console.log(`[restate] Operator legacy-token scrub done (${rowExisted ? "row cleared: legacy tokens found" : "first run"}): ${scrubbed} families scrubbed, ${purged} invocations purged`);
    return { ran: true, scrubbed, purged };
  } catch (err) {
    console.error(`[restate] Operator legacy-token scrub failed (will retry next boot): ${err instanceof Error ? err.message : String(err)}`);
    return { ran: false, scrubbed: 0, purged: 0 };
  }
}
