import type { ReferenceRepo } from "../reference-repos.js";
import type { ReviewerSelection } from "../config.js";

import type { RetryPolicy } from "./retry-backoff.js";
import type { ReviewerDefinition } from "./reviewers/registry.js";
import type { FailureRecord } from "./failure-classification.js";

export type StepStatus = "running" | "passed" | "failed" | "skipped" | "cancelled";

export type StepType =
  | "clone"
  | "install"
  | "implement"
  | "review"
  | "preflight"
  | "push"
  | "await_ci"
  | "custom";

export interface Step {
  id: string;
  type: StepType;
  status: StepStatus;
  started_at: string;
  ended_at: string | null;
  parent_step_id: string | null;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  logs_url: string | null;
}

export interface PipelineContextData {
  jobId: number;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string;
  nonce: string;
  orchestratorUrl: string;
  /** Optional model override for Claude invocations (e.g. "claude-opus-4-5"). */
  model?: string;
  /** Autonomous runner: absolute path to the cloned workspace. */
  workspaceDir?: string;
  /** Autonomous runner: planning context fetched from the ticketing provider. */
  planningContext?: string;
  /** Autonomous runner: fully rendered implementation prompt from WORKFLOW.md or fallback. */
  implementationPrompt?: string;
  /** Autonomous runner: existing PR number for gap-fill runs, "" if none. */
  prNumber?: string;
  /** Autonomous runner: target GitHub repo owner. */
  githubOwner?: string;
  /** Autonomous runner: target GitHub repo name. */
  githubRepo?: string;
  /** Autonomous runner: token used for clone/push. */
  githubToken?: string;
  /** Autonomous runner: base branch to clone. Implementation branches are derived per issue. */
  branch?: string;
  /** Autonomous runner: PR base branch for gap-fill runs (where branch holds the PR impl branch). */
  baseBranch?: string;
  /** Autonomous runner: Claude provider ("anthropic" | "bedrock"), from PROVIDER env. */
  provider?: string;
  /** Autonomous runner: cap on Claude turns per implement pass (from env). */
  maxTurns?: number;
  /** Autonomous runner: cap on implement/review iterations (from env). */
  maxIterations?: number;
  /** Autonomous runner: optional branch-name prefix (from AI_IMPLEMENT_BRANCH_PREFIX). */
  branchPrefix?: string;
  /** Autonomous runner: URL of the skills repo to clone and install into ~/.claude/skills/. */
  skillsRepo?: string;
  /** Autonomous runner: per-issue AI-Implement profile names (from AI_IMPLEMENT_PROFILES).
   *  Always set by run-autonomous ([] when the env var is absent). No built-in step reads
   *  it — it is the contract surface for image-baked custom/ steps. */
  profiles?: string[];
  /** Autonomous runner: issue assignee display name (Jira), from the run_config envelope or
   *  AI_IMPLEMENT_ASSIGNEE_NAME env. Used by push.ts to attribute the opened PR's title. */
  assigneeName?: string;
  /** Autonomous runner: per-project sensitive-file add/allow globs from the run_config envelope. */
  sensitiveFiles?: { add?: string[]; allow?: string[] };
  /** Autonomous runner: true when this is a grouping parent's own closing-work run. Push.ts
   *  uses this to finalize cleanly (no PR) when the agent produces no changes. */
  groupingParent?: boolean;
  /** Autonomous runner: WORKFLOW.md hook script paths (relative to repo root). */
  hooks?: { setup?: string; verify?: string; teardown?: string };
  /** Autonomous runner: callback URL for runner result/progress posts (from runnerCallbackUrl / RUNNER_CALLBACK_URL). */
  callbackUrl?: string;
  /** Autonomous runner: per-project dependency-repo read access scope (from run_config envelope). */
  dependencyTokenScope?: "installation";
  /** Autonomous runner: reference repositories to clone read-only into the workspace (from run_config envelope). */
  referenceRepos?: ReferenceRepo[];
  /** Autonomous runner: project reviewer selection from the trusted run_config envelope. */
  reviewers?: ReviewerSelection[];
  /** Autonomous runner: selected image-baked reviewer code resolved from the trusted package root, never the checked-out workspace. */
  trustedReviewerDefinitions?: ReadonlyMap<string, ReviewerDefinition>;
  /** Autonomous runner: optional reviewer rubric appended to the review prompt (e.g. kg-refresh-specific approval criteria). */
  reviewRubric?: string;
  /** Autonomous runner: short-lived read token minted by the dependency-auth step; set on context rather than returned as a step output so it is never persisted to the step log. */
  dependencyToken?: string;
  /** Autonomous runner: expiry timestamp for the dependency token (ISO 8601). */
  dependencyTokenExpiresAt?: string;
  /** Autonomous runner: retry/backoff policy and reviewer turn cap, from the run_config
   *  envelope's retryPolicy or DEFAULT_RETRY_POLICY when absent. The implement/review
   *  steps pass this to the executor as `retry` for pre-tool-use request retries
   *  (BAC-27114); `retryPolicy.stageRetries` also bounds the whole-stage retry rail on
   *  top, read directly by feedback-loop.ts and post-push-review.ts (BAC-27134). */
  retryPolicy?: RetryPolicy;
  /** kg-refresh dev-harness: when true, kg-snapshot-push prints the guard table but skips commit and push. */
  kgDryRun?: boolean;
  /** kg-refresh: when true, kg-snapshot-push downgrades the zero-shrink/50% guards to warnings and pushes anyway (AII-628). */
  kgAcceptNewBaseline?: boolean;
  /** kg-refresh: email of the admin who set kgAcceptNewBaseline, for the guard-override log line and the refresh PR's ### Baseline section. */
  kgBaselineActor?: string;
  /**
   * Optional runner-activity/cycle sink (AII-788). Mirrors `PipelineContext.activitySink`
   * so a context constructed from a plain `PipelineContextData` bag (e.g. the dev harness,
   * or a future concrete `PipelineContext` implementation) can carry the same optional
   * sink through the data bag rather than only the interface. Absent on every existing
   * call site — nothing constructs or calls one yet.
   */
  activitySink?: ActivitySink;
}

