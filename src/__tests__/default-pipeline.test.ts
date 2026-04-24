import { describe, it, expect } from "vitest";
import { createDefaultRunner } from "../pipeline/default-pipeline.js";
import type { PipelineRunner } from "../pipeline/runner.js";
import type { StepModule } from "../pipeline/types.js";

function registeredModule(runner: PipelineRunner, key: string): StepModule | undefined {
  // Read the private modules map for test introspection only.
  return (runner as unknown as { modules: Map<string, StepModule> }).modules.get(key);
}

describe("createDefaultRunner", () => {
  it("substitutes a custom step module when custom/steps/<id>.ts exists", async () => {
    const customClone: StepModule = { run: async () => ({ custom: true }) };

    const runner = await createDefaultRunner({
      customRoot: "/workspace",
      existsSyncImpl: (p) => p.endsWith("/custom/steps/clone.ts"),
      importFn: async () => ({ default: customClone }),
    });

    expect(registeredModule(runner, "clone")).toBe(customClone);
  });

  it("falls back to built-in step modules when no custom override exists", async () => {
    const runner = await createDefaultRunner({
      customRoot: "/workspace",
      existsSyncImpl: () => false,
    });

    for (const id of ["clone", "install", "feedback-loop", "preflight", "push"]) {
      expect(registeredModule(runner, id)).toBeDefined();
    }
  });
});
