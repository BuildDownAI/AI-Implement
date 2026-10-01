import { randomUUID } from "node:crypto";
import { createCodexPlanningDriver } from "./codex-planning-adapter.js";
import { STAGE_NAMES, type StageName, type StageSelection } from "../agent-config.js";
import type { ResolvedAgentSnapshotV1 } from "../run-config.js";
import type { ModelAuthClient } from "../model-auth-client.js";
import {
  ClaudeCliExecutor,
  isPossiblyLiveChild,
  type ActivityReportingConfig,
  type ClaudeInvokeOptions,
} from "./executor.js";
import { CodexExecutor, CodexRecoveryRequiredError, type CodexExecutorOptions } from "./codex-executor.js";
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

/**
 * A selected profile's child could not be proven stopped (or its checkpoint is uncertain). The selected
 * auth callback stays pending and the profile keeps its owner: nothing checkpoints, releases, disposes
 * or invokes it until recovery proves the stop. Carries no credential, path or session content.
 */
export class AgentRecoveryRequiredError extends Error {
  readonly code = "AGENT_RECOVERY_REQUIRED";
  readonly reason: "child_not_terminated" | "checkpoint_uncertain" | "held";
  constructor(reason: AgentRecoveryRequiredError["reason"]) {
    super(`Agent invocation requires recovery: ${reason}`);
    this.name = "AgentRecoveryRequiredError";
    this.reason = reason;
  }
}

type ClaudeLike = { invoke(params: InvokeParams, options?: ClaudeInvokeOptions): Promise<LLMResult> };

/** Planning runs on the restricted native app-server transport; implementation and review on `codex exec`. */
export type CodexTransport = "native" | "exec";

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
  /** Extra Codex executor options (spawn/sleep seams); `auth`/`profileId`/transport are always the selected ones. */
  codexOptions?: Omit<CodexExecutorOptions, "auth" | "profileId" | "allowRepositoryWrites" | "cancelSignal" | "protocolDriver">;
  /** Construction seams, mainly for tests. Each is called at most once per executor (Codex: per profile and transport). */
  createClaude?: () => ClaudeLike;
  createCodex?: (profileId: string, transport: CodexTransport) => LLMExecutor;
}

/**
 * Returns `legacy` itself for a legacy run, or a decorator that selects the Claude or Codex
 * executor per call from the snapshot's stage selection. One executor instance is cached per
 * agent (Codex: profile and transport) so invocation sequences and activity producer ids persist
 * across calls. The selector never finishes or disposes a profile; that is a runner lifecycle
 * responsibility. A profile whose child may still be alive is held for every executor and stage.
 */
