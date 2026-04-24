import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isModuleNotFoundError,
  resolveModule,
  type ResolveModuleOptions,
} from "./resolve-module.js";
import type {
  PipelineContext,
  PipelineDefinition,
  Step,
  StepModule,
  StepReporter,
  StepType,
} from "./types.js";

// runner.ts lives in src/pipeline/, which contains the steps/ subdirectory.
// Used as builtinRoot so resolveModule('steps/<key>.js') resolves to src/pipeline/steps/<key>.js.
const BUILTIN_STEPS_ROOT = fileURLToPath(new URL(".", import.meta.url));

export interface PipelineRunnerOptions {
  /** Options forwarded to resolveModule() for step discovery (customRoot, existsSyncImpl, etc.). */
  resolveModuleOptions?: ResolveModuleOptions;
  /**
   * Injectable dynamic import used when loading a step module from disk.
   * Given the resolved absolute path, returns a StepModule or undefined if the
   * path doesn't contain a valid default-exported StepModule.
   * Defaults to a real dynamic import via pathToFileURL.
   */
  importStepModule?: (resolvedPath: string) => Promise<StepModule | undefined>;
}

export class PipelineRunner {
  private modules = new Map<string, StepModule>();
  private options: PipelineRunnerOptions;

  constructor(options: PipelineRunnerOptions = {}) {
    this.options = options;
  }

  /** Register a step module under a key. Key is typically StepType but can be any string for custom modules. */
  register(key: StepType | string, module: StepModule): this {
    this.modules.set(key, module);
    return this;
  }

  /**
   * Tries to load a step module via resolveModule('steps/<key>.<ext>').
   * Checks custom/steps/ first (via resolveModule), then the builtin steps directory.
   * Returns undefined when no valid StepModule with a default export is found.
   */
  private async loadModule(moduleKey: string): Promise<StepModule | undefined> {
    const importFn = this.options.importStepModule ?? defaultImportStepModule;

    // Try .js first (production / ESM), then .ts (tsx dev environment).
    // resolveModule checks custom/<path> before falling back to builtinRoot.
    for (const ext of [".js", ".ts"]) {
      const resolvedPath = resolveModule(`steps/${moduleKey}${ext}`, {
        builtinRoot: BUILTIN_STEPS_ROOT,
        ...this.options.resolveModuleOptions,
      });
      const mod = await importFn(resolvedPath);
      if (mod) return mod;
    }
    return undefined;
  }

  async run(
    pipeline: PipelineDefinition,
    context: PipelineContext,
    reporter: StepReporter,
  ): Promise<void> {
    for (const definition of pipeline.steps) {
      if (definition.skip?.(context)) {
        const skipped: Step = {
          id: definition.id,
          type: definition.type,
          status: "skipped",
          started_at: new Date().toISOString(),
          ended_at: new Date().toISOString(),
          parent_step_id: null,
          inputs: context.resolveInputs(definition.inputs),
          outputs: {},
          logs_url: null,
        };
        await reporter.report(skipped);
        context.setOutputs(definition.id, {});
        continue;
      }

      const moduleKey = definition.moduleId ?? definition.type;
      const mod = this.modules.get(moduleKey) ?? await this.loadModule(moduleKey);
      if (!mod) {
        throw new Error(`No module registered for step "${definition.id}" (key: ${moduleKey})`);
      }

      const inputs = context.resolveInputs(definition.inputs);
      const step: Step = {
        id: definition.id,
        type: definition.type,
        status: "running",
        started_at: new Date().toISOString(),
        ended_at: null,
        parent_step_id: null,
        inputs,
        outputs: {},
        logs_url: null,
      };

      await reporter.report(step);

      try {
        const outputs = await mod.run(context, inputs, reporter);
        step.status = "passed";
        step.ended_at = new Date().toISOString();
        step.outputs = outputs;
        context.setOutputs(definition.id, outputs);
        await reporter.report(step);
      } catch (err) {
        step.status = "failed";
        step.ended_at = new Date().toISOString();
        step.outputs = { error: String(err) };
        context.setOutputs(definition.id, step.outputs);
        await reporter.report(step);
        throw err;
      }
    }
  }
}

async function defaultImportStepModule(resolvedPath: string): Promise<StepModule | undefined> {
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(resolvedPath).href);
  } catch (err) {
    // Only swallow "file not found" — let syntax errors and sub-import
    // failures surface so a broken custom step doesn't look like a missing one.
    if (isModuleNotFoundError(err)) return undefined;
    throw err;
  }
  if (mod && typeof mod === "object" && "default" in mod) {
    const def = (mod as Record<string, unknown>)["default"];
    if (
      def &&
      typeof def === "object" &&
      "run" in def &&
      typeof (def as Record<string, unknown>)["run"] === "function"
    ) {
      return def as StepModule;
    }
  }
  return undefined;
}

