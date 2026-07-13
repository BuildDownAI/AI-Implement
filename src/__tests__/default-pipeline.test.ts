import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    for (const id of ["clone", "install-skills", "install", "feedback-loop", "preflight", "push", "post-push-review"]) {
      expect(registeredModule(runner, id)).toBeDefined();
    }
  });

  it("substitutes a baked custom step when bakedRoot custom/steps/<id>.ts exists", async () => {
    const bakedClone: StepModule = { run: async () => ({ baked: true }) };

    const runner = await createDefaultRunner({
      customRoot: "/workspace",
      bakedRoot: "/app",
      existsSyncImpl: (p) => p === "/app/custom/steps/clone.ts",
      importFn: async () => ({ default: bakedClone }),
    });

    expect(registeredModule(runner, "clone")).toBe(bakedClone);
  });
});

describe("DEFAULT_PIPELINE baked custom root", () => {
  // DEFAULT_PIPELINE is loaded at module-import time, before any workspace
  // clone exists. Re-import the module with AI_IMPLEMENT_CUSTOM_ROOT pointing
  // at a real on-disk baked root (no injected fs) to prove an image-baked
  // custom/pipelines/autonomous.yml takes effect at import time.
  it("honors AI_IMPLEMENT_CUSTOM_ROOT at module-import time", async () => {
    const bakedRoot = mkdtempSync(join(tmpdir(), "ai-implement-baked-"));
    try {
      mkdirSync(join(bakedRoot, "custom", "pipelines"), { recursive: true });
      writeFileSync(
        join(bakedRoot, "custom", "pipelines", "autonomous.yml"),
        "id: baked-loop\nsteps:\n  - id: clone\n    type: clone\n",
      );
      vi.stubEnv("AI_IMPLEMENT_CUSTOM_ROOT", bakedRoot);
      vi.resetModules();
      const { DEFAULT_PIPELINE } = await import("../pipeline/default-pipeline.js");
      expect(DEFAULT_PIPELINE.id).toBe("baked-loop");
      expect(DEFAULT_PIPELINE.steps.map((s) => s.id)).toEqual(["clone"]);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      rmSync(bakedRoot, { recursive: true, force: true });
    }
  });
});
