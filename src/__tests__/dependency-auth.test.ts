import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dependencyAuthStep, fetchDependencyToken } from "../pipeline/steps/dependency-auth.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import type { LLMExecutor } from "../pipeline/types.js";
import { encodeRunConfig } from "../run-config.js";
import { resolveRunnerInputs } from "../run-autonomous.js";
import { loadPipelineDefinition } from "../pipeline/pipeline-loader.js";
import { createDefaultRunner } from "../pipeline/default-pipeline.js";
import type { PipelineRunner } from "../pipeline/runner.js";
import type { StepModule } from "../pipeline/types.js";

const noopExec: LLMExecutor = {
  async invoke() {
    return { stdout: "", exitCode: 0, tokensUsed: 0 };
  },
};

function ctx() {
  return new DefaultPipelineContext(
    {
      jobId: 1,
      issueId: "i",
      issueIdentifier: "AII-1",
      issueTitle: "T",
      issueDescription: "D",
      nonce: "n",
      orchestratorUrl: "",
    },
    noopExec,
  );
}

function mockFetch(status: number, body: unknown): typeof fetch {
  return async (_url, _init) => {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  };
}

function throwingFetch(err: Error): typeof fetch {
  return async (_url, _init) => {
    throw err;
  };
}

function registeredModule(runner: PipelineRunner, key: string): StepModule | undefined {
  return (runner as unknown as { modules: Map<string, StepModule> }).modules.get(key);
}

const BASE_ENV = {
  GITHUB_OWNER: "o",
  GITHUB_REPO: "r",
  GITHUB_TOKEN: "t",
};

beforeEach(() => {
  vi.stubEnv("GITHUB_ACTIONS", "");
  vi.stubEnv("RUN_PROGRESS_TOKEN", "tok");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── (1) Envelope → ResolvedRunnerInputs → PipelineContextData ───────────────

describe("dependencyTokenScope threading", () => {
  it("flows from run_config envelope into ResolvedRunnerInputs", () => {
    const env = {
      AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig({
        v: 1,
        issue: { id: "e", identifier: "AII-9", title: "t", description: "d" },
        dependencyTokenScope: "installation",
      }),
      ...BASE_ENV,
    };
    const inputs = resolveRunnerInputs(env as NodeJS.ProcessEnv);
    expect(inputs.dependencyTokenScope).toBe("installation");
  });

  it("is undefined in legacy-env mode", () => {
    const env = {
      ISSUE_ID: "i",
      ISSUE_IDENTIFIER: "AII-1",
      ISSUE_TITLE: "t",
      ISSUE_DESCRIPTION: "d",
      ...BASE_ENV,
    };
    const inputs = resolveRunnerInputs(env as NodeJS.ProcessEnv);
    expect(inputs.dependencyTokenScope).toBeUndefined();
  });

  it("is absent when envelope omits the field", () => {
    const env = {
      AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig({
        v: 1,
        issue: { id: "e", identifier: "AII-9", title: "t", description: "d" },
      }),
      ...BASE_ENV,
    };
    const inputs = resolveRunnerInputs(env as NodeJS.ProcessEnv);
    expect(inputs.dependencyTokenScope).toBeUndefined();
  });
});

// ─── (2) No-op conditions ─────────────────────────────────────────────────────

describe("dependencyAuthStep no-op conditions", () => {
  it("no-ops when dependencyTokenScope is absent", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = await dependencyAuthStep.run(
      ctx(),
      {
        dependencyTokenScope: undefined,
        callbackUrl: "https://orch.example",
      },
      new NoopStepReporter(),
    );
    logSpy.mockRestore();
    expect(out.acquired).toBe(false);
    expect(out.expiresAt).toBeNull();
  });

  it("no-ops when callbackUrl is absent", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = await dependencyAuthStep.run(
      ctx(),
      {
        dependencyTokenScope: "installation",
        callbackUrl: null,
      },
      new NoopStepReporter(),
    );
    logSpy.mockRestore();
    expect(out.acquired).toBe(false);
    expect(out.expiresAt).toBeNull();
  });

  it("no-ops when RUN_PROGRESS_TOKEN is absent", async () => {
    vi.stubEnv("RUN_PROGRESS_TOKEN", "");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = await dependencyAuthStep.run(
      ctx(),
      {
        dependencyTokenScope: "installation",
        callbackUrl: "https://orch.example",
      },
      new NoopStepReporter(),
    );
    logSpy.mockRestore();
    expect(out.acquired).toBe(false);
    expect(out.expiresAt).toBeNull();
  });
});

