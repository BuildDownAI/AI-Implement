import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FailureRecord } from "./pipeline/failure-classification.js";
import type { FindingDisposition } from "./pipeline/finding-dispositions.js";
import type { ReferenceRepoResult } from "./reference-repos.js";
import type { ReviewFixResultMetadataV1 } from "./review-fix-contract.js";
import { computeBackoffMs, DEFAULT_RETRY_POLICY, type RetryPolicy } from "./pipeline/retry-backoff.js";

/**
 * Mirrors runner-tokens.ts's PILOT_DELIVERY_GRACE_MS (orchestrator-only module — it imports
 * getDb() and cannot be pulled into the runner bundle). Keep the two numerically in sync: this
 * is the same grace window the server allows a prepared attempt's credential to remain usable
 * past `deadlineAt`, so bounding the client's retry loop past that point buys nothing.
 */
const PILOT_RESULT_DELIVERY_GRACE_MS = 15 * 60_000;

/** Safety backstop independent of the deadline, in case `deadlineAt` is set unreasonably far out. */
const MAX_PILOT_RESULT_ATTEMPTS = 8;

/** Bounds a single delivery attempt regardless of whether fetchImpl honours AbortSignal. */
const PILOT_TRANSPORT_TIMEOUT_MS = 10_000;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounds `promise` even if it never settles and ignores its own cancellation signal. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`runner-result POST timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function collectRunnerComments(workspaceDir: string): Array<{ body: string }> {
  const dir = join(workspaceDir, "ai-output", "comments");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((n) => ({ body: readFileSync(join(dir, n), "utf-8") }));
}

/**
 * Pull planning context from the orchestrator's provider-agnostic endpoint using
 * the run's reusable progress token. The runner never holds a ticketing-system
 * API key. Best-effort: any failure yields "" so the implementation run proceeds.
 */
export async function fetchPlanningContextFromOrchestrator(params: {
  callbackUrl: string;
  progressToken: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchFn = params.fetchImpl ?? fetch;
  try {
    const res = await fetchFn(`${params.callbackUrl.replace(/\/$/, "")}/runner/planning-context`, {
      method: "GET",
      headers: { Authorization: `Bearer ${params.progressToken}` },
    });
    if (!res.ok) {
      console.warn(`[runner] planning-context fetch failed HTTP ${res.status}; proceeding without it.`);
      return "";
    }
    const data = (await res.json()) as { planningContext?: unknown };
    return typeof data.planningContext === "string" ? data.planningContext : "";
  } catch (err) {
    console.warn("[runner] planning-context fetch failed; proceeding without it:", err);
    return "";
  }
}

export async function postRunnerResult(params: {
  phase: "planning" | "implementation" | "gap-analysis" | "kg-refresh";
  workspaceDir: string;
  outcome: "success" | "failure";
  prUrl?: string;
  failureReason?: string;
  /**
   * Machine-readable code. Set either when a known guardrail trips
   * (e.g. "SENSITIVE_FILES_BLOCKED") or, for a classified terminal failure,
   * to `failure.code` — it is not guardrail-only.
   */
  failureCode?: string;
  /** Structured failure record for the terminal error, classified by src/pipeline/failure-classification.ts. */
  failure?: FailureRecord;
  /** True when a grouping-parent run produced no changes; skips prUrl requirement on the callback. */
  noWork?: boolean;
  /** Reference repository clone outcomes, present only when the run declared entries. */
  referenceRepoResults?: ReferenceRepoResult[];
  /** Per-finding disposition from the fixing agent (fixed/follow-up/invalid), present only when non-empty. */
  findingDispositions?: FindingDisposition[];
  /** SHA of the snapshot commit pushed by a kg-refresh runner. Only meaningful for phase=kg-refresh. */
  snapshotCommit?: string | null;
  /** Number of the refresh PR opened alongside snapshotCommit. Only meaningful for phase=kg-refresh. */
  snapshotPr?: number | null;
  /** The `kg-refresh/<stamp>` branch the snapshot was pushed to; the orchestrator deletes it after merge or close. */
  snapshotBranch?: string | null;
  /** Guard verdict from kg-snapshot-push, present for a kg-refresh dry-run (AII-632) or a real `KG_SNAPSHOT_TRACKER_REGRESSION` refusal (AII-638). */
  guardVerdict?: "clean" | "refused";
  /** Per-part {part, prev, new} table from kg-snapshot-push, present for a kg-refresh dry-run (AII-632) or a real `KG_SNAPSHOT_TRACKER_REGRESSION` refusal (AII-638). */
  partTable?: Array<{ part: string; prev: string; new: string }>;
  /**
   * Optional pilot marker (AII-769 Restate review-fix pilot; AII-770 contract).
   * Present only when this result comes from a Restate-owned review-fix
   * attempt. Serialized verbatim — no producer calls this yet (AII-777 is
   * contracts + validation only).
   */
  reviewFix?: ReviewFixResultMetadataV1;
  /**
   * Resolved callback URL, e.g. from resolveRunnerInputs()/the envelope's runnerCallbackUrl.
   * Falls back to the legacy RUNNER_CALLBACK_URL env var (never set in GHA envelope mode,
   * where the URL travels inside AI_IMPLEMENT_RUN_CONFIG instead).
   */
  callbackUrl?: string | null;
  fetchImpl?: typeof fetch;
  /**
   * Backoff policy for the pilot's bounded result-delivery retry loop (AII-794). Ignored for
   * a Legacy call (no `reviewFix`), which always delivers in one attempt exactly as before.
   * Defaults to DEFAULT_RETRY_POLICY.
   */
  retryPolicy?: RetryPolicy;
  /** Injectable clock/sleep, for deterministic tests of the bounded retry loop only. */
  now?: () => number;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<void> {
  const callbackUrl = params.callbackUrl ?? process.env.RUNNER_CALLBACK_URL;
  const runToken = process.env.RUN_TOKEN;
  if (!callbackUrl || !runToken) return;
  let comments: Array<{ body: string }> = [];
  try {
    comments = collectRunnerComments(params.workspaceDir);
  } catch (err) {
    console.warn("[runner-callback] comment collection failed:", err);
  }
  const body: Record<string, unknown> = { phase: params.phase, outcome: params.outcome, comments };
  if (params.prUrl) body.prUrl = params.prUrl;
  if (params.failureReason) body.failureReason = params.failureReason;
  if (params.failureCode) body.failureCode = params.failureCode;
  if (params.failure) body.failure = params.failure;
  if (params.noWork) body.noWork = params.noWork;
  if (params.referenceRepoResults && params.referenceRepoResults.length > 0) {
    body.referenceRepoResults = params.referenceRepoResults;
  }
  if (params.findingDispositions && params.findingDispositions.length > 0) {
    body.findingDispositions = params.findingDispositions;
  }
  if (params.snapshotCommit) body.snapshotCommit = params.snapshotCommit;
  if (params.snapshotPr) body.snapshotPr = params.snapshotPr;
  if (params.snapshotBranch) body.snapshotBranch = params.snapshotBranch;
  if (params.guardVerdict) body.guardVerdict = params.guardVerdict;
  if (params.partTable) body.partTable = params.partTable;
  if (params.reviewFix) body.reviewFix = params.reviewFix;
  const url = `${callbackUrl.replace(/\/$/, "")}/runner/result`;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${runToken}` };
  // Built once and reused verbatim on every delivery attempt, including retries — a lost-ACK
  // retry must resend byte-identical bytes, not a freshly serialized (if logically equal) body.
  const payload = JSON.stringify(body);
  const fetchFn = params.fetchImpl ?? fetch;

  if (!params.reviewFix) {
    // Legacy (no pilot marker): unchanged single-attempt behavior.
    try {
      const res = await fetchFn(url, { method: "POST", headers, body: payload });
      if (!res.ok) {
        console.error(`[runner-callback] POST failed HTTP ${res.status}: ${await res.text().catch(() => "")}`);
      } else {
        console.log(`[runner-callback] POST ok phase=${params.phase} outcome=${params.outcome}`);
      }
    } catch (err) {
      console.error("[runner-callback] POST failed:", err);
    }
    return;
  }

  // Pilot (reviewFix present): bounded retry/backoff on transient transport/429/5xx failures,
  // respecting the attempt's stored deadline plus delivery grace. A terminal 4xx/conflict (incl.
  // the pilot's own 409 conflict / 410 stale classifications) stops retrying immediately and
  // remains visible via console.error — never retried, never silently swallowed. Exhausting the
  // deadline or the attempt cap without a response is its own explicit "no-result" log outcome;
  // it must never rerun agent work or mint a new attempt, only report that delivery failed.
  const attemptId = params.reviewFix.attemptId;
  const nowFn = params.now ?? Date.now;
  const sleepFn = params.sleepImpl ?? sleep;
  const policy = params.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const deadline = params.reviewFix.deadlineAt + PILOT_RESULT_DELIVERY_GRACE_MS;
  let lastDetail = "";

  for (let attempt = 1; attempt <= MAX_PILOT_RESULT_ATTEMPTS; attempt++) {
    if (nowFn() >= deadline) {
      console.error(
        `[runner-callback] POST no-result phase=${params.phase} outcome=${params.outcome} attemptId=${attemptId}: ` +
          `delivery deadline exceeded before attempt ${attempt}${lastDetail}`,
      );
      return;
    }
    try {
      const res = await withTimeout(fetchFn(url, { method: "POST", headers, body: payload }), PILOT_TRANSPORT_TIMEOUT_MS);
      if (res.ok) {
        console.log(`[runner-callback] POST ok phase=${params.phase} outcome=${params.outcome} attemptId=${attemptId}`);
        return;
      }
      const detailText = await res.text().catch(() => "");
      lastDetail = ` (last HTTP ${res.status}: ${detailText})`;
      if (!isRetryableStatus(res.status)) {
        console.error(
          `[runner-callback] POST failed HTTP ${res.status} attemptId=${attemptId} (terminal, not retrying): ${detailText}`,
        );
        return;
      }
    } catch (err) {
      lastDetail = ` (last error: ${err instanceof Error ? err.message : String(err)})`;
    }

    if (attempt === MAX_PILOT_RESULT_ATTEMPTS) {
      console.error(
        `[runner-callback] POST no-result phase=${params.phase} outcome=${params.outcome} attemptId=${attemptId}: ` +
          `retry attempts exhausted (${MAX_PILOT_RESULT_ATTEMPTS})${lastDetail}`,
      );
      return;
    }
    const backoff = computeBackoffMs(attempt, policy);
    const remaining = deadline - nowFn();
    if (remaining <= 0) {
      console.error(
        `[runner-callback] POST no-result phase=${params.phase} outcome=${params.outcome} attemptId=${attemptId}: ` +
          `delivery deadline exceeded after attempt ${attempt}${lastDetail}`,
      );
      return;
    }
    await sleepFn(Math.min(backoff, remaining));
  }
}
