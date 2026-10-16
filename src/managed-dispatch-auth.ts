/**
 * Managed dispatch decision adapter (AII-1386).
 *
 * Turns one `prepareAgentRun` result into one dispatch decision (legacy, launch, leave-queued, refuse, hold),
 * settles a launch, and revokes a grant that did not start a run. Every dispatch path calls it so each path
 * makes the same choice for the same state. A GitHub Actions launch is decided by the verified default-branch
 * workflow capability (`prepareAgentRun`), never by backend alone (AII-1420).
 *
 * The raw bearer stays inside the function-valued `takeBootstrap` on a `launch` decision, which
 * `JSON.stringify` and structured logging never see. Refusal text is fixed and built from `kind`, `category`
 * and `code` only.
 */
import { STAGE_NAMES } from "./agent-config.js";
import { getProjectOptIn, resolveProjectStageConfig } from "./agent-config-store.js";
import {
  loadStoredSnapshot,
  prepareAgentRun,
  releaseRejectedLaunch,
} from "./agent-run-preparation.js";
import type { DispatchAdmissionBackend } from "./dispatch-admission.js";
import { hasEphemeralFullAccessOptIn, parseExecutionPolicy, parseModelAuthContext, type ModelAuthGrantBootstrapV1, type SafeGrantMetadata } from "./model-auth-contract.js";
import type { ModelAuthRuntime } from "./model-auth-runtime.js";
import type { ResolvedAgentSnapshotV1, RunCredentialsV1 } from "./run-config.js";

export interface ManagedDispatchRequest {
  dispatchId: string;
  /** Mapping key (`issue.scopeKey`). */
  projectKey: string;
  backend: DispatchAdmissionBackend;
  /** The only repository sent for trust (operator decision 3). */
  owner: string;
  repo: string;
  workflowFile: string;
}

export type ManagedDispatchDecision =
  | { readonly kind: "legacy" }
  | {
      readonly kind: "launch";
      readonly dispatchId: string;
      readonly projectKey: string;
      readonly backend: DispatchAdmissionBackend;
      readonly snapshot: ResolvedAgentSnapshotV1;
      readonly grant: SafeGrantMetadata;
      readonly takeBootstrap: () => ModelAuthGrantBootstrapV1 | undefined;
    }
  | { readonly kind: "leave-queued"; readonly code: "profile_busy" }
  | {
      readonly kind: "refuse";
      readonly category: "configuration-error" | "authentication-required";
      readonly code: string;
    }
  | { readonly kind: "hold"; readonly code: string };

/** True when the dispatch has a stored snapshot or the project is opted in. Reads SQLite only. */
export function isManagedProject(projectKey: string, dispatchId?: string): boolean {
  if (typeof projectKey !== "string" || projectKey.length === 0) return false;
  if (dispatchId && loadStoredSnapshot(dispatchId) !== null) return true;
  return getProjectOptIn(projectKey);
}

/** True when the stored or currently resolved snapshot selects a `claude-subscription` profile in any stage. */
function selectsClaudeSubscription(projectKey: string, dispatchId: string): boolean {
  const stored = loadStoredSnapshot(dispatchId);
  let profiles: ResolvedAgentSnapshotV1["profiles"] | undefined = stored?.profiles;
  if (!profiles) {
    try {
      const { resolution } = resolveProjectStageConfig(projectKey);
      if (resolution.mode === "configured") profiles = resolution.profiles;
    } catch {
      // Not a refusal: `prepareAgentRun` reports `resolution_failed` itself.
      return false;
    }
  }
  if (!profiles) return false;
  return STAGE_NAMES.some((stage) => profiles![stage]?.authMode === "claude-subscription");
}

const SUBSCRIPTION_REFUSAL = {
  kind: "refuse",
  category: "configuration-error",
  code: "claude_subscription_unsupported",
} as const;

export async function prepareManagedDispatch(
  req: ManagedDispatchRequest,
  runtime: ModelAuthRuntime,
): Promise<ManagedDispatchDecision> {
  if (!isManagedProject(req.projectKey, req.dispatchId)) return { kind: "legacy" };
  if (selectsClaudeSubscription(req.projectKey, req.dispatchId)) return SUBSCRIPTION_REFUSAL;

  const repository = `${req.owner}/${req.repo}`;
  let result;
  try {
    result = await prepareAgentRun(
      {
        dispatchId: req.dispatchId,
        projectKey: req.projectKey,
        backend: req.backend,
        workflowRepository: repository,
        workflowFile: req.workflowFile,
        repositories: [repository],
      },
      runtime.preparationDeps({ owner: req.owner, repo: req.repo, projectKey: req.projectKey }),
    );
  } catch {
    return { kind: "hold", code: "preparation_failed" };
  }

  switch (result.status) {
    case "legacy":
      return { kind: "legacy" };
    case "ready":
      if (result.reused) return { kind: "hold", code: "bootstrap_consumed" };
      if (result.reservations.length > 0) {
        // Refuse even if the release is incomplete: nothing launches, and the grant stays unusable without a bootstrap.
        releaseRejectedLaunch(req.dispatchId, result.reservations, { ownership: runtime.ownership });
        return SUBSCRIPTION_REFUSAL;
      }
      return {
        kind: "launch",
        dispatchId: result.dispatchId,
        projectKey: req.projectKey,
        backend: req.backend,
        snapshot: result.snapshot,
        grant: result.grant,
        takeBootstrap: result.takeBootstrap,
      };
    case "queued":
      return { kind: "leave-queued", code: "profile_busy" };
    case "configuration-error":
      return { kind: "refuse", category: "configuration-error", code: result.code };
    case "authentication-required":
      return { kind: "refuse", category: "authentication-required", code: result.code };
    case "recovery-required":
      return { kind: "hold", code: result.code };
  }
}

