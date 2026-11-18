/** Public health reads local state only, including during a Restate outage. */
import { countFailingCore, runSetupChecks, type SetupCheckContext, type SetupCheckRun } from "./setup-checks/index.js";
import { isAdminPathConfigured, ORCHESTRATOR_CONFIG_CHECKS } from "./setup-checks/orchestrator-config.js";

import { restateCanServe, type RestateStatus } from "./restate/status.js";

export interface HealthBodyReaders {
  sourceCommit(): string | null;
  pollStats(): { pollCount: number; lastPollStartedAt: Date | null; lastPollFinishedAt: Date | null };
  kgDegraded(): boolean;
  sidecarHealthFields(): object;
  restateStatus(): RestateStatus;
  deployHealth(): unknown;
  lastSetupCheckRun(): SetupCheckRun | null;
  setupCheckContext(): SetupCheckContext;
}

export async function buildHealthBody(read: HealthBodyReaders) {
  const { pollCount: polls, lastPollStartedAt, lastPollFinishedAt } = read.pollStats();
  const run = read.lastSetupCheckRun();
  const ctx = read.setupCheckContext();
  const setupChecks: { checkedAt: number | null; failingCore: number | null; failingOnAdminPath?: string[] } = {
    checkedAt: run?.checkedAt ?? null,
    failingCore: run === null ? null : countFailingCore(run),
  };
  if (!isAdminPathConfigured(ctx)) {
    const live = await runSetupChecks(ctx, ORCHESTRATOR_CONFIG_CHECKS.filter((check) => check.onAdminPath));
    setupChecks.failingOnAdminPath = live.results.filter((row) => row.state === "fail").map((row) => row.id);
  }
  const restate = read.restateStatus();
  return {
    status: restateCanServe(restate) ? "ok" : "unavailable",
    sourceCommit: read.sourceCommit(),
    polls,
    kgDegraded: read.kgDegraded(),
    ...read.sidecarHealthFields(),
    restate,
    deploy: read.deployHealth(),
    lastPollStartedAt: lastPollStartedAt?.toISOString() ?? null,
    lastPollFinishedAt: lastPollFinishedAt?.toISOString() ?? null,
    setupChecks,
  };
}
