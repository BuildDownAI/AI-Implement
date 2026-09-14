import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveReviewer,
  type ReviewerDefinition,
} from "../pipeline/reviewers/registry.js";

function makeReviewer(id: string): ReviewerDefinition {
  return {
    id,
    buildPrompt: () => `prompt for ${id}`,
    outputSchema: { type: "object" },
  };
}

// resolveReviewer falls through to AI_IMPLEMENT_CUSTOM_ROOT for the baked root
// when options.bakedRoot is not passed. Pin it to empty so a real runner
// environment's env var can't add a second search root and change the number
// of resolveModuleImport warnings a test counts; tests that exercise the
// baked root pass bakedRoot explicitly, which takes precedence over the env var.
beforeEach(() => {
  vi.stubEnv("AI_IMPLEMENT_CUSTOM_ROOT", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveReviewer", () => {
  it("returns a registered built-in when no custom override exists", async () => {
    const builtin = makeReviewer("known-reviewer");
    const result = await resolveReviewer("known-reviewer", {
      customRoot: "/workspace",
      existsSyncImpl: () => false,
      builtins: { "known-reviewer": builtin },
    });
    expect(result).toBe(builtin);
  });

  it("a custom/reviewers/<id>.ts default export replaces the built-in of the same id", async () => {
    const builtin = makeReviewer("shadowed");
    const custom = makeReviewer("shadowed");
    const result = await resolveReviewer("shadowed", {
      customRoot: "/workspace",
      existsSyncImpl: (p) => p.endsWith("reviewers/shadowed.ts"),
      importFn: async () => ({ default: custom }),
      builtins: { shadowed: builtin },
    });
    expect(result).toBe(custom);
    expect(result).not.toBe(builtin);
  });

  it("falls back to the built-in, warning once, when a custom override has no default export", async () => {
    const builtin = makeReviewer("no-default-export");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await resolveReviewer("no-default-export", {
        customRoot: "/workspace",
        existsSyncImpl: (p) => p.endsWith(".ts"),
        importFn: async () => ({ namedExport: {} }),
        builtins: { "no-default-export": builtin },
      });
      expect(result).toBe(builtin);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("no default export"));
    } finally {
      warn.mockRestore();
    }
  });

  it("returns undefined and logs once, without throwing, for an unknown id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await resolveReviewer("totally-unknown", {
        customRoot: "/workspace",
        existsSyncImpl: () => false,
      });
      expect(result).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("totally-unknown"));
    } finally {
      warn.mockRestore();
    }
  });

  it("does not resolve inherited object properties as built-in reviewer ids", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await resolveReviewer("toString", {
        customRoot: "/workspace",
        existsSyncImpl: () => false,
      });
      expect(result).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("toString"));
    } finally {
      warn.mockRestore();
    }
  });

  it("does not throw when a custom override has no default export and no built-in exists", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        resolveReviewer("orphaned-override", {
          customRoot: "/workspace",
          existsSyncImpl: (p) => p.endsWith(".ts"),
          importFn: async () => ({ namedExport: {} }),
        }),
      ).resolves.toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("prefers the workspace custom root over the baked root", async () => {
    const workspaceReviewer = makeReviewer("shared-id");
    const bakedReviewer = makeReviewer("shared-id");
    const result = await resolveReviewer("shared-id", {
      customRoot: "/workspace",
      bakedRoot: "/baked",
      existsSyncImpl: () => true,
      importFn: async (url) => ({
        default: url.includes("/workspace/") ? workspaceReviewer : bakedReviewer,
      }),
    });
    expect(result).toBe(workspaceReviewer);
    expect(result).not.toBe(bakedReviewer);
  });

  it("prefers .ts over .js when both exist for the same id", async () => {
    const tsReviewer = makeReviewer("dual-ext");
    const jsReviewer = makeReviewer("dual-ext");
    const result = await resolveReviewer("dual-ext", {
      customRoot: "/workspace",
      existsSyncImpl: (p) => p.endsWith(".ts") || p.endsWith(".js"),
      importFn: async (url) => ({
        default: url.includes(".ts") ? tsReviewer : jsReviewer,
      }),
    });
    expect(result).toBe(tsReviewer);
  });

  it("checks the workspace root before the baked root, matching resolveModuleImport's order", async () => {
    const checkedPaths: string[] = [];
    await resolveReviewer("order-check", {
      customRoot: "/workspace",
      bakedRoot: "/baked",
      existsSyncImpl: (p) => {
        checkedPaths.push(p.replace(/\\/g, "/"));
        return false;
      },
    });
    const workspaceIndex = checkedPaths.findIndex((p) => p.startsWith("/workspace/"));
    const bakedIndex = checkedPaths.findIndex((p) => p.startsWith("/baked/"));
    expect(workspaceIndex).toBeGreaterThanOrEqual(0);
    expect(bakedIndex).toBeGreaterThanOrEqual(0);
    expect(workspaceIndex).toBeLessThan(bakedIndex);
  });

  it("resolves an arbitrary id to undefined when the built-in registry is empty (no hidden defaults)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await resolveReviewer("anything", {
        customRoot: "/workspace",
        existsSyncImpl: () => false,
      });
      expect(result).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("has no gates field on the ReviewerDefinition shape", () => {
    const reviewer: ReviewerDefinition = makeReviewer("shape-check");
    expect(Object.keys(reviewer).sort()).toEqual(["buildPrompt", "id", "outputSchema"]);
    expect("gates" in reviewer).toBe(false);
  });
});