// ─── (3) Successful token fetch ───────────────────────────────────────────────

describe("dependencyAuthStep successful fetch", () => {
  it("POSTs to <callbackBase>/api/runner/dependency-token with bearer header", async () => {
    vi.stubEnv("RUN_PROGRESS_TOKEN", "progress-tok");
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const captureFetch: typeof fetch = async (url, init) => {
      calls.push({ url: url as string, init: init ?? {} });
      return { ok: true, status: 200, json: async () => ({ token: "dep-tok", expires_at: "2030-01-01T00:00:00Z" }) } as Response;
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await dependencyAuthStep.run(
      ctx(),
      {
        dependencyTokenScope: "installation",
        callbackUrl: "https://orch.example/",
        fetchImpl: captureFetch,
      },
      new NoopStepReporter(),
    );
    logSpy.mockRestore();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://orch.example/api/runner/dependency-token");
    expect((calls[0].init.headers as Record<string, string>)["Authorization"]).toBe("Bearer progress-tok");
  });

  it("sets token on context.data and returns acquired=true with expiresAt", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const context = ctx();
    const out = await dependencyAuthStep.run(
      context,
      {
        dependencyTokenScope: "installation",
        callbackUrl: "https://orch.example",
        fetchImpl: mockFetch(200, { token: "dep-tok-123", expires_at: "2030-06-01T12:00:00Z" }),
      },
      new NoopStepReporter(),
    );
    logSpy.mockRestore();
    expect(out.acquired).toBe(true);
    expect(out.expiresAt).toBe("2030-06-01T12:00:00Z");
    expect(context.data.dependencyToken).toBe("dep-tok-123");
    expect(context.data.dependencyTokenExpiresAt).toBe("2030-06-01T12:00:00Z");
  });
});

// ─── (4) Failure is non-fatal ─────────────────────────────────────────────────

describe("dependencyAuthStep failure handling", () => {
  it("warns and returns acquired=false on non-200 response", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await dependencyAuthStep.run(
      ctx(),
      {
        dependencyTokenScope: "installation",
        callbackUrl: "https://orch.example",
        fetchImpl: mockFetch(403, {}),
      },
      new NoopStepReporter(),
    );
    const warnings = warnSpy.mock.calls.map((c) => c.join(" "));
    warnSpy.mockRestore();
    expect(out.acquired).toBe(false);
    expect(out.expiresAt).toBeNull();
    expect(warnings.some((w) => /dependency-auth.*failed.*token/i.test(w))).toBe(true);
  });

  it("warns and returns acquired=false on malformed JSON body", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await dependencyAuthStep.run(
      ctx(),
      {
        dependencyTokenScope: "installation",
        callbackUrl: "https://orch.example",
        fetchImpl: mockFetch(200, { not_a_token: true }),
      },
      new NoopStepReporter(),
    );
    const warnings = warnSpy.mock.calls.map((c) => c.join(" "));
    warnSpy.mockRestore();
    expect(out.acquired).toBe(false);
    expect(warnings.some((w) => /dependency-auth.*failed.*token/i.test(w))).toBe(true);
  });

  it("warns and returns acquired=false on thrown network error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await dependencyAuthStep.run(
      ctx(),
      {
        dependencyTokenScope: "installation",
        callbackUrl: "https://orch.example",
        fetchImpl: throwingFetch(new Error("ECONNREFUSED")),
      },
      new NoopStepReporter(),
    );
    const warnings = warnSpy.mock.calls.map((c) => c.join(" "));
    warnSpy.mockRestore();
    expect(out.acquired).toBe(false);
    expect(warnings.some((w) => /dependency-auth.*failed.*token/i.test(w))).toBe(true);
  });
});

// ─── (5) GitHub Actions masking ───────────────────────────────────────────────

