import type { LLMExecutor, PipelineContext, PipelineContextData } from "./types.js";

const _noopExecutor: LLMExecutor = {
  invoke(): Promise<never> {
    return Promise.reject(new Error("No LLMExecutor provided to DefaultPipelineContext"));
  },
};

export class DefaultPipelineContext implements PipelineContext {
  private _outputs = new Map<string, Record<string, unknown>>();
  readonly llmExecutor: LLMExecutor;

  constructor(public readonly data: PipelineContextData, llmExecutor?: LLMExecutor) {
    this.llmExecutor = llmExecutor ?? _noopExecutor;
  }

  getOutputs(stepId: string): Record<string, unknown> {
    return this._outputs.get(stepId) ?? {};
  }

  setOutputs(stepId: string, outputs: Record<string, unknown>): void {
    this._outputs.set(stepId, outputs);
  }

  resolveInputs(
    def:
      | Record<string, unknown>
      | ((ctx: PipelineContext) => Record<string, unknown>)
      | undefined,
  ): Record<string, unknown> {
    if (!def) return {};
    if (typeof def === "function") return def(this);
    return def;
  }
}
