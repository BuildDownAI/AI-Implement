import type { LLMResult, RunTelemetry } from "./types.js";

/**
 * Closed on purpose: the retry rails this issue is laying the foundation for
 * switch on `category`. An open string here would let a new call site invent
 * a category the retry policy never matches and therefore never retries.
 */
export type FailureCategory =
  | "transient" // provider overload, retryable rate limit, transport/service error, git server error
  | "auth" // expired or invalid credential, 401/403
  | "config" // bad model id, missing env, invalid request shape
  | "conflict" // push lease rejected, non-fast-forward, remote advanced
  | "invalid_output" // model returned no or malformed structured output
  | "cancelled" // SIGTERM/SIGKILL/SIGINT, workflow cancellation
  | "crash" // non-zero exit with no recognised signature
  | "unknown"; // nothing matched — never retried

export const FAILURE_CATEGORIES: readonly FailureCategory[] = [
  "transient",
  "auth",
  "config",
  "conflict",
  "invalid_output",
  "cancelled",
  "crash",
  "unknown",
];

export interface FailureRecord {
  category: FailureCategory;
  /** Open-ended machine code, UPPER_SNAKE, e.g. PROVIDER_OVERLOADED, GIT_LEASE_REJECTED. */
  code: string;
  stage: string; // step id or sub-step id, e.g. "feedback-loop/implement-1"
  attempt: number; // 1 until later issues add retries
  retryable: boolean; // transient and budget not yet spent (GIT_PUSH_RETRIES_EXHAUSTED is transient with retryable: false)
  exitCode?: number | null;
  signal?: string | null;
  elapsedMs?: number;
  /** Human-readable one-liner, redacted. */
  message: string;
  /** Set only when code is REVIEWER_TURNS_EXHAUSTED — the configured `retryPolicy.reviewMaxTurns`
   *  cap the reviewer hit, stamped on at the one place it's known (post-push-review.ts) so both
   *  the callback path and the monitor path render the same cap from the persisted record. */
  reviewMaxTurns?: number;
  evidence: {
    stdoutTail?: string; // redacted, <= EVIDENCE_TAIL_BYTES
    stderrTail?: string; // redacted, <= EVIDENCE_TAIL_BYTES
    truncated: boolean;
    llmSubtype?: string | null; // from LLMTerminalStatus
    llmIsError?: boolean | null;
    /** From RunTelemetry.outcome — makes e.g. a `subtype: success` / `outcome: max_turns` mismatch explainable from the record alone. */
    llmOutcome?: RunTelemetry["outcome"] | null;
    /** Set only when evidence capture itself failed (best-effort — see classify* catch blocks). */
    captureError?: string;
  };
}

export const EVIDENCE_TAIL_BYTES = 8 * 1024;

/** The closed set `RunTelemetry["outcome"]` accepts — mirrored here so `isFailureRecord` can
 *  validate `evidence.llmOutcome` against the real union instead of merely `typeof === "string"`,
 *  which would let a runner-callback body persist an arbitrary string into `failure_json`.
 *  Built from a `satisfies Record<RunTelemetry["outcome"], true>` object rather than a bare
 *  string array, so adding a member to that union without listing it here is a compile error
 *  instead of a silently-incomplete runtime check. */
const RUN_TELEMETRY_OUTCOMES_BY_NAME = {
  success: true,
  max_turns: true,
  error: true,
  unknown: true,
} satisfies Record<RunTelemetry["outcome"], true>;
const RUN_TELEMETRY_OUTCOMES: ReadonlySet<string> = new Set(Object.keys(RUN_TELEMETRY_OUTCOMES_BY_NAME));

interface SignatureRow {
  category: FailureCategory;
  code: string;
  test: RegExp | ((input: string) => boolean);
}

function testRow(row: SignatureRow, text: string): boolean {
  return row.test instanceof RegExp ? row.test.test(text) : row.test(text);
}

function matchSignature(table: SignatureRow[], text: string): { category: FailureCategory; code: string } | null {
  for (const row of table) {
    if (testRow(row, text)) return { category: row.category, code: row.code };
  }
  return null;
}

/**
 * Provider/transport signatures. Text-derived only — `invalid_output` (needs
 * `structuredOutput === undefined`), `cancelled` (needs a signal) and `crash`/
 * `unknown` (structural fallbacks) are not text patterns and are applied by
 * the classify* functions directly rather than as rows here.
 */
