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
   *  same id again replaces the prior record for that id rather than duplicating it. */
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
}

export type CycleSummaryInput = Omit<CycleSummary, "truncated" | "limitReached">;

/** Mirrors `ACTIVITY_MAX_EVENT_BYTES` (16 KiB) — the same per-record ceiling the tool-activity
 *  contract uses, reused here as a single source of truth rather than a second magic number. */
export const CYCLE_SUMMARY_MAX_BYTES = ACTIVITY_MAX_EVENT_BYTES;

export const CYCLE_SUMMARY_FILE = "ai-output/cycle-summaries.jsonl";

const VERDICT_SUMMARY_MAX_CHARS = 2000;
const MAX_TEST_ENTRIES = 50;
const MAX_DISPOSITION_ENTRIES = 200;
/** Hard fallback cap applied only when the record still exceeds `CYCLE_SUMMARY_MAX_BYTES`
 *  after the normal per-field caps above. */
const OVERFLOW_ENTRY_CAP = 10;

const TEST_COMMAND_RE = /\b(npm (run )?test|npm run typecheck|vitest|jest|pytest|go test|yarn test|pnpm test|tsc)\b/i;
const FAIL_TOKEN_RE = /\b(fail(ed|ure)?|✗|error)\b/i;
const SKIP_TOKEN_RE = /\b(skip(ped)?|not run|no tests?|missing)\b/i;
const PASS_TOKEN_RE = /\b(pass(ed)?|✓|ok|succeeded)\b/i;

/** `telemetry?.toolTrace ?? []` — a small helper so call sites never repeat the optional chain. */
export function toolTraceLines(telemetry: RunTelemetry | undefined): string[] {
  return telemetry?.toolTrace ?? [];
}

/**
 * Best-effort scan for test-runner invocations across tool-trace lines and/or free-text agent
 * notes (e.g. the fix agent's `testing[]` summary). There is no structured source for "which
 * tests ran and passed" yet (AII-798's tool-activity records are a separate, later contract) —
 * this never infers "passed" from a clean exit or from silence: a source list with no
 * recognisable test-command mention returns a single explicit "missing" entry rather than an
 * empty array, and a recognised command whose outcome can't be read from the line returns
 * "unobserved" rather than defaulting to "passed".
 */
export function inferTestResults(sources: string[], secrets: string[] = envSecrets()): CycleTestResult[] {
  const candidates = sources.filter((line) => TEST_COMMAND_RE.test(line));
  if (candidates.length === 0) {
    return [{ name: "test execution", status: "missing" }];
  }
  return candidates.map((line) => {
    const name = redactEvidence(line.trim(), secrets).slice(0, 200);
    const status: TestStatus = FAIL_TOKEN_RE.test(line)
      ? "failed"
      : SKIP_TOKEN_RE.test(line)
        ? "skipped"
        : PASS_TOKEN_RE.test(line)
          ? "passed"
          : "unobserved";
    return { name, status };
  });
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

function isCycleSummary(value: unknown): value is CycleSummary {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string") return false;
  if (value.stage !== "feedback-loop" && value.stage !== "post-push-review-fix") return false;
  if (typeof value.cycle !== "number") return false;
  if (!Array.isArray(value.dispositions) || !Array.isArray(value.tests)) return false;
  if (!isRecord(value.verdict) || typeof value.verdict.reason !== "string") return false;
  if (!isRecord(value.usage)) return false;
  if (typeof value.truncated !== "boolean" || typeof value.limitReached !== "boolean") return false;
  return true;
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

function appendCycleSummary(workspaceDir: string, record: CycleSummary): void {
  const filePath = path.join(workspaceDir, CYCLE_SUMMARY_FILE);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Upsert by id: a cycle re-summarized under the same identity (retry idempotency) replaces
  // its prior record instead of appending a duplicate, while every other cycle's record in the
  // file is left untouched — this is what keeps multiple cycles individually inspectable.
  const existing = readCycleSummaries(workspaceDir).filter((s) => s.id !== record.id);
  const all = [...existing, record];
  fs.writeFileSync(filePath, `${all.map((s) => JSON.stringify(s)).join("\n")}\n`, "utf-8");
}

/**
 * Redacts and bounds `input` to `CYCLE_SUMMARY_MAX_BYTES`, then appends it to
 * `CYCLE_SUMMARY_FILE` (best-effort — a write failure is logged and swallowed, matching the
 * feedback-loop step's own non-fatal file-write convention, so a cycle-summary write can never
 * fail the run it is reporting on). Cycle input/output commits, dispositions, tests, verdict and
 * usage are otherwise carried in full; only the free-text `verdict.summary` is capped for
 * everyday cycles, with the whole-record limit as a last resort for a pathological input.
 */
export function writeCycleSummary(workspaceDir: string, input: CycleSummaryInput): CycleSummary {
  const secrets = envSecrets();
  let truncated = false;

  let verdictSummary = input.verdict.summary;
  if (verdictSummary !== undefined) {
    const capped = redactAndCap(verdictSummary, VERDICT_SUMMARY_MAX_CHARS, secrets);
    if (capped.endsWith("…")) truncated = true;
    verdictSummary = capped;
  }
  if (input.tests.length > MAX_TEST_ENTRIES || input.dispositions.length > MAX_DISPOSITION_ENTRIES) {
    truncated = true;
  }

  let record: CycleSummary = {
    id: input.id,
    stage: input.stage,
    cycle: input.cycle,
    inputCommit: input.inputCommit,
    outputCommit: input.outputCommit,
    outputCommitStatus: input.outputCommitStatus,
    dispositions: input.dispositions.slice(0, MAX_DISPOSITION_ENTRIES),
    tests: input.tests.slice(0, MAX_TEST_ENTRIES),
    verdict: {
      approved: input.verdict.approved,
      reason: input.verdict.reason,
      ...(verdictSummary !== undefined ? { summary: verdictSummary } : {}),
    },
    usage: input.usage,
    truncated,
    limitReached: false,
  };

  let limitReached = false;
  if (Buffer.byteLength(JSON.stringify(record), "utf-8") > CYCLE_SUMMARY_MAX_BYTES) {
    limitReached = true;
    truncated = true;
    record = {
      ...record,
      verdict: { approved: record.verdict.approved, reason: record.verdict.reason },
      tests: record.tests.slice(0, OVERFLOW_ENTRY_CAP),
      dispositions: record.dispositions.slice(0, OVERFLOW_ENTRY_CAP),
    };
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
