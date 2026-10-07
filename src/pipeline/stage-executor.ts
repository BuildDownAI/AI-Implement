import { randomUUID } from "node:crypto";
import { STAGE_NAMES, type StageName, type StageSelection } from "../agent-config.js";
import type { ResolvedAgentSnapshotV1 } from "../run-config.js";
import type { ModelAuthClient } from "../model-auth-client.js";
import {
  ClaudeCliExecutor,
  type ActivityReportingConfig,
  type ClaudeInvokeOptions,
} from "./executor.js";
import { CodexExecutor, type CodexExecutorOptions } from "./codex-executor.js";
import { createCodexPlanningDriver } from "./codex-planning-adapter.js";
import {
  sanitizeAttribution,
  type InvocationAttributionV1,
  type InvokeParams,
  type LLMExecutor,
  type LLMResult,
  type LogLevel,
  type RunTelemetry,
} from "./types.js";

/**
 * Stage map (AII-959). Callers pass the explicit `agentStage`; the diagnostic `stage` label
 * (e.g. "implement", "review", "plan-probe") is never parsed.
 *   planning probes and planning generation -> planning
 *   code changes and post-push fixes        -> implementation
 *   verdicts, internal/advisory reviewers, read-only post-mortems -> review
 */
export class AgentStageError extends Error {
  readonly code = "AGENT_STAGE_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "AgentStageError";
  }
}

type ClaudeLike = { invoke(params: InvokeParams, options?: ClaudeInvokeOptions): Promise<LLMResult> };

export interface StageExecutorOptions {
  workspaceDir: string;
  /** The injected legacy executor, returned untouched when no snapshot is supplied. */
  legacy: LLMExecutor;
  /** Validated immutable snapshot (`RunConfigV1.agentConfig`). Absent = legacy run. */
  snapshot?: ResolvedAgentSnapshotV1;
  /** Selected-credential client. Required when a snapshot is supplied. */
  auth?: Pick<ModelAuthClient, "invoke">;
  logLevel?: LogLevel;
  allowRepositoryWrites?: boolean;
  activityReporting?: ActivityReportingConfig;
  cancelSignal?: AbortSignal;
  /** Extra Codex executor options (spawn/sleep seams); `auth`/`profileId` are always the selected ones. */
  codexOptions?: Omit<CodexExecutorOptions, "auth" | "profileId" | "allowRepositoryWrites" | "cancelSignal">;
  /** Construction seams, mainly for tests. Each is called at most once per executor (Codex: per profile). */
  createClaude?: () => ClaudeLike;
  createCodex?: (profileId: string) => LLMExecutor;
}

/**
 * Returns `legacy` itself for a legacy run, or a decorator that selects the Claude or Codex
 * executor per call from the snapshot's stage selection. One executor instance is cached per
 * agent/profile so invocation sequences and activity producer ids persist across calls. The
 * selector never finishes or disposes a profile; that is a runner lifecycle responsibility.
 */
export function createStageExecutor(options: StageExecutorOptions): LLMExecutor {
  const { snapshot } = options;
  if (!snapshot) return options.legacy;
  if (!options.auth) throw new AgentStageError("A stage snapshot requires a model auth client");
  const auth = options.auth;

  let claude: ClaudeLike | undefined;
  const codexByProfile = new Map<string, LLMExecutor>();

  const getClaude = (): ClaudeLike =>
    (claude ??=
      options.createClaude?.() ??
      new ClaudeCliExecutor(
        options.workspaceDir,
        options.logLevel ?? "summary",
        options.allowRepositoryWrites ?? false,
        undefined,
        undefined,
        options.activityReporting,
      ));
  // Planning has its own Codex executor and argv: the native app-server path (read-only sandbox, shell and
  // unified exec disabled, repo_read/repo_search/comments_write host tools confined to ai-output/comments).
  // Implementation and review keep the `codex exec` path with their own sandbox. Cached per profile and kind.
  const getCodex = (profileId: string, stage: StageName): LLMExecutor => {
    const key = `${stage === "planning" ? "planning" : "exec"}:${profileId}`;
    let ex = codexByProfile.get(key);
    if (!ex) {
      ex =
        options.createCodex?.(profileId) ??
        new CodexExecutor(options.workspaceDir, {
          ...options.codexOptions,
          ...(stage === "planning" ? { protocolDriver: options.codexOptions?.protocolDriver ?? createCodexPlanningDriver() } : { protocolDriver: undefined }),
          auth,
          profileId,
          allowRepositoryWrites: options.allowRepositoryWrites,
          cancelSignal: options.cancelSignal,
        });
      codexByProfile.set(key, ex);
    }
    return ex;
  };

  return {
    async invoke(params: InvokeParams): Promise<LLMResult> {
      const stage = requireStage(params.agentStage);
      const selection = snapshot.stages[stage];
      const profile = snapshot.profiles[stage];
      const invocationId = `${stage}-${randomUUID()}`;
      // Validate the static projection before any auth acquisition or spawn: a rejected model, id or limit
      // fails closed with a fixed message and never reaches a child or a result.
      const base = sanitizeAttribution(staticAttribution(snapshot, stage, selection, profile, invocationId, limitFor(selection, params)));
      if (!base) throw new AgentStageError("The stage selection cannot be attributed safely; refusing to run it");
      const attribute = (outcomeHint: InvocationAttributionV1["outcome"], telemetry?: RunTelemetry): InvocationAttributionV1 =>
        withOutcome(base, outcomeHint, telemetry);

      // Snapshot values always win; caller and repository model/timeout values are discarded.
      const call: InvokeParams = { ...params, model: selection.model, invocationTimeoutMs: selection.invocationTimeoutMs };
      // Codex has a timeout, not a native turn cap: never forward one.
      if (selection.agent === "codex") delete call.maxTurns;

      try {
        const result =
          selection.agent === "claude"
            ? await auth.invoke(selection.accountProfileId, (selected) => getClaude().invoke(call, { env: selected.env }))
            : await getCodex(selection.accountProfileId, stage).invoke(call);
        return withAttribution(result, attribute(result.failure ? "error" : "success", result.telemetry));
      } catch (err) {
        if (err instanceof Error || (typeof err === "object" && err !== null)) {
          const carried = (err as { telemetry?: RunTelemetry }).telemetry;
          const attribution = attribute("error", carried);
          Object.assign(err, { attribution });
          if (carried) carried.attribution = attribution;
        }
        throw err;
      }
    },
  };
}

