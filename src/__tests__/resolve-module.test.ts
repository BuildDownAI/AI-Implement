import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveModule, resolveModuleImport } from "../pipeline/resolve-module.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveModule", () => {
  it("returns custom path when custom override exists", () => {
    const result = resolveModule("pipelines/autonomous.yml", {
      customRoot: "/workspace",
      builtinRoot: "/app",
      existsSyncImpl: (p) => p.includes("custom"),
    });
    expect(result.replace(/\\/g, "/")).toContain("custom/pipelines/autonomous.yml");
  });

  it("returns builtin path when no custom override exists", () => {
    const result = resolveModule("pipelines/autonomous.yml", {
      customRoot: "/workspace",
      builtinRoot: "/app",
      existsSyncImpl: () => false,
    });
    expect(result.replace(/\\/g, "/")).toBe("/app/pipelines/autonomous.yml");
  });

  it("falls back to bakedRoot custom/ when workspace has no override", () => {
    const result = resolveModule("pipelines/autonomous.yml", {
      customRoot: "/workspace",
      bakedRoot: "/baked",
      builtinRoot: "/app",
      existsSyncImpl: (p) => p.replace(/\\/g, "/").startsWith("/baked/"),
    });
    expect(result.replace(/\\/g, "/")).toBe("/baked/custom/pipelines/autonomous.yml");
  });

  it("prefers workspace custom/ over bakedRoot custom/ when both exist", () => {
    const result = resolveModule("pipelines/autonomous.yml", {
      customRoot: "/workspace",
      bakedRoot: "/baked",
      builtinRoot: "/app",
      existsSyncImpl: () => true,
    });
    expect(result.replace(/\\/g, "/")).toBe("/workspace/custom/pipelines/autonomous.yml");
  });

  it("returns builtin path when neither workspace nor bakedRoot has an override", () => {
    const result = resolveModule("pipelines/autonomous.yml", {
      customRoot: "/workspace",
      bakedRoot: "/baked",
      builtinRoot: "/app",
      existsSyncImpl: () => false,
    });
    expect(result.replace(/\\/g, "/")).toBe("/app/pipelines/autonomous.yml");
  });

  it("reads the baked root from AI_IMPLEMENT_CUSTOM_ROOT when the option is not passed", () => {
    vi.stubEnv("AI_IMPLEMENT_CUSTOM_ROOT", "/image");
    const result = resolveModule("pipelines/autonomous.yml", {
      customRoot: "/workspace",
      builtinRoot: "/app",
      existsSyncImpl: (p) => p.replace(/\\/g, "/").startsWith("/image/"),
    });
    expect(result.replace(/\\/g, "/")).toBe("/image/custom/pipelines/autonomous.yml");
  });

  it("checks only the workspace custom path when no baked root is configured", () => {
    vi.stubEnv("AI_IMPLEMENT_CUSTOM_ROOT", "");
    const checkedPaths: string[] = [];
    const result = resolveModule("pipelines/autonomous.yml", {
      customRoot: "/workspace",
      builtinRoot: "/app",
      existsSyncImpl: (p) => {
        checkedPaths.push(p.replace(/\\/g, "/"));
        return false;
      },
    });
    expect(checkedPaths).toEqual(["/workspace/custom/pipelines/autonomous.yml"]);
    expect(result.replace(/\\/g, "/")).toBe("/app/pipelines/autonomous.yml");
  });

  it("does not check the baked root twice when it equals customRoot", () => {
    const checkedPaths: string[] = [];
    resolveModule("pipelines/autonomous.yml", {
      customRoot: "/workspace",
      bakedRoot: "/workspace",
      builtinRoot: "/app",
      existsSyncImpl: (p) => {
        checkedPaths.push(p.replace(/\\/g, "/"));
        return false;
      },
    });
    expect(checkedPaths).toEqual(["/workspace/custom/pipelines/autonomous.yml"]);
  });
});

