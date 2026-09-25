import fs from "node:fs";
import path from "node:path";
import { envSecrets, redactAndCap, redactEvidence } from "./failure-classification.js";
import { ACTIVITY_MAX_EVENT_BYTES, type RunTelemetry } from "./types.js";

/**
 * Per-review-cycle evidence contract (AII-801). Emitted once per feedback-loop
 * implement/review pass and once per post-push-review fix pass, independently of
 * the tool-activity buffer AII-784/798 own (`ActivitySink`/`CycleActivitySummary`
 * in ./types.js) — this is a declared append-only file (mirrors
 * `finding-dispositions.ts`'s `DISPOSITIONS_FILE` convention) so a later swap to
 * a real sink is additive rather than a rewrite.
 *
 * This file's own durability ends at runner teardown. `run-autonomous.ts` forwards each
 * pilot record through the independently authenticated `/runner/cycle-summary` callback
 * before terminal result intake, so even a run without an output commit can retain evidence.
 * See docs/cycle-summary-evidence.md for the full path and Legacy limitation.
 */

export type TestStatus = "passed" | "failed" | "missing" | "skipped" | "unobserved";

export interface CycleTestResult {
  name: string;
  status: TestStatus;
}

export interface CycleDisposition {
  key: string;
  disposition: string;
}

