import { describe, it, expect, vi } from "vitest";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { PipelineRunner, type PipelineRunnerOptions } from "../pipeline/runner.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import type {
  PipelineContext,
  PipelineDefinition,
  Step,
  StepModule,
  StepReporter,
} from "../pipeline/types.js";

function makeContext(overrides: Partial<Parameters<typeof DefaultPipelineContext>[0]> = {}): DefaultPipelineContext {
  return new DefaultPipelineContext({
    jobId: 1,
    issueId: "issue-1",
    issueIdentifier: "ENG-1",
    issueTitle: "Test issue",
    issueDescription: "Description",
    nonce: "test-nonce",
    orchestratorUrl: "http://localhost:8080",
    ...overrides,
  });
}

function makeModule(outputs: Record<string, unknown> = {}): StepModule {
  return {
    run: vi.fn().mockResolvedValue(outputs),
  };
}

describe("PipelineRunner", () => {
  describe("run", () => {
    it("executes steps in order and sets outputs on context", async () => {
      const order: string[] = [];
      const cloneMod: StepModule = {
        run: vi.fn(async () => { order.push("clone"); return { workspaceDir: "/tmp/work" }; }),
      };
      const installMod: StepModule = {
        run: vi.fn(async () => { order.push("install"); return { packageManager: "npm" }; }),
      };

      const pipeline: PipelineDefinition = {
        id: "test",
        steps: [
          { id: "clone", type: "clone" },
          { id: "install", type: "install" },
        ],
      };

      const runner = new PipelineRunner()
        .register("clone", cloneMod)
        .register("install", installMod);

      const ctx = makeContext();
      await runner.run(pipeline, ctx, new NoopStepReporter());

      expect(order).toEqual(["clone", "install"]);
      expect(ctx.getOutputs("clone")).toEqual({ workspaceDir: "/tmp/work" });
      expect(ctx.getOutputs("install")).toEqual({ packageManager: "npm" });
    });

    it("flows outputs from prior steps into next step inputs via resolver", async () => {
      const cloneMod = makeModule({ workspaceDir: "/workspace/abc" });
      let capturedInputs: Record<string, unknown> = {};
      const installMod: StepModule = {
        run: vi.fn(async (_ctx, inputs) => {
          capturedInputs = inputs;
          return {};
        }),
      };

      const pipeline: PipelineDefinition = {
        id: "test",
        steps: [
          { id: "clone", type: "clone" },
          {
            id: "install",
            type: "install",
            inputs: (ctx: PipelineContext) => ({
              workspaceDir: ctx.getOutputs("clone").workspaceDir,
            }),
          },
        ],
      };

      const runner = new PipelineRunner()
        .register("clone", cloneMod)
        .register("install", installMod);

      await runner.run(pipeline, makeContext(), new NoopStepReporter());

      expect(capturedInputs.workspaceDir).toBe("/workspace/abc");
    });

    it("skips a step when skip() returns true and reports skipped status", async () => {
      const reports: Step[] = [];
      const reporter: StepReporter = { report: async (s) => { reports.push({ ...s }); } };

      const pipeline: PipelineDefinition = {
        id: "test",
        steps: [
          { id: "clone", type: "clone" },
          {
            id: "push",
            type: "push",
            skip: () => true,
          },
        ],
      };

      const runner = new PipelineRunner()
        .register("clone", makeModule({ workspaceDir: "/tmp" }));

      await runner.run(pipeline, makeContext(), reporter);

      const pushReport = reports.find((r) => r.id === "push");
      expect(pushReport?.status).toBe("skipped");
    });

    it("does not call module.run for skipped steps", async () => {
      const pushMod = makeModule({});

      const pipeline: PipelineDefinition = {
        id: "test",
        steps: [
          { id: "push", type: "push", skip: () => true },
        ],
      };

      const runner = new PipelineRunner().register("push", pushMod);

      await runner.run(pipeline, makeContext(), new NoopStepReporter());

      expect(pushMod.run).not.toHaveBeenCalled();
    });

    it("reports running then passed for a successful step", async () => {
      const reports: Step[] = [];
      const reporter: StepReporter = { report: async (s) => { reports.push({ ...s }); } };

      const pipeline: PipelineDefinition = {
        id: "test",
        steps: [{ id: "clone", type: "clone" }],
      };

      const runner = new PipelineRunner().register("clone", makeModule({ workspaceDir: "/x" }));

      await runner.run(pipeline, makeContext(), reporter);

      const stepReports = reports.filter((r) => r.id === "clone");
      expect(stepReports[0].status).toBe("running");
      expect(stepReports[1].status).toBe("passed");
      expect(stepReports[1].outputs).toEqual({ workspaceDir: "/x" });
    });

    it("reports failed status and rethrows on module error", async () => {
      const reports: Step[] = [];
      const reporter: StepReporter = { report: async (s) => { reports.push({ ...s }); } };

      const errorMod: StepModule = {
        run: vi.fn().mockRejectedValue(new Error("clone failed")),
      };

      const pipeline: PipelineDefinition = {
        id: "test",
        steps: [{ id: "clone", type: "clone" }],
      };

      const runner = new PipelineRunner().register("clone", errorMod);

      await expect(runner.run(pipeline, makeContext(), reporter)).rejects.toThrow("clone failed");

      const failedReport = reports.find((r) => r.status === "failed");
      expect(failedReport?.id).toBe("clone");
      expect(failedReport?.outputs.error).toMatch("clone failed");
    });

    it("stops pipeline on first failure without running subsequent steps", async () => {
      const installMod = makeModule({});

      const pipeline: PipelineDefinition = {
        id: "test",
        steps: [
          { id: "clone", type: "clone" },
          { id: "install", type: "install" },
        ],
      };

      const runner = new PipelineRunner()
        .register("clone", { run: vi.fn().mockRejectedValue(new Error("boom")) })
        .register("install", installMod);

      await expect(runner.run(pipeline, makeContext(), new NoopStepReporter())).rejects.toThrow();

      expect(installMod.run).not.toHaveBeenCalled();
    });

    it("throws when no module is registered for the step type", async () => {
      const pipeline: PipelineDefinition = {
        id: "test",
        steps: [{ id: "clone", type: "clone" }],
      };

      const runner = new PipelineRunner(); // nothing registered

      await expect(runner.run(pipeline, makeContext(), new NoopStepReporter())).rejects.toThrow(
        /No module registered/,
      );
    });

    it("uses moduleId override to look up a non-type module", async () => {
      const customMod = makeModule({ done: true });

      const pipeline: PipelineDefinition = {
        id: "test",
        steps: [{ id: "feedback-loop", type: "custom", moduleId: "feedback-loop" }],
      };

      const runner = new PipelineRunner().register("feedback-loop", customMod);

      await runner.run(pipeline, makeContext(), new NoopStepReporter());

      expect(customMod.run).toHaveBeenCalledOnce();
    });

    it("passes static inputs to module.run", async () => {
      let capturedInputs: Record<string, unknown> = {};
      const mod: StepModule = {
        run: vi.fn(async (_ctx, inputs) => { capturedInputs = inputs; return {}; }),
      };

      const pipeline: PipelineDefinition = {
        id: "test",
        steps: [{ id: "clone", type: "clone", inputs: { repoOwner: "acme", repoRepo: "app" } }],
      };

      const runner = new PipelineRunner().register("clone", mod);

      await runner.run(pipeline, makeContext(), new NoopStepReporter());

      expect(capturedInputs.repoOwner).toBe("acme");
      expect(capturedInputs.repoRepo).toBe("app");
    });
  });
});