describe("resolveModuleImport", () => {
  it("returns null when no custom override exists", async () => {
    const result = await resolveModuleImport("steps/implement", {
      customRoot: "/workspace",
      existsSyncImpl: () => false,
    });
    expect(result).toBeNull();
  });

  it("imports and returns default export when custom .ts override exists", async () => {
    const fakeModule = { run: async () => ({}) };
    const result = await resolveModuleImport("steps/implement", {
      customRoot: "/workspace",
      existsSyncImpl: (p) => p.endsWith("implement.ts"),
      importFn: async () => ({ default: fakeModule }),
    });
    expect(result).toBe(fakeModule);
  });

  it("imports and returns default export when custom .js override exists", async () => {
    const fakeModule = { run: async () => ({}) };
    const result = await resolveModuleImport("steps/implement", {
      customRoot: "/workspace",
      existsSyncImpl: (p) => p.endsWith("implement.js"),
      importFn: async () => ({ default: fakeModule }),
    });
    expect(result).toBe(fakeModule);
  });

  it("imports and returns default export when custom .mjs override exists", async () => {
    const fakeModule = { run: async () => ({}) };
    const result = await resolveModuleImport("steps/clone", {
      customRoot: "/workspace",
      existsSyncImpl: (p) => p.endsWith("clone.mjs"),
      importFn: async () => ({ default: fakeModule }),
    });
    expect(result).toBe(fakeModule);
  });

  it("prefers .ts over .js when both exist", async () => {
    const tsModule = { run: async () => ({ source: "ts" }) };
    const jsModule = { run: async () => ({ source: "js" }) };
    const result = await resolveModuleImport("steps/implement", {
      customRoot: "/workspace",
      existsSyncImpl: (p) => p.endsWith(".ts") || p.endsWith(".js"),
      importFn: async (url) => ({
        default: url.includes(".ts") ? tsModule : jsModule,
      }),
    });
    expect(result).toBe(tsModule);
  });

  it("warns and returns null when file exists but has no default export", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await resolveModuleImport("steps/implement", {
        customRoot: "/workspace",
        existsSyncImpl: (p) => p.endsWith(".ts"),
        importFn: async () => ({ namedExport: {} }),
      });
      expect(result).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("has no default export"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("resolves path using customRoot for custom override lookup", async () => {
    const capturedPaths: string[] = [];
    await resolveModuleImport("steps/push", {
      customRoot: "/my/workspace",
      existsSyncImpl: (p) => {
        capturedPaths.push(p);
        return false;
      },
    });
    expect(capturedPaths.some((p) => p.replace(/\\/g, "/").includes("/my/workspace/custom/steps/push"))).toBe(true);
  });

  it("rethrows non-MODULE_NOT_FOUND import errors", async () => {
    await expect(
      resolveModuleImport("steps/broken", {
        customRoot: "/workspace",
        existsSyncImpl: (p) => p.endsWith(".ts"),
        importFn: async () => {
          const err = new Error("Syntax error in module");
          (err as NodeJS.ErrnoException).code = "ERR_INVALID_PACKAGE_CONFIG";
          throw err;
        },
      }),
    ).rejects.toThrow("Syntax error in module");
  });

  it("works for provider module paths", async () => {
    const fakeProvider = { createIssue: async () => ({}) };
    const result = await resolveModuleImport("providers/ticketing", {
      customRoot: "/workspace",
      existsSyncImpl: (p) => p.endsWith("ticketing.ts"),
      importFn: async () => ({ default: fakeProvider }),
    });
    expect(result).toBe(fakeProvider);
  });

  it("falls back to bakedRoot custom/ when workspace has no override", async () => {
    const bakedModule = { run: async () => ({}) };
    const result = await resolveModuleImport("steps/implement", {
      customRoot: "/workspace",
      bakedRoot: "/baked",
      existsSyncImpl: (p) => p.replace(/\\/g, "/") === "/baked/custom/steps/implement.ts",
      importFn: async () => ({ default: bakedModule }),
    });
    expect(result).toBe(bakedModule);
  });

  it("prefers a workspace override over a bakedRoot override", async () => {
    const workspaceModule = { run: async () => ({ source: "workspace" }) };
    const bakedModule = { run: async () => ({ source: "baked" }) };
    const result = await resolveModuleImport("steps/implement", {
      customRoot: "/workspace",
      bakedRoot: "/baked",
      existsSyncImpl: (p) => p.endsWith("implement.ts"),
      importFn: async (url) => ({
        default: url.includes("/workspace/") ? workspaceModule : bakedModule,
      }),
    });
    expect(result).toBe(workspaceModule);
  });

  it("reads the baked root from AI_IMPLEMENT_CUSTOM_ROOT when the option is not passed", async () => {
    vi.stubEnv("AI_IMPLEMENT_CUSTOM_ROOT", "/image");
    const bakedModule = { run: async () => ({}) };
    const result = await resolveModuleImport("steps/implement", {
      customRoot: "/workspace",
      existsSyncImpl: (p) => p.replace(/\\/g, "/") === "/image/custom/steps/implement.ts",
      importFn: async () => ({ default: bakedModule }),
    });
    expect(result).toBe(bakedModule);
  });

  it("checks only workspace custom paths when no baked root is configured", async () => {
    vi.stubEnv("AI_IMPLEMENT_CUSTOM_ROOT", "");
    const checkedPaths: string[] = [];
    const result = await resolveModuleImport("steps/push", {
      customRoot: "/workspace",
      existsSyncImpl: (p) => {
        checkedPaths.push(p.replace(/\\/g, "/"));
        return false;
      },
    });
    expect(checkedPaths).toEqual([
      "/workspace/custom/steps/push.ts",
      "/workspace/custom/steps/push.js",
      "/workspace/custom/steps/push.mjs",
    ]);
    expect(result).toBeNull();
  });

  it("falls through to the baked root when the workspace override has no default export", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const bakedModule = { run: async () => ({}) };
      const result = await resolveModuleImport("steps/implement", {
        customRoot: "/workspace",
        bakedRoot: "/baked",
        existsSyncImpl: (p) => p.endsWith("implement.ts"),
        importFn: async (url) =>
          url.includes("/workspace/") ? { namedExport: {} } : { default: bakedModule },
      });
      expect(result).toBe(bakedModule);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("has no default export"));
    } finally {
      warn.mockRestore();
    }
  });
});
