import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { installStep } from "../pipeline/steps/install.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdtempSync: vi.fn(),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
  },
}));

import { spawn } from "node:child_process";
import fs from "node:fs";

function mockSpawnSuccess() {
  vi.mocked(spawn).mockImplementation(() => {
    const emitter = new EventEmitter() as ReturnType<typeof spawn>;
    setImmediate(() => emitter.emit("close", 0));
    return emitter;
  });
}

function makeContext(): DefaultPipelineContext {
  return new DefaultPipelineContext({
    jobId: 1,
    issueId: "issue-1",
    issueIdentifier: "ENG-1",
    issueTitle: "Test",
    issueDescription: "Desc",
    nonce: "nonce",
    orchestratorUrl: "http://localhost:8080",
  });
}

function mockRootPackageJson(extraMatches?: (p: string) => boolean) {
  vi.mocked(fs.existsSync).mockImplementation((p) => {
    const rawPath = String(p).replace(/\\/g, "/");
    return rawPath.endsWith("package.json") || extraMatches?.(rawPath) === true;
  });
}

describe("installStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawnSuccess();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not mutate dependencies in a mounted host workspace", async () => {
    vi.stubEnv("AI_IMPLEMENT_WORKSPACE_MODE", "mounted");
    mockRootPackageJson((p) => p.endsWith("package-lock.json"));

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.packageManager).toBe("npm");
    expect(outputs.installMethod).toBe("skipped: mounted workspace");
    expect(outputs.durationMs).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("detects npm when no lock files exist", async () => {
    mockRootPackageJson();

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.packageManager).toBe("npm");
    expect(outputs.installMethod).toBe("npm ci");
    expect(spawn).toHaveBeenCalledWith("npm", ["ci"], expect.anything());
  });

  it("detects yarn when yarn.lock exists", async () => {
    mockRootPackageJson((p) => p.endsWith("yarn.lock"));

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.packageManager).toBe("yarn");
    expect(outputs.installMethod).toBe("yarn install --frozen-lockfile");
  });

  it("detects pnpm when pnpm-lock.yaml exists", async () => {
    mockRootPackageJson((p) => p.endsWith("pnpm-lock.yaml"));

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.packageManager).toBe("pnpm");
    expect(outputs.installMethod).toBe("pnpm install --frozen-lockfile");
  });

  it("reads packageManager from .ai-implement/config.yml when present", async () => {
    mockRootPackageJson((p) => p.includes(".ai-implement/config.yml"));
    vi.mocked(fs.readFileSync).mockReturnValue("packageManager: pnpm\n");

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.packageManager).toBe("pnpm");
  });

  it("parses models.implement from .ai-implement/config.yml", async () => {
    mockRootPackageJson((p) => p.includes(".ai-implement/config.yml"));
    vi.mocked(fs.readFileSync).mockReturnValue(
      "models:\n  implement: claude-opus-4-7\n",
    );

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect((outputs.repoModels as { implement?: string }).implement).toBe("claude-opus-4-7");
  });

  it("parses models.review from .ai-implement/config.yml", async () => {
    mockRootPackageJson((p) => p.includes(".ai-implement/config.yml"));
    vi.mocked(fs.readFileSync).mockReturnValue(
      "models:\n  review: claude-haiku-4-5-20251001\n",
    );

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect((outputs.repoModels as { review?: string }).review).toBe("claude-haiku-4-5-20251001");
  });

  it("parses both models from .ai-implement/config.yml", async () => {
    mockRootPackageJson((p) => p.includes(".ai-implement/config.yml"));
    vi.mocked(fs.readFileSync).mockReturnValue(
      "packageManager: npm\nmodels:\n  implement: claude-opus-4-7\n  review: claude-haiku-4-5-20251001\n",
    );

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect((outputs.repoModels as { implement?: string; review?: string })).toEqual({
      implement: "claude-opus-4-7",
      review: "claude-haiku-4-5-20251001",
    });
    expect(outputs.packageManager).toBe("npm");
  });

  it("parses known reviewProviders from .ai-implement/config.yml", async () => {
    mockRootPackageJson((p) => p.includes(".ai-implement/config.yml"));
    vi.mocked(fs.readFileSync).mockReturnValue(
      "reviewProviders:\n  - github-claude-code-review\n",
    );

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.reviewProviders).toEqual(["github-claude-code-review"]);
  });

  it("ignores unknown reviewProviders from .ai-implement/config.yml", async () => {
    mockRootPackageJson((p) => p.includes(".ai-implement/config.yml"));
    vi.mocked(fs.readFileSync).mockReturnValue(
      "reviewProviders:\n  - unsupported-reviewer\n  - github-claude-code-review\n",
    );

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.reviewProviders).toEqual(["github-claude-code-review"]);
  });

  it("parses quoted reviewProviders with trailing comments from .ai-implement/config.yml", async () => {
    mockRootPackageJson((p) => p.includes(".ai-implement/config.yml"));
    vi.mocked(fs.readFileSync).mockReturnValue(
      "reviewProviders:\n  - \"github-claude-code-review\" # enabled by repo config\n  - 'github-claude-code-review'\n",
    );

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.reviewProviders).toEqual([
      "github-claude-code-review",
      "github-claude-code-review",
    ]);
  });

  it("parses inline reviewProviders arrays from .ai-implement/config.yml", async () => {
    mockRootPackageJson((p) => p.includes(".ai-implement/config.yml"));
    vi.mocked(fs.readFileSync).mockReturnValue(
      "reviewProviders: [\"github-claude-code-review\"]\n",
    );

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.reviewProviders).toEqual(["github-claude-code-review"]);
  });

  it("preserves explicit empty reviewProviders arrays from .ai-implement/config.yml", async () => {
    mockRootPackageJson((p) => p.includes(".ai-implement/config.yml"));
    vi.mocked(fs.readFileSync).mockReturnValue("reviewProviders: []\n");

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.reviewProviders).toEqual([]);
  });

  it("treats unknown-only reviewProviders as explicit empty config", async () => {
    mockRootPackageJson((p) => p.includes(".ai-implement/config.yml"));
    vi.mocked(fs.readFileSync).mockReturnValue(
      "reviewProviders:\n  - unsupported-reviewer\n",
    );

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.reviewProviders).toEqual([]);
  });

  it("treats malformed reviewProviders config as absent", async () => {
    mockRootPackageJson((p) => p.includes(".ai-implement/config.yml"));
    vi.mocked(fs.readFileSync).mockReturnValue("reviewProviders: github-claude-code-review\n");

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.reviewProviders).toBeUndefined();
  });

  it("returns empty repoModels when config.yml has no models section", async () => {
    mockRootPackageJson();

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.repoModels).toEqual({});
  });

  it("includes durationMs in outputs", async () => {
    mockRootPackageJson();

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(typeof outputs.durationMs).toBe("number");
    expect(outputs.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("throws when the install command exits with non-zero code", async () => {
    mockRootPackageJson();
    vi.mocked(spawn).mockImplementation(() => {
      const emitter = new EventEmitter() as ReturnType<typeof spawn>;
      setImmediate(() => emitter.emit("close", 1));
      return emitter;
    });

    await expect(
      installStep.run(makeContext(), { workspaceDir: "/tmp/test" }, new NoopStepReporter()),
    ).rejects.toThrow("exited with code 1");
  });

  it("skips install when the repo root has no package.json", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.packageManager).toBe("none");
    expect(outputs.installMethod).toBe("skipped: no package.json");
    expect(outputs.durationMs).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("preserves configured packageManager when skipping without package.json", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      String(p).replace(/\\/g, "/").includes(".ai-implement/config.yml"),
    );
    vi.mocked(fs.readFileSync).mockReturnValue("packageManager: pnpm\n");

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.packageManager).toBe("pnpm");
    expect(outputs.installMethod).toBe("skipped: no package.json");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not pass model credentials to the install command environment", async () => {
    mockRootPackageJson();
    vi.stubEnv("ANTHROPIC_API_KEY", "sentinel-api-key");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sentinel-oauth-token");

    await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(spawn).toHaveBeenCalledOnce();
    const spawnOptions = vi.mocked(spawn).mock.calls[0][2];
    expect(spawnOptions?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(spawnOptions?.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(spawnOptions?.env?.PATH).toBeDefined();
  });

  describe("npm auth from env", () => {
    const REGISTRY = "https://registry.example.test/artifactory/api/npm/npm/";
    const TMP_DIR = "/tmp/ai-implement-npmrc-abc123";
    const USERCONFIG = `${TMP_DIR}/.npmrc`;

    function spawnEnv(): NodeJS.ProcessEnv {
      const options = vi.mocked(spawn).mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
      return options?.env ?? {};
    }

    beforeEach(() => {
      vi.stubEnv("NPM_TOKEN", "");
      vi.stubEnv("AI_IMPLEMENT_NPM_REGISTRY", "");
      vi.stubEnv("AI_IMPLEMENT_NPM_SCOPE", "");
      vi.mocked(fs.mkdtempSync).mockReturnValue(TMP_DIR);
    });

    it("does nothing when neither token nor registry is set", async () => {
      mockRootPackageJson();

      await installStep.run(makeContext(), { workspaceDir: "/tmp/test" }, new NoopStepReporter());

      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(spawnEnv()).not.toHaveProperty("NPM_CONFIG_USERCONFIG");
    });

    it("does nothing when only the token is set", async () => {
      mockRootPackageJson();
      vi.stubEnv("NPM_TOKEN", "secret-token");

      await installStep.run(makeContext(), { workspaceDir: "/tmp/test" }, new NoopStepReporter());

      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(spawnEnv()).not.toHaveProperty("NPM_CONFIG_USERCONFIG");
    });

    it("writes an _authToken line to a temp user config when token + registry are set", async () => {
      mockRootPackageJson();
      vi.stubEnv("NPM_TOKEN", "secret-token");
      vi.stubEnv("AI_IMPLEMENT_NPM_REGISTRY", REGISTRY);

      await installStep.run(makeContext(), { workspaceDir: "/tmp/test" }, new NoopStepReporter());

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        USERCONFIG,
        "//registry.example.test/artifactory/api/npm/npm/:_authToken=secret-token\n",
        { mode: 0o600 },
      );
      expect(spawnEnv().NPM_CONFIG_USERCONFIG).toBe(USERCONFIG);
    });

    it("also writes scoped registry mappings when AI_IMPLEMENT_NPM_SCOPE is set", async () => {
      mockRootPackageJson();
      vi.stubEnv("NPM_TOKEN", "secret-token");
      vi.stubEnv("AI_IMPLEMENT_NPM_REGISTRY", REGISTRY);
      vi.stubEnv("AI_IMPLEMENT_NPM_SCOPE", "@cs, other");

      await installStep.run(makeContext(), { workspaceDir: "/tmp/test" }, new NoopStepReporter());

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        USERCONFIG,
        [
          "//registry.example.test/artifactory/api/npm/npm/:_authToken=secret-token",
          "@cs:registry=https://registry.example.test/artifactory/api/npm/npm/",
          "@other:registry=https://registry.example.test/artifactory/api/npm/npm/",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
    });

    it("carries an existing ~/.npmrc forward instead of shadowing it", async () => {
      mockRootPackageJson((p) => p.endsWith("/.npmrc"));
      vi.mocked(fs.readFileSync).mockReturnValue("always-auth=true");
      vi.stubEnv("NPM_TOKEN", "secret-token");
      vi.stubEnv("AI_IMPLEMENT_NPM_REGISTRY", REGISTRY);

      await installStep.run(makeContext(), { workspaceDir: "/tmp/test" }, new NoopStepReporter());

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        USERCONFIG,
        "always-auth=true\n//registry.example.test/artifactory/api/npm/npm/:_authToken=secret-token\n",
        { mode: 0o600 },
      );
    });

    it("removes the temp user config after install, including when install fails", async () => {
      mockRootPackageJson();
      vi.stubEnv("NPM_TOKEN", "secret-token");
      vi.stubEnv("AI_IMPLEMENT_NPM_REGISTRY", REGISTRY);
      vi.mocked(spawn).mockImplementation(() => {
        const emitter = new EventEmitter() as ReturnType<typeof spawn>;
        setImmediate(() => emitter.emit("close", 1));
        return emitter;
      });

      await expect(
        installStep.run(makeContext(), { workspaceDir: "/tmp/test" }, new NoopStepReporter()),
      ).rejects.toThrow("npm ci exited with code 1");

      expect(fs.rmSync).toHaveBeenCalledWith(TMP_DIR, { recursive: true, force: true });
    });

    it("never writes the token to ~/.npmrc", async () => {
      mockRootPackageJson();
      vi.stubEnv("NPM_TOKEN", "secret-token");
      vi.stubEnv("AI_IMPLEMENT_NPM_REGISTRY", REGISTRY);

      await installStep.run(makeContext(), { workspaceDir: "/tmp/test" }, new NoopStepReporter());

      const writtenPaths = vi.mocked(fs.writeFileSync).mock.calls.map((c) => String(c[0]));
      expect(writtenPaths).toEqual([USERCONFIG]);
      expect(writtenPaths.some((p) => p.endsWith("/.npmrc") && !p.startsWith(TMP_DIR))).toBe(false);
    });

    it("skips configuring npm auth when there is no package.json to install", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.stubEnv("NPM_TOKEN", "secret-token");
      vi.stubEnv("AI_IMPLEMENT_NPM_REGISTRY", REGISTRY);

      await installStep.run(makeContext(), { workspaceDir: "/tmp/test" }, new NoopStepReporter());

      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });
});
