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
        progressToken: "tok",
      },
      new NoopStepReporter(),
    );
    logSpy.mockRestore();
    expect(out.dependencyToken).toBeNull();
    expect(out.dependencyTokenExpiresAt).toBeNull();
  });

  it("no-ops when callbackUrl is absent", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = await dependencyAuthStep.run(
      ctx(),
      {
        dependencyTokenScope: "installation",
        callbackUrl: null,
        progressToken: "tok",
      },
      new NoopStepReporter(),
    );
    logSpy.mockRestore();
    expect(out.dependencyToken).toBeNull();
    expect(out.dependencyTokenExpiresAt).toBeNull();
  });

  it("no-ops when progressToken is absent", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = await dependencyAuthStep.run(
      ctx(),
      {
        dependencyTokenScope: "installation",
        callbackUrl: "https://orch.example",
        progressToken: null,
      },
      new NoopStepReporter(),
    );
    logSpy.mockRestore();
    expect(out.dependencyToken).toBeNull();
    expect(out.dependencyTokenExpiresAt).toBeNull();
  });
});

// ─── (3) Successful token fetch ───────────────────────────────────────────────

describe("dependencyAuthStep successful fetch", () => {
  it("POSTs to <callbackBase>/api/runner/dependency-token with bearer header", async () => {
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
        progressToken: "progress-tok",
        fetchImpl: captureFetch,
      },
      new NoopStepReporter(),
    );
    logSpy.mockRestore();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://orch.example/api/runner/dependency-token");
    expect((calls[0].init.headers as Record<string, string>)["Authorization"]).toBe("Bearer progress-tok");
  });

  it("stores token and expires_at in outputs", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = await dependencyAuthStep.run(
      ctx(),
      {
        dependencyTokenScope: "installation",
        callbackUrl: "https://orch.example",
        progressToken: "tok",
        fetchImpl: mockFetch(200, { token: "dep-tok-123", expires_at: "2030-06-01T12:00:00Z" }),
      },
      new NoopStepReporter(),
    );
    logSpy.mockRestore();
    expect(out.dependencyToken).toBe("dep-tok-123");
    expect(out.dependencyTokenExpiresAt).toBe("2030-06-01T12:00:00Z");
  });
});

// ─── (4) Failure is non-fatal ─────────────────────────────────────────────────

describe("dependencyAuthStep failure handling", () => {
  it("warns and returns null on non-200 response", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await dependencyAuthStep.run(
      ctx(),
      {
        dependencyTokenScope: "installation",
        callbackUrl: "https://orch.example",
        progressToken: "tok",
        fetchImpl: mockFetch(403, {}),
      },
      new NoopStepReporter(),
    );
    const warnings = warnSpy.mock.calls.map((c) => c.join(" "));
    warnSpy.mockRestore();
    expect(out.dependencyToken).toBeNull();
    expect(out.dependencyTokenExpiresAt).toBeNull();
    expect(warnings.some((w) => /dependency-auth.*failed.*token/i.test(w))).toBe(true);
  });

  it("warns and returns null on malformed JSON body", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await dependencyAuthStep.run(
      ctx(),
      {
        dependencyTokenScope: "installation",
        callbackUrl: "https://orch.example",
        progressToken: "tok",
        fetchImpl: mockFetch(200, { not_a_token: true }),
      },
      new NoopStepReporter(),
    );
    const warnings = warnSpy.mock.calls.map((c) => c.join(" "));
    warnSpy.mockRestore();
    expect(out.dependencyToken).toBeNull();
    expect(warnings.some((w) => /dependency-auth.*failed.*token/i.test(w))).toBe(true);
  });

  it("warns and returns null on thrown network error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await dependencyAuthStep.run(
      ctx(),
      {
        dependencyTokenScope: "installation",
        callbackUrl: "https://orch.example",
        progressToken: "tok",
        fetchImpl: throwingFetch(new Error("ECONNREFUSED")),
      },
      new NoopStepReporter(),
    );
    const warnings = warnSpy.mock.calls.map((c) => c.join(" "));
    warnSpy.mockRestore();
    expect(out.dependencyToken).toBeNull();
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
        progressToken: "tok",
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
        progressToken: "tok",
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

// ─── (8) fetchDependencyToken unit tests ──────────────────────────────────────

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