function requireStage(value: unknown): StageName {
  if (typeof value === "string" && (STAGE_NAMES as readonly string[]).includes(value)) return value as StageName;
  throw new AgentStageError("A configured run requires an explicit known agentStage (planning, implementation or review)");
}

function limitFor(selection: StageSelection, params: InvokeParams): InvocationAttributionV1["limit"] {
  if (selection.agent === "codex") return { kind: "timeout_ms", value: selection.invocationTimeoutMs };
  return params.maxTurns != null ? { kind: "max_turns", value: params.maxTurns } : null;
}

function staticAttribution(
  snapshot: ResolvedAgentSnapshotV1,
  stage: StageName,
  selection: StageSelection,
  profile: ResolvedAgentSnapshotV1["profiles"][StageName],
  invocationId: string,
  limit: InvocationAttributionV1["limit"],
): InvocationAttributionV1 {
  return {
    version: 1,
    invocationId,
    stage,
    snapshotId: snapshot.snapshotId,
    agent: selection.agent,
    provider: selection.provider,
    model: selection.model,
    profileId: profile.id,
    authMode: profile.authMode,
    limit,
    outcome: "unknown",
    usage: null,
  };
}

/** Adds outcome and usage to an already-validated static projection; unusable usage is stripped, nothing else changes. */
function withOutcome(
  base: InvocationAttributionV1,
  outcomeHint: InvocationAttributionV1["outcome"],
  telemetry?: RunTelemetry,
): InvocationAttributionV1 {
  const tokensIn = telemetry?.tokensIn ?? null;
  const tokensOut = telemetry?.tokensOut ?? null;
  const costUsd = telemetry?.costUsd ?? null;
  const present = (tokensIn !== null ? 1 : 0) + (tokensOut !== null ? 1 : 0);
  const full: InvocationAttributionV1 = {
    ...base,
    outcome: telemetry && !(outcomeHint === "error" && telemetry.outcome === "success") ? telemetry.outcome : outcomeHint,
    usage: telemetry
      ? {
          availability: present === 2 ? "complete" : present === 1 ? "partial" : "unavailable",
          tokensIn,
          tokensOut,
          costUsd,
          costStatus: costUsd === null ? "unavailable" : "reported",
        }
      : null,
  };
  return sanitizeAttribution(full) ?? { ...base, outcome: outcomeHint, usage: null };
}

function withAttribution(result: LLMResult, attribution: InvocationAttributionV1): LLMResult {
  return {
    ...result,
    attribution,
    ...(result.telemetry ? { telemetry: { ...result.telemetry, attribution } } : {}),
  };
}

const SAFE_LABEL_RE = /^[\x21-\x7e]{1,128}$/;
const SECRET_SHAPE_RE = /(sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}|ghp_|gho_|ghs_|xox[bp]-)/i;

/** Displayable `agent/model` label from an attribution or selection; never includes credential or session data. */
export function safeModelLabel(source: Pick<InvocationAttributionV1, "agent" | "model">): string {
  const model = SAFE_LABEL_RE.test(source.model) && !SECRET_SHAPE_RE.test(source.model) ? source.model : "unknown-model";
  return `${source.agent}/${model}`;
}

/** Displayable limit label: Codex has an elapsed-time limit, Claude a native turn cap. Null limit is "no limit". */
export function safeLimitLabel(limit: InvocationAttributionV1["limit"]): string {
  if (!limit || !Number.isFinite(limit.value) || limit.value <= 0) return "no limit";
  if (limit.kind === "timeout_ms") return `timeout ${Math.round(limit.value / 1000)}s`;
  return `${Math.floor(limit.value)} turns`;
}