describe("DefaultPipelineContext", () => {
  it("returns empty object for unknown step id", () => {
    const ctx = makeContext();
    expect(ctx.getOutputs("nonexistent")).toEqual({});
  });

  it("stores and retrieves outputs by step id", () => {
    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: "/tmp/x" });
    expect(ctx.getOutputs("clone")).toEqual({ workspaceDir: "/tmp/x" });
  });

  it("resolveInputs returns empty object for undefined", () => {
    const ctx = makeContext();
    expect(ctx.resolveInputs(undefined)).toEqual({});
  });

  it("resolveInputs passes through static object", () => {
    const ctx = makeContext();
    const inputs = { a: 1, b: "two" };
    expect(ctx.resolveInputs(inputs)).toBe(inputs);
  });

  it("resolveInputs calls function with context", () => {
    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: "/work" });
    const result = ctx.resolveInputs((c) => ({ dir: c.getOutputs("clone").workspaceDir }));
    expect(result).toEqual({ dir: "/work" });
  });
});

describe("PipelineRunner — dynamic step loading via resolveModule()", () => {
  function makeRunnerWithMocks(
    importResult: StepModule | undefined,
    existingPath = "custom/steps/hello.js",
    extraOptions: Partial<PipelineRunnerOptions> = {},
  ): PipelineRunner {
    return new PipelineRunner({
      resolveModuleOptions: {
        customRoot: "/fake-workspace",
        builtinRoot: "/fake-builtin",
        existsSyncImpl: (p) => p.includes(existingPath),
      },
      importStepModule: async (p) => (p.includes(existingPath) ? importResult : undefined),
      ...extraOptions,
    });
  }

  it("discovers and loads a custom step from custom/steps/ when not pre-registered", async () => {
    const helloMod: StepModule = { run: vi.fn().mockResolvedValue({ greeted: true }) };
    const runner = makeRunnerWithMocks(helloMod);

    const pipeline: PipelineDefinition = {
      id: "test",
      steps: [{ id: "hello-step", type: "custom", moduleId: "hello" }],
    };

    await runner.run(pipeline, makeContext(), new NoopStepReporter());
    expect(helloMod.run).toHaveBeenCalledOnce();
  });

  it("passes the resolved custom path (not the builtin path) to importStepModule", async () => {
    const importedPaths: string[] = [];
    const helloMod: StepModule = { run: vi.fn().mockResolvedValue({}) };

    const runner = new PipelineRunner({
      resolveModuleOptions: {
        customRoot: "/my-workspace",
        builtinRoot: "/builtin",
        existsSyncImpl: (p) => p.includes("/my-workspace/custom/steps/hello.js"),
      },
      importStepModule: async (p) => {
        importedPaths.push(p);
        return p.includes("custom") ? helloMod : undefined;
      },
    });

    await runner.run(
      { id: "t", steps: [{ id: "s", type: "custom", moduleId: "hello" }] },
      makeContext(),
      new NoopStepReporter(),
    );

    expect(importedPaths[0]).toContain("/my-workspace/custom/steps/hello.js");
  });

  it("pre-registered modules take precedence over dynamic loading", async () => {
    const registeredMod: StepModule = { run: vi.fn().mockResolvedValue({ source: "registered" }) };
    const dynamicMod: StepModule = { run: vi.fn().mockResolvedValue({ source: "dynamic" }) };

    const runner = new PipelineRunner({
      resolveModuleOptions: { existsSyncImpl: () => true },
      importStepModule: async () => dynamicMod,
    }).register("clone", registeredMod);

    await runner.run(
      { id: "t", steps: [{ id: "clone", type: "clone" }] },
      makeContext(),
      new NoopStepReporter(),
    );

    expect(registeredMod.run).toHaveBeenCalledOnce();
    expect(dynamicMod.run).not.toHaveBeenCalled();
  });

  it("throws No module registered when both registry and dynamic load return nothing", async () => {
    const runner = new PipelineRunner({
      resolveModuleOptions: {
        customRoot: "/fake-workspace",
        builtinRoot: "/fake-builtin",
        existsSyncImpl: () => false,
      },
      importStepModule: async () => undefined,
    });

    const pipeline: PipelineDefinition = {
      id: "test",
      steps: [{ id: "missing-step", type: "custom", moduleId: "nonexistent" }],
    };

    await expect(runner.run(pipeline, makeContext(), new NoopStepReporter())).rejects.toThrow(
      /No module registered/,
    );
  });

  it("falls back to .ts extension when .js custom file does not exist", async () => {
    const helloMod: StepModule = { run: vi.fn().mockResolvedValue({ loaded: "ts" }) };

    const runner = new PipelineRunner({
      resolveModuleOptions: {
        customRoot: "/ws",
        builtinRoot: "/builtin",
        // Only the .ts path exists
        existsSyncImpl: (p) => p.endsWith("custom/steps/hello.ts"),
      },
      importStepModule: async (p) => (p.endsWith("custom/steps/hello.ts") ? helloMod : undefined),
    });

    await runner.run(
      { id: "t", steps: [{ id: "h", type: "custom", moduleId: "hello" }] },
      makeContext(),
      new NoopStepReporter(),
    );

    expect(helloMod.run).toHaveBeenCalledOnce();
  });
});
