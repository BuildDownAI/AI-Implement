import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveReviewer,
  resolveTrustedReviewer,
  trustedReviewerRoot,
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


describe("resolveTrustedReviewer", () => {
  it("derives the package root used as the image-baked reviewer root", () => {
    expect(existsSync(join(trustedReviewerRoot(), "package.json"))).toBe(true);
  });

  it("searches only the trusted package root for custom reviewer code", async () => {
    const checkedPaths: string[] = [];
    const trusted = makeReviewer("trusted-only");
    const workspace = makeReviewer("trusted-only");

    const result = await resolveTrustedReviewer("trusted-only", {
      trustedRoot: "/trusted-package",
      existsSyncImpl: (p) => {
        const normalized = p.replace(/\\/g, "/");
        checkedPaths.push(normalized);
        if (normalized.startsWith("/workspace/")) return true;
        return normalized === "/trusted-package/custom/reviewers/trusted-only.ts";
      },
      importFn: async (url) => ({
        default: url.includes("/trusted-package/") ? trusted : workspace,
      }),
    });

    expect(result).toBe(trusted);
    expect(result).not.toBe(workspace);
    expect(checkedPaths.length).toBeGreaterThan(0);
    expect(checkedPaths.every((p) => p.startsWith("/trusted-package/"))).toBe(true);
  });

  it("keeps trusted image-baked custom reviewers ahead of built-ins", async () => {
    const builtin = makeReviewer("shadowed");
    const custom = makeReviewer("shadowed");

    const result = await resolveTrustedReviewer("shadowed", {
      trustedRoot: "/runner",
      existsSyncImpl: (p) => p.replace(/\\/g, "/") === "/runner/custom/reviewers/shadowed.ts",
      importFn: async () => ({ default: custom }),
      builtins: { shadowed: builtin },
    });

    expect(result).toBe(custom);
  });

  it("rejects traversal ids before probing the filesystem or importer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const id of ["../evil", "nested/evil", "nested\\evil", "/abs/evil", ".", ".."]) {
        const existsSyncImpl = vi.fn(() => true);
        const importFn = vi.fn(async () => ({ default: makeReviewer(id) }));
        await expect(
          resolveTrustedReviewer(id, { trustedRoot: "/trusted-package", existsSyncImpl, importFn }),
        ).resolves.toBeUndefined();
        expect(existsSyncImpl).not.toHaveBeenCalled();
        expect(importFn).not.toHaveBeenCalled();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("never falls through to AI_IMPLEMENT_CUSTOM_ROOT", async () => {
    vi.stubEnv("AI_IMPLEMENT_CUSTOM_ROOT", "/env-baked-root");
    const checkedPaths: string[] = [];

    await resolveTrustedReviewer("missing", {
      trustedRoot: "/trusted-package",
      existsSyncImpl: (p) => {
        checkedPaths.push(p.replace(/\\/g, "/"));
        return false;
      },
      builtins: {},
    });

    expect(checkedPaths.every((p) => p.startsWith("/trusted-package/"))).toBe(true);
    expect(checkedPaths.some((p) => p.startsWith("/env-baked-root/"))).toBe(false);
  });

  it("can suppress trusted missing-id warnings for config probes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(resolveTrustedReviewer("missing", { trustedRoot: "/trusted-package", existsSyncImpl: () => false, builtins: {}, quietMissing: true })).resolves.toBeUndefined();
      await expect(resolveTrustedReviewer("../evil", { trustedRoot: "/trusted-package", existsSyncImpl: () => true, quietMissing: true })).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
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

  it("resolves an arbitrary id to undefined when no built-in or custom reviewer matches", async () => {
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