describe("dependencyAuthStep GitHub Actions masking", () => {
  it("emits ::add-mask:: when GITHUB_ACTIONS=true", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await dependencyAuthStep.run(
      ctx(),
      {
        dependencyTokenScope: "installation",
        callbackUrl: "https://orch.example",
        fetchImpl: mockFetch(200, { token: "secret-dep-tok", expires_at: "2030-01-01T00:00:00Z" }),
      },
      new NoopStepReporter(),
    );
    const maskCalls = logSpy.mock.calls.map((c) => c.join(" "));
    logSpy.mockRestore();
    expect(maskCalls.some((c) => c.includes("::add-mask::secret-dep-tok"))).toBe(true);
  });

  it("does not emit ::add-mask:: when GITHUB_ACTIONS is absent", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await dependencyAuthStep.run(
      ctx(),
      {
        dependencyTokenScope: "installation",
        callbackUrl: "https://orch.example",
        fetchImpl: mockFetch(200, { token: "secret-dep-tok", expires_at: "2030-01-01T00:00:00Z" }),
      },
      new NoopStepReporter(),
    );
    const maskCalls = logSpy.mock.calls.map((c) => c.join(" "));
    logSpy.mockRestore();
    expect(maskCalls.some((c) => c.includes("::add-mask::"))).toBe(false);
  });
});

// ─── (6) Pipeline YAML position ───────────────────────────────────────────────

describe("autonomous.yml step ordering", () => {
  it("runs dependency-auth after clone and before install", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml");
    const ids = pipeline.steps.map((s) => s.id);
    const cloneIdx = ids.indexOf("clone");
    const depAuthIdx = ids.indexOf("dependency-auth");
    const installIdx = ids.indexOf("install");
    expect(depAuthIdx).toBeGreaterThan(cloneIdx);
    expect(depAuthIdx).toBeLessThan(installIdx);
  });
});

// ─── (7) Custom override via resolver ─────────────────────────────────────────

describe("dependency-auth custom step override", () => {
  it("substitutes a custom dependency-auth module when custom/steps/dependency-auth.ts exists", async () => {
    const customDepAuth: StepModule = { run: async () => ({ custom: true }) };

    const runner = await createDefaultRunner({
      customRoot: "/workspace",
      existsSyncImpl: (p) =>
        p.replace(/\\/g, "/").endsWith("/custom/steps/dependency-auth.ts"),
      importFn: async () => ({ default: customDepAuth }),
    });

    expect(registeredModule(runner, "dependency-auth")).toBe(customDepAuth);
  });
});

// ─── (8) Secret leakage regression ───────────────────────────────────────────

