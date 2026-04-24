import { getDb } from "./dedup.js";

export const DEFAULT_MAX_IN_PROGRESS_AI_ISSUES = 3;
export const DEFAULT_EXECUTION_MODE = "github-actions" as const;
export const DEFAULT_SESSION_MODE = "autonomous" as const;
export const DEFAULT_MACHINE_CPUS = 2;
export const DEFAULT_MACHINE_MEMORY_MB = 4096;
export const DEFAULT_PLANNING_ENABLED = true;
export const DEFAULT_PLANNING_WORKFLOW_FILE = "claude-plan.yml";
export const DEFAULT_AUTO_APPROVE_PLANS = true;

export type ExecutionMode = "github-actions" | "fly-machines";
export type SessionMode = "autonomous" | "interactive" | "hybrid";
export type ClaudeProvider = "anthropic" | "bedrock";

export const DEFAULT_PROVIDER: ClaudeProvider = "anthropic";

export interface RepoMapping {
  owner: string;
  repo: string;
  workflowFile: string;
  defaultBranch: string;
  maxInProgressAiIssues: number;
  executionMode: ExecutionMode;
  sessionMode: SessionMode;
  machineCpus: number;
  machineMemoryMb: number;
  /** Whether to run the planning phase before implementation. Default true. */
  planningEnabled: boolean;
  /** Workflow file to dispatch for the planning phase. Required when planningEnabled=true. */
  planningWorkflowFile: string;
  /** Whether to auto-approve plans and proceed to implementation automatically. Default true. */
  autoApprovePlans: boolean;
  /** Extra env vars injected into Fly machine env at dispatch time. */
  extraEnv: Record<string, string>;
  /** Claude provider used by the dispatched workflow. Default 'anthropic'. */
  provider: ClaudeProvider;
  /** AWS region for Bedrock. Required when provider='bedrock'. */
  awsRegion: string | null;
}

// Seed mappings are only applied on first run (empty DB).
// Add your initial team→repo mappings here, or manage them via the admin UI.
const SEED_MAPPINGS: Record<string, RepoMapping> = {};

function ensureMappingsColumns(): void {
  const db = getDb();
  const info = db.prepare("PRAGMA table_info(mappings)").all() as Array<{ name: string }>;
  const names = new Set(info.map((column) => column.name));

  if (!names.has("max_in_progress_ai_issues")) {
    db.exec(
      `ALTER TABLE mappings ADD COLUMN max_in_progress_ai_issues INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_IN_PROGRESS_AI_ISSUES}`,
    );
    db.prepare(
      "UPDATE mappings SET max_in_progress_ai_issues = ? WHERE max_in_progress_ai_issues IS NULL",
    ).run(DEFAULT_MAX_IN_PROGRESS_AI_ISSUES);
  }

  if (!names.has("execution_mode")) {
    db.exec(`ALTER TABLE mappings ADD COLUMN execution_mode TEXT NOT NULL DEFAULT '${DEFAULT_EXECUTION_MODE}'`);
  }
  if (!names.has("session_mode")) {
    db.exec(`ALTER TABLE mappings ADD COLUMN session_mode TEXT NOT NULL DEFAULT '${DEFAULT_SESSION_MODE}'`);
  }
  if (!names.has("machine_cpus")) {
    db.exec(`ALTER TABLE mappings ADD COLUMN machine_cpus INTEGER NOT NULL DEFAULT ${DEFAULT_MACHINE_CPUS}`);
  }
  if (!names.has("machine_memory_mb")) {
    db.exec(`ALTER TABLE mappings ADD COLUMN machine_memory_mb INTEGER NOT NULL DEFAULT ${DEFAULT_MACHINE_MEMORY_MB}`);
  }
  if (!names.has("planning_enabled")) {
    db.exec(`ALTER TABLE mappings ADD COLUMN planning_enabled INTEGER NOT NULL DEFAULT 0`);
  }
  if (!names.has("planning_workflow_file")) {
    db.exec(`ALTER TABLE mappings ADD COLUMN planning_workflow_file TEXT NOT NULL DEFAULT ''`);
  }
  db.prepare(
    `UPDATE mappings SET planning_workflow_file = ? WHERE planning_workflow_file = ''`,
  ).run(DEFAULT_PLANNING_WORKFLOW_FILE);
  if (!names.has("auto_approve_plans")) {
    db.exec(`ALTER TABLE mappings ADD COLUMN auto_approve_plans INTEGER NOT NULL DEFAULT 1`);
  }
  if (!names.has("extra_env")) {
    db.exec(`ALTER TABLE mappings ADD COLUMN extra_env TEXT`);
  }
  if (!names.has("provider")) {
    db.exec(`ALTER TABLE mappings ADD COLUMN provider TEXT NOT NULL DEFAULT '${DEFAULT_PROVIDER}'`);
  }
  if (!names.has("aws_region")) {
    db.exec(`ALTER TABLE mappings ADD COLUMN aws_region TEXT`);
  }
}

