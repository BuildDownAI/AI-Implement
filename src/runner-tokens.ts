import crypto from "node:crypto";
import { getDb } from "./dedup.js";

export type RunTokenAudience = "result" | "progress" | "publication";

export interface RunTokenClaims {
  issueId: string;
  phase: "planning" | "implementation" | "gap-analysis" | "kg-refresh";
  audience: RunTokenAudience;
  dispatchId: string;
  exp: number;
  /** Exact owner/repository bound at dispatch time for publication credentials. */
  repository?: string;
  /** Present only for a prepared Restate review-fix attempt. */
  attemptId?: string;
  installationId?: number;
  prNumber?: number;
}

export interface MintInput {
  issueId: string;
  mappingTeamKey: string;
  phase: RunTokenClaims["phase"];
  audience?: RunTokenAudience;
  ttlSeconds: number;
  secret: string;
  dispatchId?: string;
  /** Required for publication credentials; ignored by other audiences. */
  repository?: string;
}

export interface MintOutput {
  token: string;
  dispatchId: string;
}

export type VerifyResult =
  | { ok: true; claims: RunTokenClaims; mappingTeamKey: string; consumedAt: number | null }
  // Claims on a refusal so it can be attributed to a dispatch; absent when the payload was never trustworthy.
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "already_consumed" | "wrong_audience" | "wrong_scope" | "revoked"; claims?: RunTokenClaims };

export const PLANNING_TTL_SECONDS = 30 * 60;
export const IMPLEMENTATION_TTL_SECONDS = 2 * 60 * 60;
export const GAP_ANALYSIS_TTL_SECONDS = 30 * 60;

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payload: string, secret: string): string {
  return b64url(crypto.createHmac("sha256", secret).update(payload).digest());
}

export function mintRunToken(input: MintInput): MintOutput {
  const dispatchId = input.dispatchId ?? crypto.randomUUID();
  const audience = input.audience ?? "result";
  const repository = input.repository?.trim();
  if (audience === "publication" && !repository?.match(/^[^/\s]+\/[^/\s]+$/)) {
    throw new Error("Publication tokens require an exact owner/repository binding");
  }
  const claims: RunTokenClaims = {
    issueId: input.issueId,
    phase: input.phase,
    audience,
    dispatchId,
    exp: Date.now() + input.ttlSeconds * 1000,
    ...(audience === "publication" ? { repository } : {}),
  };
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const sig = sign(payload, input.secret);
  const token = `${payload}.${sig}`;

  getDb()
    .prepare(
      "INSERT INTO runner_tokens (dispatch_id, audience, issue_id, phase, expires_at, consumed_at, mapping_team_key) VALUES (?, ?, ?, ?, ?, NULL, ?)",
    )
    .run(dispatchId, claims.audience, claims.issueId, claims.phase, claims.exp, input.mappingTeamKey);

  return { token, dispatchId };
}