export const PROVIDER_SIGNATURES: SignatureRow[] = [
  {
    category: "transient",
    code: "PROVIDER_OVERLOADED",
    test: /overloaded_error|\b529\b|\boverloaded\b/i,
  },
  {
    category: "transient",
    code: "PROVIDER_RATE_LIMITED",
    test: /rate_limit_error|\b429\b/i,
  },
  {
    category: "transient",
    code: "PROVIDER_TRANSPORT",
    test: /\b(500|502|503|504)\b|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i,
  },
  {
    category: "auth",
    code: "PROVIDER_AUTH",
    test: (t: string) =>
      /\b(401|403)\b/.test(t) ||
      /authentication_error/i.test(t) ||
      /invalid x-api-key/i.test(t) ||
      (/expired/i.test(t) && /\btoken\b/i.test(t)),
  },
  {
    category: "config",
    code: "PROVIDER_CONFIG",
    test: /not_found_error|invalid_request_error|unknown model/i,
  },
];

/**
 * Lines carrying a transport-level marker, checked when falling back to
 * `stdout` for signature matching (see `signatureMatchText`) — `stdout` is
 * the model's final text, and an ordinary sentence can otherwise collide
 * with a provider signature (e.g. "returns 503" is not a transport error).
 * `HTTP/\d` (a real status line, e.g. `HTTP/1.1 503`) is required rather than
 * a bare `HTTP` — prose like "added an HTTP 503 handler" mentions a status
 * code without ever being transport output and must not qualify. Likewise
 * `status code \d{3}` requires the code to sit right next to the phrase —
 * a line that merely mentions "status code" and, elsewhere, an unrelated
 * three-digit number must not qualify either.
 */
const STDOUT_TRANSPORT_MARKER = /API Error|HTTP\/\d|status code[:=]?\s*\d{3}|error_type|"type"\s*:\s*"[a-z_]*_error"/i;

/**
 * Text `PROVIDER_SIGNATURES` is matched against. `stderr` is process output
 * and safe to match wholesale; `stdout` is the model's own prose and is only
 * matched line-by-line, and only for lines that also carry a transport
 * marker, so a model merely discussing an HTTP status doesn't get
 * misclassified as the transport itself failing. The two are concatenated
 * rather than either-or: an unrelated stderr line (e.g. a Node
 * `ExperimentalWarning`) must not hide a real transport signature that only
 * appears in the marker-filtered stdout.
 */
function signatureMatchText(stdout: string, stderr: string): string {
  const markedStdout = stdout
    ? stdout
        .split("\n")
        .filter((line) => STDOUT_TRANSPORT_MARKER.test(line))
        .join("\n")
    : "";
  return [stderr, markedStdout].filter(Boolean).join("\n");
}

