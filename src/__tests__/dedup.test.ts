import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import type * as DedupModule from "../dedup.js";

let dbPath: string;
let dedup: typeof DedupModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `dedup-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

describe("dedup", () => {
  it("markDispatched and isAlreadyDispatched", () => {
    expect(dedup.isAlreadyDispatched("issue-1")).toBe(false);
    dedup.markDispatched("issue-1");
    expect(dedup.isAlreadyDispatched("issue-1")).toBe(true);
    expect(dedup.isAlreadyDispatched("issue-2")).toBe(false);
  });

  it("listDispatched returns entries", () => {
    dedup.markDispatched("issue-a", "A-1", "Fix foo");
    dedup.markDispatched("issue-b", "A-2", "Fix bar");

    const entries = dedup.listDispatched();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.issueId).sort()).toEqual(["issue-a", "issue-b"]);
  });

  it("old entries are still considered dispatched (no TTL expiry)", () => {
    const db = dedup.getDb();
    const oldTime = Date.now() - 25 * 60 * 60 * 1000;
    db.prepare("INSERT INTO dispatched (issue_id, dispatched_at) VALUES (?, ?)").run("old-issue", oldTime);
    expect(dedup.isAlreadyDispatched("old-issue")).toBe(true);
  });

  it("deleteDispatched removes an entry", () => {
    dedup.markDispatched("issue-x");
    expect(dedup.isAlreadyDispatched("issue-x")).toBe(true);
    expect(dedup.deleteDispatched("issue-x")).toBe(true);
    expect(dedup.isAlreadyDispatched("issue-x")).toBe(false);
    expect(dedup.deleteDispatched("issue-x")).toBe(false);
  });

  it("getDispatchedIds returns all tracked issue IDs", () => {
    dedup.markDispatched("id-1");
    dedup.markDispatched("id-2");
    const ids = dedup.getDispatchedIds();
    expect(ids.sort()).toEqual(["id-1", "id-2"]);
  });
});

describe("dispatch admission schema", () => {
  it("upgrades a pre-pilot database twice without backfilling or changing old dispatch history", () => {
    const old = new Database(dbPath);
    old.exec("CREATE TABLE dispatched (issue_id TEXT PRIMARY KEY, dispatched_at INTEGER NOT NULL)");
    old.prepare("INSERT INTO dispatched (issue_id, dispatched_at) VALUES (?, ?)").run("old-issue", 123);
    old.close();

    const first = dedup.getDb();
    expect(first.prepare("SELECT issue_id, dispatched_at FROM dispatched").all())
      .toEqual([{ issue_id: "old-issue", dispatched_at: 123 }]);
    expect((first.prepare("SELECT COUNT(*) AS n FROM dispatch_admissions").get() as { n: number }).n).toBe(0);
    dedup.closeDb();
    const second = dedup.getDb();
    expect((second.prepare("SELECT COUNT(*) AS n FROM dispatch_admissions").get() as { n: number }).n).toBe(0);
    expect((second.prepare("SELECT COUNT(*) AS n FROM dispatch_budget_entries").get() as { n: number }).n).toBe(0);
    expect(second.prepare("SELECT issue_id FROM dispatched").all()).toEqual([{ issue_id: "old-issue" }]);
  });

  it("enforces one active scoped issue and PR while retaining released history and budget identity", () => {
    const db = dedup.getDb();
    const insert = db.prepare(`INSERT INTO dispatch_admissions
      (dispatch_id, mapping_key, issue_scope, issue_id, installation_id, repository, pr_number,
       lifecycle_owner, phase, backend, created_at)
      VALUES (@dispatchId, 'APP', @issueScope, @issueId, @installationId, @repository, @prNumber,
              'legacy', 'review-fix', 'github-actions', @createdAt)`);
    const issue = (dispatchId: string, issueScope = "team-a", issueId = "AII-1") => insert.run({
      dispatchId, issueScope, issueId, installationId: null, repository: null, prNumber: null, createdAt: 100,
    });
    issue("issue-1");
    expect(() => issue("issue-conflict")).toThrow(/UNIQUE/);
    issue("other-scope", "team-b");
    db.prepare("UPDATE dispatch_admissions SET released_at = ?, release_reason = ? WHERE dispatch_id = ?")
      .run(200, "terminal", "issue-1");
    issue("issue-2");

    const pr = (dispatchId: string, installationId = "7", repository = "BuildDownAI/AI-Implement", prNumber = 42) => insert.run({
      dispatchId, issueScope: "pr", issueId: dispatchId, installationId, repository, prNumber, createdAt: 100,
    });
    pr("pr-1");
    expect(() => pr("pr-conflict")).toThrow(/UNIQUE/);
    pr("other-installation", "8");
    pr("other-repository", "7", "BuildDownAI/Sandbox");
    db.prepare("UPDATE dispatch_admissions SET released_at = ? WHERE dispatch_id = ?").run(201, "pr-1");
    pr("pr-2");

    const budget = db.prepare(`INSERT INTO dispatch_budget_entries
      (dispatch_id, repository, pr_number, request_kind, created_at) VALUES (?, ?, ?, ?, ?)`);
    budget.run("pr-1", "BuildDownAI/AI-Implement", 42, "automatic", 100);
    expect(() => budget.run("pr-1", "BuildDownAI/AI-Implement", 42, "automatic", 101)).toThrow(/UNIQUE/);
    budget.run("pr-2", "BuildDownAI/AI-Implement", 42, "automatic", 201);
    expect(db.prepare("SELECT dispatch_id FROM dispatch_budget_entries ORDER BY created_at").all())
      .toEqual([{ dispatch_id: "pr-1" }, { dispatch_id: "pr-2" }]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM review_fix_dispatches").get() as { n: number }).n).toBe(0);
  });
});

describe("review-fix attempt and inbox schema", () => {
  it("upgrades old findings and queue history twice without rewriting legacy rows", () => {
    const old = new Database(dbPath);
    old.exec(`
      CREATE TABLE review_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, pr_number INTEGER NOT NULL,
        finding_key TEXT NOT NULL, source TEXT NOT NULL, severity TEXT NOT NULL,
        body TEXT NOT NULL, path TEXT, line INTEGER, url TEXT,
        status TEXT NOT NULL DEFAULT 'open', first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL, resolved_at INTEGER,
        UNIQUE (repo, pr_number, finding_key)
      );
      CREATE TABLE review_fix_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id TEXT NOT NULL, issue_identifier TEXT,
        repo TEXT NOT NULL, pr_number INTEGER NOT NULL, reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, dispatched_at INTEGER, UNIQUE (repo, pr_number)
      );
    `);
    old.prepare(`INSERT INTO review_findings
      (repo, pr_number, finding_key, source, severity, body, first_seen_at, last_seen_at)
      VALUES ('acme/app', 42, 'f-1', 'review', 'high', 'keep this body', 10, 11)`).run();
    old.prepare(`INSERT INTO review_fix_queue
      (issue_id, repo, pr_number, reason, created_at, updated_at)
      VALUES ('issue-1', 'acme/app', 42, 'feedback', 12, 13)`).run();
    old.close();

    dedup.getDb();
    dedup.closeDb();
    const db = dedup.getDb();
    expect(db.prepare("SELECT finding_key, body, revision FROM review_findings").all())
      .toEqual([{ finding_key: "f-1", body: "keep this body", revision: 1 }]);
    expect(db.prepare("SELECT issue_id, reason, created_at FROM review_fix_queue").all())
      .toEqual([{ issue_id: "issue-1", reason: "feedback", created_at: 12 }]);
    expect((db.prepare("PRAGMA table_info(review_findings)").all() as Array<{ name: string }>)
      .filter((column) => column.name === "revision")).toHaveLength(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM review_fix_attempts").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM review_fix_inbox").get() as { n: number }).n).toBe(0);
  });

  it("keeps attempt ownership immutable and duplicate identities from allocating another record", () => {
    const db = dedup.getDb();
    const insertAttempt = db.prepare(`INSERT INTO review_fix_attempts
      (attempt_id, dispatch_id, mapping_key, installation_id, repository, pr_number,
       issue_scope, issue_id, owner, state, created_at, deadline_at,
       task_snapshot_json, finding_versions_json)
      VALUES (@attemptId, @dispatchId, 'APP', '7', 'acme/app', 42,
              'team', 'issue-1', @owner, 'prepared', 10, 1000, '{}', '[]')`);
    insertAttempt.run({ attemptId: "attempt-1", dispatchId: "dispatch-1", owner: "attempt-1" });
    expect(() => insertAttempt.run({ attemptId: "attempt-1", dispatchId: "dispatch-2", owner: "attempt-1" }))
      .toThrow(/UNIQUE/);
    expect(() => insertAttempt.run({ attemptId: "attempt-2", dispatchId: "dispatch-1", owner: "attempt-2" }))
      .toThrow(/UNIQUE/);
    expect(() => db.prepare("UPDATE review_fix_attempts SET owner = ? WHERE attempt_id = ?")
      .run("attempt-2", "attempt-1")).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE review_fix_attempts SET github_run_id = 99 WHERE attempt_id = 'attempt-1'").run())
      .toThrow(/CHECK/);
    db.prepare(`UPDATE review_fix_attempts SET github_run_id = 99, github_run_attempt = 1
      WHERE attempt_id = 'attempt-1'`).run();
    expect(() => db.prepare(`UPDATE review_fix_attempts SET accepted_result_hash = 'hash-1'
      WHERE attempt_id = 'attempt-1'`).run()).toThrow(/CHECK/);
    db.prepare(`UPDATE review_fix_attempts
      SET accepted_result_json = '{}', accepted_result_hash = 'hash-1'
      WHERE attempt_id = 'attempt-1'`).run();

    const insertEvent = db.prepare(`INSERT INTO review_fix_inbox
      (authenticated_source, event_id, installation_id, repository, pr_number,
       kind, payload_json, payload_hash, accepted_at)
      VALUES (?, ?, '7', 'acme/app', 42, ?, '{}', 'hash-1', 20)`);
    insertEvent.run("github", "event-1", "feedback");
    db.prepare("UPDATE review_fix_inbox SET delivery_state = 'delivered', delivered_at = 30 WHERE event_id = 'event-1'").run();
    expect(() => insertEvent.run("github", "event-1", "feedback")).toThrow(/UNIQUE/);
    insertEvent.run("runner", "event-1", "result");
    expect(db.prepare("SELECT authenticated_source, event_id, kind FROM review_fix_inbox ORDER BY authenticated_source").all())
      .toEqual([
        { authenticated_source: "github", event_id: "event-1", kind: "feedback" },
        { authenticated_source: "runner", event_id: "event-1", kind: "result" },
      ]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM review_fix_dispatches").get() as { n: number }).n).toBe(0);
  });
});

describe("review-fix activity and cycle schema", () => {
  it("retains cycle evidence independently when activity reaches its durable cap", () => {
    const db = dedup.getDb();
    const payload = JSON.stringify({ text: "x".repeat(16373) });
    expect(Buffer.byteLength(payload)).toBe(16384);
    const insertActivity = db.prepare(`INSERT INTO review_fix_activity
      (attempt_id, producer_id, sequence, payload_hash, kind, cycle, occurred_at,
       redacted_payload_json, byte_count)
      VALUES ('attempt-1', 'runner-1', ?, ?, 'tool-result', 1, 100, ?, ?)`);
    db.transaction(() => {
      for (let sequence = 1; sequence <= 640; sequence++) {
        insertActivity.run(sequence, `hash-${sequence}`, payload, 16384);
      }
    })();
    expect(db.prepare("SELECT accepted_bytes FROM review_fix_activity_streams WHERE attempt_id = 'attempt-1'").get())
      .toEqual({ accepted_bytes: 10 * 1024 * 1024 });
    expect(() => insertActivity.run(641, "hash-641", "{}", 2)).toThrow(/CHECK/);
    db.prepare(`INSERT INTO review_fix_activity_producers
      (attempt_id, producer_id, highest_contiguous_sequence, final_sequence, limit_reached_at)
      VALUES ('attempt-1', 'runner-1', 640, 641, 101)`).run();
    db.prepare(`INSERT INTO review_fix_activity_streams
      (attempt_id, limit_reached_at, truncated_at) VALUES ('attempt-2', 102, 102)`).run();
    db.prepare(`INSERT INTO review_fix_cycles
      (attempt_id, cycle, summary_id, summary_hash, input_commit, output_commit,
       dispositions_json, tests_json, verdict, usage_json, completed_at)
      VALUES ('attempt-1', 1, 'summary-1', 'summary-hash', 'before', 'after',
              '[]', '[]', 'passed', '{}', 103)`).run();
    dedup.closeDb();
    const reopened = dedup.getDb();
    expect(reopened.prepare("SELECT accepted_bytes, limit_reached_at FROM review_fix_activity_streams WHERE attempt_id = 'attempt-1'").get())
      .toEqual({ accepted_bytes: 10 * 1024 * 1024, limit_reached_at: null });
    expect(reopened.prepare("SELECT final_sequence, limit_reached_at FROM review_fix_activity_producers WHERE attempt_id = 'attempt-1'").get())
      .toEqual({ final_sequence: 641, limit_reached_at: 101 });
    expect(reopened.prepare("SELECT input_commit, output_commit, verdict FROM review_fix_cycles WHERE attempt_id = 'attempt-1'").get())
      .toEqual({ input_commit: "before", output_commit: "after", verdict: "passed" });
  });

  it("rejects conflicting activity identities and keeps replay from increasing the byte tally", () => {
    const db = dedup.getDb();
    const insert = db.prepare(`INSERT INTO review_fix_activity
      (attempt_id, producer_id, sequence, payload_hash, kind, cycle, occurred_at,
       redacted_payload_json, byte_count)
      VALUES ('attempt-1', 'runner-1', 1, ?, 'tool-call', 1, 100, ?, ?)`);
    insert.run("hash-1", "{}", 2);
    expect(() => insert.run("hash-2", "[]", 2)).toThrow(/conflicting/);
    db.prepare(`INSERT OR IGNORE INTO review_fix_activity
      (attempt_id, producer_id, sequence, payload_hash, kind, cycle, occurred_at,
       redacted_payload_json, byte_count)
      VALUES ('attempt-1', 'runner-1', 1, 'hash-1', 'tool-call', 1, 100, '{}', 2)`).run();
    expect(() => db.prepare(`INSERT OR IGNORE INTO review_fix_activity
      (attempt_id, producer_id, sequence, payload_hash, kind, cycle, occurred_at,
       redacted_payload_json, byte_count)
      VALUES ('attempt-1', 'runner-1', 1, 'hash-2', 'tool-call', 1, 100, '[]', 2)`).run())
      .toThrow(/conflicting/);
    expect(db.prepare("SELECT accepted_bytes FROM review_fix_activity_streams WHERE attempt_id = 'attempt-1'").get())
      .toEqual({ accepted_bytes: 2 });
    expect(() => db.prepare("UPDATE review_fix_activity SET redacted_payload_json = '[]'").run())
      .toThrow(/immutable/);
    expect(() => db.prepare("UPDATE review_fix_activity_streams SET accepted_bytes = 0").run())
      .toThrow(/cannot decrease/);
    expect(() => db.prepare(`INSERT INTO review_fix_activity
      (attempt_id, producer_id, sequence, payload_hash, kind, cycle, occurred_at,
       redacted_payload_json, byte_count)
      VALUES ('attempt-1', 'runner-1', 2, 'hash-3', 'tool-call', 1, 101, '{}', 3)`).run())
      .toThrow(/CHECK/);
    db.prepare(`INSERT INTO review_fix_cycles
      (attempt_id, cycle, summary_id, summary_hash, dispositions_json,
       tests_json, verdict, usage_json, completed_at)
      VALUES ('attempt-1', 1, 'summary-1', 'hash', '[]', '[]', 'passed', '{}', 101)`).run();
    expect(() => db.prepare("UPDATE review_fix_cycles SET summary_id = 'summary-2'").run())
      .toThrow(/immutable/);
  });

  it("adds activity tables around an existing attempt without changing its identity", () => {
    const old = new Database(dbPath);
    old.exec(`CREATE TABLE review_fix_attempts (
      attempt_id TEXT PRIMARY KEY, dispatch_id TEXT NOT NULL UNIQUE,
      owner TEXT NOT NULL, installation_id TEXT NOT NULL,
      repository TEXT NOT NULL, pr_number INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    old.prepare(`INSERT INTO review_fix_attempts VALUES
      ('attempt-legacy', 'dispatch-legacy', 'legacy', '7', 'acme/app', 42, 10)`).run();
    old.close();
    const db = dedup.getDb();
    db.prepare(`INSERT INTO review_fix_activity_streams (attempt_id, accepted_bytes, limit_reached_at)
      VALUES ('attempt-legacy', 10485760, 20)`).run();
    db.prepare(`INSERT INTO review_fix_cycles
      (attempt_id, cycle, summary_id, summary_hash, dispositions_json,
       tests_json, verdict, usage_json, completed_at)
      VALUES ('attempt-legacy', 1, 'summary-legacy', 'hash', '[]', '[]', 'passed', '{}', 30)`).run();
    dedup.closeDb();
    const reopened = dedup.getDb();
    expect(reopened.prepare("SELECT dispatch_id, owner FROM review_fix_attempts WHERE attempt_id = 'attempt-legacy'").get())
      .toEqual({ dispatch_id: "dispatch-legacy", owner: "legacy" });
    expect(reopened.prepare("SELECT summary_id FROM review_fix_cycles WHERE attempt_id = 'attempt-legacy'").get())
      .toEqual({ summary_id: "summary-legacy" });
    expect(reopened.prepare("SELECT accepted_bytes FROM review_fix_activity_streams WHERE attempt_id = 'attempt-legacy'").get())
      .toEqual({ accepted_bytes: 10 * 1024 * 1024 });
  });
});