/** `accepted` keeps the grant; `rejected` and `unknown` revoke it, because a grant lives only when the launch is accepted. */
export function settleLaunch(
  decision: ManagedDispatchDecision,
  outcome: "accepted" | "rejected" | "unknown",
  runtime: ModelAuthRuntime,
): { revoked: boolean } {
  if (decision.kind !== "launch" || outcome === "accepted") return { revoked: false };
  const released = releaseRejectedLaunch(decision.dispatchId, [], { ownership: runtime.ownership });
  return { revoked: released.complete };
}

/** Mirrors `isDefinitiveFlyRejectionError` and `isDefinitiveLocalDockerLaunchFailure` in `src/index.ts`. */
export function classifyLaunchError(
  backend: DispatchAdmissionBackend,
  launchAttempted: boolean,
  err: unknown,
): "rejected" | "unknown" {
  if (!launchAttempted) return "rejected";
  if (backend !== "fly-machines") return "unknown";
  if (!(err instanceof Error)) return "unknown";
  const match = /\((\d{3})\)/.exec(err.message);
  if (!match) return "unknown";
  const status = Number(match[1]);
  return status >= 400 && status < 500 ? "rejected" : "unknown";
}

export function refusalText(
  decision: Extract<ManagedDispatchDecision, { kind: "refuse" | "hold" | "leave-queued" }>,
): string {
  switch (decision.kind) {
    case "refuse":
      return `Managed dispatch refused (${decision.category}): ${decision.code}. No run was started.`;
    case "hold":
      return `Managed dispatch held: ${decision.code}. No run was started.`;
    case "leave-queued":
      return `Managed dispatch left queued: ${decision.code}. No run was started.`;
  }
}

/**
 * Private credentials for a GitHub Actions `launch` decision, or undefined for a legacy one. The bearer is taken
 * once; a missing bootstrap (already consumed) throws a fixed message so nothing launches without it.
 */
export function ghaManagedCredentials(
  decision: Extract<ManagedDispatchDecision, { kind: "legacy" | "launch" }>,
  callbackBaseUrl: string | null | undefined,
  /** Implementation-phase writers only: the mapping's `extraEnv`, read for the ephemeral full-access opt-in. Planning
   *  and every other writer omit it, so they can never carry the policy. */
  implementation?: { extraEnv?: Readonly<Record<string, string>> | null },
): RunCredentialsV1 | undefined {
  if (decision.kind !== "launch") return undefined;
  // Context comes from the trusted request and configured callback base, never from the grant.
  const context = parseModelAuthContext({
    version: 1,
    dispatchId: decision.dispatchId,
    projectKey: decision.projectKey,
    backend: "gha",
    modelAuthUrl: callbackBaseUrl,
  });
  if (!context.ok) throw new Error("managed dispatch refused: model auth context unavailable");
  const bootstrap = decision.takeBootstrap();
  if (!bootstrap) throw new Error("managed dispatch bootstrap unavailable");
  // The policy is derived from the trusted decision identity plus the administrator's mapping opt-in, never from the grant.
  let executionPolicy: RunCredentialsV1["executionPolicy"];
  if (implementation && hasEphemeralFullAccessOptIn(implementation.extraEnv)) {
    const policy = parseExecutionPolicy({
      version: 1,
      implementationSandbox: "ephemeral-full-access",
      dispatchId: decision.dispatchId,
      projectKey: decision.projectKey,
      backend: "gha",
      ephemeralRunnerAsserted: true,
    });
    if (!policy.ok) throw new Error("managed dispatch refused: execution policy unavailable");
    executionPolicy = policy.value;
  }
  return {
    version: 1,
    modelAuthGrant: bootstrap,
    modelAuthContext: context.value,
    ...(executionPolicy ? { executionPolicy } : {}),
  };
}

/** Maps a `postWorkflowDispatch` result to a settle outcome: only an API-level rejection is definitive. */
export function ghaLaunchOutcome(result: { success: boolean; outcome?: string }): "accepted" | "rejected" | "unknown" {
  if (result.success) return "accepted";
  return result.outcome === "rejected" ? "rejected" : "unknown";
}
