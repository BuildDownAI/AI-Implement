import type { AccountAuthMode, StageName } from "./agent-config.js";
import type { ResolvedAgentSnapshotV1 } from "./run-config.js";
import {
  sanitizeAttribution,
  type AttributionCostStatus,
  type AttributionLimitKind,
  type InvocationAttributionV1,
  type RunTelemetry,
  type UsageAvailability,
} from "./pipeline/types.js";

/**
 * Invocation usage and configuration attribution (AII-954).
 *
 * Pure helpers: they normalize already-produced attribution/telemetry against the frozen
 * `agentConfig` snapshot and aggregate the result. Nothing here does I/O, emits, or persists.
 *
 * Authority rules:
 *  - stage/agent/provider/model/profile/authMode/timeout come from the snapshot, never from a
 *    claimed attribution. A disagreeing claim is surfaced as a mismatch *field name* only.
 *  - observed outcome, usage and actual limit come from telemetry (attribution fills gaps).
 *  - null usage stays null, a reported zero stays zero, and cost is never derived from tokens.
 *  - `tokensIn` already includes cache reads/creation; cache fields are reported beside it and
 *    never added to it.
 * Output rows contain only allowlisted, bounded fields; rejected payloads are never echoed.
 */

export type UsageMismatchField =
  | "stage" | "agent" | "provider" | "model" | "profileId" | "authMode" | "limit" | "outcome" | "usage";

/** `verified`: attribution accepted; `mismatch`: accepted but a claim disagreed with the snapshot;
 *  `rejected`: present but malformed or from another snapshot; `absent`: none supplied. */
export type AttributionStatus = "verified" | "mismatch" | "rejected" | "absent";

export interface InvocationUsageRow {
  /** Trusted: copied from the frozen snapshot, never from a claimed attribution. */
  snapshotId: string;
  /** Trusted immutable configuration row id + revision of each layer the snapshot resolved from. */
  configRevisions: {
    orchestratorDefault: { configRevisionId: string; revision: number };
    project: { configRevisionId: string; revision: number };
  };
  /** Trusted revision of the selected account profile row. */
  profileRevision: number;
  /** Stable identity, scoped by `snapshotId` for dedup; null when none was supplied (never deduplicated). */
  invocationId: string | null;
  stage: StageName;
  agent: "claude" | "codex";
  provider: "anthropic" | "bedrock" | "openai";
  model: string;
  profileId: string;
  authMode: AccountAuthMode;
  /** Actual limit observed for the invocation; null when none was reported. */
  limit: { kind: AttributionLimitKind; value: number } | null;
  outcome: "success" | "max_turns" | "error" | "unknown";
  usage: {
    availability: UsageAvailability;
    tokensIn: number | null;
    tokensOut: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
    costUsd: number | null;
    costStatus: AttributionCostStatus;
  };
  /** Spawn attempts for this one invocation (transport retries); minimum 1. */
  attempts: number;
  attribution: AttributionStatus;
  mismatches: UsageMismatchField[];
}

export interface InvocationObservation {
  /** Stage the caller ran; falls back to a valid attribution's stage. */
  stage?: StageName;
  /** Stable identity; falls back to a valid attribution's id. */
  invocationId?: string;
  /** Untrusted claimed attribution; validated with `sanitizeAttribution`. */
  attribution?: unknown;
  telemetry?: RunTelemetry;
  /** `LLMResult.attempts`; repeated model attempts reported by telemetry. */
  attempts?: number;
}

const ID_RE = /^[\w.:/@-]{1,128}$/;
const SECRET_RE = /(sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}|ghp_|gho_|ghs_|xox[bp]-)/i;

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function safeId(v: unknown): string | null {
  return typeof v === "string" && ID_RE.test(v) && !SECRET_RE.test(v) ? v : null;
}

function isStage(snapshot: ResolvedAgentSnapshotV1, v: unknown): v is StageName {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(snapshot.stages, v);
}

function availabilityOf(tokensIn: number | null, tokensOut: number | null): UsageAvailability {
  const present = (tokensIn !== null ? 1 : 0) + (tokensOut !== null ? 1 : 0);
  return present === 2 ? "complete" : present === 1 ? "partial" : "unavailable";
}