describe("reaper actions", () => {
  it("recordReaperAction persists a row and listReaperActions returns it", () => {
    dedup.recordReaperAction({
      ruleMatched: "orphan",
      machineId: "m-1",
      tenantId: "team-a",
      issueIdentifier: "AII-1",
      ageSeconds: 120,
      dryRun: false,
    });

    const rows = dedup.listReaperActions(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ruleMatched: "orphan",
      machineId: "m-1",
      tenantId: "team-a",
      issueIdentifier: "AII-1",
      ageSeconds: 120,
      dryRun: false,
    });
  });

  it("getReaperSummary counts only live (non-dry-run) rows in total24h", () => {
    dedup.recordReaperAction({ ruleMatched: "orphan", machineId: "m-live-1", tenantId: null, issueIdentifier: null, ageSeconds: null, dryRun: false });
    dedup.recordReaperAction({ ruleMatched: "orphan", machineId: "m-live-2", tenantId: null, issueIdentifier: null, ageSeconds: null, dryRun: false });
    dedup.recordReaperAction({ ruleMatched: "stale-terminal-job", machineId: "m-dry-1", tenantId: null, issueIdentifier: null, ageSeconds: null, dryRun: true });

    const summary = dedup.getReaperSummary();
    expect(summary.total24h).toBe(2);
    expect(summary.byRule["orphan"]).toBe(2);
    expect(summary.byRule["stale-terminal-job"]).toBeUndefined();
  });

  it("getReaperSummary excludes rows older than 24h", () => {
    const db = dedup.getDb();
    const oldTime = Date.now() - 25 * 60 * 60 * 1000;
    db.prepare(
      "INSERT INTO reaper_actions (created_at, rule_matched, machine_id, dry_run) VALUES (?, ?, ?, ?)"
    ).run(oldTime, "orphan", "m-old", 0);
    dedup.recordReaperAction({ ruleMatched: "orphan", machineId: "m-new", tenantId: null, issueIdentifier: null, ageSeconds: null, dryRun: false });

    const summary = dedup.getReaperSummary();
    expect(summary.total24h).toBe(1);
  });

  it("listReaperActions respects the limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      dedup.recordReaperAction({ ruleMatched: "orphan", machineId: `m-${i}`, tenantId: null, issueIdentifier: null, ageSeconds: null, dryRun: false });
    }
    const rows = dedup.listReaperActions(3);
    expect(rows).toHaveLength(3);
  });
});