export const GIT_SIGNATURES: SignatureRow[] = [
  {
    category: "transient",
    code: "GIT_REMOTE_TRANSIENT",
    test: (t: string) =>
      /commit_refs/i.test(t) ||
      /internal server error/i.test(t) ||
      (/could not read from remote repository/i.test(t) && /timeout/i.test(t)) ||
      /bad gateway/i.test(t) ||
      /service unavailable/i.test(t) ||
      /gateway time-?out/i.test(t),
  },
  // Checked before GIT_LEASE_REJECTED: a caller (e.g. post-push-review's
  // `git push --force-with-lease rejected: ...` wrapper) fixes the words
  // "rejected" and "force-with-lease" into every push failure's message
  // regardless of cause, so an auth signature (401/403, "authentication
  // failed") must win over the generic lease-conflict wording rather than
  // being shadowed by it. The numeric check is anchored the same way as the
  // transient row below it, for the same reason: a bare 401/403 can appear in
  // git's own unrelated progress counters.
  {
    category: "auth",
    code: "GIT_AUTH",
    test: (t: string) =>
      /authentication failed/i.test(t) ||
      /(RPC failed; HTTP|HTTP\/[\d.]+|The requested URL returned error:?|HTTP code\s*=)\s*(401|403)\b/i.test(t) ||
      /permission to .* denied/i.test(t) ||
      // Unanchored, mirroring the 5xx row's bare "Bad Gateway"/"Service Unavailable" phrases below:
      // a proxy in front of GitHub can report the status as a bare "remote: 403 Forbidden" (or
      // just "Forbidden"/"Unauthorized" on its own line), with no "HTTP"/"RPC failed"/"HTTP code ="
      // marker for the numeric test above to anchor to.
      /remote:\s*403\s+forbidden/i.test(t) ||
      /remote:\s*401\s+unauthorized/i.test(t) ||
      /^\s*(forbidden|unauthorized)\s*$/im.test(t),
  },
  // Checked after GIT_AUTH but ahead of GIT_LEASE_REJECTED: post-push-review's
  // `git push --force-with-lease rejected: ...` wrapper fixes the words "rejected"
  // and "force-with-lease" onto every push failure regardless of cause, so a git
  // transport 5xx (e.g. `RPC failed; HTTP 503`) reported through that wrapper must
  // still classify transient rather than being shadowed by the generic lease-conflict
  // wording below. The number is anchored to an actual transport marker (an RPC/HTTP
  // status line, curl's "The requested URL returned error", or the older "HTTP code ="
  // wording) rather than a bare 500-504 — git's own progress counters ("Enumerating
  // objects: 503, done.") contain plausible-looking numbers that are not status codes
  // at all, and a bare-number test would misclassify e.g. a `pre-receive hook declined`
  // failure that merely happens to enumerate 503 objects.
  {
    category: "transient",
    code: "GIT_REMOTE_TRANSIENT",
    test: /(RPC failed; HTTP|HTTP\/[\d.]+|The requested URL returned error:?|HTTP code\s*=)\s*(500|502|503|504)\b/i,
  },
  {
    category: "conflict",
    code: "GIT_LEASE_REJECTED",
    test: (t: string) =>
      /stale info/i.test(t) ||
      /non-fast-forward/i.test(t) ||
      (/rejected/i.test(t) && /force-with-lease/i.test(t)),
  },
  // Checked last, after GIT_AUTH and GIT_LEASE_REJECTED: git prints these
  // transport phrases as a trailer on plenty of non-transient failures too —
  // most notably "fatal: the remote end hung up unexpectedly" right after an
  // `RPC failed; HTTP 403` line. A row this generic must never get first pick,
  // or a permission failure classifies (and retries) as transient.
  {
    category: "transient",
    code: "GIT_REMOTE_TRANSIENT",
    test: (t: string) =>
      /the remote end hung up unexpectedly/i.test(t) ||
      /RPC failed; curl/i.test(t) ||
      /Connection reset by peer/i.test(t),
  },
];

/**
 * Heuristic for "this thrown message is git's own output" — gates GIT_SIGNATURES
 * ahead of PROVIDER_SIGNATURES in `classifyThrown` so e.g. a git 403 classifies as
 * GIT_AUTH rather than PROVIDER_AUTH (both categories are "auth"; only the code differs,
 * but the code is what future retry/observability tooling keys off of).
 */
const GIT_MESSAGE_MARKER = /^git |fatal:|remote:|error: failed to push/i;

const FIXED_REDACTION_PATTERNS: RegExp[] = [
  /ghs_[A-Za-z0-9]+/g,
  /ghp_[A-Za-z0-9]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /sk-ant-[A-Za-z0-9-]+/g,
  /Bearer\s+\S+/g,
  /x-api-key:\s*\S+/gi,
  /https:\/\/[^:/\s]+:[^@/\s]+@/g,
];

/**
 * Replaces every string in `secrets` with `***` (via `replaceAll`, since a
 * token can recur many times in one git trace — the push step's redaction
 * has the same requirement), then applies the fixed pattern set. Best-effort
 * pattern reused from the push step's `activeGithubToken` redaction rather
 * than a second implementation.
 */
export function redactEvidence(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.replaceAll(secret, "***");
  }
  for (const pattern of FIXED_REDACTION_PATTERNS) {
    out = out.replace(pattern, "***");
  }
  return out;
}

/**
 * Keeps only the last `max` bytes of `text` (UTF-8), reporting whether it truncated.
 * After slicing, skips forward past any leading UTF-8 continuation bytes so the
 * result never starts mid-codepoint (which `Buffer#toString` would otherwise
 * render as a leading U+FFFD replacement character).
 */
export function tailBytes(text: string, max: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= max) return { text, truncated: false };
  let start = buf.length - max;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return { text: buf.subarray(start).toString("utf-8"), truncated: true };
}