/**
 * Builds one row for an invocation. Returns null only when no stage can be determined from the
 * snapshot. Never throws: malformed optional attribution is dropped and the observed outcome kept.
 */
export function normalizeInvocation(
  snapshot: ResolvedAgentSnapshotV1,
  obs: InvocationObservation,
): InvocationUsageRow | null {
  const telemetry = obs.telemetry;
  let claim = sanitizeAttribution(obs.attribution ?? telemetry?.attribution);
  let attribution: AttributionStatus = obs.attribution === undefined && telemetry?.attribution === undefined ? "absent" : "verified";
  if (attribution !== "absent" && claim === null) attribution = "rejected";
  if (claim !== null && claim.snapshotId !== snapshot.snapshotId) {
    claim = null;
    attribution = "rejected";
  }

  const stage = isStage(snapshot, obs.stage) ? obs.stage : claim && isStage(snapshot, claim.stage) ? claim.stage : null;
  if (stage === null) return null;

  const selection = snapshot.stages[stage];
  const profile = snapshot.profiles[stage];
  const mismatches: UsageMismatchField[] = [];
  const flag = (f: UsageMismatchField): void => {
    if (!mismatches.includes(f)) mismatches.push(f);
  };

  if (claim) {
    if (claim.stage !== stage) flag("stage");
    if (claim.agent !== selection.agent) flag("agent");
    if (claim.provider !== selection.provider) flag("provider");
    if (claim.model !== selection.model) flag("model");
    if (claim.profileId !== profile.id) flag("profileId");
    if (claim.authMode !== profile.authMode) flag("authMode");
    if (claim.limit?.kind === "timeout_ms" && claim.limit.value !== selection.invocationTimeoutMs) flag("limit");
  }

  const outcome = telemetry?.outcome ?? claim?.outcome ?? "unknown";
  if (claim && telemetry && claim.outcome !== telemetry.outcome) flag("outcome");

  // Usage: observed telemetry is authoritative; claimed usage only fills fields telemetry lacks.
  const cu = claim?.usage ?? null;
  const pick = (observed: unknown, claimed: number | null | undefined): number | null => {
    const o = count(observed);
    const c = count(claimed);
    if (o !== null && c !== null && o !== c) flag("usage");
    return o ?? c;
  };
  const tokensIn = pick(telemetry?.tokensIn, cu?.tokensIn);
  const tokensOut = pick(telemetry?.tokensOut, cu?.tokensOut);
  const costUsd = pick(telemetry?.costUsd, cu?.costUsd);
  const cacheReadTokens = count(telemetry?.cacheReadTokens);
  const cacheCreationTokens = count(telemetry?.cacheCreationTokens);

  const attempts = Number.isSafeInteger(obs.attempts) && (obs.attempts as number) >= 1 ? (obs.attempts as number) : 1;

  if (attribution === "verified" && mismatches.length > 0) attribution = "mismatch";

  const revs = snapshot.configRevisions;
  return {
    snapshotId: snapshot.snapshotId,
    configRevisions: {
      orchestratorDefault: { configRevisionId: revs.orchestratorDefault.configRevisionId, revision: revs.orchestratorDefault.revision },
      project: { configRevisionId: revs.project.configRevisionId, revision: revs.project.revision },
    },
    profileRevision: profile.revision,
    invocationId: safeId(obs.invocationId) ?? claim?.invocationId ?? null,
    stage,
    agent: selection.agent,
    provider: selection.provider,
    model: selection.model,
    profileId: profile.id,
    authMode: profile.authMode,
    limit: claim?.limit ?? null,
    outcome,
    usage: {
      availability: availabilityOf(tokensIn, tokensOut),
      tokensIn,
      tokensOut,
      cacheReadTokens,
      cacheCreationTokens,
      costUsd,
      costStatus: costUsd === null ? "unavailable" : "reported",
    },
    attempts,
    attribution,
    mismatches,
  };
}

export interface UsageTotals {
  tokensIn: number | null;
  tokensOut: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /** Known subtotal only; null when no row reported cost. Check `costStatus` before presenting it as a total. */
  costUsd: number | null;
}

