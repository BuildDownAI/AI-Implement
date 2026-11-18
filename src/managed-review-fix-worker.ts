/** Managed preparation stays inside the attempt's launch-once effect. Only the
 * immutable snapshot is persisted; the bootstrap never crosses a Restate boundary. */
import { getMappings } from "./config.js";
import { isManagedProject, prepareManagedDispatch, ghaManagedCredentials, settleLaunch } from "./managed-dispatch-auth.js";
import type { ModelAuthRuntime } from "./model-auth-runtime.js";
import { GithubReviewFixWorker, type GithubReviewFixWorkerDeps } from "./review-fix-worker.js";
import type { ReviewFixWorkerPort } from "./review-fix-ports.js";

export function createManagedReviewFixWorker(deps: GithubReviewFixWorkerDeps, runtime: () => ModelAuthRuntime): ReviewFixWorkerPort {
  const worker = new GithubReviewFixWorker(deps);
  return {
    prepare: (attempt) => worker.prepare(attempt),
    reconcile: (id, scope) => worker.reconcile(id, scope),
    cancel: (id, execution) => worker.cancel(id, execution),
    inspectTerminal: (execution) => worker.inspectTerminal(execution),
    async launch(plan) {
      const entry = Object.entries(getMappings()).find(([, m]) => `${m.owner}/${m.repo}` === plan.scope.repository);
      if (!entry) return { status: "rejected", reason: "review-fix mapping unavailable" };
      const [projectKey, mapping] = entry;
      if (!isManagedProject(projectKey, plan.attemptId)) return worker.launch(plan);
      const auth = runtime();
      const decision = await prepareManagedDispatch({ dispatchId: plan.attemptId, projectKey,
        backend: "github-actions", owner: mapping.owner, repo: mapping.repo, workflowFile: mapping.workflowFile }, auth);
      if (decision.kind === "legacy") return worker.launch(plan);
      if (decision.kind !== "launch") return { status: "rejected", reason: `managed review-fix unavailable: ${decision.code}` };
      let outcome: "accepted" | "rejected" | "unknown" = "rejected";
      try {
        const credentials = ghaManagedCredentials(decision)!;
        const launched = await new GithubReviewFixWorker({ ...deps,
          managedConfig: { snapshot: decision.snapshot, credentials } }).launch(plan);
        outcome = launched.status;
        return launched;
      } finally {
        settleLaunch(decision, outcome, auth);
      }
    },
  };
}
