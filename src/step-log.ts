import { getDb } from "./dedup.js";
import type { Step } from "./pipeline/types.js";

export interface StepRecord {
  id: number;
  jobId: number;
  stepId: string;
  stepType: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  parentStepId: string | null;
  inputsJson: string;
  outputsJson: string;
  logsUrl: string | null;
}

export function initStepLogTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS step_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id        INTEGER NOT NULL,
      step_id       TEXT    NOT NULL,
      step_type     TEXT    NOT NULL,
      status        TEXT    NOT NULL,
      started_at    TEXT    NOT NULL,
      ended_at      TEXT,
      parent_step_id TEXT,
      inputs_json   TEXT    NOT NULL DEFAULT '{}',
      outputs_json  TEXT    NOT NULL DEFAULT '{}',
      logs_url      TEXT,
      UNIQUE (job_id, step_id)
    )
  `);
}

export function upsertStepRecord(jobId: number, step: Step): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO step_log
      (job_id, step_id, step_type, status, started_at, ended_at, parent_step_id, inputs_json, outputs_json, logs_url)
    VALUES
      (@jobId, @stepId, @stepType, @status, @startedAt, @endedAt, @parentStepId, @inputsJson, @outputsJson, @logsUrl)
    ON CONFLICT (job_id, step_id) DO UPDATE SET
      status         = excluded.status,
      ended_at       = excluded.ended_at,
      outputs_json   = excluded.outputs_json,
      logs_url       = excluded.logs_url
  `).run({
    jobId,
    stepId: step.id,
    stepType: step.type,
    status: step.status,
    startedAt: step.started_at,
    endedAt: step.ended_at,
    parentStepId: step.parent_step_id,
    inputsJson: JSON.stringify(step.inputs),
    outputsJson: JSON.stringify(step.outputs),
    logsUrl: step.logs_url,
  });
}

export function getStepsByJobId(jobId: number): StepRecord[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, job_id as jobId, step_id as stepId, step_type as stepType,
              status, started_at as startedAt, ended_at as endedAt,
              parent_step_id as parentStepId, inputs_json as inputsJson,
              outputs_json as outputsJson, logs_url as logsUrl
       FROM step_log WHERE job_id = ? ORDER BY id ASC`,
    )
    .all(jobId) as StepRecord[];
}

export function getStepRecord(jobId: number, stepId: string): StepRecord | undefined {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, job_id as jobId, step_id as stepId, step_type as stepType,
              status, started_at as startedAt, ended_at as endedAt,
              parent_step_id as parentStepId, inputs_json as inputsJson,
              outputs_json as outputsJson, logs_url as logsUrl
       FROM step_log WHERE job_id = ? AND step_id = ?`,
    )
    .get(jobId, stepId) as StepRecord | undefined;
}