export interface CycleUsage {
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

/** `approved` is `null` when the cycle ended before a verdict was reached (error/incomplete),
 *  never inferred as `false` — `reason` carries the short machine code (e.g. a termination
 *  reason already used elsewhere in the pipeline) and `summary` an optional redacted, capped
 *  human-readable note. */
export interface CycleVerdict {
  approved: boolean | null;
  reason: string;
  summary?: string;
}

export type CycleOutputCommitStatus = "committed" | "pending_push" | "not_applicable";

export interface CycleSummary {
  /** Stable per-cycle identity (e.g. "feedback-loop.2", "post-push-review.fix-1"). Writing the
   *  same id again with identical content is an idempotent no-op; writing it again with
   *  different content is rejected (the first-recorded summary wins) rather than silently
   *  replacing it — see `appendCycleSummary`. */
  id: string;
  stage: "feedback-loop" | "post-push-review-fix";
  cycle: number;
  inputCommit: string | null;
  outputCommit: string | null;
  outputCommitStatus: CycleOutputCommitStatus;
  dispositions: CycleDisposition[];
  /** Never empty — a cycle with no observed test evidence still carries one entry with an
   *  explicit non-"passed" status rather than an absent/empty list. */
  tests: CycleTestResult[];
  verdict: CycleVerdict;
  usage: CycleUsage;
  /** True when any field below was capped (verdict summary redaction/cap, or the whole-record
   *  byte limit below). */
  truncated: boolean;
  /** True only when the whole-record byte cap (`CYCLE_SUMMARY_MAX_BYTES`) was hit and fields
   *  had to be dropped, not merely capped. */
  limitReached: boolean;
  /** Epoch-ms captured once, at write time, by `writeCycleSummary` — never passed in by a
   *  caller and never recomputed on read. A durable-storage forwarder (`recordReviewFixCycleSummary`,
   *  ../review-fix-evidence.ts) hashes this field as part of the record's identity/payload
   *  idempotency check, so it must stay byte-identical across every retry of the same write; a
   *  value that changed each time it was read would turn an idempotent replay into a spurious
   *  conflict. */
  completedAt: number;
}

export type CycleSummaryInput = Omit<CycleSummary, "truncated" | "limitReached" | "completedAt">;

/** Mirrors `ACTIVITY_MAX_EVENT_BYTES` (16 KiB) — the same per-record ceiling the tool-activity
 *  contract uses, reused here as a single source of truth rather than a second magic number. */
export const CYCLE_SUMMARY_MAX_BYTES = ACTIVITY_MAX_EVENT_BYTES;

export const CYCLE_SUMMARY_FILE = "ai-output/cycle-summaries.jsonl";

const VERDICT_SUMMARY_MAX_CHARS = 2000;
const MAX_TEST_NAME_CHARS = 200;
const MAX_DISPOSITION_FIELD_CHARS = 200;
const MAX_TEST_ENTRIES = 50;
const MAX_DISPOSITION_ENTRIES = 200;
/** Hard fallback cap applied only when the record still exceeds `CYCLE_SUMMARY_MAX_BYTES`
 *  after the normal per-field caps above. */
const OVERFLOW_ENTRY_CAP = 10;
/** Last-resort placeholder when even the overflow cap above still leaves the record oversized
 *  (e.g. many long entries survive per-field capping). Keeps the "tests is never empty"
 *  invariant while guaranteeing the record shrinks to something well under the byte cap. */
const SIZE_LIMIT_TEST_PLACEHOLDER: CycleTestResult = {
  name: "test evidence omitted (cycle-summary size limit)",
  status: "unobserved",
};

const TEST_COMMAND_RE = /\b(npm (run )?test|npm run typecheck|vitest|jest|pytest|go test|yarn test|pnpm test|tsc)\b/i;

/** `telemetry?.toolTrace ?? []` — a small helper so call sites never repeat the optional chain. */
export function toolTraceLines(telemetry: RunTelemetry | undefined): string[] {
  return telemetry?.toolTrace ?? [];
}

/**
 * Best-effort scan for test-runner invocations across tool-trace lines and/or free-text agent
 * notes (e.g. the fix agent's `testing[]` summary). These remain unobserved unless a matching
 * structured Bash tool_result is supplied through `observed`. No verdict is inferred from
 * agent prose. With no recognised command, the result explicitly says "missing".
 */
export function inferTestResults(sources: string[], secrets: string[] = envSecrets(), observed: readonly { command: string; failed: boolean }[] = []): CycleTestResult[] {
  const witnessed = observed.filter((entry) => TEST_COMMAND_RE.test(entry.command)).map((entry) => ({
    name: redactEvidence(entry.command.trim(), secrets).slice(0, MAX_TEST_NAME_CHARS),
    status: (entry.failed ? "failed" : "passed") as TestStatus,
  }));
  const candidates = sources.filter((line) => TEST_COMMAND_RE.test(line));
  if (candidates.length === 0 && witnessed.length === 0) {
    return [{ name: "test execution", status: "missing" }];
  }
  return [...witnessed, ...candidates.filter((line) => !witnessed.some((entry) => line.includes(entry.name))).map((line) => ({
    name: redactEvidence(line.trim(), secrets).slice(0, MAX_TEST_NAME_CHARS),
    status: "unobserved" as TestStatus,
  }))];
}

/** Nullable-aware sum across every telemetry object a cycle spent (e.g. implement + review) —
 *  a field stays `null` only when every source left it `null`/absent. */
export function sumUsage(...tels: (RunTelemetry | undefined)[]): CycleUsage {
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let costUsd: number | null = null;
  for (const t of tels) {
    if (!t) continue;
    if (t.tokensIn != null) tokensIn = (tokensIn ?? 0) + t.tokensIn;
    if (t.tokensOut != null) tokensOut = (tokensOut ?? 0) + t.tokensOut;
    if (t.costUsd != null) costUsd = (costUsd ?? 0) + t.costUsd;
  }
  return { tokensIn, tokensOut, costUsd };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Exported so a consumer that receives a `CycleSummary` over the wire (e.g. `/runner/result`'s
 *  forwarded `cycleSummaries`, AII-801) can shape-validate an entry the same way the file reader
 *  below does, rather than re-implementing this check. */
export function isCycleSummary(value: unknown): value is CycleSummary {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 128) return false;
  if (value.stage !== "feedback-loop" && value.stage !== "post-push-review-fix") return false;
  if (!Number.isSafeInteger(value.cycle) || (value.cycle as number) <= 0) return false;
  if ((value.inputCommit !== null && (typeof value.inputCommit !== "string" || value.inputCommit.length > 40))
    || (value.outputCommit !== null && (typeof value.outputCommit !== "string" || value.outputCommit.length > 40))) return false;
  if (value.outputCommitStatus !== "committed" && value.outputCommitStatus !== "pending_push" && value.outputCommitStatus !== "not_applicable") return false;
  if (!Array.isArray(value.dispositions) || !value.dispositions.every((d) => isRecord(d) && typeof d.key === "string" && typeof d.disposition === "string")) return false;
  if (!Array.isArray(value.tests) || value.tests.length === 0 || !value.tests.every((t) => isRecord(t) && typeof t.name === "string" && ["passed", "failed", "missing", "skipped", "unobserved"].includes(String(t.status)))) return false;
  if (!isRecord(value.verdict) || typeof value.verdict.reason !== "string" || value.verdict.reason.length > 128) return false;
  if (value.verdict.approved !== null && typeof value.verdict.approved !== "boolean") return false;
  if (value.verdict.summary !== undefined && typeof value.verdict.summary !== "string") return false;
  if (!isRecord(value.usage)) return false;
  for (const field of [value.usage.tokensIn, value.usage.tokensOut, value.usage.costUsd]) {
    if (field !== null && (typeof field !== "number" || !Number.isFinite(field))) return false;
  }
  if (typeof value.truncated !== "boolean" || typeof value.limitReached !== "boolean") return false;
  if (!Number.isSafeInteger(value.completedAt) || (value.completedAt as number) <= 0) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf-8") <= CYCLE_SUMMARY_MAX_BYTES;
  } catch {
    return false;
  }
}