describe("runner_tokens table", () => {
  it("is created on init with the expected columns", () => {
    const db = dedup.getDb();
    const cols = db.prepare("PRAGMA table_info(runner_tokens)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names).toContain("dispatch_id");
    expect(names).toContain("issue_id");
    expect(names).toContain("phase");
    expect(names).toContain("expires_at");
    expect(names).toContain("consumed_at");
    expect(names).toContain("mapping_team_key");
  });

  it("drops + recreates the table when an old fork-shape (provider_id + issue_json) is present", async () => {
    // Set up a DB with the fork's old runner_tokens shape BEFORE init runs.
    const Database = (await import("better-sqlite3")).default;
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE runner_tokens (
        dispatch_id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        provider_id TEXT NOT NULL,
        issue_json TEXT NOT NULL
      )
    `);
    seed.prepare(
      "INSERT INTO runner_tokens (dispatch_id, issue_id, phase, expires_at, consumed_at, provider_id, issue_json) VALUES (?, ?, ?, ?, NULL, ?, ?)",
    ).run("d1", "i1", "planning", Date.now() + 60000, "linear", "{}");
    seed.close();

    // Now bring up dedup — its init should detect the old shape and recreate.
    const db = dedup.getDb();
    const cols = db.prepare("PRAGMA table_info(runner_tokens)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names).toContain("mapping_team_key");
    expect(names).not.toContain("provider_id");
    expect(names).not.toContain("issue_json");

    // Old rows are gone (acceptable: tokens are short-lived).
    const rows = db.prepare("SELECT COUNT(*) AS n FROM runner_tokens").get() as { n: number };
    expect(rows.n).toBe(0);
  });
});
