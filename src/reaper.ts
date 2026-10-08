import { listMachines, destroyMachine } from "./fly-machines.js";
import { getJobByMachineId, updateJobStatus, invalidateNonce } from "./log.js";
import type { IssueLifecycleState } from "./providers/types.js";
import type { ProviderRegistry } from "./providers/registry.js";
import type { RepoMapping } from "./config.js";
import { recordReaperAction } from "./dedup.js";
import { notifyReaperBurst } from "./notify.js";
import { read as readAdmission } from "./dispatch-admission.js";
import type { Job } from "./log.js";
import {
  DURABLE_RUNNER_PURPOSE_KEY,
  DURABLE_RUNNER_PURPOSE_VALUE,
  DURABLE_UNTIL_KEY,
} from "./restate/fly-machine-profile.js";

export const SWEEP_MACHINE_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours
const TERMINAL_LIFECYCLE_STATES = new Set<IssueLifecycleState>(["completed", "cancelled"]);

/**
 * AII-791: before any reaper outcome action (a destroy, a status write, a ticket reset),
 * read the row's immutable admission owner and skip entirely when it names a Restate
 * attempt — Restate's own workflow owns confirming that attempt's termination and
 * releasing its reservation, not the reaper. A job with no `dispatchId`, or no matching
 * admission row (historical/unreserved dispatch), is unaffected — it keeps the existing
 * Legacy handling this function guards.
 */
function isRestateOwnedJob(job: Job): boolean {
  if (!job.dispatchId) return false;
  return readAdmission(job.dispatchId)?.lifecycleOwner.kind === "restate";
}

export interface ReaperConfig {
  flySessionsToken: string | null;
  flySessionsApp: string | null;
  flyOrchestratorApp: string | null;
  registry: ProviderRegistry;
  getMappings: () => Record<string, RepoMapping>;
  reaperDryRun: boolean;
  notifyType?: string;
  notifyWebhookUrl?: string | null;
  reaperAlertThreshold?: number;
}