/**
 * Every value in `process.env` whose key ends in _TOKEN, _KEY, _SECRET, or
 * _PASSWORD — restricted to values at least 8 characters long so a short,
 * common value (e.g. `FOO_KEY=main`) can't blanket-redact ordinary evidence
 * text via `replaceAll`.
 */
export function envSecrets(): string[] {
  const pattern = /(_TOKEN|_KEY|_SECRET|_PASSWORD)$/;
  return Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length >= 8)
    .filter(([key]) => pattern.test(key))
    .map(([, value]) => value);
}

function buildTail(text: string, secrets: string[]): { tail: string; truncated: boolean } {
  const { text: tail, truncated } = tailBytes(redactEvidence(text, secrets), EVIDENCE_TAIL_BYTES);
  return { tail, truncated };
}

/** Returned by `oneLinerMessage` when `text` has no non-blank line — a human-readable
 *  placeholder rather than leaking a bare machine code (e.g. "PROCESS_SIGNALLED") into
 *  ticket-facing prose. */
export const NO_DETAIL_MESSAGE = "The runner reported no detail.";

/** Character cap applied to a SENSITIVE_FILES_BLOCKED guardrail reason, shared between this
 *  module's own `redactAndCap` call below and `completion-classification.ts`'s
 *  `redactedGuardrailReason` — generous enough that an ordinary flagged-file list never
 *  gets cut, but bounds a pathological one. A single exported constant keeps both call
 *  sites from drifting apart if the cap is ever tuned. */
export const GUARDRAIL_REASON_MAX_CHARS = 1200;

/**
 * First non-blank line of `text`, redacted and capped at 500 characters. Shared by every
 * `FailureRecord.message` derivation here. Also exported so call sites outside this module
 * (the push step's mid-retry notes) can format an appended note the same way, rather than
 * splicing raw, unredacted, unbounded error text.
 *
 * `fallback` defaults to `NO_DETAIL_MESSAGE` for the `FailureRecord.message` call sites in
 * this module, but a caller building an optional, parenthetical note (the push step's
 * mid-retry notes) can pass `""` instead — a blank underlying reason then contributes
 * nothing to the note rather than a placeholder sentence that would read strangely
 * embedded mid-sentence.
 */
export function oneLinerMessage(text: string, secrets: string[], fallback: string = NO_DETAIL_MESSAGE): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return fallback;
  const redacted = redactEvidence(line, secrets);
  return redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted;
}

/**
 * Redacts `text` (the same secret set `oneLinerMessage`/evidence tails use) then caps it to
 * `max` characters, truncating from the *end* with a trailing "…" rather than the start —
 * the opposite direction from evidence tails' tail-preserving cap, since a guardrail reason's
 * most important content (the header and the flagged-file list) comes first. Unlike
 * `oneLinerMessage`, keeps embedded line breaks intact, so a multi-line reason (e.g. the
 * push step's flagged-file list) survives rather than collapsing to its first line. Never
 * splits a UTF-16 surrogate pair at the cut point.
 */
