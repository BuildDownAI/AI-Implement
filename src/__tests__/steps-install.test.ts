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

type MockChildProcess = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };

function createMockChildProcess(): MockChildProcess {
  const proc = new EventEmitter() as MockChildProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

function mockSpawnSuccess() {
  vi.mocked(spawn).mockImplementation(() => {
    const proc = createMockChildProcess();
    setImmediate(() => proc.emit("close", 0));
    return proc as unknown as ReturnType<typeof spawn>;
  });
}

function mockSpawnExit(code: number, chunks: { stdout?: string[]; stderr?: string[] } = {}) {
  vi.mocked(spawn).mockImplementation(() => {
    const proc = createMockChildProcess();
    setImmediate(() => {
      for (const chunk of chunks.stdout ?? []) proc.stdout.emit("data", Buffer.from(chunk));
      for (const chunk of chunks.stderr ?? []) proc.stderr.emit("data", Buffer.from(chunk));
      proc.emit("close", code);
    });
    return proc as unknown as ReturnType<typeof spawn>;
  });
}

function mockSpawnError(message = "spawn npm ENOENT") {
  vi.mocked(spawn).mockImplementation(() => {
    const proc = createMockChildProcess();
    setImmediate(() => proc.emit("error", new Error(message)));
    return proc as unknown as ReturnType<typeof spawn>;
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
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawnSuccess();
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
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
    expect(outputs.installFailed).toBe(false);
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

  it("returns installFailed: false and no installError on a successful install", async () => {
    mockRootPackageJson();

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.installFailed).toBe(false);
    expect(outputs.installError).toBeUndefined();
  });

  it("resolves with installFailed: true (does not throw) when the install command exits non-zero, and still publishes every config output", async () => {
    mockRootPackageJson((p) => p.includes(".ai-implement/config.yml"));
    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        "packageManager: npm",
        "models:",
        "  implement: claude-opus-4-7",
        "  review: claude-haiku-4-5-20251001",
        "reviewProviders:",
        "  - github-claude-code-review",
        "reviewCheckNames:",
        "  - custom-check",
        "reviewers:",
        "  - id: my-reviewer",
        "    prompt: Check the thing",
        "",
      ].join("\n"),
    );
    mockSpawnExit(1);

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.installFailed).toBe(true);
    expect(outputs.repoModels).toEqual({ implement: "claude-opus-4-7", review: "claude-haiku-4-5-20251001" });
    expect(outputs.reviewProviders).toEqual(["github-claude-code-review"]);
    expect(outputs.reviewCheckNames).toEqual(["custom-check"]);
    expect((outputs.reviewers as Array<{ id: string }>).map((r) => r.id)).toEqual(["my-reviewer"]);
    expect(outputs.trustedConfigReviewers).toEqual([]);
    expect(outputs.installError).toContain("npm ci exited with code 1");
  });

  it("resolves with installFailed: true when the spawned process emits an error instead of closing", async () => {
    mockRootPackageJson();
    mockSpawnError("spawn npm ENOENT");

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.installFailed).toBe(true);
    expect(typeof outputs.installError).toBe("string");
  });

  it("captures the tail of the install output, not the head, and caps it at 4096 characters", async () => {
    mockRootPackageJson();
    const head = `HEAD-MARKER-${"H".repeat(4000)}`;
    const middle = "M".repeat(4000);
    const tail = `${"C".repeat(200)} ERESOLVE unable to resolve dependency tree`;
    mockSpawnExit(1, { stdout: [head, middle, tail] });

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.installFailed).toBe(true);
    const installError = outputs.installError as string;
    expect(installError).toContain("ERESOLVE");
    expect(installError).not.toContain("HEAD-MARKER");
    expect(installError.length).toBeLessThanOrEqual(4096);
  });

  it("redacts a secret env value from installError", async () => {
    mockRootPackageJson();
    vi.stubEnv("NPM_TOKEN", "super-secret-npm-token-value");
    mockSpawnExit(1, { stdout: ["installing with token super-secret-npm-token-value in the URL\n"] });

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.installFailed).toBe(true);
    expect(outputs.installError as string).not.toContain("super-secret-npm-token-value");
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
    expect(outputs.installFailed).toBe(false);
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

  it("skips the built-in install when packageManager is none and package.json exists", async () => {
    mockRootPackageJson((p) => p.includes(".ai-implement/config.yml"));
    vi.mocked(fs.readFileSync).mockReturnValue("packageManager: none\n");

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.packageManager).toBe("none");
    expect(outputs.installMethod).toBe("skipped: packageManager none");
    expect(outputs.installFailed).toBe(false);
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

  describe("retry mode", () => {
    it("uses the provided packageManager, never reads config.yml, and never calls fetchImpl", async () => {
      mockRootPackageJson();
      const fetchImpl = vi.fn();

      const outputs = await installStep.run(
        makeContext(),
        { workspaceDir: "/tmp/test", retry: true, packageManager: "yarn", fetchImpl },
        new NoopStepReporter(),
      );

      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(outputs.packageManager).toBe("yarn");
      expect(outputs.installMethod).toBe("yarn install --frozen-lockfile");
      expect(outputs.installFailed).toBe(false);
      expect(outputs).not.toHaveProperty("repoModels");
      expect(outputs).not.toHaveProperty("trustedConfigReviewers");
    });

    it("reports installFailed: true on a failed retry attempt", async () => {
      mockSpawnExit(1);

      const outputs = await installStep.run(
        makeContext(),
        { workspaceDir: "/tmp/test", retry: true, packageManager: "npm" },
        new NoopStepReporter(),
      );

      expect(outputs.installFailed).toBe(true);
      expect(typeof outputs.installError).toBe("string");
    });
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
      mockSpawnExit(1);

      const outputs = await installStep.run(
        makeContext(),
        { workspaceDir: "/tmp/test" },
        new NoopStepReporter(),
      );

      expect(outputs.installFailed).toBe(true);
      expect(outputs.installError as string).toContain("npm ci exited with code 1");
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