export function createStageExecutor(options: StageExecutorOptions): LLMExecutor {
  const { snapshot } = options;
  if (!snapshot) return options.legacy;
  if (!options.auth) throw new AgentStageError("A stage snapshot requires a model auth client");
  const auth = options.auth;

  let claude: ClaudeLike | undefined;
  const codexByKey = new Map<string, LLMExecutor>();
  const heldProfiles = new Map<string, Error>();

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
  const getCodex = (profileId: string, transport: CodexTransport): LLMExecutor => {
    const key = `${profileId}\u0000${transport}`;
    let ex = codexByKey.get(key);
    if (!ex) {
      ex =
        options.createCodex?.(profileId, transport) ??
        new CodexExecutor(options.workspaceDir, {
          ...options.codexOptions,
          auth,
          profileId,
          allowRepositoryWrites: options.allowRepositoryWrites,
          cancelSignal: options.cancelSignal,
          ...(transport === "native" ? { protocolDriver: createCodexPlanningDriver() } : {}),
        });
      codexByKey.set(key, ex);
    }
    return ex;
  };

  /** One selected auth invocation for Claude; mirrors CodexExecutor's unproven-child hold. */
  const invokeClaude = async (profileId: string, call: InvokeParams): Promise<LLMResult> => {
    let signalRecovery: (err: Error) => void = () => {};
    const recovery = new Promise<never>((_, reject) => (signalRecovery = reject));
    const invocation = auth.invoke(profileId, async (selected) => {
      try {
        return await getClaude().invoke(call, { env: selected.env });
      } catch (err) {
        if (isPossiblyLiveChild(err)) {
          // Never settle: the client checkpoints on return and throw, which would persist session
          // state under a possibly-live child and mark the profile ready. The pending callback keeps
          // the profile owned; the race surfaces bounded recovery to the caller meanwhile.
          signalRecovery(Object.assign(new AgentRecoveryRequiredError("child_not_terminated"), carryTelemetry(err)));
          return new Promise<LLMResult>(() => {});
        }
        throw err;
      }
    });
    invocation.catch(() => {});
    return Promise.race([invocation, recovery]);
  };

  return {
    async invoke(params: InvokeParams): Promise<LLMResult> {
      const stage = requireStage(params.agentStage);
      const selection = snapshot.stages[stage];
      const profile = snapshot.profiles[stage];
      const invocationId = `${stage}-${randomUUID()}`;
      const attribute = (outcomeHint: InvocationAttributionV1["outcome"], telemetry?: RunTelemetry): InvocationAttributionV1 =>
        buildAttribution(snapshot, stage, selection, profile, invocationId, limitFor(selection, params), outcomeHint, telemetry);

      // Snapshot values always win; caller and repository model/timeout values are discarded.
      const call: InvokeParams = { ...params, model: selection.model, invocationTimeoutMs: selection.invocationTimeoutMs };
      // Codex has a timeout, not a native turn cap: never forward one.
      if (selection.agent === "codex") delete call.maxTurns;

      try {
        if (heldProfiles.has(selection.accountProfileId)) throw new AgentRecoveryRequiredError("held");
        const result =
          selection.agent === "claude"
            ? await invokeClaude(selection.accountProfileId, call)
            : await getCodex(selection.accountProfileId, stage === "planning" ? "native" : "exec").invoke(call);
        return withAttribution(result, attribute(result.failure ? "error" : "success", result.telemetry));
      } catch (err) {
        if (holdsProfile(err)) heldProfiles.set(selection.accountProfileId, err as Error);
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

function carryTelemetry(err: unknown): { telemetry?: RunTelemetry } {
  const telemetry = (err as { telemetry?: RunTelemetry } | null)?.telemetry;
  return telemetry ? { telemetry } : {};
}

/** Errors after which the selected profile may still be owned by an unproven child or uncertain checkpoint. */
function holdsProfile(err: unknown): boolean {
  if (err instanceof AgentRecoveryRequiredError || err instanceof CodexRecoveryRequiredError) return true;
  const category = (err as { category?: unknown } | null)?.category;
  return category === "checkpoint_uncertain" || category === "checkpoint_rejected";
}

function requireStage(value: unknown): StageName {
  if (typeof value === "string" && (STAGE_NAMES as readonly string[]).includes(value)) return value as StageName;
  throw new AgentStageError("A configured run requires an explicit known agentStage (planning, implementation or review)");
}

function limitFor(selection: StageSelection, params: InvokeParams): InvocationAttributionV1["limit"] {
  if (selection.agent === "codex") return { kind: "timeout_ms", value: selection.invocationTimeoutMs };
  return params.maxTurns != null ? { kind: "max_turns", value: params.maxTurns } : null;
}

function buildAttribution(
  snapshot: ResolvedAgentSnapshotV1,
  stage: StageName,
  selection: StageSelection,
  profile: ResolvedAgentSnapshotV1["profiles"][StageName],
  invocationId: string,
  limit: InvocationAttributionV1["limit"],
  outcomeHint: InvocationAttributionV1["outcome"],
  telemetry?: RunTelemetry,
): InvocationAttributionV1 {
  const tokensIn = telemetry?.tokensIn ?? null;
  const tokensOut = telemetry?.tokensOut ?? null;
  const costUsd = telemetry?.costUsd ?? null;
  const present = (tokensIn !== null ? 1 : 0) + (tokensOut !== null ? 1 : 0);
  const attribution: InvocationAttributionV1 = {
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
  // Fail safe to a minimal, still-valid projection rather than carrying a rejected value.
  return sanitizeAttribution(attribution) ?? { ...attribution, usage: null };
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
