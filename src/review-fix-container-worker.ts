/** Fresh, attempt-owned containers using the established gap-fill transports (ADR 037). */
import { getMappings } from "./config.js";
import { read as readAdmission } from "./dispatch-admission.js";
import { dispatchFlyGapfill, type DispatchFlyGapfillInput } from "./gapfill-launch.js";
import { dispatchLocalGapfill, type DispatchLocalGapfillInput } from "./local-gapfill.js";
import { listMachines } from "./fly-machines.js";
import { findLocalContainerIdByName, inspectLocalContainer } from "./local-docker.js";
import { readBackendRun, stopBackendRun } from "./backend-run.js";
import { appendLogIfAbsent, getJobByDispatchId, setJobMachineId } from "./log.js";
import { classifyLaunchError, isManagedProject } from "./managed-dispatch-auth.js";
import { githubActionsReviewFixWorkerTransport, inMemoryReviewFixWorkerScopeStore, type GithubReviewFixWorkerDeps } from "./review-fix-worker.js";
import type { ReviewFixWorkerPort } from "./review-fix-ports.js";
import type { WorkerExecutionIdentity } from "./review-fix-contract.js";

type FlySettings = Pick<DispatchFlyGapfillInput, "flySessionsToken" | "flySessionsApp" | "flySessionsRegion" | "flyOrchestratorApp" | "sessionImage" | "runnerCallbackBaseUrl" | "tenantId" | "anthropicApiKey" | "claudeOAuthToken">;
export interface ContainerReviewFixWorkerDeps {
  credentials: GithubReviewFixWorkerDeps["credentials"];
  callbackInputs: NonNullable<GithubReviewFixWorkerDeps["callbackInputs"]>;
  scopeStore?: GithubReviewFixWorkerDeps["scopeStore"];
  fly: FlySettings;
  local: Pick<DispatchLocalGapfillInput, "image" | "orchestratorUrl" | "anthropicApiKey" | "claudeOAuthToken">;
  /** Docker names are unique; the array seam also permits conservative duplicate handling. */
  localCandidates?: (name: string) => Promise<readonly string[]>;
  getPullRequestHeadSha?: typeof githubActionsReviewFixWorkerTransport.getPullRequestHeadSha;
}