/** Filters `value` down to well-formed `CycleSummary` entries, same fail-safe convention as
 *  `sanitizeFindingDispositions` (../finding-dispositions.ts): a non-array or an individual
 *  malformed entry is dropped and counted rather than rejecting the whole batch — a newer runner
 *  reporting a shape this orchestrator doesn't yet know about must not stall the callback. */
export function sanitizeCycleSummaries(value: unknown): { valid: CycleSummary[]; dropped: number } {
  if (!Array.isArray(value)) return { valid: [], dropped: 0 };
  const valid: CycleSummary[] = [];
  let dropped = 0;
  for (const entry of value) {
    if (isCycleSummary(entry)) valid.push(entry);
    else dropped++;
  }
  return { valid, dropped };
}

/** Reads every well-formed record from `CYCLE_SUMMARY_FILE`; a missing file, malformed JSON, or
 *  a line that fails the shape check is skipped rather than failing the read — the same
 *  fail-safe convention `readFindingDispositions` uses. */
export function readCycleSummaries(workspaceDir: string): CycleSummary[] {
  const filePath = path.join(workspaceDir, CYCLE_SUMMARY_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const out: CycleSummary[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isCycleSummary(parsed)) out.push(parsed);
    } catch {
      // Skip a malformed line rather than failing the whole read.
    }
  }
  return out;
}

/**
 * Appends `record` to `CYCLE_SUMMARY_FILE`, honoring the "same identity, same payload is
 * idempotent; conflicting payload is rejected" contract at the file layer:
 *  - No prior record for `record.id` → append.
 *  - A prior record for `record.id` with byte-identical content → no-op (idempotent replay of
 *    an already-durable cycle; the file is not rewritten).
 *  - A prior record for `record.id` with *different* content → rejected and alerted via
 *    `console.warn`; the first-recorded summary is left in place, never silently overwritten.
 *    Every real call site in `feedback-loop.ts`/`post-push-review.ts` writes a given cycle id
 *    exactly once per run (each is a terminal branch of a mutually-exclusive per-iteration
 *    outcome), so a same-id conflict here signals an anomaly, not a normal state transition.
 */
function appendCycleSummary(workspaceDir: string, record: CycleSummary): void {
  const filePath = path.join(workspaceDir, CYCLE_SUMMARY_FILE);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = readCycleSummaries(workspaceDir);
  const priorIndex = existing.findIndex((s) => s.id === record.id);
  if (priorIndex !== -1) {
    if (JSON.stringify(existing[priorIndex]) === JSON.stringify(record)) return;
    console.warn(
      `[cycle-summary] conflicting cycle summary for id "${record.id}": a different summary is ` +
        "already recorded for this identity; keeping the first-recorded summary and discarding this write",
    );
    return;
  }
  const all = [...existing, record];
  fs.writeFileSync(filePath, `${all.map((s) => JSON.stringify(s)).join("\n")}\n`, "utf-8");
}

/** Redacts, then caps `value` to `maxChars`; `truncated` is explicit rather than inferred from
 *  length so a caller never has to re-derive it from the redacted-and-capped result. */
function boundField(value: string, maxChars: number, secrets: string[]): { value: string; truncated: boolean } {
  const capped = redactAndCap(value, maxChars, secrets);
  return { value: capped, truncated: capped.endsWith("…") };
}

/**
 * Redacts and bounds `input` to `CYCLE_SUMMARY_MAX_BYTES`, then appends it to
 * `CYCLE_SUMMARY_FILE` (best-effort — a write failure is logged and swallowed, matching the
 * feedback-loop step's own non-fatal file-write convention, so a cycle-summary write can never
 * fail the run it is reporting on). Cycle input/output commits, dispositions, tests, verdict and
 * usage are otherwise carried in full; every free-text field (`verdict.summary`, each test's
 * `name`, each disposition's `key`/`disposition`) is individually bounded so that capping the
 * *number* of entries can never be defeated by leaving the surviving entries' strings unbounded,
 * and the final serialized size is verified explicitly — never assumed — with a last-resort
 * fallback for a pathological input that still overflows after every per-field/per-array cap.
 */
