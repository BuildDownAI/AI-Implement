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
  /** Autonomous runner: short-lived read token minted by the dependency-auth step; set on context rather than returned as a step output so it is never persisted to the step log. */
  dependencyToken?: string;
  /** Autonomous runner: expiry timestamp for the dependency token (ISO 8601). */
  dependencyTokenExpiresAt?: string;
}

export interface PipelineContext {
  readonly data: PipelineContextData;
  readonly llmExecutor: LLMExecutor;
  getOutputs(stepId: string): Record<string, unknown>;
  setOutputs(stepId: string, outputs: Record<string, unknown>): void;
  resolveInputs(
    def:
      | Record<string, unknown>
      | ((ctx: PipelineContext) => Record<string, unknown>)
      | undefined,
  ): Record<string, unknown>;
}

export interface StepReporter {
  report(step: Step): Promise<void>;
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
}

export interface LLMResult {
  stdout: string;
  stderr?: string;
  exitCode: number;
  tokensUsed: number;
  telemetry?: RunTelemetry;
}

export interface LLMExecutor {
  invoke(params: {
    prompt: string;
    model: string;
    maxTurns?: number;
    tools?: string[];
  }): Promise<LLMResult>;
}

export interface StepDefinition {
  id: string;
  type: StepType;
  /** Module registry key override — defaults to `type`. Use for custom step variants. */
  moduleId?: string;
  inputs?: Record<string, unknown> | ((context: PipelineContext) => Record<string, unknown>);
  skip?: (context: PipelineContext) => boolean;
}

export interface PipelineDefinition {
  id: string;
  steps: StepDefinition[];
}