export interface AgentUsageAggregate {
  /** Deduplicated rows; per-invocation attribution is always retained. */
  rows: InvocationUsageRow[];
  invocations: number;
  /** Sum of per-invocation attempts (repeated model attempts reported by telemetry). */
  attempts: number;
  /** Rows dropped as byte-equivalent repeat deliveries. */
  duplicatesIgnored: number;
  /** Rows dropped because their identity matched a different earlier record; first is kept. */
  conflicts: number;
  totals: UsageTotals;
  usageStatus: UsageAvailability;
  /** `partial` means `totals.costUsd` is a known subtotal, not the full cost. */
  costStatus: "complete" | "partial" | "unavailable";
  /** True when subscription and non-subscription accounts both appear. */
  mixedAuth: boolean;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function sum(values: Array<number | null>): number | null {
  let total: number | null = null;
  for (const v of values) if (v !== null) total = (total ?? 0) + v;
  return total;
}

const isSubscription = (m: AccountAuthMode): boolean => m === "claude-subscription" || m === "codex-subscription";

/** Deduplicates by snapshot-scoped invocation identity and aggregates. Byte-equivalent repeats are
 *  ignored; a repeated identity within one snapshot with different content is counted in
 *  `conflicts` and the first record wins. Identical ids under different snapshots stay distinct here.
 *  The persisted `model_invocation_attribution` table is stricter: its primary key is `invocation_id`
 *  alone, so `INSERT OR IGNORE` deduplicates by `invocation_id`, which must be globally unique. */
export function aggregateUsage(input: readonly InvocationUsageRow[]): AgentUsageAggregate {
  const seen = new Map<string, string>();
  const rows: InvocationUsageRow[] = [];
  let duplicatesIgnored = 0;
  let conflicts = 0;
  for (const row of input) {
    if (row.invocationId !== null) {
      const fp = canonical(row);
      const key = canonical([row.snapshotId, row.invocationId]);
      const prior = seen.get(key);
      if (prior !== undefined) {
        if (prior === fp) duplicatesIgnored++;
        else conflicts++;
        continue;
      }
      seen.set(key, fp);
    }
    rows.push(row);
  }

  const totals: UsageTotals = {
    tokensIn: sum(rows.map((r) => r.usage.tokensIn)),
    tokensOut: sum(rows.map((r) => r.usage.tokensOut)),
    cacheReadTokens: sum(rows.map((r) => r.usage.cacheReadTokens)),
    cacheCreationTokens: sum(rows.map((r) => r.usage.cacheCreationTokens)),
    costUsd: sum(rows.map((r) => r.usage.costUsd)),
  };

  const mixedAuth = rows.some((r) => isSubscription(r.authMode)) && rows.some((r) => !isSubscription(r.authMode));
  const reported = rows.filter((r) => r.usage.costStatus === "reported").length;
  const costStatus = reported === 0 ? "unavailable"
    : reported === rows.length && !mixedAuth ? "complete" : "partial";
  const usageStatus: UsageAvailability = rows.length === 0 || rows.every((r) => r.usage.availability === "unavailable") ? "unavailable"
    : rows.every((r) => r.usage.availability === "complete") ? "complete" : "partial";

  return {
    rows,
    invocations: rows.length,
    attempts: rows.reduce((n, r) => n + r.attempts, 0),
    duplicatesIgnored,
    conflicts,
    totals,
    usageStatus,
    costStatus,
    mixedAuth,
  };
}

/** Convenience: normalize observations and aggregate. Unresolvable observations are counted, not thrown. */
export function summarizeInvocations(
  snapshot: ResolvedAgentSnapshotV1,
  observations: readonly InvocationObservation[],
): AgentUsageAggregate & { unattributable: number } {
  const rows: InvocationUsageRow[] = [];
  let unattributable = 0;
  for (const o of observations) {
    const row = normalizeInvocation(snapshot, o);
    if (row) rows.push(row);
    else unattributable++;
  }
  return { ...aggregateUsage(rows), unattributable };
}

export type { InvocationAttributionV1 };
