import { describe, expect, it, vi } from "vitest";
import { encodeRunConfig } from "../run-config.js";
import { resolveRunnerInputs } from "../run-autonomous.js";

const BASE_ENV = {
  GITHUB_OWNER: "o",
  GITHUB_REPO: "r",
  GITHUB_TOKEN: "t",
};

describe("resolveRunnerInputs", () => {
  describe("(a) envelope wins over flat env", () => {
    it("prefers envelope over flat env", () => {
      const env = {
        AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig({
          v: 1,
          issue: { id: "e", identifier: "AII-9", title: "env", description: "d" },
          maxTurns: 7,
        }),
        ISSUE_ID: "flat",
        ISSUE_IDENTIFIER: "FLAT-1",
        ISSUE_TITLE: "flat",
        ISSUE_DESCRIPTION: "flat",
        AI_IMPLEMENT_MAX_TURNS: "99",
        ...BASE_ENV,
      };
      const inputs = resolveRunnerInputs(env as NodeJS.ProcessEnv);
      expect(inputs.issueIdentifier).toBe("AII-9");
      expect(inputs.maxTurns).toBe(7);
    });

    it("maps all envelope fields correctly", () => {
      const env = {
        AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig({
          v: 1,
          issue: { id: "eid", identifier: "AII-9", title: "etitle", description: "edesc" },
          prNumber: "55",
          maxTurns: 10,
          maxIterations: 2,
          branchPrefix: "pr",
          skillsRepo: "org/skills",
          runnerCallbackUrl: "https://orch.example/callback",
          commentInstruction: "do the thing",
          runnerPhase: "gap-analysis",
        }),
        ...BASE_ENV,
      };
      const inputs = resolveRunnerInputs(env as NodeJS.ProcessEnv);
      expect(inputs.issueId).toBe("eid");
      expect(inputs.issueIdentifier).toBe("AII-9");
      expect(inputs.issueTitle).toBe("etitle");
      expect(inputs.issueDescription).toBe("edesc");
      expect(inputs.prNumber).toBe("55");
      expect(inputs.maxTurns).toBe(10);
      expect(inputs.maxIterations).toBe(2);
      expect(inputs.branchPrefix).toBe("pr");
      expect(inputs.skillsRepo).toBe("org/skills");
      expect(inputs.callbackUrl).toBe("https://orch.example/callback");
      expect(inputs.commentInstruction).toBe("do the thing");
      expect(inputs.runnerPhase).toBe("gap-analysis");
    });
  });

  describe("(b) flat-env fallback when envelope is absent", () => {
    it("maps all flat vars correctly", () => {
      const env = {
        ISSUE_ID: "issue-123",
        ISSUE_IDENTIFIER: "AII-1",
        ISSUE_TITLE: "My Issue",
        ISSUE_DESCRIPTION: "Some description",
        PR_NUMBER: "42",
        AI_IMPLEMENT_COMMENT_INSTRUCTION: "fix it",
        RUNNER_PHASE: "gap-analysis",
        RUNNER_CALLBACK_URL: "https://orch.example/runner",
        AI_IMPLEMENT_MAX_TURNS: "25",
        AI_IMPLEMENT_MAX_ITERATIONS: "2",
        AI_IMPLEMENT_BRANCH_PREFIX: "pr",
        AI_IMPLEMENT_SKILLS_REPO: "org/skills",
        AI_IMPLEMENT_PROFILES: "profile-a, profile-b",
        ...BASE_ENV,
      };
      const inputs = resolveRunnerInputs(env as NodeJS.ProcessEnv);
      expect(inputs.issueId).toBe("issue-123");
      expect(inputs.issueIdentifier).toBe("AII-1");
      expect(inputs.issueTitle).toBe("My Issue");
      expect(inputs.issueDescription).toBe("Some description");
      expect(inputs.prNumber).toBe("42");
      expect(inputs.commentInstruction).toBe("fix it");
      expect(inputs.runnerPhase).toBe("gap-analysis");
      expect(inputs.callbackUrl).toBe("https://orch.example/runner");
      expect(inputs.maxTurns).toBe(25);
      expect(inputs.maxIterations).toBe(2);
      expect(inputs.branchPrefix).toBe("pr");
      expect(inputs.skillsRepo).toBe("org/skills");
      expect(inputs.profiles).toEqual(["profile-a", "profile-b"]);
    });

    it("returns undefined maxTurns and warns on invalid AI_IMPLEMENT_MAX_TURNS", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const env = {
        ISSUE_ID: "i", ISSUE_IDENTIFIER: "AII-1", ISSUE_TITLE: "t", ISSUE_DESCRIPTION: "d",
        AI_IMPLEMENT_MAX_TURNS: "abc",
        ...BASE_ENV,
      };
      const inputs = resolveRunnerInputs(env as NodeJS.ProcessEnv);
      expect(inputs.maxTurns).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/AI_IMPLEMENT_MAX_TURNS/));
      warnSpy.mockRestore();
    });

    it("returns undefined branchPrefix and warns on invalid AI_IMPLEMENT_BRANCH_PREFIX", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const env = {
        ISSUE_ID: "i", ISSUE_IDENTIFIER: "AII-1", ISSUE_TITLE: "t", ISSUE_DESCRIPTION: "d",
        AI_IMPLEMENT_BRANCH_PREFIX: "bad..prefix",
        ...BASE_ENV,
      };
      const inputs = resolveRunnerInputs(env as NodeJS.ProcessEnv);
      expect(inputs.branchPrefix).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/AI_IMPLEMENT_BRANCH_PREFIX/));
      warnSpy.mockRestore();
    });

    it("splits AI_IMPLEMENT_PROFILES by comma, trims, and drops empties", () => {
      const env = {
        ISSUE_ID: "i", ISSUE_IDENTIFIER: "AII-1", ISSUE_TITLE: "t", ISSUE_DESCRIPTION: "d",
        AI_IMPLEMENT_PROFILES: "a,,b",
        ...BASE_ENV,
      };
      const inputs = resolveRunnerInputs(env as NodeJS.ProcessEnv);
      expect(inputs.profiles).toEqual(["a", "b"]);
    });

    it("returns empty profiles when AI_IMPLEMENT_PROFILES is absent", () => {
      const env = {
        ISSUE_ID: "i", ISSUE_IDENTIFIER: "AII-1", ISSUE_TITLE: "t", ISSUE_DESCRIPTION: "d",
        ...BASE_ENV,
      };
      const inputs = resolveRunnerInputs(env as NodeJS.ProcessEnv);
      expect(inputs.profiles).toEqual([]);
    });

    it("throws when GITHUB_TOKEN is missing", () => {
      const env = {
        ISSUE_ID: "i", ISSUE_IDENTIFIER: "AII-1", ISSUE_TITLE: "t", ISSUE_DESCRIPTION: "d",
        GITHUB_OWNER: "o", GITHUB_REPO: "r",
      };
      expect(() => resolveRunnerInputs(env as NodeJS.ProcessEnv)).toThrow(/GITHUB_TOKEN/);
    });
  });

  describe("(c) malformed envelope throws", () => {
    it("throws on malformed AI_IMPLEMENT_RUN_CONFIG", () => {
      expect(() =>
        resolveRunnerInputs({ AI_IMPLEMENT_RUN_CONFIG: "not-valid-base64-json", ...BASE_ENV } as NodeJS.ProcessEnv)
      ).toThrow(/run_config/i);
    });
  });

  describe("(d) platform vars always come from env", () => {
    it("reads platform vars from env when envelope is set", () => {
      const env = {
        AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig({
          v: 1,
          issue: { id: "e", identifier: "AII-9", title: "env", description: "d" },
        }),
        ...BASE_ENV,
        PROVIDER: "bedrock",
        CLAUDE_MODEL: "my-model",
        AI_IMPLEMENT_LOG_LEVEL: "stream",
        RUN_PROGRESS_TOKEN: "tok",
      };
      const inputs = resolveRunnerInputs(env as NodeJS.ProcessEnv);
      expect(inputs.githubOwner).toBe("o");
      expect(inputs.githubRepo).toBe("r");
      expect(inputs.githubToken).toBe("t");
      expect(inputs.provider).toBe("bedrock");
      expect(inputs.claudeModel).toBe("my-model");
      expect(inputs.logLevel).toBe("stream");
      expect(inputs.progressToken).toBe("tok");
    });

    it("reads platform vars from env in flat-env mode", () => {
      const env = {
        ISSUE_ID: "i", ISSUE_IDENTIFIER: "AII-1", ISSUE_TITLE: "t", ISSUE_DESCRIPTION: "d",
        ...BASE_ENV,
        PROVIDER: "bedrock",
        CLAUDE_MODEL: "model-x",
        AI_IMPLEMENT_LOG_LEVEL: "stream",
        RUN_PROGRESS_TOKEN: "token-y",
      };
      const inputs = resolveRunnerInputs(env as NodeJS.ProcessEnv);
      expect(inputs.githubOwner).toBe("o");
      expect(inputs.githubRepo).toBe("r");
      expect(inputs.githubToken).toBe("t");
      expect(inputs.provider).toBe("bedrock");
      expect(inputs.claudeModel).toBe("model-x");
      expect(inputs.logLevel).toBe("stream");
      expect(inputs.progressToken).toBe("token-y");
    });
  });

  describe("(e) envelope caps/branchPrefix are validated like flat env", () => {
    it("ignores a non-positive-integer maxTurns/maxIterations from the envelope and warns", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const env = {
        AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig({
          v: 1,
          issue: { id: "e", identifier: "AII-9", title: "t", description: "d" },
          maxTurns: 0,
          maxIterations: -3,
        }),
        ...BASE_ENV,
      };
      const inputs = resolveRunnerInputs(env as NodeJS.ProcessEnv);
      expect(inputs.maxTurns).toBeUndefined();
      expect(inputs.maxIterations).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/run_config\.maxTurns/));
      warnSpy.mockRestore();
    });

    it("ignores an invalid branchPrefix from the envelope and warns", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const env = {
        AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig({
          v: 1,
          issue: { id: "e", identifier: "AII-9", title: "t", description: "d" },
          branchPrefix: "bad..prefix",
        }),
        ...BASE_ENV,
      };
      const inputs = resolveRunnerInputs(env as NodeJS.ProcessEnv);
      expect(inputs.branchPrefix).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/branch prefix/));
      warnSpy.mockRestore();
    });

    it("accepts valid caps and branchPrefix from the envelope", () => {
      const env = {
        AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig({
          v: 1,
          issue: { id: "e", identifier: "AII-9", title: "t", description: "d" },
          maxTurns: 12,
          maxIterations: 3,
          branchPrefix: "pr",
        }),
        ...BASE_ENV,
      };
      const inputs = resolveRunnerInputs(env as NodeJS.ProcessEnv);
      expect(inputs.maxTurns).toBe(12);
      expect(inputs.maxIterations).toBe(3);
      expect(inputs.branchPrefix).toBe("pr");
    });
  });

  describe("(f) sensitiveFiles threading", () => {
    it("(a) allow-list in envelope maps to sensitiveFiles.allow", () => {
      const env = {
        AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig({
          v: 1,
          issue: { id: "e", identifier: "AII-9", title: "t", description: "d" },
          sensitiveFiles: { allow: [".env", ".env.*"] },
        }),
        ...BASE_ENV,
      };
      const inputs = resolveRunnerInputs(env as NodeJS.ProcessEnv);
      expect(inputs.sensitiveFiles).toEqual({ allow: [".env", ".env.*"] });
    });

    it("(a) add-patterns in envelope maps to sensitiveFiles.add", () => {
      const env = {
        AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig({
          v: 1,
          issue: { id: "e", identifier: "AII-9", title: "t", description: "d" },
          sensitiveFiles: { add: ["*.secret"] },
        }),
        ...BASE_ENV,
      };
      const inputs = resolveRunnerInputs(env as NodeJS.ProcessEnv);
      expect(inputs.sensitiveFiles).toEqual({ add: ["*.secret"] });
    });

    it("(a) both lists in envelope map to sensitiveFiles", () => {
      const env = {
        AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig({
          v: 1,
          issue: { id: "e", identifier: "AII-9", title: "t", description: "d" },
          sensitiveFiles: { add: ["*.secret"], allow: [".env"] },
        }),
        ...BASE_ENV,
      };
      const inputs = resolveRunnerInputs(env as NodeJS.ProcessEnv);
      expect(inputs.sensitiveFiles).toEqual({ add: ["*.secret"], allow: [".env"] });
    });

    it("(b) absent sensitiveFiles in envelope → undefined", () => {
      const env = {
        AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig({
          v: 1,
          issue: { id: "e", identifier: "AII-9", title: "t", description: "d" },
        }),
        ...BASE_ENV,
      };
      const inputs = resolveRunnerInputs(env as NodeJS.ProcessEnv);
      expect(inputs.sensitiveFiles).toBeUndefined();
    });

    it("(b) legacy-env mode always returns sensitiveFiles as undefined", () => {
      const env = {
        ISSUE_ID: "i", ISSUE_IDENTIFIER: "AII-1", ISSUE_TITLE: "t", ISSUE_DESCRIPTION: "d",
        ...BASE_ENV,
      };
      const inputs = resolveRunnerInputs(env as NodeJS.ProcessEnv);
      expect(inputs.sensitiveFiles).toBeUndefined();
    });
  });
});