export function initMappingsTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS mappings (
      team_key TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      workflow_file TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      max_in_progress_ai_issues INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_IN_PROGRESS_AI_ISSUES},
      execution_mode TEXT NOT NULL DEFAULT '${DEFAULT_EXECUTION_MODE}',
      session_mode TEXT NOT NULL DEFAULT '${DEFAULT_SESSION_MODE}',
      machine_cpus INTEGER NOT NULL DEFAULT ${DEFAULT_MACHINE_CPUS},
      machine_memory_mb INTEGER NOT NULL DEFAULT ${DEFAULT_MACHINE_MEMORY_MB},
      planning_enabled INTEGER NOT NULL DEFAULT 1,
      planning_workflow_file TEXT NOT NULL DEFAULT 'claude-plan.yml',
      auto_approve_plans INTEGER NOT NULL DEFAULT 1,
      extra_env TEXT,
      provider TEXT NOT NULL DEFAULT '${DEFAULT_PROVIDER}',
      aws_region TEXT
    )
  `);
  ensureMappingsColumns();

  // Seed if empty
  const count = db.prepare("SELECT COUNT(*) as n FROM mappings").get() as { n: number };
  if (count.n === 0 && Object.keys(SEED_MAPPINGS).length > 0) {
    const insert = db.prepare(
      "INSERT INTO mappings (team_key, owner, repo, workflow_file, default_branch, max_in_progress_ai_issues, execution_mode, session_mode, machine_cpus, machine_memory_mb, planning_enabled, planning_workflow_file, auto_approve_plans, extra_env, provider, aws_region) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const [key, m] of Object.entries(SEED_MAPPINGS)) {
      insert.run(key, m.owner, m.repo, m.workflowFile, m.defaultBranch, m.maxInProgressAiIssues, m.executionMode, m.sessionMode, m.machineCpus, m.machineMemoryMb, m.planningEnabled ? 1 : 0, m.planningWorkflowFile, m.autoApprovePlans ? 1 : 0, Object.keys(m.extraEnv).length > 0 ? JSON.stringify(m.extraEnv) : null, m.provider, m.awsRegion);
    }
    console.log(`[config] Seeded ${Object.keys(SEED_MAPPINGS).length} default mappings`);
  }
}

export function getMappings(): Record<string, RepoMapping> {
  const rows = getDb()
    .prepare(
      "SELECT team_key, owner, repo, workflow_file, default_branch, max_in_progress_ai_issues, execution_mode, session_mode, machine_cpus, machine_memory_mb, planning_enabled, planning_workflow_file, auto_approve_plans, extra_env, provider, aws_region FROM mappings",
    )
    .all() as Array<{
      team_key: string;
      owner: string;
      repo: string;
      workflow_file: string;
      default_branch: string;
      max_in_progress_ai_issues: number;
      execution_mode: string;
      session_mode: string;
      machine_cpus: number;
      machine_memory_mb: number;
      planning_enabled: number;
      planning_workflow_file: string;
      auto_approve_plans: number;
      extra_env: string | null;
      provider: string | null;
      aws_region: string | null;
    }>;

  const result: Record<string, RepoMapping> = {};
  for (const row of rows) {
    result[row.team_key] = {
      owner: row.owner,
      repo: row.repo,
      workflowFile: row.workflow_file,
      defaultBranch: row.default_branch,
      maxInProgressAiIssues: row.max_in_progress_ai_issues ?? DEFAULT_MAX_IN_PROGRESS_AI_ISSUES,
      executionMode: (row.execution_mode as ExecutionMode) ?? DEFAULT_EXECUTION_MODE,
      sessionMode: (row.session_mode as SessionMode) ?? DEFAULT_SESSION_MODE,
      machineCpus: row.machine_cpus ?? DEFAULT_MACHINE_CPUS,
      machineMemoryMb: row.machine_memory_mb ?? DEFAULT_MACHINE_MEMORY_MB,
      planningEnabled: Boolean(row.planning_enabled ?? DEFAULT_PLANNING_ENABLED),
      planningWorkflowFile: row.planning_workflow_file || DEFAULT_PLANNING_WORKFLOW_FILE,
      autoApprovePlans: Boolean(row.auto_approve_plans ?? DEFAULT_AUTO_APPROVE_PLANS),
      extraEnv: (() => { try { return row.extra_env ? JSON.parse(row.extra_env) as Record<string, string> : {}; } catch { return {}; } })(),
      provider: (row.provider as ClaudeProvider) ?? DEFAULT_PROVIDER,
      awsRegion: row.aws_region,
    };
  }
  return result;
}

export function upsertMapping(teamKey: string, mapping: RepoMapping): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO mappings (team_key, owner, repo, workflow_file, default_branch, max_in_progress_ai_issues, execution_mode, session_mode, machine_cpus, machine_memory_mb, planning_enabled, planning_workflow_file, auto_approve_plans, extra_env, provider, aws_region) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      teamKey,
      mapping.owner,
      mapping.repo,
      mapping.workflowFile,
      mapping.defaultBranch,
      mapping.maxInProgressAiIssues,
      mapping.executionMode,
      mapping.sessionMode,
      mapping.machineCpus,
      mapping.machineMemoryMb,
      mapping.planningEnabled ? 1 : 0,
      mapping.planningWorkflowFile,
      mapping.autoApprovePlans ? 1 : 0,
      Object.keys(mapping.extraEnv).length > 0 ? JSON.stringify(mapping.extraEnv) : null,
      mapping.provider,
      mapping.awsRegion,
    );
}

export function updateMappingCap(teamKey: string, maxInProgressAiIssues: number): boolean {
  const result = getDb()
    .prepare("UPDATE mappings SET max_in_progress_ai_issues = ? WHERE team_key = ?")
    .run(maxInProgressAiIssues, teamKey);
  return result.changes > 0;
}

export function deleteMapping(teamKey: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM mappings WHERE team_key = ?")
    .run(teamKey);
  return result.changes > 0;
}
