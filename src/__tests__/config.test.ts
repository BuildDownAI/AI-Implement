import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as ConfigModule from "../config.js";
import type * as DedupModule from "../dedup.js";
import type { RepoMapping } from "../config.js";

let dbPath: string;
let config: typeof ConfigModule;
let dedup: typeof DedupModule;

// Helper: create a RepoMapping with defaults for new fields
function mapping(overrides: Partial<RepoMapping> & Pick<RepoMapping, "owner" | "repo">): RepoMapping {
  return {
    workflowFile: "claude-implement.yml",
    defaultBranch: "main",
    maxInProgressAiIssues: 3,
    executionMode: "github-actions",
    sessionMode: "autonomous",
    machineCpus: 2,
    machineMemoryMb: 4096,
    planningEnabled: false,
    planningWorkflowFile: "",
    autoApprovePlans: true,
    extraEnv: {},
    provider: "anthropic",
    ticketingProvider: "linear",
    ticketingConfig: { kind: "linear" },
    awsRegion: null,
    paused: false,
    ...overrides,
  };
}

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `config-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  config = await import("../config.js");
  dedup = await import("../dedup.js");
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

describe("config", () => {
  it("initialises an empty mappings table", () => {
    config.initMappingsTable();
    expect(config.getMappings()).toEqual({});
  });

  it("upsertMapping stores and retrieves a mapping", () => {
    config.initMappingsTable();
    config.upsertMapping("APP", mapping({ owner: "my-org", repo: "my-app", maxInProgressAiIssues: 4 }));
    const mappings = config.getMappings();
    expect(mappings.APP.owner).toBe("my-org");
    expect(mappings.APP.repo).toBe("my-app");
    expect(mappings.APP.maxInProgressAiIssues).toBe(4);
  });

  it("upsertMapping overwrites an existing entry", () => {
    config.initMappingsTable();
    config.upsertMapping("APP", mapping({ owner: "old", repo: "old-repo", maxInProgressAiIssues: 2 }));
    config.upsertMapping("APP", mapping({ owner: "new", repo: "new-repo", maxInProgressAiIssues: 5 }));
    const mappings = config.getMappings();
    expect(mappings.APP.owner).toBe("new");
    expect(mappings.APP.maxInProgressAiIssues).toBe(5);
  });

  it("updateMappingCap updates the cap and returns true", () => {
    config.initMappingsTable();
    config.upsertMapping("APP", mapping({ owner: "org", repo: "app", maxInProgressAiIssues: 2 }));
    expect(config.updateMappingCap("APP", 10)).toBe(true);
    expect(config.getMappings().APP.maxInProgressAiIssues).toBe(10);
  });

  it("updateMappingCap returns false for unknown team", () => {
    config.initMappingsTable();
    expect(config.updateMappingCap("NOPE", 5)).toBe(false);
  });

  it("deleteMapping removes the entry and returns true", () => {
    config.initMappingsTable();
    config.upsertMapping("APP", mapping({ owner: "org", repo: "app" }));
    expect(config.deleteMapping("APP")).toBe(true);
    expect(config.getMappings().APP).toBeUndefined();
  });

  it("deleteMapping returns false for unknown team", () => {
    config.initMappingsTable();
    expect(config.deleteMapping("NOPE")).toBe(false);
  });

  it("migrates existing mappings table to include max_in_progress_ai_issues", () => {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE mappings (
        team_key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        workflow_file TEXT NOT NULL,
        default_branch TEXT NOT NULL
      )
    `);
    db.prepare("INSERT INTO mappings (team_key, owner, repo, workflow_file, default_branch) VALUES (?, ?, ?, ?, ?)").run("LEG", "org", "legacy-repo", "claude-implement.yml", "main");
    db.close();

    config.initMappingsTable();
    const mappings = config.getMappings();
    expect(mappings.LEG.maxInProgressAiIssues).toBe(config.DEFAULT_MAX_IN_PROGRESS_AI_ISSUES);
  });

  it("stores and retrieves v2 machine config fields", () => {
    config.initMappingsTable();
    config.upsertMapping("FLY", mapping({
      owner: "org",
      repo: "fly-repo",
      executionMode: "fly-machines",
      sessionMode: "hybrid",
      machineCpus: 4,
      machineMemoryMb: 8192,
    }));
    const m = config.getMappings().FLY;
    expect(m.executionMode).toBe("fly-machines");
    expect(m.sessionMode).toBe("hybrid");
    expect(m.machineCpus).toBe(4);
    expect(m.machineMemoryMb).toBe(8192);
  });

  it("returns default v2 fields for mappings created without them", () => {
    config.initMappingsTable();
    config.upsertMapping("DEF", mapping({ owner: "org", repo: "default-repo" }));
    const m = config.getMappings().DEF;
    expect(m.executionMode).toBe("github-actions");
    expect(m.sessionMode).toBe("autonomous");
    expect(m.machineCpus).toBe(2);
    expect(m.machineMemoryMb).toBe(4096);
  });

  it("migrates existing table to include v2 columns with defaults", () => {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE mappings (
        team_key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        workflow_file TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        max_in_progress_ai_issues INTEGER NOT NULL DEFAULT 3
      )
    `);
    db.prepare("INSERT INTO mappings (team_key, owner, repo, workflow_file, default_branch, max_in_progress_ai_issues) VALUES (?, ?, ?, ?, ?, ?)").run("OLD", "org", "old-repo", "claude-implement.yml", "main", 3);
    db.close();

    config.initMappingsTable();
    const m = config.getMappings().OLD;
    expect(m.executionMode).toBe("github-actions");
    expect(m.sessionMode).toBe("autonomous");
    expect(m.machineCpus).toBe(2);
    expect(m.machineMemoryMb).toBe(4096);
  });

  it("stores and retrieves extraEnv", () => {
    config.initMappingsTable();
    config.upsertMapping("ENV", mapping({ owner: "org", repo: "repo", extraEnv: { FOO: "bar", BAZ: "qux" } }));
    const m = config.getMappings().ENV;
    expect(m.extraEnv).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("returns empty extraEnv when field is null", () => {
    config.initMappingsTable();
    config.upsertMapping("ENV2", mapping({ owner: "org", repo: "repo" }));
    const m = config.getMappings().ENV2;
    expect(m.extraEnv).toEqual({});
  });

  it("autoApprovePlans round-trips true when upserted", () => {
    config.initMappingsTable();
    config.upsertMapping("APR", mapping({ owner: "org", repo: "repo", autoApprovePlans: true }));
    expect(config.getMappings().APR.autoApprovePlans).toBe(true);
  });

  it("autoApprovePlans round-trips false when upserted", () => {
    config.initMappingsTable();
    config.upsertMapping("APR", mapping({ owner: "org", repo: "repo", autoApprovePlans: false }));
    expect(config.getMappings().APR.autoApprovePlans).toBe(false);
  });

  it("planningEnabled round-trips both values", () => {
    config.initMappingsTable();
    config.upsertMapping("PON", mapping({ owner: "org", repo: "repo", planningEnabled: true }));
    expect(config.getMappings().PON.planningEnabled).toBe(true);
    config.upsertMapping("POFF", mapping({ owner: "org", repo: "repo", planningEnabled: false }));
    expect(config.getMappings().POFF.planningEnabled).toBe(false);
  });

  it("stores and retrieves provider=bedrock with awsRegion", () => {
    config.initMappingsTable();
    config.upsertMapping("BED", mapping({
      owner: "org", repo: "repo", provider: "bedrock", awsRegion: "us-west-2",
    }));
    const m = config.getMappings().BED;
    expect(m.provider).toBe("bedrock");
    expect(m.awsRegion).toBe("us-west-2");
  });

  it("defaults to provider=anthropic with null awsRegion when not specified", () => {
    config.initMappingsTable();
    config.upsertMapping("DEF", mapping({ owner: "org", repo: "repo" }));
    const m = config.getMappings().DEF;
    expect(m.provider).toBe("anthropic");
    expect(m.awsRegion).toBeNull();
  });

  it("migrates existing table to include provider and aws_region columns with defaults", () => {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE mappings (
        team_key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        workflow_file TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        max_in_progress_ai_issues INTEGER NOT NULL DEFAULT 3,
        execution_mode TEXT NOT NULL DEFAULT 'github-actions',
        session_mode TEXT NOT NULL DEFAULT 'autonomous',
        machine_cpus INTEGER NOT NULL DEFAULT 2,
        machine_memory_mb INTEGER NOT NULL DEFAULT 4096,
        planning_enabled INTEGER NOT NULL DEFAULT 0,
        planning_workflow_file TEXT NOT NULL DEFAULT 'claude-plan.yml',
        auto_approve_plans INTEGER NOT NULL DEFAULT 1,
        extra_env TEXT
      )
    `);
    db.prepare("INSERT INTO mappings (team_key, owner, repo, workflow_file, default_branch) VALUES (?, ?, ?, ?, ?)")
      .run("PRE", "org", "pre-bedrock", "claude-implement.yml", "main");
    db.close();

    config.initMappingsTable();
    const m = config.getMappings().PRE;
    expect(m.provider).toBe("anthropic");
    expect(m.awsRegion).toBeNull();
  });

  it("adds ticketing_provider column with default 'linear' on upgrade", () => {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE mappings (
        team_key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        workflow_file TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        max_in_progress_ai_issues INTEGER NOT NULL DEFAULT 3,
        execution_mode TEXT NOT NULL DEFAULT 'github-actions',
        session_mode TEXT NOT NULL DEFAULT 'autonomous',
        machine_cpus INTEGER NOT NULL DEFAULT 2,
        machine_memory_mb INTEGER NOT NULL DEFAULT 4096,
        planning_enabled INTEGER NOT NULL DEFAULT 0,
        planning_workflow_file TEXT NOT NULL DEFAULT 'claude-plan.yml',
        auto_approve_plans INTEGER NOT NULL DEFAULT 1,
        extra_env TEXT,
        provider TEXT NOT NULL DEFAULT 'anthropic',
        aws_region TEXT
      )
    `);
    db.prepare("INSERT INTO mappings (team_key, owner, repo, workflow_file, default_branch) VALUES (?, ?, ?, ?, ?)")
      .run("LEG", "org", "legacy-repo", "claude-implement.yml", "main");
    db.close();

    config.initMappingsTable();
    const m = config.getMappings().LEG;
    expect(m.ticketingProvider).toBe("linear");

    // Verify the column exists in the schema.
    const reopened = new Database(dbPath);
    const info = reopened.prepare("PRAGMA table_info(mappings)").all() as Array<{ name: string }>;
    reopened.close();
    expect(info.map((c) => c.name)).toContain("ticketing_provider");
  });

  it("round-trips a custom ticketingProvider", () => {
    config.initMappingsTable();
    config.upsertMapping(
      "JIR",
      mapping({
        owner: "org",
        repo: "repo",
        ticketingProvider: "jira",
        ticketingConfig: { kind: "jira", jql: "project = T", repoFieldValue: "org/repo" },
      }),
    );
    const m = config.getMappings().JIR;
    expect(m.ticketingProvider).toBe("jira");
  });

  it("defaults to ticketingProvider='linear' when not specified", () => {
    config.initMappingsTable();
    config.upsertMapping("LIN", mapping({ owner: "org", repo: "repo" }));
    const m = config.getMappings().LIN;
    expect(m.ticketingProvider).toBe("linear");
  });

  describe("mappings ticketing_config migration", () => {
    it("adds ticketing_config column with linear default on upgrade", () => {
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE mappings (
          team_key TEXT PRIMARY KEY,
          owner TEXT NOT NULL,
          repo TEXT NOT NULL,
          workflow_file TEXT NOT NULL,
          default_branch TEXT NOT NULL,
          max_in_progress_ai_issues INTEGER NOT NULL DEFAULT 3,
          execution_mode TEXT NOT NULL DEFAULT 'github-actions',
          session_mode TEXT NOT NULL DEFAULT 'autonomous',
          machine_cpus INTEGER NOT NULL DEFAULT 2,
          machine_memory_mb INTEGER NOT NULL DEFAULT 4096,
          planning_enabled INTEGER NOT NULL DEFAULT 0,
          planning_workflow_file TEXT NOT NULL DEFAULT 'claude-plan.yml',
          auto_approve_plans INTEGER NOT NULL DEFAULT 1,
          extra_env TEXT,
          provider TEXT NOT NULL DEFAULT 'anthropic',
          ticketing_provider TEXT NOT NULL DEFAULT 'linear',
          aws_region TEXT
        )
      `);
      db.prepare("INSERT INTO mappings (team_key, owner, repo, workflow_file, default_branch) VALUES (?, ?, ?, ?, ?)")
        .run("LEG", "org", "legacy-repo", "claude-implement.yml", "main");
      db.close();

      config.initMappingsTable();
      const m = config.getMappings().LEG;
      expect(m.ticketingConfig).toEqual({ kind: "linear" });

      // Verify the column exists in the schema.
      const reopened = new Database(dbPath);
      const info = reopened.prepare("PRAGMA table_info(mappings)").all() as Array<{ name: string }>;
      reopened.close();
      expect(info.map((c) => c.name)).toContain("ticketing_config");
    });

    it("round-trips a Jira ticketingConfig", () => {
      config.initMappingsTable();
      config.upsertMapping("JIR", mapping({
        owner: "acme",
        repo: "x",
        ticketingProvider: "jira",
        ticketingConfig: {
          kind: "jira",
          jql: "project = TEST",
          repoFieldValue: "acme/x",
          statusFieldOverride: "customfield_10001",
          repoFieldOverride: "customfield_10002",
        },
      }));
      const m = config.getMappings().JIR;
      expect(m.ticketingProvider).toBe("jira");
      expect(m.ticketingConfig).toEqual({
        kind: "jira",
        jql: "project = TEST",
        repoFieldValue: "acme/x",
        statusFieldOverride: "customfield_10001",
        repoFieldOverride: "customfield_10002",
      });
    });

    it("drops the mapping from getMappings on malformed JSON in the column", () => {
      config.initMappingsTable();
      config.upsertMapping("GOOD", mapping({ owner: "org", repo: "good" }));
      config.upsertMapping("BAD", mapping({ owner: "org", repo: "repo" }));
      // Direct SQL update to corrupt the JSON.
      const db = new Database(dbPath);
      db.prepare("UPDATE mappings SET ticketing_config = ? WHERE team_key = ?").run("{bad json", "BAD");
      db.close();

      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const all = config.getMappings();
      expect(all.BAD).toBeUndefined();
      expect(all.GOOD).toBeDefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("BAD"));
      warn.mockRestore();
    });

    it("drops a jira-provider mapping with corrupted ticketing_config", () => {
      config.initMappingsTable();
      config.upsertMapping(
        "JIR-BAD",
        mapping({
          owner: "org",
          repo: "jira-repo",
          ticketingProvider: "jira",
          ticketingConfig: {
            kind: "jira",
            jql: "project = TEST",
            repoFieldValue: "org/jira-repo",
          },
        }),
      );
      // Corrupt JSON for the jira row.
      const db = new Database(dbPath);
      db.prepare("UPDATE mappings SET ticketing_config = ? WHERE team_key = ?").run("{not valid", "JIR-BAD");
      db.close();

      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const all = config.getMappings();
      expect(all["JIR-BAD"]).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("JIR-BAD"));
      warn.mockRestore();
    });
  });

  it("upsertMapping defaults paused to false when not set", () => {
    config.initMappingsTable();
    config.upsertMapping("PAU", mapping({ owner: "org", repo: "p" }));
    expect(config.getMappings().PAU.paused).toBe(false);
  });

  it("upsertMapping round-trips paused=true", () => {
    config.initMappingsTable();
    config.upsertMapping("PAU", mapping({ owner: "org", repo: "p", paused: true }));
    expect(config.getMappings().PAU.paused).toBe(true);
  });

  it("setMappingPaused toggles the column and returns true on success", () => {
    config.initMappingsTable();
    config.upsertMapping("PAU", mapping({ owner: "org", repo: "p" }));
    expect(config.setMappingPaused("PAU", true)).toBe(true);
    expect(config.getMappings().PAU.paused).toBe(true);
    expect(config.setMappingPaused("PAU", false)).toBe(true);
    expect(config.getMappings().PAU.paused).toBe(false);
  });

  it("setMappingPaused returns false for an unknown team", () => {
    config.initMappingsTable();
    expect(config.setMappingPaused("NOPE", true)).toBe(false);
  });

  it("migrates a pre-existing mappings table to include the paused column with default false", () => {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE mappings (
        team_key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        workflow_file TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        max_in_progress_ai_issues INTEGER NOT NULL DEFAULT 3,
        execution_mode TEXT NOT NULL DEFAULT 'github-actions',
        session_mode TEXT NOT NULL DEFAULT 'autonomous',
        machine_cpus INTEGER NOT NULL DEFAULT 2,
        machine_memory_mb INTEGER NOT NULL DEFAULT 4096,
        planning_enabled INTEGER NOT NULL DEFAULT 0,
        planning_workflow_file TEXT NOT NULL DEFAULT 'claude-plan.yml',
        auto_approve_plans INTEGER NOT NULL DEFAULT 1,
        extra_env TEXT,
        provider TEXT NOT NULL DEFAULT 'anthropic',
        ticketing_provider TEXT NOT NULL DEFAULT 'linear',
        ticketing_config TEXT NOT NULL DEFAULT '{"kind":"linear"}',
        aws_region TEXT
      )
    `);
    db.prepare("INSERT INTO mappings (team_key, owner, repo, workflow_file, default_branch) VALUES (?, ?, ?, ?, ?)")
      .run("LEG", "org", "legacy", "claude-implement.yml", "main");
    db.close();

    config.initMappingsTable();
    expect(config.getMappings().LEG.paused).toBe(false);
  });

  it("getMappings falls back to {} when extra_env contains invalid JSON", () => {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE mappings (
        team_key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        workflow_file TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        max_in_progress_ai_issues INTEGER NOT NULL DEFAULT 3,
        execution_mode TEXT NOT NULL DEFAULT 'github-actions',
        session_mode TEXT NOT NULL DEFAULT 'autonomous',
        machine_cpus INTEGER NOT NULL DEFAULT 2,
        machine_memory_mb INTEGER NOT NULL DEFAULT 4096,
        planning_enabled INTEGER NOT NULL DEFAULT 0,
        planning_workflow_file TEXT NOT NULL DEFAULT '',
        extra_env TEXT
      )
    `);
    db.prepare("INSERT INTO mappings (team_key, owner, repo, workflow_file, default_branch, extra_env) VALUES (?, ?, ?, ?, ?, ?)").run("BAD", "org", "bad-repo", "claude-implement.yml", "main", "not-valid-json{{{");
    db.close();

    config.initMappingsTable();
    const m = config.getMappings().BAD;
    expect(m.extraEnv).toEqual({});
  });
});