export interface ReaperHelpers {
  resetTicket: (job: Job) => Promise<void>;
  postSessionLogs: (job: Job, context: string) => Promise<void>;
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
 *
 * Returns whether the machine's death is confirmed — the API call succeeded, or it
 * 404'd (already gone) — versus a swallowed non-404 error, which leaves the machine's
 * actual state unknown. Callers that gate an admission-reservation release (AII-783) on
 * verified termination need this distinction: a caught-and-logged failure here used to
 * read identically to a real destroy from the outside.
 */
export async function safeDestroyMachine(
  config: ReaperConfig,
  machineId: string,
  reason: string,
  ctx?: DestroyContext,
): Promise<boolean> {
  if (!config.flySessionsToken || !config.flySessionsApp) return false;

  const t = ctx?.tenantId ?? "-";
  const i = ctx?.issueIdentifier ?? "-";
  const a = ctx?.ageSeconds != null ? String(ctx.ageSeconds) : "-";
  const d = config.reaperDryRun;

  console.log(
    `[reaper] rule=${reason} machine=${machineId} tenant=${t} issue=${i} age_s=${a} dry_run=${d}`,
  );

  if (d) return true;

  try {
    await destroyMachine(config.flySessionsToken, config.flySessionsApp, machineId);
    return true;
  } catch (err) {
    if (err instanceof Error && err.message.includes("404")) {
      return true; // already gone — confirmed dead
    }
    console.error(`[reaper] Failed to destroy machine=${machineId} rule=${reason}:`, err);
    return false;
  }
}

/** Whether the machine is owned by a FlyMachineProfile object (purpose: durable-runner). */
export function isDurableRunnerMachine(machine: { config?: { metadata?: Record<string, string> } }): boolean {
  return machine.config?.metadata?.[DURABLE_RUNNER_PURPOSE_KEY] === DURABLE_RUNNER_PURPOSE_VALUE;
}

/**
 * Whether a durable-runner machine's `durable_until` stamp (epoch seconds) is past.
 * Absent keeps the machine; a present value that is not a finite number is a corrupt
 * stamp, treated as past (with one warning) so it cannot keep a machine for ever.
 */
function isDurableExpired(machineId: string, raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const text = String(raw).trim();
  const until = text === "" ? NaN : Number(text);
  if (!Number.isFinite(until)) {
    console.warn(
      `[reaper] machine=${machineId} has a corrupt ${DURABLE_UNTIL_KEY}=${JSON.stringify(raw)}; treating as expired`,
    );
    return true;
  }
  return until < Date.now() / 1000;
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

  // Pre-fetch ticket lifecycle states for in-flight machine jobs so we can
  // detect machines whose issue was completed/cancelled outside of the normal
  // flow. We group issue IDs by their mapping's ticketing provider so each
  // provider is queried only with its own issues.
  const mappings = config.getMappings();
  const issueIdsByProvider = new Map<string, Set<string>>();
  for (const machine of machines) {
    if (machine.state === "destroyed") continue;
    const job = getJobByMachineId(machine.id);
    if (!job) continue;
    if (!(job.status === "dispatched" || job.status === "running")) continue;
    if (!job.issueId) continue;
    if (job.phase === "kg-refresh") continue; // issue-less: no provider record to look up

    const mapping = job.teamKey ? mappings[job.teamKey] : undefined;
    if (!mapping) continue;
    const key = mapping.ticketingProvider;
    if (!issueIdsByProvider.has(key)) issueIdsByProvider.set(key, new Set());
    issueIdsByProvider.get(key)!.add(job.issueId);
  }

  const issueStateMap = new Map<string, IssueLifecycleState>();
  for (const [providerId, ids] of issueIdsByProvider) {
    if (ids.size === 0) continue;
    // Pick any mapping with this provider id so the registry can resolve.
    const sampleMapping = Object.values(mappings).find(
      (m) => m.ticketingProvider === providerId,
    );
    if (!sampleMapping) continue;
    try {
      const provider = await config.registry.forMapping(sampleMapping);
      const states = await provider.fetchLifecycleStates([...ids]);
      for (const [k, v] of states) issueStateMap.set(k, v);
    } catch (err) {
      console.error("[sweep] Failed to fetch issue states:", err);
      // Continue — age and orphan checks still work without ticket state
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

    const ageSeconds = Math.floor((Date.now() - new Date(machine.created_at).getTime()) / 1000);

    // A durable-runner machine is owned by a FlyMachineProfile object, not a dispatch_log
    // row: its job row is terminal (or absent) by design, so none of the four rules below
    // may see it. The reaper is only the backstop for an owner lost with the Restate store.
    const metadata = machine.config?.metadata;
    if (metadata?.[DURABLE_RUNNER_PURPOSE_KEY] === DURABLE_RUNNER_PURPOSE_VALUE) {
      if (!isDurableExpired(machine.id, metadata[DURABLE_UNTIL_KEY])) continue;
      recordReaperAction({
        ruleMatched: "durable-expired",
        machineId: machine.id,
        tenantId: null,
        issueIdentifier: null,
        ageSeconds,
        dryRun: config.reaperDryRun,
      });
      await safeDestroyMachine(config, machine.id, "durable-expired", { ageSeconds });
      if (!config.reaperDryRun) destroyedCount++;
      continue;
    }

    const job = getJobByMachineId(machine.id);

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

    // AII-791: the reaper never finalizes a Restate-owned attempt, even one that looks
    // orphaned or stale from this row's own status.
    if (isRestateOwnedJob(job)) continue;

    const isTerminal =
      job.status === "completed" || job.status === "review_failed" || job.status === "failed" || job.status === "timed_out";
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
      if (!config.reaperDryRun && job.phase !== "kg-refresh") {
        // Only dump logs on genuine failures — check for a PR first so we don't
        // post an unexpected log comment on a session that completed but hasn't
        // been processed by the monitor loop yet.
        const sweepPrUrl = await helpers.findPrForIssue(job.repo, job.issueIdentifier);
        if (!sweepPrUrl && job.runnerMode !== "shadow") {
          await helpers.postSessionLogs(job, "max_age_sweep");
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
      const maxAgeDestroyConfirmed = await safeDestroyMachine(config, machine.id, "max-age-exceeded", {
        tenantId: job.teamKey,
        issueIdentifier: job.issueIdentifier,
        ageSeconds,
      });
      if (!config.reaperDryRun) {
        destroyedCount++;
        // A destroy call that failed (and wasn't a 404-already-gone) leaves the machine's
        // real state unknown — hold the admission reservation for the stale-reservation
        // sweep rather than releasing a slot whose backend might still be running.
        if (maxAgeDestroyConfirmed) {
          updateJobStatus(job.id, "timed_out", "machine_max_age_sweep", undefined, { backendTerminated: true });
        } else {
          updateJobStatus(job.id, "timed_out", "machine_max_age_sweep", undefined, { skipAdmissionRelease: true });
        }
        invalidateNonce(job.id);
        if (job.phase !== "kg-refresh") {
          await helpers.resetTicket(job);
        }
      }
      continue;
    }

    // TODO(interactive): heartbeat rule

    // TODO(interactive): PR-closed rule

    // In-flight job: check whether the ticket has reached a terminal lifecycle state
    const lifecycle = issueStateMap.get(job.issueId ?? "");
    if (lifecycle !== undefined && TERMINAL_LIFECYCLE_STATES.has(lifecycle)) {
      recordReaperAction({
        ruleMatched: "issue-terminal",
        machineId: machine.id,
        tenantId: job.teamKey ?? null,
        issueIdentifier: job.issueIdentifier ?? null,
        ageSeconds,
        dryRun: config.reaperDryRun,
      });
      const issueTerminalDestroyConfirmed = await safeDestroyMachine(config, machine.id, "issue-terminal", {
        tenantId: job.teamKey,
        issueIdentifier: job.issueIdentifier,
        ageSeconds,
      });
      if (!config.reaperDryRun) {
        destroyedCount++;
        if (issueTerminalDestroyConfirmed) {
          updateJobStatus(job.id, "timed_out", "issue_completed_sweep", undefined, { backendTerminated: true });
        } else {
          updateJobStatus(job.id, "timed_out", "issue_completed_sweep", undefined, { skipAdmissionRelease: true });
        }
        invalidateNonce(job.id);
        await helpers.resetTicket(job);
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