// Token verification is intentionally DB-only (runner_tokens table) — no in-memory state
// is consulted. This means verification survives orchestrator restarts as long as the
// SQLite volume persists across deploys.
function verifyTokenSignatureAndLoadClaims(token: string, secret: string): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payload, sig] = parts;
  const expected = sign(payload, secret);
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    return { ok: false, reason: "bad_signature" };
  }
  let claims: RunTokenClaims;
  try {
    claims = JSON.parse(b64urlDecode(payload).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  claims.audience ??= "result";
  if (claims.exp < Date.now()) return { ok: false, reason: "expired", claims };

  const db = getDb();
  const row = db
    .prepare("SELECT consumed_at, mapping_team_key FROM runner_tokens WHERE dispatch_id = ? AND audience = ?")
    .get(claims.dispatchId, claims.audience) as { consumed_at: number | null; mapping_team_key: string } | undefined;
  // Reason stays "malformed" though the payload verified: callers map it to a status.
  if (!row) return { ok: false, reason: "malformed", claims };

  return { ok: true, claims, mappingTeamKey: row.mapping_team_key, consumedAt: row.consumed_at };
}

export function verifyRunToken(
  token: string,
  secret: string,
  expectedAudience: RunTokenAudience,
  options: { consume: boolean },
): VerifyResult {
  const verified = verifyTokenSignatureAndLoadClaims(token, secret);
  if (!verified.ok) return verified;
  const { claims } = verified;
  if (claims.audience !== expectedAudience) return { ok: false, reason: "wrong_audience", claims };
  if (verified.consumedAt !== null) return { ok: false, reason: "already_consumed", claims };
  if (!options.consume) return verified;

  const result = getDb()
    .prepare("UPDATE runner_tokens SET consumed_at = ? WHERE dispatch_id = ? AND audience = ? AND consumed_at IS NULL")
    .run(Date.now(), claims.dispatchId, claims.audience);
  if (result.changes === 0) return { ok: false, reason: "already_consumed", claims };

  return verified;
}

export function verifyAndConsumeRunToken(token: string, secret: string): VerifyResult {
  return verifyRunToken(token, secret, "result", { consume: true });
}

/** The pilot uses the immutable prepared row as the credential authority. No caller
 * supplies a deadline, issue, mapping, or repository that could drift on retry. */
interface PreparedAttemptTokenRow {
  attempt_id: string;
  dispatch_id: string;
  issue_scope: string;
  issue_id: string;
  mapping_key: string;
  installation_id: string;
  repository: string;
  pr_number: number;
  deadline_at: number;
  authority_revoked_at: number | null;
  owner: string;
  lifecycle_owner: string;
  admission_mapping_key: string;
  admission_issue_scope: string;
  admission_issue_id: string;
  admission_installation_id: string | null;
  admission_repository: string | null;
  admission_pr_number: number | null;
  released_at: number | null;
}

const PILOT_DELIVERY_GRACE_MS = 15 * 60_000;

function preparedAttempt(attemptId: string): PreparedAttemptTokenRow | undefined {
  return getDb().prepare(`
    SELECT a.attempt_id, a.dispatch_id, a.issue_scope, a.issue_id, a.mapping_key,
           a.installation_id, a.repository, a.pr_number, a.deadline_at,
           a.authority_revoked_at, a.owner, d.lifecycle_owner,
           d.mapping_key AS admission_mapping_key, d.issue_scope AS admission_issue_scope,
           d.issue_id AS admission_issue_id, d.installation_id AS admission_installation_id,
           d.repository AS admission_repository, d.pr_number AS admission_pr_number,
           d.released_at
    FROM review_fix_attempts a
    JOIN dispatch_admissions d ON d.dispatch_id = a.dispatch_id
    WHERE a.attempt_id = ?
  `).get(attemptId) as PreparedAttemptTokenRow | undefined;
}

function hasPreparedAdmissionAuthority(attempt: PreparedAttemptTokenRow): boolean {
  return attempt.dispatch_id === attempt.attempt_id
    && attempt.owner === attempt.attempt_id
    && attempt.lifecycle_owner === `restate:${attempt.attempt_id}`
    && attempt.admission_mapping_key === attempt.mapping_key
    && attempt.admission_issue_scope === attempt.issue_scope
    && attempt.admission_issue_id === attempt.issue_id
    && attempt.admission_installation_id === attempt.installation_id
    && attempt.admission_repository === attempt.repository
    && attempt.admission_pr_number === attempt.pr_number
    && attempt.authority_revoked_at === null
    && attempt.released_at === null;
}

/** Mint for an already-prepared pilot attempt. Calling this again returns the same
 * claims and stored expiry. In particular, a consumed publication row stays consumed.
 * Call from an adapter outside Restate's journal: the returned bearer is a secret. */
export function mintPreparedReviewFixToken(input: {
  attemptId: string;
  audience: RunTokenAudience;
  secret: string;
}): MintOutput {
  if (input.audience !== "result" && input.audience !== "progress" && input.audience !== "publication") {
    throw new Error("Unsupported prepared review-fix token audience");
  }
  const db = getDb();
  return db.transaction((): MintOutput => {
    const attempt = preparedAttempt(input.attemptId);
    if (!attempt || !hasPreparedAdmissionAuthority(attempt)) {
      throw new Error("Prepared review-fix attempt has no current authority");
    }
    const latestExpiry = attempt.deadline_at + PILOT_DELIVERY_GRACE_MS;
    if (!Number.isSafeInteger(latestExpiry) || latestExpiry <= Date.now()) {
      throw new Error("Prepared review-fix credential has expired");
    }
    db.prepare(`
      INSERT INTO runner_tokens
        (dispatch_id, audience, issue_id, phase, expires_at, consumed_at, mapping_team_key)
      VALUES (?, ?, ?, 'implementation', ?, NULL, ?)
      ON CONFLICT (dispatch_id, audience) DO NOTHING
    `).run(attempt.dispatch_id, input.audience, attempt.issue_id, latestExpiry, attempt.mapping_key);
    const row = db.prepare(`
      SELECT issue_id, phase, expires_at, mapping_team_key
      FROM runner_tokens WHERE dispatch_id = ? AND audience = ?
    `).get(attempt.dispatch_id, input.audience) as {
      issue_id: string; phase: string; expires_at: number; mapping_team_key: string;
    };
    if (row.issue_id !== attempt.issue_id || row.phase !== "implementation"
      || row.mapping_team_key !== attempt.mapping_key || row.expires_at > latestExpiry) {
      throw new Error("Prepared review-fix credential identity changed");
    }
    const claims: RunTokenClaims = {
      issueId: attempt.issue_id,
      phase: "implementation",
      audience: input.audience,
      dispatchId: attempt.dispatch_id,
      attemptId: attempt.attempt_id,
      repository: attempt.repository,
      installationId: Number(attempt.installation_id),
      prNumber: attempt.pr_number,
      exp: row.expires_at,
    };
    const payload = b64url(Buffer.from(JSON.stringify(claims)));
    return { token: `${payload}.${sign(payload, input.secret)}`, dispatchId: attempt.dispatch_id };
  })();
}

/** Validate a pilot bearer without burning result/progress authority before the
 * durable inbox commits. Publication alone may consume its one-shot claim, after
 * all prepared-attempt scope and revocation checks pass in the same transaction. */
export function verifyPreparedReviewFixToken(
  token: string,
  secret: string,
  expectedAudience: RunTokenAudience,
  options: { consumePublication?: boolean } = {},
): VerifyResult {
  const db = getDb();
  return db.transaction((): VerifyResult => {
    const verified = verifyRunToken(token, secret, expectedAudience, { consume: false });
    if (!verified.ok) return verified;
    const { claims } = verified;
    const attempt = claims.attemptId && preparedAttempt(claims.attemptId);
    if (!attempt || claims.dispatchId !== attempt.dispatch_id || claims.issueId !== attempt.issue_id
      || claims.phase !== "implementation" || claims.repository !== attempt.repository
      || claims.installationId !== Number(attempt.installation_id)
      || claims.prNumber !== attempt.pr_number || verified.mappingTeamKey !== attempt.mapping_key) {
      return { ok: false, reason: "wrong_scope", claims };
    }
    const row = db.prepare(`
      SELECT expires_at FROM runner_tokens WHERE dispatch_id = ? AND audience = ?
    `).get(claims.dispatchId, claims.audience) as { expires_at: number } | undefined;
    if (!row || claims.exp !== row.expires_at) return { ok: false, reason: "wrong_scope", claims };
    if (!hasPreparedAdmissionAuthority(attempt)) {
      return { ok: false, reason: "revoked", claims };
    }
    if (options.consumePublication) {
      if (expectedAudience !== "publication") return { ok: false, reason: "wrong_audience", claims };
      const result = db.prepare(`
        UPDATE runner_tokens SET consumed_at = ?
        WHERE dispatch_id = ? AND audience = 'publication' AND consumed_at IS NULL
      `).run(Date.now(), claims.dispatchId);
      if (result.changes === 0) return { ok: false, reason: "already_consumed", claims };
    }
    return verified;
  })();
}