export function redactAndCap(text: string, max: number, secrets: string[] = envSecrets()): string {
  const redacted = redactEvidence(text, secrets);
  if (redacted.length <= max) return redacted;
  let end = max - 1; // reserve one character for the trailing "…"
  if (end > 0 && redacted.charCodeAt(end - 1) >= 0xd800 && redacted.charCodeAt(end - 1) <= 0xdbff) end -= 1;
  return `${redacted.slice(0, end)}…`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shape check only — used both to recognise an already-attached record and to validate a runner callback body. */
export function isFailureRecord(value: unknown): value is FailureRecord {
  if (!isPlainObject(value)) return false;
  if (typeof value.category !== "string" || !FAILURE_CATEGORIES.includes(value.category as FailureCategory)) {
    return false;
  }
  if (typeof value.code !== "string") return false;
  if (typeof value.stage !== "string") return false;
  if (typeof value.attempt !== "number") return false;
  if (typeof value.retryable !== "boolean") return false;
  if (typeof value.message !== "string") return false;
  if (value.reviewMaxTurns !== undefined && typeof value.reviewMaxTurns !== "number") return false;
  if (!isPlainObject(value.evidence) || typeof value.evidence.truncated !== "boolean") return false;
  const { stdoutTail, stderrTail, captureError, llmOutcome } = value.evidence;
  // Reject the wrong type outright rather than only checking length when it
  // happens to already be a string — a non-string value must not slip through
  // just because the length check never ran.
  if (stdoutTail !== undefined && typeof stdoutTail !== "string") return false;
  if (stderrTail !== undefined && typeof stderrTail !== "string") return false;
  if (captureError !== undefined && typeof captureError !== "string") return false;
  if (
    llmOutcome !== undefined &&
    llmOutcome !== null &&
    (typeof llmOutcome !== "string" || !RUN_TELEMETRY_OUTCOMES.has(llmOutcome))
  ) {
    return false;
  }
  if (typeof stdoutTail === "string" && Buffer.byteLength(stdoutTail, "utf-8") > EVIDENCE_TAIL_BYTES) return false;
  if (typeof stderrTail === "string" && Buffer.byteLength(stderrTail, "utf-8") > EVIDENCE_TAIL_BYTES) return false;
  return true;
}

/**
 * Re-derives a `FailureRecord` field-by-field from a value already narrowed by
 * `isFailureRecord`, so an object that merely satisfies that shape check can't
 * carry extra, unrecognised keys along into `failure_json` — `isFailureRecord`
 * only checks that the required fields are present and well-typed, not that
 * there is nothing else on the object.
 */
export function projectFailureRecord(value: FailureRecord): FailureRecord {
  const { evidence } = value;
  return {
    category: value.category,
    code: value.code,
    stage: value.stage,
    attempt: value.attempt,
    retryable: value.retryable,
    ...(value.exitCode !== undefined ? { exitCode: value.exitCode } : {}),
    ...(value.signal !== undefined ? { signal: value.signal } : {}),
    ...(value.elapsedMs !== undefined ? { elapsedMs: value.elapsedMs } : {}),
    message: value.message,
    ...(value.reviewMaxTurns !== undefined ? { reviewMaxTurns: value.reviewMaxTurns } : {}),
    evidence: {
      ...(evidence.stdoutTail !== undefined ? { stdoutTail: evidence.stdoutTail } : {}),
      ...(evidence.stderrTail !== undefined ? { stderrTail: evidence.stderrTail } : {}),
      truncated: evidence.truncated,
      ...(evidence.llmSubtype !== undefined ? { llmSubtype: evidence.llmSubtype } : {}),
      ...(evidence.llmIsError !== undefined ? { llmIsError: evidence.llmIsError } : {}),
      ...(evidence.llmOutcome !== undefined ? { llmOutcome: evidence.llmOutcome } : {}),
      ...(evidence.captureError !== undefined ? { captureError: evidence.captureError } : {}),
    },
  };
}

function fallbackRecord(
  ctx: { stage: string; attempt: number },
  captureErr: unknown,
  originalMessage: string,
): FailureRecord {
  console.error(`[failure-classification] evidence capture failed: ${String(captureErr)}`);
  return {
    category: "unknown",
    code: "UNKNOWN",
    stage: ctx.stage,
    attempt: ctx.attempt,
    retryable: false,
    message: originalMessage || "failure classification could not capture evidence",
    evidence: {
      truncated: true,
      captureError: String(captureErr),
    },
  };
}

/**
 * Classifies a completed (but failing, or incomplete) LLM invocation. Used
 * both for a non-zero exit and for a structurally invalid result (missing
 * structured output) — the caller has already decided the result represents
 * a failure; this only assigns a category, code and evidence to it.
 */
export function classifyLlmResult(
  result: LLMResult,
  ctx: {
    stage: string;
    attempt: number;
    elapsedMs?: number;
    /**
     * Whether this call site requires `structuredOutput` (review does; implement
     * never requests it). Gates `invalid_output`/`LLM_NO_STRUCTURED_OUTPUT` so an
     * implement crash — which never has structured output to begin with — isn't
     * misclassified as one.
     */
    expectsStructuredOutput: boolean;
  },
): FailureRecord {
  try {
    const secrets = envSecrets();
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const text = [stderr, stdout].filter(Boolean).join("\n");

    let category: FailureCategory;
    let code: string;
    if (result.signal) {
      // A SIGTERM/SIGKILL/SIGINT close always means an external cancellation (job
      // timeout, GHA cancellation, OOM) — checked ahead of any text signature so a
      // signalled attempt is never mistaken for e.g. a provider transient error.
      category = "cancelled";
      code = "PROCESS_SIGNALLED";
    } else if (result.exitCode === 0) {
      // Structural checks first, ahead of any text signature: the model's own final
      // text is part of PROVIDER_SIGNATURES' match input (see signatureMatchText), so
      // a reviewer note like "treat API Error 503 as transient" appearing in a dropped
      // verdict's stdout must not turn a structural failure into a retryable transport
      // one. PROVIDER_SIGNATURES is consulted only in the exitCode !== 0 branch below.
      // Ordered so a genuinely absent result event (terminalStatus == null, which
      // also always means structuredOutput === undefined — both derive from the
      // same event) is never shadowed by the missing-structured-output check below:
      // no terminal event → terminal error → outcome mismatch → missing structured
      // output. The last of these is reachable only once the earlier, more specific
      // checks have ruled themselves out.
      if (ctx.expectsStructuredOutput && result.terminalStatus == null) {
        // No terminal event at all is a distinct failure from one that arrived but
        // reported an error — gated on expectsStructuredOutput so an implement call
        // site (which never inspects terminalStatus) isn't affected.
        category = "invalid_output";
        code = "LLM_NO_TERMINAL_EVENT";
      } else if (
        result.terminalStatus?.isError === true ||
        (ctx.expectsStructuredOutput && result.terminalStatus != null && result.terminalStatus.subtype !== "success")
      ) {
        category = "invalid_output";
        code = "LLM_TERMINAL_ERROR";
      } else if (
        ctx.expectsStructuredOutput &&
        result.telemetry?.outcome != null &&
        result.telemetry.outcome !== "success"
      ) {
        // Terminal status reported success but the run's own telemetry outcome
        // disagrees (e.g. subtype: success / outcome: max_turns) — surfaced as
        // evidence.llmOutcome regardless, but gated here on expectsStructuredOutput
        // so this stays a review-only structural check.
        category = "invalid_output";
        code = "LLM_OUTCOME_MISMATCH";
      } else if (ctx.expectsStructuredOutput && result.structuredOutput === undefined) {
        category = "invalid_output";
        code = "LLM_NO_STRUCTURED_OUTPUT";
      } else {
        category = "unknown";
        code = "UNKNOWN";
      }
    } else {
      const matched = matchSignature(PROVIDER_SIGNATURES, signatureMatchText(stdout, stderr));
      if (matched) {
        category = matched.category;
        code = matched.code;
      } else {
        category = "crash";
        code = "PROCESS_EXIT_NONZERO";
      }
    }

    const stdoutInfo = stdout ? buildTail(stdout, secrets) : null;
    const stderrInfo = stderr ? buildTail(stderr, secrets) : null;

    return {
      category,
      code,
      stage: ctx.stage,
      attempt: ctx.attempt,
      retryable: category === "transient",
      exitCode: result.exitCode,
      signal: result.signal ?? null,
      elapsedMs: ctx.elapsedMs,
      message: oneLinerMessage(text, secrets),
      evidence: {
        ...(stdoutInfo ? { stdoutTail: stdoutInfo.tail } : {}),
        ...(stderrInfo ? { stderrTail: stderrInfo.tail } : {}),
        truncated: Boolean(stdoutInfo?.truncated || stderrInfo?.truncated),
        llmOutcome: result.telemetry?.outcome ?? null,
        llmSubtype: result.terminalStatus?.subtype ?? null,
        llmIsError: result.terminalStatus?.isError ?? null,
      },
    };
  } catch (captureErr) {
    return fallbackRecord(ctx, captureErr, result?.stderr || result?.stdout || "");
  }
}

/**
 * Whether a settled attempt represents a failure at all — the gate the executor
 * runs before calling `classifyLlmResult`, which cannot be called unconditionally:
 * once `exitCode === 0`, its structural branches fall back to `"unknown"` when
 * nothing else matches, which is indistinguishable from a genuine success unless
 * the caller already knows a failure occurred. Mirrors the same conditions
 * `classifyLlmResult` uses to pick a code, minus that fallback.
 */
export function isLlmResultFailure(result: LLMResult, expectsStructuredOutput: boolean): boolean {
  if (result.signal) return true;
  if (result.exitCode !== 0) return true;
  // Mirrors classifyLlmResult's exit-0 branch order exactly (minus the "unknown"
  // fallback): a terminal error is a failure regardless of expectsStructuredOutput,
  // so this must not early-return false for implement before checking it.
  if (expectsStructuredOutput && result.terminalStatus == null) return true;
  if (result.terminalStatus?.isError === true) return true;
  if (expectsStructuredOutput && result.terminalStatus != null && result.terminalStatus.subtype !== "success") return true;
  if (expectsStructuredOutput && result.telemetry?.outcome != null && result.telemetry.outcome !== "success") return true;
  if (expectsStructuredOutput && result.structuredOutput === undefined) return true;
  return false;
}

/**
 * Classifies a rejection from spawning the CLI process itself — `proc.on("error")`
 * (the binary is missing, or the host is out of resources) or the stdin EPIPE
 * handler (EPIPE means the child stopped reading stdin; it may still be alive,
 * which is why the handler kills it and waits for `close` rather than rejecting
 * immediately). No LLMResult exists at this point, so this is a distinct entry
 * point from classifyLlmResult. ENOENT means the binary itself can't be found —
 * retrying won't fix a config problem; EAGAIN/ENOMEM/EPIPE are host resource
 * pressure and are transient.
 */
export function classifySpawnError(err: unknown, ctx: { stage: string; attempt: number }): FailureRecord {
  try {
    const secrets = envSecrets();
    const message = err instanceof Error ? err.message : String(err);
    const code = isPlainObject(err) && typeof err.code === "string" ? err.code : undefined;
    const category: FailureCategory =
      code === "ENOENT" ? "config" : code === "EAGAIN" || code === "ENOMEM" || code === "EPIPE" ? "transient" : "crash";
    return {
      category,
      code: "PROCESS_SPAWN_FAILED",
      stage: ctx.stage,
      attempt: ctx.attempt,
      retryable: category === "transient",
      message: oneLinerMessage(message, secrets),
      evidence: { truncated: false, llmSubtype: null, llmIsError: null, llmOutcome: null },
    };
  } catch (captureErr) {
    return fallbackRecord(ctx, captureErr, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Classifies a failed git invocation (push, ls-remote, etc). `stderr` is
 * expected to already have any run-specific credential redacted by the
 * caller (as the push step already does with `activeGithubToken`) — this
 * additionally applies the fixed pattern set and any `_TOKEN`/`_KEY`/
 * `_SECRET`/`_PASSWORD` env values.
 *
 * The BAC-27048 `commit_refs` fixture is transient by classification, but its
 * real cause is not established — `message` always carries the original git
 * text so that uncertainty is not lost behind the category.
 */
export function classifyGitFailure(
  stderr: string,
  exitStatus: number | null,
  ctx: { stage: string; attempt: number },
): FailureRecord {
  try {
    const secrets = envSecrets();
    const text = stderr ?? "";
    const matched = matchSignature(GIT_SIGNATURES, text) ?? { category: "unknown" as const, code: "UNKNOWN" };
    const stderrInfo = text ? buildTail(text, secrets) : null;

    return {
      category: matched.category,
      code: matched.code,
      stage: ctx.stage,
      attempt: ctx.attempt,
      retryable: matched.category === "transient",
      exitCode: exitStatus,
      signal: null,
      message: oneLinerMessage(text, secrets),
      evidence: {
        ...(stderrInfo ? { stderrTail: stderrInfo.tail } : {}),
        truncated: Boolean(stderrInfo?.truncated),
        llmSubtype: null,
        llmIsError: null,
      },
    };
  } catch (captureErr) {
    return fallbackRecord(ctx, captureErr, stderr || "");
  }
}

/**
 * Renders a PROVIDER_UNAVAILABLE FailureRecord's `stage` into the two phrase
 * fragments `formatFailureComment` (runner-callback.ts) and `formatRunAutopsy`
 * (run-autopsy.ts) share: which phase failed, and what state the code was left
 * in. Only the implement branch varies by `hasPr` (BAC-27134): a dirty tree
 * gets pushed as a draft PR and reads "partially implemented", while a clean
 * tree throws before any push exists and must not claim partial work survived.
 * Every other stage (including an unrecognised one) reads as "not reviewed",
 * the safer default since it never claims code changed that didn't.
 */
export function providerUnavailablePhrase(
  stage: string | undefined,
  hasPr: boolean,
): { stageLabel: string; codeState: string } {
  if (stage === "implement") {
    return hasPr
      ? { stageLabel: "implementation", codeState: "partially implemented" }
      : { stageLabel: "implementation", codeState: "not implemented" };
  }
  if (stage === "post-push-review") return { stageLabel: "post-push review", codeState: "not reviewed" };
  return { stageLabel: "review", codeState: "not reviewed" };
}

function attachedFailure(err: unknown): FailureRecord | null {
  if (!isPlainObject(err)) return null;
  const failure = (err as Record<string, unknown>).failure;
  return isFailureRecord(failure) ? failure : null;
}

function detectSignal(err: unknown, message: string): string | null {
  const carried = isPlainObject(err) ? err.signal : null;
  if (typeof carried === "string" && /^SIG(TERM|KILL|INT)$/.test(carried)) return carried;
  const found = message.match(/\bSIG(TERM|KILL|INT)\b/);
  return found ? `SIG${found[1]}` : null;
}

function carriedExitCode(err: unknown): number | null {
  if (!isPlainObject(err)) return null;
  if (typeof err.exitCode === "number") return err.exitCode;
  if (typeof err.code === "number") return err.code;
  return null;
}

function exitCodeFromMessage(message: string): number | null {
  const match = message.match(/\(exit (\d+)\)|exit code (\d+)/i);
  if (!match) return null;
  const raw = match[1] ?? match[2];
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Classifies an arbitrary thrown error from a pipeline step. If a more
 * specific classifier already attached a `FailureRecord` (`err.failure`,
 * set by the implement/review/push steps), that record is returned as-is
 * rather than re-derived from the stringified message.
 */
export function classifyThrown(err: unknown, ctx: { stage: string; attempt: number }): FailureRecord {
  try {
    const attached = attachedFailure(err);
    if (attached) return attached;

    const secrets = envSecrets();
    const message = err instanceof Error ? err.message : String(err);
    const signal = detectSignal(err, message);
    if (signal) {
      return {
        category: "cancelled",
        code: "PROCESS_SIGNALLED",
        stage: ctx.stage,
        attempt: ctx.attempt,
        retryable: false,
        exitCode: carriedExitCode(err),
        signal,
        message: oneLinerMessage(message, secrets),
        evidence: { truncated: false, llmSubtype: null, llmIsError: null },
      };
    }

    // SensitiveFilesError (src/pipeline/sensitive-files.ts) carries a string `code`
    // rather than an attached FailureRecord — duck-typed here instead of imported to
    // avoid a cross-module dependency for a single-field check.
    const carriedCode = isPlainObject(err) && typeof err.code === "string" ? err.code : null;
    if (carriedCode === "SENSITIVE_FILES_BLOCKED") {
      return {
        category: "config",
        code: "SENSITIVE_FILES_BLOCKED",
        stage: ctx.stage,
        attempt: ctx.attempt,
        retryable: false,
        exitCode: null,
        signal: null,
        // redactAndCap, not oneLinerMessage: the guardrail message is
        // formatSensitiveFilesError's multi-line flagged-file list, and one-lining it
        // here threw away the list before it ever reached the tracker comment.
        message: message.trim() ? redactAndCap(message, GUARDRAIL_REASON_MAX_CHARS, secrets) : NO_DETAIL_MESSAGE,
        evidence: { truncated: false, llmSubtype: null, llmIsError: null },
      };
    }

    // Git output is checked ahead of the provider table so a git-side auth/transient/
    // conflict signature (e.g. a 403 from a rejected push) isn't misclassified under a
    // PROVIDER_* code merely because both tables recognise overlapping tokens like "403".
    const looksLikeGitOutput = GIT_MESSAGE_MARKER.test(message);
    const matched = looksLikeGitOutput
      ? matchSignature(GIT_SIGNATURES, message) ?? matchSignature(PROVIDER_SIGNATURES, message)
      : matchSignature(PROVIDER_SIGNATURES, message);
    const exitCode = carriedExitCode(err) ?? exitCodeFromMessage(message);
    let category: FailureCategory;
    let code: string;
    if (matched) {
      category = matched.category;
      code = matched.code;
    } else if (exitCode != null && exitCode !== 0) {
      category = "crash";
      code = "PROCESS_EXIT_NONZERO";
    } else {
      category = "unknown";
      code = "UNKNOWN";
    }

    return {
      category,
      code,
      stage: ctx.stage,
      attempt: ctx.attempt,
      retryable: category === "transient",
      exitCode: exitCode ?? null,
      signal: null,
      message: oneLinerMessage(message, secrets),
      evidence: { truncated: false, llmSubtype: null, llmIsError: null },
    };
  } catch (captureErr) {
    return fallbackRecord(ctx, captureErr, err instanceof Error ? err.message : String(err));
  }
}