export class ContainerReviewFixWorker implements ReviewFixWorkerPort {
  private readonly scopes;
  constructor(private readonly deps: ContainerReviewFixWorkerDeps) {
    this.scopes = deps.scopeStore ?? inMemoryReviewFixWorkerScopeStore();
  }
  prepare: ReviewFixWorkerPort["prepare"] = async (attempt) => {
    await this.scopes.rememberAttempt(attempt.attemptId, attempt.scope);
    return { executionBackend: attempt.executionBackend, attemptId: attempt.attemptId, scope: attempt.scope, taskText: attempt.taskText, deadlineAt: attempt.deadlineAt };
  };
  launch: ReviewFixWorkerPort["launch"] = async (plan) => {
    const backend = plan.executionBackend;
    if (backend !== "fly-machines" && backend !== "local-docker") return { status: "rejected", reason: "Container worker requires a container backend" };
    let started = false;
    let created = false;
    try {
      const admission = readAdmission(plan.attemptId);
      if (!admission || admission.releasedAt !== null || admission.backend !== backend) return { status: "unknown" };
      const teamKey = admission.mappingKey;
      const mapping = getMappings()[teamKey];
      if (!mapping || admission.scope.kind !== "pr" || admission.scope.repository !== plan.scope.repository || `${mapping.owner}/${mapping.repo}` !== admission.scope.repository) return { status: "unknown" };
      if (isManagedProject(teamKey, plan.attemptId)) return { status: "rejected", reason: `managed review-fix on ${backend} not supported yet` };
      // A durable launch intent must be reconciled, never launched again with a new nonce.
      if (getJobByDispatchId(plan.attemptId)) return { status: "unknown" };
      const credential = await this.deps.credentials.resolve(plan.scope);
      if (credential.installationId !== plan.scope.installationId) return { status: "unknown" };
      const tokens = await this.deps.callbackInputs(plan.attemptId);
      const runName = `review-fix-${plan.attemptId}`;
      const issue = { id: `review-fix:${plan.attemptId}`, identifier: `review-fix-${plan.scope.prNumber}`, title: `Review-fix for ${plan.scope.repository}#${plan.scope.prNumber}`, description: plan.taskText };
      const common = { mapping, prNumber: plan.scope.prNumber, githubToken: credential.token, runName, dispatchId: plan.attemptId,
        reviewFix: { version: 1 as const, attemptId: plan.attemptId, installationId: plan.scope.installationId, repository: plan.scope.repository, prNumber: plan.scope.prNumber, deadlineAt: plan.deadlineAt, executionBackend: backend },
        runnerCallbackUrl: tokens.runner_callback_url, runToken: tokens.run_token, runProgressToken: tokens.run_progress_token, runPublicationToken: tokens.run_publication_token, commentInstruction: plan.taskText };
      let jobId: number | undefined;
      const beforeLaunch = (nonce: string) => {
        jobId = appendLogIfAbsent({ issueId: issue.id, issueIdentifier: issue.identifier, issueTitle: issue.title, teamKey, repo: plan.scope.repository, dispatchId: plan.attemptId, admissionGeneration: admission.generation, executionMode: backend, machineNonce: nonce, phase: "gap-analysis", computeStartedAt: Date.now() });
        started = true;
      };
      let id: string;
      if (backend === "fly-machines") {
        const result = await dispatchFlyGapfill({ ...this.deps.fly, ...common, issue: { issueId: issue.id, issueIdentifier: issue.identifier, issueTitle: issue.title }, owner: mapping.owner, repo: mapping.repo, issueIdentifier: issue.identifier, scopeKey: teamKey, allTeamKeys: Object.keys(getMappings()), decision: { kind: "legacy" },
          runnerCallbackUrl: tokens.runner_callback_url ?? "", runToken: tokens.run_token ?? "", runProgressToken: tokens.run_progress_token ?? "", onBeforeLaunch: (_, n) => beforeLaunch(n) });
        id = result.machine.id;
      } else {
        const result = await dispatchLocalGapfill({ ...this.deps.local, ...common, issue, retryPolicy: null, onBeforeLaunch: beforeLaunch });
        id = result.containerId;
      }
      created = true;
      if (jobId === undefined) return { status: "unknown" };
      setJobMachineId(jobId, id);
      const execution = { backend, runRef: id } as const;
      await this.scopes.rememberExecution(execution, plan.scope);
      console.log(`[review-fix] dispatched via ${backend} (attempt ${plan.attemptId}, run ${id})`);
      return { status: "accepted", execution };
    } catch (err) {
      const status = created ? "unknown" : classifyLaunchError(backend, started, err);
      return status === "rejected" ? { status, reason: "Container review-fix launch rejected" } : { status };
    }
  };
  reconcile: ReviewFixWorkerPort["reconcile"] = async (attemptId, scope) => {
    try {
      const admission = readAdmission(attemptId);
      const backend = admission?.backend;
      if (!admission || (backend !== "fly-machines" && backend !== "local-docker")) return { status: "unknown" };
      const row = getJobByDispatchId(attemptId);
      if (!row?.machineNonce || row.admissionGeneration !== admission.generation || row.executionMode !== backend) return { status: "unknown" };
      let id = row.machineId;
      if (!id) {
        const name = `review-fix-${attemptId}`;
        const candidates = backend === "fly-machines"
          ? (await listMachines(this.deps.fly.flySessionsToken, this.deps.fly.flySessionsApp)).filter(m => m.name === name).map(m => m.id)
          : await (this.deps.localCandidates ?? (async (n) => { const found = await findLocalContainerIdByName(n); return found ? [found] : []; }))(name);
        if (candidates.length !== 1) return { status: "unknown" };
        id = candidates[0];
        setJobMachineId(row.id, id);
      }
      const execution = { backend, runRef: id } as const;
      await this.scopes.rememberExecution(execution, scope);
      return { status: "found", execution };
    } catch { return { status: "unknown" }; }
  };
  inspectTerminal: ReviewFixWorkerPort["inspectTerminal"] = async (execution) => {
    if (execution.backend !== "fly-machines" && execution.backend !== "local-docker") return { reached: false };
    try {
      let exit: number | null;
      if (execution.backend === "fly-machines") {
        const read = await readBackendRun(this.deps.fly, execution.backend, execution.runRef);
        if (read.state !== "ended") return { reached: false };
        exit = read.exit?.exitCode ?? null;
      } else {
        try {
          const read = await inspectLocalContainer(execution.runRef);
          // A zero exit code can also be reported before Docker has terminated.
          if (read.running || read.status !== "exited") return { reached: false };
          exit = read.exitCode;
        } catch (err) {
          if (!(err instanceof Error && /No such container/i.test(err.message))) return { reached: false };
          exit = null;
        }
      }
      if (exit !== 0) return { reached: true, outcome: { status: "failed", reason: "Container review-fix run failed" } };
      const scope = await this.scopes.scopeForExecution(execution);
      if (!scope) return { reached: false };
      const credential = await this.deps.credentials.resolve(scope);
      if (credential.installationId !== scope.installationId) return { reached: false };
      const [owner, repo] = scope.repository.split("/");
      const head = await (this.deps.getPullRequestHeadSha ?? githubActionsReviewFixWorkerTransport.getPullRequestHeadSha)({ token: credential.token, owner, repo, prNumber: scope.prNumber });
      return head && /^[0-9a-f]{40}$/.test(head) ? { reached: true, outcome: { status: "succeeded", outputCommit: head } } : { reached: false };
    } catch { return { reached: false }; }
  };
  cancel: ReviewFixWorkerPort["cancel"] = async (_, execution: WorkerExecutionIdentity) => {
    if (execution.backend !== "fly-machines" && execution.backend !== "local-docker") return { status: "unknown" };
    try { return { status: await stopBackendRun(this.deps.fly, execution.backend, execution.runRef) ? "cancelled" : "unknown" }; }
    catch { return { status: "unknown" }; }
  };
}
