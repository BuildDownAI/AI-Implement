import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export interface PipelineStepEntry {
  id: string;
  type: string;
  moduleId: string;
  hasCustomOverride: boolean;
}

export interface PipelineEntry {
  id: string;
  file: string;
  isOverride: boolean;
  steps: PipelineStepEntry[];
  error: string | null;
}

export interface StepModuleEntry {
  id: string;
  builtinPath: string | null;
  customPath: string | null;
  hasCustomOverride: boolean;
}

const STEP_EXTS = [".ts", ".js", ".mjs"];

function listYamls(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"));
}

function listStepModules(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => STEP_EXTS.some((e) => n.endsWith(e)))
    .map((n) => n.replace(/\.(ts|js|mjs)$/, ""));
}

export function inspectPipelinesAndSteps(opts?: { cwd?: string }): {
  pipelines: PipelineEntry[];
  steps: StepModuleEntry[];
} {
  const cwd = opts?.cwd ?? process.cwd();
  const builtinPipelinesDir = path.join(cwd, "pipelines");
  const customPipelinesDir = path.join(cwd, "custom/pipelines");
  const builtinStepsDir = path.join(cwd, "src/pipeline/steps");
  const customStepsDir = path.join(cwd, "custom/steps");

  const customSteps = new Set(listStepModules(customStepsDir));
  const builtinSteps = new Set(listStepModules(builtinStepsDir));
  const stepIds = new Set([...builtinSteps, ...customSteps]);

  function parsePipelineFile(filePath: string, file: string, isOverride: boolean): PipelineEntry {
    const placeholder: PipelineEntry = { id: file, file, isOverride, steps: [], error: null };
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch (e) {
      return { ...placeholder, error: `Read error: ${(e as Error).message}` };
    }
    let doc: unknown;
    try {
      doc = parseYaml(raw);
    } catch (e) {
      return { ...placeholder, error: `YAML parse error: ${(e as Error).message}` };
    }
    if (!doc || typeof doc !== "object") {
      return { ...placeholder, error: "Pipeline YAML must be an object" };
    }
    const { id, steps } = doc as { id?: unknown; steps?: unknown };
    if (typeof id !== "string" || !id) {
      return { ...placeholder, error: "Pipeline YAML missing 'id'" };
    }
    if (!Array.isArray(steps)) {
      return { ...placeholder, id, error: "Pipeline YAML 'steps' must be an array" };
    }
    const stepEntries: PipelineStepEntry[] = steps.map((s, i) => {
      const stepObj = (s ?? {}) as { id?: string; type?: string; moduleId?: string };
      const stepId = stepObj.id ?? `step-${i}`;
      const stepType = stepObj.type ?? "unknown";
      const moduleId = stepObj.moduleId ?? stepType;
      return {
        id: stepId,
        type: stepType,
        moduleId,
        hasCustomOverride: customSteps.has(moduleId),
      };
    });
    return { id, file, isOverride, steps: stepEntries, error: null };
  }

  const pipelines: PipelineEntry[] = [];
  for (const name of listYamls(builtinPipelinesDir)) {
    const customSibling = path.join(customPipelinesDir, name);
    const useCustom = fs.existsSync(customSibling);
    pipelines.push(
      useCustom
        ? parsePipelineFile(customSibling, `custom/pipelines/${name}`, true)
        : parsePipelineFile(path.join(builtinPipelinesDir, name), `pipelines/${name}`, false),
    );
  }
  for (const name of listYamls(customPipelinesDir)) {
    if (fs.existsSync(path.join(builtinPipelinesDir, name))) continue;
    pipelines.push(
      parsePipelineFile(path.join(customPipelinesDir, name), `custom/pipelines/${name}`, true),
    );
  }
  pipelines.sort((a, b) => a.file.localeCompare(b.file));

  const stepEntries: StepModuleEntry[] = Array.from(stepIds)
    .sort()
    .map((id) => {
      const builtinPath =
        STEP_EXTS.map((e) => `src/pipeline/steps/${id}${e}`).find((p) =>
          fs.existsSync(path.join(cwd, p)),
        ) ?? null;
      const customPath =
        STEP_EXTS.map((e) => `custom/steps/${id}${e}`).find((p) =>
          fs.existsSync(path.join(cwd, p)),
        ) ?? null;
      return { id, builtinPath, customPath, hasCustomOverride: customPath !== null };
    });

  return { pipelines, steps: stepEntries };
}
