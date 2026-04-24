import { listMachines, destroyMachine } from "./fly-machines.js";
import { getJobByMachineId, updateJobStatus, invalidateNonce } from "./log.js";
import { fetchIssueStates } from "./linear.js";
import { recordReaperAction } from "./dedup.js";
import { notifyReaperBurst } from "./notify.js";
import type { Job } from "./log.js";

export const SWEEP_MACHINE_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours
const TERMINAL_STATE_TYPES = new Set(["completed", "canceled"]);

export interface ReaperConfig {
  flySessionsToken: string | null;
  flySessionsApp: string | null;
  flyOrchestratorApp: string | null;
  linearApiKey: string;
  reaperDryRun: boolean;
  notifyType?: string;
  notifyWebhookUrl?: string | null;
  reaperAlertThreshold?: number;
}

export interface ReaperHelpers {
  resetLinearIssue: (job: Job) => Promise<void>;
  postSessionLogsToLinear: (job: Job, context: string) => Promise<void>;
  findPrForIssue: (repo: string | null, issueIdentifier: string | null) => Promise<string | null>;
}

export interface DestroyContext {
  tenantId?: string | null;
  issueIdentifier?: string | null;
  ageSeconds?: number | null;
}

let lastSweepAt: number | null = null;

export function getLastSweepAt(): number | null {
  return lastSweepAt;
}

/**
 * Destroys a single Fly machine. In dry-run mode logs `would destroy` instead
 * of calling the API, so no machines are actually affected.
 */
export async function safeDestroyMachine(
  config: ReaperConfig,
  machineId: string,
  reason: string,
  ctx?: DestroyContext,
): Promise<void> {
  if (!config.flySessionsToken || !config.flySessionsApp) return;

  const t = ctx?.tenantId ?? "-";
  const i = ctx?.issueIdentifier ?? "-";
  const a = ctx?.ageSeconds != null ? String(ctx.ageSeconds) : "-";
  const d = config.reaperDryRun;

  console.log(
    `[reaper] rule=${reason} machine=${machineId} tenant=${t} issue=${i} age_s=${a} dry_run=${d}`,
  );

  if (d) return;

  try {
    await destroyMachine(config.flySessionsToken, config.flySessionsApp, machineId);
  } catch (err) {
    if (!(err instanceof Error && err.message.includes("404"))) {
      console.error(`[reaper] Failed to destroy machine=${machineId} rule=${reason}:`, err);
    }
  }
}

/**
 * Per-poll cleanup sweep: lists all Fly machines and destroys any that are
 * orphaned (no dispatch log entry), belong to a completed/failed job, exceed
 * the max session age, or whose Linear issue has reached a terminal state.
 *
 * When `config.reaperDryRun` is true the sweep logs `would destroy` for each
 * machine that would be destroyed but does not call the Fly API or mutate any
 * local state (jobs, nonces, Linear).
 */
