import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
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
});
