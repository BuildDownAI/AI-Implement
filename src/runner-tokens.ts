import crypto from "node:crypto";
import { getDb } from "./dedup.js";

export type RunTokenAudience = "result" | "progress";

export interface RunTokenClaims {
  issueId: string;
  phase: "planning" | "implementation" | "gap-analysis";
  audience: RunTokenAudience;
  dispatchId: string;
  exp: number;
}

export interface MintInput {
  issueId: string;
  mappingTeamKey: string;
  phase: RunTokenClaims["phase"];
  audience?: RunTokenAudience;
  ttlSeconds: number;
  secret: string;
  dispatchId?: string;
}

export interface MintOutput {
  token: string;
  dispatchId: string;
}

export type VerifyResult =
  | { ok: true; claims: RunTokenClaims; mappingTeamKey: string; consumedAt: number | null }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "already_consumed" | "wrong_audience" };

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
  const claims: RunTokenClaims = {
    issueId: input.issueId,
    phase: input.phase,
    audience: input.audience ?? "result",
    dispatchId,
    exp: Date.now() + input.ttlSeconds * 1000,
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
  if (claims.exp < Date.now()) return { ok: false, reason: "expired" };

  const db = getDb();
  const row = db
    .prepare("SELECT consumed_at, mapping_team_key FROM runner_tokens WHERE dispatch_id = ? AND audience = ?")
    .get(claims.dispatchId, claims.audience) as { consumed_at: number | null; mapping_team_key: string } | undefined;
  if (!row) return { ok: false, reason: "malformed" };

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
  if (claims.audience !== expectedAudience) return { ok: false, reason: "wrong_audience" };
  if (verified.consumedAt !== null) return { ok: false, reason: "already_consumed" };
  if (!options.consume) return verified;

  const result = getDb()
    .prepare("UPDATE runner_tokens SET consumed_at = ? WHERE dispatch_id = ? AND audience = ? AND consumed_at IS NULL")
    .run(Date.now(), claims.dispatchId, claims.audience);
  if (result.changes === 0) return { ok: false, reason: "already_consumed" };

  return verified;
}

export function verifyAndConsumeRunToken(token: string, secret: string): VerifyResult {
  return verifyRunToken(token, secret, "result", { consume: true });
}
