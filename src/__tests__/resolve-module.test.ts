import { describe, it, expect, vi } from "vitest";
import { resolveModule, resolveModuleImport } from "../pipeline/resolve-module.js";

describe("resolveModule", () => {
  it("returns custom path when custom override exists", () => {
    const result = resolveModule("pipelines/autonomous.yml", {
      customRoot: "/workspace",
      builtinRoot: "/app",
      existsSyncImpl: (p) => p.includes("custom"),
    });
    expect(result).toContain("custom/pipelines/autonomous.yml");
  });

  it("returns builtin path when no custom override exists", () => {
    const result = resolveModule("pipelines/autonomous.yml", {
      customRoot: "/workspace",
      builtinRoot: "/app",
      existsSyncImpl: () => false,
    });
    expect(result).toBe("/app/pipelines/autonomous.yml");
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
    expect(capturedPaths.some((p) => p.includes("/my/workspace/custom/steps/push"))).toBe(true);
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
});
