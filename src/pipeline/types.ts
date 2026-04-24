export type StepStatus = "running" | "passed" | "failed" | "skipped" | "cancelled";

export type StepType =
  | "clone"
  | "install"
  | "implement"
  | "review"
  | "preflight"
  | "push"
  | "await_ci"
  | "explore-codebase"
  | "architecture-analysis"
  | "test-plan"
  | "work-unit-decomposition"
  | "cross-story-context"
  | "post-to-linear"
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
  /** Planning pipeline: parent issue as "- IDENTIFIER: Title" or "None" */
  parent?: string;
  /** Planning pipeline: sibling stories, newline-separated or "None" */
  siblings?: string;
  /** Planning pipeline: related issues as "- [type] IDENTIFIER: Title", newline-separated or "None" */
  dependencies?: string;
  /** Optional model override for Claude invocations (e.g. "claude-opus-4-5"). */
  model?: string;
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

export interface LLMResult {
  stdout: string;
  exitCode: number;
  tokensUsed: number;
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