describe("dependency-auth secret leakage regression", () => {
  it("step inputs do not contain the progress token, outputs do not contain the dependency token", async () => {
    const progressTokenValue = "LIVE_PROGRESS_SECRET_TOKEN";
    const dependencyTokenValue = "LIVE_DEPENDENCY_SECRET_TOKEN";
    vi.stubEnv("RUN_PROGRESS_TOKEN", progressTokenValue);

    const resolvedInputs = {
      dependencyTokenScope: "installation" as const,
      callbackUrl: "https://orch.example",
      fetchImpl: mockFetch(200, { token: dependencyTokenValue, expires_at: "2030-01-01T00:00:00Z" }),
      spawnSyncImpl: vi.fn().mockReturnValue({ status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") }),
      writeFileSyncImpl: vi.fn(),
    };

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const outputs = await dependencyAuthStep.run(ctx(), resolvedInputs, new NoopStepReporter());
    logSpy.mockRestore();

    // Inputs must not carry the live progress token (it is read from env inside the step)
    expect(JSON.stringify(resolvedInputs)).not.toContain(progressTokenValue);
    // Outputs must not carry the dependency token (it is stored on context.data instead)
    expect(JSON.stringify(outputs)).not.toContain(dependencyTokenValue);
  });
});

// ─── (9) fetchDependencyToken unit tests ──────────────────────────────────────

describe("fetchDependencyToken", () => {
  it("throws on non-200 response", async () => {
    await expect(
      fetchDependencyToken({
        callbackBase: "https://orch.example",
        progressToken: "tok",
        fetchImpl: mockFetch(500, {}),
      }),
    ).rejects.toThrow(/500/);
  });

  it("throws on missing token field", async () => {
    await expect(
      fetchDependencyToken({
        callbackBase: "https://orch.example",
        progressToken: "tok",
        fetchImpl: mockFetch(200, { expires_at: "2030-01-01T00:00:00Z" }),
      }),
    ).rejects.toThrow(/missing token or expires_at/);
  });

  it("throws on missing expires_at field", async () => {
    await expect(
      fetchDependencyToken({
        callbackBase: "https://orch.example",
        progressToken: "tok",
        fetchImpl: mockFetch(200, { token: "tok123" }),
      }),
    ).rejects.toThrow(/missing token or expires_at/);
  });

  it("strips trailing slash from callbackBase before constructing URL", async () => {
    const calls: string[] = [];
    const captureFetch: typeof fetch = async (url) => {
      calls.push(url as string);
      return { ok: true, status: 200, json: async () => ({ token: "t", expires_at: "2030-01-01T00:00:00Z" }) } as Response;
    };
    await fetchDependencyToken({
      callbackBase: "https://orch.example/",
      progressToken: "tok",
      fetchImpl: captureFetch,
    });
    expect(calls[0]).toBe("https://orch.example/api/runner/dependency-token");
  });
});

// ─── (10) Credential helper registration ─────────────────────────────────────

describe("dependencyAuthStep credential helper registration", () => {
  let origTokenFile: string | undefined;
  let origCallbackUrl: string | undefined;
  let origComposerAuth: string | undefined;

  beforeEach(() => {
    origTokenFile = process.env.GIT_DEPENDENCY_TOKEN_FILE;
    origCallbackUrl = process.env.GIT_DEPENDENCY_CALLBACK_URL;
    origComposerAuth = process.env.COMPOSER_AUTH;
    delete process.env.GIT_DEPENDENCY_TOKEN_FILE;
    delete process.env.GIT_DEPENDENCY_CALLBACK_URL;
    delete process.env.COMPOSER_AUTH;
  });

  afterEach(() => {
    if (origTokenFile !== undefined) process.env.GIT_DEPENDENCY_TOKEN_FILE = origTokenFile;
    else delete process.env.GIT_DEPENDENCY_TOKEN_FILE;
    if (origCallbackUrl !== undefined) process.env.GIT_DEPENDENCY_CALLBACK_URL = origCallbackUrl;
    else delete process.env.GIT_DEPENDENCY_CALLBACK_URL;
    if (origComposerAuth !== undefined) process.env.COMPOSER_AUTH = origComposerAuth;
    else delete process.env.COMPOSER_AUTH;
  });

  it("registers git credential helper for https://github.com on successful fetch", async () => {
    const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
    const mockSpawn = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args });
      return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await dependencyAuthStep.run(
      ctx(),
      {
        dependencyTokenScope: "installation",
        callbackUrl: "https://orch.example",
        fetchImpl: mockFetch(200, { token: "dep-tok", expires_at: "2030-01-01T00:00:00Z" }),
        spawnSyncImpl: mockSpawn,
        writeFileSyncImpl: vi.fn(),
        credentialHelperPath: "/opt/ai-implement/git-credential-helper.sh",
      },
      new NoopStepReporter(),
    );
    logSpy.mockRestore();

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd).toBe("git");
    expect(spawnCalls[0].args).toEqual([
      "config",
      "--global",
      "credential.https://github.com.helper",
      "/opt/ai-implement/git-credential-helper.sh",
    ]);
  });

  it("writes token cache file and sets GIT_DEPENDENCY_TOKEN_FILE + GIT_DEPENDENCY_CALLBACK_URL", async () => {
    const writeCalls: Array<{ path: string; data: string }> = [];
    const mockWrite = vi.fn().mockImplementation((path: string, data: string) => {
      writeCalls.push({ path, data });
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await dependencyAuthStep.run(
      ctx(),
      {
        dependencyTokenScope: "installation",
        callbackUrl: "https://orch.example",
        fetchImpl: mockFetch(200, { token: "dep-tok-file", expires_at: "2030-06-01T12:00:00Z" }),
        spawnSyncImpl: vi.fn().mockReturnValue({ status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") }),
        writeFileSyncImpl: mockWrite,
      },
      new NoopStepReporter(),
    );
    logSpy.mockRestore();

    expect(writeCalls).toHaveLength(1);
    const written = JSON.parse(writeCalls[0].data) as { token: string; expires_at: string };
    expect(written.token).toBe("dep-tok-file");
    expect(written.expires_at).toBe("2030-06-01T12:00:00Z");
    expect(process.env.GIT_DEPENDENCY_TOKEN_FILE).toBe(writeCalls[0].path);
    expect(process.env.GIT_DEPENDENCY_CALLBACK_URL).toBe("https://orch.example");
  });

  it("exports COMPOSER_AUTH with valid JSON containing the token", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await dependencyAuthStep.run(
      ctx(),
      {
        dependencyTokenScope: "installation",
        callbackUrl: "https://orch.example",
        fetchImpl: mockFetch(200, { token: "composer-tok", expires_at: "2030-01-01T00:00:00Z" }),
        spawnSyncImpl: vi.fn().mockReturnValue({ status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") }),
        writeFileSyncImpl: vi.fn(),
      },
      new NoopStepReporter(),
    );
    logSpy.mockRestore();

    expect(process.env.COMPOSER_AUTH).toBeDefined();
    const parsed = JSON.parse(process.env.COMPOSER_AUTH!) as unknown;
    expect(parsed).toEqual({ "github-oauth": { "github.com": "composer-tok" } });
  });

  it("does not register helper or set env vars when feature is off (no scope)", async () => {
    const mockSpawn = vi.fn();
    const mockWrite = vi.fn();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await dependencyAuthStep.run(
      ctx(),
      {
        dependencyTokenScope: undefined,
        callbackUrl: "https://orch.example",
        spawnSyncImpl: mockSpawn,
        writeFileSyncImpl: mockWrite,
      },
      new NoopStepReporter(),
    );
    logSpy.mockRestore();

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
    expect(process.env.GIT_DEPENDENCY_TOKEN_FILE).toBeUndefined();
    expect(process.env.COMPOSER_AUTH).toBeUndefined();
  });

  it("does not register helper or set env vars when token fetch fails", async () => {
    const mockSpawn = vi.fn();
    const mockWrite = vi.fn();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await dependencyAuthStep.run(
      ctx(),
      {
        dependencyTokenScope: "installation",
        callbackUrl: "https://orch.example",
        fetchImpl: mockFetch(403, {}),
        spawnSyncImpl: mockSpawn,
        writeFileSyncImpl: mockWrite,
      },
      new NoopStepReporter(),
    );
    warnSpy.mockRestore();

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
    expect(process.env.GIT_DEPENDENCY_TOKEN_FILE).toBeUndefined();
    expect(process.env.COMPOSER_AUTH).toBeUndefined();
  });

  it("continues and returns acquired=true even when git config registration fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = await dependencyAuthStep.run(
      ctx(),
      {
        dependencyTokenScope: "installation",
        callbackUrl: "https://orch.example",
        fetchImpl: mockFetch(200, { token: "tok", expires_at: "2030-01-01T00:00:00Z" }),
        spawnSyncImpl: vi.fn().mockReturnValue({ status: 1, stdout: Buffer.from(""), stderr: Buffer.from("error") }),
        writeFileSyncImpl: vi.fn(),
      },
      new NoopStepReporter(),
    );
    logSpy.mockRestore();
    const warnings = warnSpy.mock.calls.map((c) => c.join(" "));
    warnSpy.mockRestore();

    expect(out.acquired).toBe(true);
    expect(warnings.some((w) => /credential helper/i.test(w))).toBe(true);
  });

  it("COMPOSER_AUTH does not appear in step outputs (token not leaked)", async () => {
    const tokenValue = "SECRET_COMPOSER_TOKEN_VALUE";

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const outputs = await dependencyAuthStep.run(
      ctx(),
      {
        dependencyTokenScope: "installation",
        callbackUrl: "https://orch.example",
        fetchImpl: mockFetch(200, { token: tokenValue, expires_at: "2030-01-01T00:00:00Z" }),
        spawnSyncImpl: vi.fn().mockReturnValue({ status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") }),
        writeFileSyncImpl: vi.fn(),
      },
      new NoopStepReporter(),
    );
    logSpy.mockRestore();

    expect(JSON.stringify(outputs)).not.toContain(tokenValue);
  });
});