export interface PipelineContext {
  readonly data: PipelineContextData;
  readonly llmExecutor: LLMExecutor;
  /**
   * Optional runner-activity/cycle sink (AII-788). Absent on every existing
   * `PipelineContext` implementation and call site — nothing constructs or
   * calls one yet; a later issue wires a concrete sink here.
   */
  readonly activitySink?: ActivitySink;
  getOutputs(stepId: string): Record<string, unknown>;
  setOutputs(stepId: string, outputs: Record<string, unknown>): void;
  resolveInputs(
    def:
      | Record<string, unknown>
      | ((ctx: PipelineContext) => Record<string, unknown>)
      | undefined,
  ): Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Activity/cycle sink (AII-788)
// ---------------------------------------------------------------------------
//
// Pure protocol shapes for reporting runner activity and per-cycle summaries
// out of the pipeline — no Restate or Claude Code SDK dependency, no
// transport, no buffering/redaction/retry behavior. Those belong to a
// concrete implementation (e.g. `ActivityReporter`, ./activity-reporter.ts,
// AII-784) that a later issue wires into the executor/steps below. Every
// method exists so a producer never has to invent its own wire shape.
// Optional everywhere it attaches, so every existing implementation of
// `PipelineContext`/`InvokeParams` and every existing call site stays source
// compatible with no edits. Nothing in this codebase constructs or calls an
// `ActivitySink` yet.

/**
 * Identifies one activity record within an attempt's ordered stream.
 * `sequence` must be contiguous per (attemptId, producerId) — a gap is how a
 * downstream consumer detects a missing tail, matching the wire identity
 * already used by the AII-784 activity transport (`ReviewFixActivityEvent`,
 * ../review-fix-contract.ts).
 */
export interface ActivityIdentity {
  readonly attemptId: string;
  readonly producerId: string;
  readonly sequence: number;
}

/** Per-event redacted-payload byte cap. */
export const ACTIVITY_MAX_EVENT_BYTES = 16 * 1024;

/** Cumulative redacted-byte cap per attempt. */
export const ACTIVITY_MAX_ATTEMPT_BYTES = 10 * 1024 * 1024;

/**
 * Already-redacted text bounded to `ACTIVITY_MAX_EVENT_BYTES`. `truncated` is
 * explicit so a consumer never has to infer truncation from length.
 */
export interface BoundedActivityText {
  readonly text: string;
  readonly truncated: boolean;
}

/** An observable tool call starting. Never the model's hidden reasoning or tokens. */
export interface ActivityToolStart {
  readonly cycle: number;
  readonly action: string;
  /** Observable, structured arguments only — must not carry hidden reasoning. */
  readonly detail?: unknown;
}

/** An observable tool call's outcome. `output` is already bounded per `ACTIVITY_MAX_EVENT_BYTES`. */
export interface ActivityToolResult {
  readonly cycle: number;
  readonly action: string;
  readonly output: BoundedActivityText;
}

/**
 * End-of-cycle summary. Deliberately independent of the activity byte limit:
 * none of these fields is redacted/bounded text, so a cycle summary always
 * carries its full commit list, disposition set, test results, verdict and
 * usage rather than competing with tool activity for the
 * `ACTIVITY_MAX_EVENT_BYTES`/`ACTIVITY_MAX_ATTEMPT_BYTES` caps.
 */
export interface CycleActivitySummary {
  readonly cycle: number;
  readonly commits: readonly string[];
  readonly dispositions: readonly { readonly key: string; readonly disposition: string }[];
  readonly tests: readonly { readonly name: string; readonly passed: boolean }[] | null;
  readonly verdict: { readonly approved: boolean; readonly summary?: string } | null;
  readonly usage: {
    readonly tokensIn: number | null;
    readonly tokensOut: number | null;
    readonly costUsd: number | null;
  };
}

/**
 * Optional producer-side sink for runner activity and per-cycle telemetry.
 *
 * Behavior a concrete implementation must honor (enforced by the
 * transport/storage layer, not by this type — nothing here does I/O):
 *  - The same identity with an identical payload is idempotent — replaying it
 *    is a safe no-op.
 *  - The same identity with a *different* payload is rejected and must raise
 *    an alert, never silently overwrite the stored event.
 *  - `sequence` is contiguous per (attemptId, producerId); a gap is the
 *    signal a missing tail is visible downstream.
 *  - `final()` marks the highest sequence issued for the identity's
 *    (attemptId, producerId) pair; an attempt with no final marker is
 *    presumed still in-flight.
 */
export interface ActivitySink {
  toolStart(identity: ActivityIdentity, input: ActivityToolStart): void;
  toolResult(identity: ActivityIdentity, result: ActivityToolResult): void;
  cycleSummary(identity: ActivityIdentity, summary: CycleActivitySummary): void;
  final(identity: ActivityIdentity, lastSequence: number): void;
}

export interface StepReporter {
  /**
   * Optional second param carries the runner-activity/cycle sink (AII-788)
   * alongside the step report. Optional so `NoopStepReporter`, `HttpStepReporter`,
   * `TokenStepReporter`, `TimingStepReporter` and every existing call site
   * (`reporter.report(step)`) stay source compatible with zero edits. No
   * implementation reads it yet.
   */
  report(step: Step, activitySink?: ActivitySink): Promise<void>;
}

export interface StepModule<
  I extends Record<string, unknown> = Record<string, unknown>,
  O extends Record<string, unknown> = Record<string, unknown>,
> {
  run(context: PipelineContext, inputs: I, reporter: StepReporter): Promise<O>;
}

export type LogLevel = "summary" | "stream";

export interface RunTelemetry {
  outcome: "success" | "max_turns" | "error" | "unknown";
  numTurns: number | null;
  durationMs: number | null;
  costUsd: number | null;
  /** Total input tokens, including prompt-cache creation and cache reads. */
  tokensIn: number | null;
  tokensOut: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  /** Compact per-call tool trace ("ToolName input-summary"), capped; last entry may be a truncation marker. */
  toolTrace?: string[];
  /** Bash commands with a matching structured tool result; never inferred from model text. */
  executedCommands?: Array<{ command: string; failed: boolean }>;
}

export interface LLMTerminalStatus {
  subtype: string | null;
  isError: boolean | null;
}

export interface LLMResult {
  stdout: string;
  stderr?: string;
  exitCode: number;
  tokensUsed: number;
  telemetry?: RunTelemetry;
  structuredOutput?: unknown;
  terminalStatus?: LLMTerminalStatus;
  /** Termination signal from the CLI process's close event (e.g. SIGTERM), null when it exited normally. */
  signal?: string | null;
  /** Number of spawn attempts made for this invocation; 1 unless `retry` was supplied and a transient pre-tool-use failure was re-spawned. Optional so a custom LLMExecutor may omit it — consumers fall back to `?? 1`. */
  attempts?: number;
  /** Set on any classified failure of the final attempt (retryable or not) — the last attempt's classified record. */
  failure?: FailureRecord;
}

export interface InvokeParams {
  prompt: string;
  model: string;
  maxTurns?: number;
  tools?: string[];
  jsonSchema?: Record<string, unknown>;
  /**
   * Stage identifier used to tag a classified failure (e.g. "implement" or
   * "review"). Read independently of `retry` — a bare invoke() caller (the
   * dev harness, or any custom LLMExecutor) still gets a correctly-staged
   * failure record even with no retry policy configured.
   */
  stage?: string;
  /**
   * Whether this call site requires `structuredOutput` (review does; implement
   * never requests it). Read independently of `retry` for the same reason as
   * `stage`: without it, a call site with no retry policy configured (e.g. the
   * dev harness) would never classify a dropped/missing verdict as
   * invalid_output, since `classifyLlmResult`'s structural checks are all
   * gated on this flag.
   */
  expectsStructuredOutput?: boolean;
  /**
   * Enables re-spawning a transient failure that occurred before any tool use.
   * Omit to keep single-attempt behaviour (the default before BAC-27114).
   */
  retry?: {
    policy: RetryPolicy;
    /**
     * True when a tool call made during a failed attempt cannot have mutated the
     * workspace (review runs read-only tools) — EXCEPT a Bash-prefixed tool use
     * (e.g. review's allowed `Bash(curl *)`), which can still write files or POST
     * despite the read-only allowlist and so still blocks a retry regardless of
     * this flag. See `effectiveSawToolUse`/`sawUnsafeToolUse`.
     */
    toolUseIsSafe: boolean;
  };
  /**
   * Optional runner-activity sink this invocation may report tool
   * start/result and cycle-summary events to (AII-788). Absent means no
   * activity reporting — identical behavior to before this field existed.
   * No built-in `LLMExecutor` reads it yet.
   */
  activitySink?: ActivitySink;
  /**
   * The feedback-loop iteration this invocation belongs to, stamped onto every
   * `ActivityToolStart`/`ActivityToolResult` this call emits (AII-798) so a
   * `CycleActivitySummary.cycle` can be matched back to the tool events that
   * produced it. Defaults to 1 for a bare/non-loop caller (e.g. the dev
   * harness), matching single-pass behavior.
   */
  cycle?: number;
}

export interface LLMExecutor {
  invoke(params: InvokeParams): Promise<LLMResult>;
}

export interface StepDefinition {
  id: string;
  type: StepType;
  /** Module registry key override — defaults to `type`. Use for custom step variants. */
  moduleId?: string;
  inputs?: Record<string, unknown> | ((context: PipelineContext) => Record<string, unknown>);
  /** Return `false`/falsy to run the step. A truthy string is logged as the skip reason; bare `true` gets a generic fallback. */
  skip?: (context: PipelineContext) => boolean | string;
}

export interface PipelineDefinition {
  id: string;
  steps: StepDefinition[];
}
