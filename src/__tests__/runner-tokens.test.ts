import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type * as DedupModule from "../dedup.js";
import type * as RunnerTokensModule from "../runner-tokens.js";

const SECRET = "test-secret-with-enough-entropy-for-hmac";

let dbPath: string;
let dedup: typeof DedupModule;
let runnerTokens: typeof RunnerTokensModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `runner-tokens-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  runnerTokens = await import("../runner-tokens.js");
  // Force DB init so the runner_tokens table exists for the first test access.
  dedup.getDb();
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

describe("mintRunToken", () => {
  it("a stale publication release cannot clear a newer claim, even within one millisecond", () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "issue-1", mappingTeamKey: "ENG", phase: "implementation",
      audience: "publication", repository: "acme/app", ttlSeconds: 60, secret: SECRET,
    });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const first = runnerTokens.verifyRunToken(token, SECRET, "publication", { consume: true });
      expect(first.ok).toBe(true);
      if (!first.ok || first.consumedAt === null) throw new Error("missing first claim stamp");
      expect(runnerTokens.releasePublicationClaim(dispatchId, first.consumedAt)).toBe(true);

      const second = runnerTokens.verifyRunToken(token, SECRET, "publication", { consume: true });
      expect(second.ok).toBe(true);
      if (!second.ok || second.consumedAt === null) throw new Error("missing second claim stamp");
      expect(second.consumedAt).not.toBe(first.consumedAt);
      expect(runnerTokens.releasePublicationClaim(dispatchId, first.consumedAt)).toBe(false);
      const replay = runnerTokens.verifyRunToken(token, SECRET, "publication", { consume: true });
      expect(replay).toMatchObject({ ok: false, reason: "already_consumed" });
    } finally { vi.restoreAllMocks(); }
  });

  it("returns a token and dispatchId, persists a row", () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "issue-1",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const row = dedup
      .getDb()
      .prepare("SELECT * FROM runner_tokens WHERE dispatch_id = ?")
      .get(dispatchId) as { phase: string; mapping_team_key: string } | undefined;
    expect(row?.phase).toBe("planning");
    expect(row?.mapping_team_key).toBe("ENG");
  });

  it("mints result tokens with audience=result by default", () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "issue-1",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });

    const row = dedup
      .getDb()
      .prepare("SELECT audience FROM runner_tokens WHERE dispatch_id = ?")
      .get(dispatchId) as { audience: string } | undefined;
    expect(row?.audience).toBe("result");

    const result = runnerTokens.verifyAndConsumeRunToken(token, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.audience).toBe("result");
  });

  it("can mint result, progress, and publication tokens for the same dispatch id", () => {
    const dispatchId = "dispatch-shared";
    runnerTokens.mintRunToken({
      issueId: "issue-1",
      mappingTeamKey: "ENG",
      phase: "implementation",
      audience: "result",
      dispatchId,
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });

    const { token } = runnerTokens.mintRunToken({
      issueId: "issue-1",
      mappingTeamKey: "ENG",
      phase: "implementation",
      audience: "progress",
      dispatchId,
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });

    const publication = runnerTokens.mintRunToken({
      issueId: "issue-1",
      mappingTeamKey: "ENG",
      phase: "implementation",
      audience: "publication",
      dispatchId,
      repository: "acme/app",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });

    const rows = dedup
      .getDb()
      .prepare("SELECT audience FROM runner_tokens WHERE dispatch_id = ? ORDER BY audience")
      .all(dispatchId) as Array<{ audience: string }>;
    expect(rows.map((row) => row.audience)).toEqual(["progress", "publication", "result"]);

    const result = runnerTokens.verifyRunToken(token, SECRET, "progress", { consume: false });
    expect(result.ok).toBe(true);
    const publicationResult = runnerTokens.verifyRunToken(
      publication.token,
      SECRET,
      "publication",
      { consume: true },
    );
    expect(publicationResult.ok).toBe(true);
    const replay = runnerTokens.verifyRunToken(
      publication.token,
      SECRET,
      "publication",
      { consume: true },
    );
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe("already_consumed");
  });

  it("requires publication credentials to bind an exact repository", () => {
    expect(() => runnerTokens.mintRunToken({
      issueId: "issue-1",
      mappingTeamKey: "ENG",
      phase: "implementation",
      audience: "publication",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    })).toThrow(/owner\/repository binding/);
  });
});

describe("verifyAndConsumeRunToken", () => {
  it("happy path: returns ok with claims and mappingTeamKey", () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "issue-1",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });
    const result = runnerTokens.verifyAndConsumeRunToken(token, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.issueId).toBe("issue-1");
      expect(result.claims.phase).toBe("planning");
      expect(result.mappingTeamKey).toBe("ENG");
    }
  });

  it("returns already_consumed on second use", () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "issue-1",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });
    expect(runnerTokens.verifyAndConsumeRunToken(token, SECRET).ok).toBe(true);
    const second = runnerTokens.verifyAndConsumeRunToken(token, SECRET);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("already_consumed");
  });

  it("returns bad_signature when secret differs", () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "issue-1",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });
    const result = runnerTokens.verifyAndConsumeRunToken(token, "different-secret");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_signature");
  });

  it("returns expired after TTL passes", () => {
    const realNow = Date.now;
    let now = realNow();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { token } = runnerTokens.mintRunToken({
      issueId: "issue-1",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: 1,
      secret: SECRET,
    });
    now += 2000;
    const result = runnerTokens.verifyAndConsumeRunToken(token, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("returns malformed for a token without a dot", () => {
    expect(runnerTokens.verifyAndConsumeRunToken("nodothere", SECRET).ok).toBe(false);
  });

  it("returns malformed when no row exists for the dispatchId", () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "issue-1",
      mappingTeamKey: "ENG",
      phase: "planning",
      ttlSeconds: runnerTokens.PLANNING_TTL_SECONDS,
      secret: SECRET,
    });
    dedup.getDb().prepare("DELETE FROM runner_tokens WHERE dispatch_id = ?").run(dispatchId);
    const result = runnerTokens.verifyAndConsumeRunToken(token, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  it("allows progress tokens to be verified repeatedly without consuming them", () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "issue-1",
      mappingTeamKey: "ENG",
      phase: "implementation",
      audience: "progress",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });

    const first = runnerTokens.verifyRunToken(token, SECRET, "progress", { consume: false });
    const second = runnerTokens.verifyRunToken(token, SECRET, "progress", { consume: false });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it("rejects using a result token as a progress token", () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "issue-1",
      mappingTeamKey: "ENG",
      phase: "implementation",
      audience: "result",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });

    const result = runnerTokens.verifyRunToken(token, SECRET, "progress", { consume: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wrong_audience");
  });
});

describe("verifyRunToken — claims on a refusal", () => {
  it("carries claims when the token is already consumed", () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "issue-9",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    expect(runnerTokens.verifyAndConsumeRunToken(token, SECRET).ok).toBe(true);

    const second = runnerTokens.verifyAndConsumeRunToken(token, SECRET);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("already_consumed");
      expect(second.claims?.dispatchId).toBe(dispatchId);
      expect(second.claims?.phase).toBe("implementation");
    }
  });

  it("carries claims when the audience does not match", () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "issue-9",
      mappingTeamKey: "ENG",
      phase: "implementation",
      audience: "progress",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });

    const result = runnerTokens.verifyRunToken(token, SECRET, "result", { consume: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("wrong_audience");
      expect(result.claims?.dispatchId).toBe(dispatchId);
    }
  });

  it("carries claims when the token has expired", () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "issue-9",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: -1,
      secret: SECRET,
    });

    const result = runnerTokens.verifyRunToken(token, SECRET, "result", { consume: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("expired");
      expect(result.claims?.dispatchId).toBe(dispatchId);
    }
  });

  it("omits claims when the token is malformed or badly signed", () => {
    const malformed = runnerTokens.verifyRunToken("not-a-token", SECRET, "result", { consume: false });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.reason).toBe("malformed");
      expect(malformed.claims).toBeUndefined();
    }

    const { token } = runnerTokens.mintRunToken({
      issueId: "issue-9",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    const tampered = `${token.split(".")[0]}.${"A".repeat(token.split(".")[1].length)}`;

    const badSig = runnerTokens.verifyRunToken(tampered, SECRET, "result", { consume: false });
    expect(badSig.ok).toBe(false);
    if (!badSig.ok) {
      expect(badSig.reason).toBe("bad_signature");
      expect(badSig.claims).toBeUndefined();
    }
  });

  it("carries claims when the payload verified but its row is gone", () => {
    const { token, dispatchId } = runnerTokens.mintRunToken({
      issueId: "issue-9",
      mappingTeamKey: "ENG",
      phase: "implementation",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: SECRET,
    });
    dedup.getDb().prepare("DELETE FROM runner_tokens WHERE dispatch_id = ?").run(dispatchId);

    const result = runnerTokens.verifyRunToken(token, SECRET, "result", { consume: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed");
      expect(result.claims?.dispatchId).toBe(dispatchId);
    }
  });
});

const PILOT_ATTEMPT = "reviewfix-pilot-attempt-1";

function seedPreparedPilotAttempt(deadlineAt = Date.now() + 60_000): void {
  const db = dedup.getDb();
  db.prepare(`
    INSERT INTO dispatch_admissions
      (dispatch_id, mapping_key, issue_scope, issue_id, installation_id,
       repository, pr_number, lifecycle_owner, phase, backend, created_at)
    VALUES (?, 'AII', 'pr', 'acme/app#42', '7', 'acme/app', 42,
            ?, 'implementation', 'github-actions', ?)
  `).run(PILOT_ATTEMPT, `restate:${PILOT_ATTEMPT}`, Date.now());
  db.prepare(`
    INSERT INTO review_fix_attempts
      (attempt_id, dispatch_id, mapping_key, installation_id, repository,
       pr_number, issue_scope, issue_id, owner, state, created_at, deadline_at,
       task_snapshot_json, finding_versions_json)
    VALUES (?, ?, 'AII', '7', 'acme/app', 42, 'pr', 'acme/app#42',
            ?, 'prepared', ?, ?, '{}', '[]')
  `).run(PILOT_ATTEMPT, PILOT_ATTEMPT, PILOT_ATTEMPT, Date.now(), deadlineAt);
}

function resignPilotClaims(token: string, changes: Record<string, unknown>): string {
  const [payload] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  const alteredPayload = Buffer.from(JSON.stringify({ ...claims, ...changes })).toString("base64url");
  const signature = crypto.createHmac("sha256", SECRET).update(alteredPayload).digest("base64url");
  return `${alteredPayload}.${signature}`;
}

describe("prepared review-fix credentials", () => {
  it("permits publication only for the bound live execution, then rejects revocation and termination", () => {
    seedPreparedPilotAttempt();
    const db = dedup.getDb();
    db.prepare("UPDATE review_fix_attempts SET state = 'launch_intent', github_run_id = 123, github_run_attempt = 2 WHERE attempt_id = ?")
      .run(PILOT_ATTEMPT);
    const publication = runnerTokens.mintPreparedReviewFixToken({ attemptId: PILOT_ATTEMPT, audience: "publication", secret: SECRET });
    const result = runnerTokens.mintPreparedReviewFixToken({ attemptId: PILOT_ATTEMPT, audience: "result", secret: SECRET });
    const execution = { repository: "acme/app", githubRunId: 123, githubRunAttempt: 2 };
    expect(runnerTokens.verifyPreparedReviewFixToken(result.token, SECRET, "result", { publicationExecution: execution }).ok).toBe(true);
    expect(runnerTokens.verifyPreparedReviewFixToken(publication.token, SECRET, "publication", {
      consumePublication: true, publicationExecution: { ...execution, githubRunAttempt: 3 },
    })).toMatchObject({ ok: false, reason: "wrong_scope" });
    expect(runnerTokens.verifyPreparedReviewFixToken(publication.token, SECRET, "publication", {
      consumePublication: true, publicationExecution: execution,
    }).ok).toBe(true);
    db.prepare("UPDATE review_fix_attempts SET authority_revoked_at = ? WHERE attempt_id = ?").run(Date.now(), PILOT_ATTEMPT);
    expect(runnerTokens.verifyPreparedReviewFixToken(result.token, SECRET, "result", { publicationExecution: execution }))
      .toMatchObject({ ok: false, reason: "revoked" });
    db.prepare("UPDATE review_fix_attempts SET authority_revoked_at = NULL, terminal_outcome_json = '{}' WHERE attempt_id = ?")
      .run(PILOT_ATTEMPT);
    expect(runnerTokens.verifyPreparedReviewFixToken(result.token, SECRET, "result", { publicationExecution: execution }))
      .toMatchObject({ ok: false, reason: "revoked" });
  });

  it("holds publication at the deadline while preserving result-delivery grace", () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    seedPreparedPilotAttempt(now + 1000);
    const db = dedup.getDb();
    db.prepare("UPDATE review_fix_attempts SET state = 'launch_intent', github_run_id = 123, github_run_attempt = 1 WHERE attempt_id = ?")
      .run(PILOT_ATTEMPT);
    const publication = runnerTokens.mintPreparedReviewFixToken({ attemptId: PILOT_ATTEMPT, audience: "publication", secret: SECRET });
    const result = runnerTokens.mintPreparedReviewFixToken({ attemptId: PILOT_ATTEMPT, audience: "result", secret: SECRET });
    clock.mockReturnValue(now + 1001);
    const execution = { repository: "acme/app", githubRunId: 123, githubRunAttempt: 1 };
    expect(runnerTokens.verifyPreparedReviewFixToken(publication.token, SECRET, "publication", {
      consumePublication: true, publicationExecution: execution,
    })).toMatchObject({ ok: false, reason: "revoked" });
    expect(runnerTokens.verifyPreparedReviewFixToken(result.token, SECRET, "result").ok).toBe(true);
    expect(() => runnerTokens.mintPreparedReviewFixToken({ attemptId: PILOT_ATTEMPT, audience: "publication", secret: SECRET }))
      .toThrow(/publication authority has ended/);
  });
  it("reuses the stored identity and expiry without resetting a consumed publication claim", () => {
    seedPreparedPilotAttempt();
    const first = runnerTokens.mintPreparedReviewFixToken({ attemptId: PILOT_ATTEMPT, audience: "publication", secret: SECRET });
    const expiry = (dedup.getDb().prepare(
      "SELECT expires_at FROM runner_tokens WHERE dispatch_id = ? AND audience = 'publication'",
    ).get(PILOT_ATTEMPT) as { expires_at: number }).expires_at;
    expect(runnerTokens.verifyPreparedReviewFixToken(first.token, SECRET, "publication", { consumePublication: true }).ok).toBe(true);

    const retry = runnerTokens.mintPreparedReviewFixToken({ attemptId: PILOT_ATTEMPT, audience: "publication", secret: SECRET });
    expect(retry).toEqual(first);
    const row = dedup.getDb().prepare(
      "SELECT expires_at, consumed_at FROM runner_tokens WHERE dispatch_id = ? AND audience = 'publication'",
    ).get(PILOT_ATTEMPT) as { expires_at: number; consumed_at: number | null };
    expect(row.expires_at).toBe(expiry);
    expect(row.consumed_at).not.toBeNull();
    const replay = runnerTokens.verifyPreparedReviewFixToken(retry.token, SECRET, "publication", { consumePublication: true });
    expect(replay).toMatchObject({ ok: false, reason: "already_consumed" });
  });

  it("validates pilot result repeatedly without consuming before durable intake", () => {
    seedPreparedPilotAttempt();
    const minted = runnerTokens.mintPreparedReviewFixToken({ attemptId: PILOT_ATTEMPT, audience: "result", secret: SECRET });
    expect(runnerTokens.verifyPreparedReviewFixToken(minted.token, SECRET, "result").ok).toBe(true);
    expect(runnerTokens.verifyPreparedReviewFixToken(minted.token, SECRET, "result").ok).toBe(true);
    const row = dedup.getDb().prepare(
      "SELECT consumed_at FROM runner_tokens WHERE dispatch_id = ? AND audience = 'result'",
    ).get(PILOT_ATTEMPT) as { consumed_at: number | null };
    expect(row.consumed_at).toBeNull();
  });

  it("rejects wrong audience, repository, attempt, mapping, and expiry even when re-signed", () => {
    seedPreparedPilotAttempt();
    const minted = runnerTokens.mintPreparedReviewFixToken({ attemptId: PILOT_ATTEMPT, audience: "result", secret: SECRET });
    expect(runnerTokens.verifyPreparedReviewFixToken(minted.token, SECRET, "progress"))
      .toMatchObject({ ok: false, reason: "wrong_audience" });
    for (const change of [
      { repository: "other/repo" },
      { attemptId: "other-attempt" },
      { installationId: 8 },
      { prNumber: 43 },
      { issueId: "other-issue" },
      { exp: Date.now() + 10_000_000 },
    ]) {
      const altered = resignPilotClaims(minted.token, change);
      expect(runnerTokens.verifyPreparedReviewFixToken(altered, SECRET, "result"))
        .toMatchObject({ ok: false });
    }
    dedup.getDb().prepare("UPDATE runner_tokens SET mapping_team_key = 'WRONG' WHERE dispatch_id = ?")
      .run(PILOT_ATTEMPT);
    expect(runnerTokens.verifyPreparedReviewFixToken(minted.token, SECRET, "result"))
      .toMatchObject({ ok: false, reason: "wrong_scope" });
  });

  it("uses the persisted deadline plus bounded grace and rejects revoked or released authority", () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    seedPreparedPilotAttempt(now + 60_000);
    const minted = runnerTokens.mintPreparedReviewFixToken({ attemptId: PILOT_ATTEMPT, audience: "progress", secret: SECRET });
    const row = dedup.getDb().prepare(
      "SELECT expires_at FROM runner_tokens WHERE dispatch_id = ? AND audience = 'progress'",
    ).get(PILOT_ATTEMPT) as { expires_at: number };
    expect(row.expires_at).toBe(now + 60_000 + 15 * 60_000);
    clock.mockReturnValue(row.expires_at + 1);
    expect(runnerTokens.verifyPreparedReviewFixToken(minted.token, SECRET, "progress"))
      .toMatchObject({ ok: false, reason: "expired" });

    clock.mockReturnValue(now);
    dedup.getDb().prepare("UPDATE review_fix_attempts SET authority_revoked_at = ? WHERE attempt_id = ?")
      .run(now, PILOT_ATTEMPT);
    expect(runnerTokens.verifyPreparedReviewFixToken(minted.token, SECRET, "progress"))
      .toMatchObject({ ok: false, reason: "revoked" });
    expect(() => runnerTokens.mintPreparedReviewFixToken({ attemptId: PILOT_ATTEMPT, audience: "result", secret: SECRET }))
      .toThrow(/no current authority/);

    dedup.getDb().prepare("UPDATE review_fix_attempts SET authority_revoked_at = NULL WHERE attempt_id = ?")
      .run(PILOT_ATTEMPT);
    dedup.getDb().prepare("UPDATE dispatch_admissions SET released_at = ? WHERE dispatch_id = ?")
      .run(now, PILOT_ATTEMPT);
    expect(runnerTokens.verifyPreparedReviewFixToken(minted.token, SECRET, "progress"))
      .toMatchObject({ ok: false, reason: "revoked" });
  });

  it("allows a credential retry during delivery grace but no first issuance after the deadline", () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    seedPreparedPilotAttempt(now + 1_000);
    const first = runnerTokens.mintPreparedReviewFixToken({ attemptId: PILOT_ATTEMPT, audience: "result", secret: SECRET });
    clock.mockReturnValue(now + 1_001);
    expect(runnerTokens.mintPreparedReviewFixToken({ attemptId: PILOT_ATTEMPT, audience: "result", secret: SECRET }))
      .toEqual(first);
    expect(runnerTokens.verifyPreparedReviewFixToken(first.token, SECRET, "result").ok).toBe(true);
    expect(() => runnerTokens.mintPreparedReviewFixToken({ attemptId: PILOT_ATTEMPT, audience: "progress", secret: SECRET }))
      .toThrow(/deadline has passed/);
  });

  it("rejects credentials if the admission is reassigned", () => {
    seedPreparedPilotAttempt();
    const minted = runnerTokens.mintPreparedReviewFixToken({ attemptId: PILOT_ATTEMPT, audience: "result", secret: SECRET });
    dedup.getDb().prepare("UPDATE dispatch_admissions SET lifecycle_owner = 'legacy' WHERE dispatch_id = ?")
      .run(PILOT_ATTEMPT);
    expect(runnerTokens.verifyPreparedReviewFixToken(minted.token, SECRET, "result"))
      .toMatchObject({ ok: false, reason: "revoked" });
    expect(() => runnerTokens.mintPreparedReviewFixToken({ attemptId: PILOT_ATTEMPT, audience: "progress", secret: SECRET }))
      .toThrow(/no current authority/);
    dedup.getDb().prepare("UPDATE dispatch_admissions SET lifecycle_owner = ?, repository = 'other/app' WHERE dispatch_id = ?")
      .run(`restate:${PILOT_ATTEMPT}`, PILOT_ATTEMPT);
    expect(runnerTokens.verifyPreparedReviewFixToken(minted.token, SECRET, "result"))
      .toMatchObject({ ok: false, reason: "revoked" });
  });
});