export function writeCycleSummary(
  workspaceDir: string,
  input: CycleSummaryInput,
  now: () => number = Date.now,
): CycleSummary {
  const secrets = envSecrets();
  const completedAt = now();
  let truncated = false;

  let verdictSummary = input.verdict.summary;
  if (verdictSummary !== undefined) {
    const capped = boundField(verdictSummary, VERDICT_SUMMARY_MAX_CHARS, secrets);
    if (capped.truncated) truncated = true;
    verdictSummary = capped.value;
  }

  const boundedTests: CycleTestResult[] = input.tests.map((t) => {
    const name = boundField(t.name, MAX_TEST_NAME_CHARS, secrets);
    if (name.truncated) truncated = true;
    return { name: name.value, status: t.status };
  });
  const boundedDispositions: CycleDisposition[] = input.dispositions.map((d) => {
    const key = boundField(d.key, MAX_DISPOSITION_FIELD_CHARS, secrets);
    const disposition = boundField(d.disposition, MAX_DISPOSITION_FIELD_CHARS, secrets);
    if (key.truncated || disposition.truncated) truncated = true;
    return { key: key.value, disposition: disposition.value };
  });
  if (boundedTests.length > MAX_TEST_ENTRIES || boundedDispositions.length > MAX_DISPOSITION_ENTRIES) {
    truncated = true;
  }

  let record: CycleSummary = {
    id: boundField(input.id, 128, secrets).value,
    stage: input.stage,
    cycle: input.cycle,
    inputCommit: input.inputCommit && input.inputCommit.length <= 40 ? input.inputCommit : null,
    outputCommit: input.outputCommit && input.outputCommit.length <= 40 ? input.outputCommit : null,
    outputCommitStatus: input.outputCommitStatus,
    dispositions: boundedDispositions.slice(0, MAX_DISPOSITION_ENTRIES),
    tests: boundedTests.slice(0, MAX_TEST_ENTRIES),
    verdict: {
      approved: input.verdict.approved,
      reason: boundField(input.verdict.reason, 128, secrets).value,
      ...(verdictSummary !== undefined ? { summary: verdictSummary } : {}),
    },
    usage: input.usage,
    truncated,
    limitReached: false,
    completedAt,
  };
  if (record.id !== input.id || record.verdict.reason !== input.verdict.reason
    || record.inputCommit !== input.inputCommit || record.outputCommit !== input.outputCommit) truncated = true;

  let limitReached = false;
  let sizeBytes = Buffer.byteLength(JSON.stringify(record), "utf-8");
  if (sizeBytes > CYCLE_SUMMARY_MAX_BYTES) {
    limitReached = true;
    truncated = true;
    record = {
      ...record,
      verdict: { approved: record.verdict.approved, reason: record.verdict.reason },
      tests: record.tests.slice(0, OVERFLOW_ENTRY_CAP),
      dispositions: record.dispositions.slice(0, OVERFLOW_ENTRY_CAP),
    };
    sizeBytes = Buffer.byteLength(JSON.stringify(record), "utf-8");
  }
  // Last resort: per-field bounds plus the ten-entry overflow cap above bound every realistic
  // input, but the size is verified rather than assumed — a record that still overflows drops
  // to the smallest valid shape (one placeholder test entry, no dispositions) instead of being
  // written oversized or dropped entirely.
  if (sizeBytes > CYCLE_SUMMARY_MAX_BYTES) {
    record = { ...record, tests: [SIZE_LIMIT_TEST_PLACEHOLDER], dispositions: [] };
    sizeBytes = Buffer.byteLength(JSON.stringify(record), "utf-8");
    if (sizeBytes > CYCLE_SUMMARY_MAX_BYTES) {
      console.warn(
        `[cycle-summary] cycle summary "${record.id}" is ${sizeBytes} bytes, still over the ` +
          `${CYCLE_SUMMARY_MAX_BYTES}-byte cap after the full fallback; omitting it`,
      );
      return record;
    }
  }
  record.truncated = truncated;
  record.limitReached = limitReached;

  try {
    appendCycleSummary(workspaceDir, record);
  } catch (err) {
    console.warn(`[cycle-summary] could not write cycle summary ${record.id} (non-fatal): ${String(err)}`);
  }
  return record;
}