export async function sweepOrphanedMachines(
  config: ReaperConfig,
  helpers: ReaperHelpers,
): Promise<void> {
  if (!config.flySessionsToken || !config.flySessionsApp) return;

  let machines;
  try {
    machines = await listMachines(config.flySessionsToken, config.flySessionsApp);
  } catch (err) {
    console.error("[sweep] Failed to list machines:", err);
    return;
  }

  if (machines.length === 0) {
    lastSweepAt = Date.now();
    return;
  }

  // Pre-fetch Linear issue states for in-flight machine jobs so we can detect
  // machines whose issue was completed/canceled outside of the normal flow.
  const issueIds = new Set<string>();
  for (const machine of machines) {
    if (machine.state === "destroyed") continue;
    const job = getJobByMachineId(machine.id);
    if (job && (job.status === "dispatched" || job.status === "running") && job.issueId) {
      issueIds.add(job.issueId);
    }
  }

  let issueStateMap = new Map<string, string>();
  if (issueIds.size > 0) {
    try {
      issueStateMap = await fetchIssueStates(config.linearApiKey, [...issueIds]);
    } catch (err) {
      console.error("[sweep] Failed to fetch Linear issue states:", err);
      // Continue — age and orphan checks still work without Linear state
    }
  }

  let destroyedCount = 0;

  for (const machine of machines) {
    if (machine.state === "destroyed") continue;

    // Skip machines not owned by this orchestrator. When we know our own app name,
    // we only process machines explicitly tagged as ours — untagged machines and
    // machines tagged for a different orchestrator are both skipped. This prevents
    // one orchestrator (e.g. prod) from orphan-killing machines created by another
    // (e.g. local dev) that shares the same sessions app.
    const machineOrchestrator = machine.config?.metadata?.orchestrator_app;
    if (config.flyOrchestratorApp && machineOrchestrator !== config.flyOrchestratorApp) {
      continue;
    }

    const job = getJobByMachineId(machine.id);
    const ageSeconds = Math.floor((Date.now() - new Date(machine.created_at).getTime()) / 1000);

    if (!job) {
      // No dispatch log entry — orphaned machine
      recordReaperAction({
        ruleMatched: "orphan",
        machineId: machine.id,
        tenantId: null,
        issueIdentifier: null,
        ageSeconds,
        dryRun: config.reaperDryRun,
      });
      await safeDestroyMachine(config, machine.id, "orphan", { ageSeconds });
      if (!config.reaperDryRun) destroyedCount++;
      continue;
    }

    const isTerminal =
      job.status === "completed" || job.status === "failed" || job.status === "timed_out";
    if (isTerminal) {
      // Job already reached a terminal state but machine was not destroyed
      recordReaperAction({
        ruleMatched: "stale-terminal-job",
        machineId: machine.id,
        tenantId: job.teamKey ?? null,
        issueIdentifier: job.issueIdentifier ?? null,
        ageSeconds,
        dryRun: config.reaperDryRun,
      });
      await safeDestroyMachine(config, machine.id, "stale-terminal-job", {
        tenantId: job.teamKey,
        issueIdentifier: job.issueIdentifier,
        ageSeconds,
      });
      if (!config.reaperDryRun) destroyedCount++;
      continue;
    }

    // In-flight job: check machine age
    const ageMs = ageSeconds * 1000;
    if (ageMs > SWEEP_MACHINE_MAX_AGE_MS) {
      if (!config.reaperDryRun) {
        // Only dump logs on genuine failures — check for a PR first so we don't
        // post an unexpected log comment on a session that completed but hasn't
        // been processed by the monitor loop yet.
        const sweepPrUrl = await helpers.findPrForIssue(job.repo, job.issueIdentifier);
        if (!sweepPrUrl && job.runnerMode !== "shadow") {
          await helpers.postSessionLogsToLinear(job, "max_age_sweep");
        }
      }
      recordReaperAction({
        ruleMatched: "max-age-exceeded",
        machineId: machine.id,
        tenantId: job.teamKey ?? null,
        issueIdentifier: job.issueIdentifier ?? null,
        ageSeconds,
        dryRun: config.reaperDryRun,
      });
      await safeDestroyMachine(config, machine.id, "max-age-exceeded", {
        tenantId: job.teamKey,
        issueIdentifier: job.issueIdentifier,
        ageSeconds,
      });
      if (!config.reaperDryRun) {
        destroyedCount++;
        updateJobStatus(job.id, "timed_out", "machine_max_age_sweep");
        invalidateNonce(job.id);
        await helpers.resetLinearIssue(job);
      }
      continue;
    }

    // TODO(interactive): heartbeat rule

    // TODO(interactive): PR-closed rule

    // In-flight job: check whether the Linear issue is already terminal
    const stateType = issueStateMap.get(job.issueId ?? "");
    if (stateType !== undefined && TERMINAL_STATE_TYPES.has(stateType)) {
      recordReaperAction({
        ruleMatched: "issue-terminal",
        machineId: machine.id,
        tenantId: job.teamKey ?? null,
        issueIdentifier: job.issueIdentifier ?? null,
        ageSeconds,
        dryRun: config.reaperDryRun,
      });
      await safeDestroyMachine(config, machine.id, "issue-terminal", {
        tenantId: job.teamKey,
        issueIdentifier: job.issueIdentifier,
        ageSeconds,
      });
      if (!config.reaperDryRun) {
        destroyedCount++;
        updateJobStatus(job.id, "timed_out", "issue_completed_sweep");
        invalidateNonce(job.id);
        await helpers.resetLinearIssue(job);
      }
    }
  }

  lastSweepAt = Date.now();

  const threshold = config.reaperAlertThreshold ?? 10;
  if (destroyedCount > threshold && config.notifyWebhookUrl) {
    try {
      await notifyReaperBurst(config.notifyType ?? "slack", config.notifyWebhookUrl, {
        count: destroyedCount,
        threshold,
      });
    } catch (err) {
      console.error("[reaper] Failed to send burst alert:", err);
    }
  }
}
