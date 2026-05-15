import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createMachine,
  getMachine,
  listMachines,
  stopMachine,
  destroyMachine,
  waitForMachine,
  generateSessionToken,
  generateMachineNonce,
  buildSessionMachineConfig,
  listAppSecrets,
  setAppSecrets,
  unsetAppSecret,
  fetchMachineLogs,
  updateMachineMetadata,
} from "../fly-machines.js";
import type { SessionMachineInput } from "../fly-machines.js";

const TOKEN = "fly-test-token";
const APP = "ai-implement-sessions-test";

const mockMachine = {
  id: "machine-123",
  name: "session-eng-42",
  state: "started",
  region: "iad",
  created_at: "2026-04-04T00:00:00Z",
  updated_at: "2026-04-04T00:00:00Z",
  config: {
    image: "ghcr.io/builddownai/ai-implement-runner:latest",
    env: {},
    guest: { cpu_kind: "shared", cpus: 1, memory_mb: 1024 },
    auto_destroy: true,
    restart: { policy: "no" },
  },
};

describe("createMachine", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("sends POST with correct URL and body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockMachine,
    } as Response);

    const opts = { name: "test-machine", region: "iad", config: mockMachine.config };
    const result = await createMachine(TOKEN, APP, opts);

    expect(result.id).toBe("machine-123");

    const [url, reqOpts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`https://api.machines.dev/v1/apps/${APP}/machines`);
    expect((reqOpts as RequestInit).method).toBe("POST");

    const body = JSON.parse((reqOpts as RequestInit).body as string);
    expect(body.name).toBe("test-machine");
    expect(body.region).toBe("iad");
    expect(body.config.image).toBe("ghcr.io/builddownai/ai-implement-runner:latest");
  });

  it("sends correct auth header", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockMachine,
    } as Response);

    await createMachine(TOKEN, APP, { config: mockMachine.config });

    const opts = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe("Bearer fly-test-token");
  });

  it("throws on error response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () => "invalid config",
    } as Response);

    await expect(createMachine(TOKEN, APP, { config: mockMachine.config }))
      .rejects.toThrow("Failed to create machine in ai-implement-sessions-test (422): invalid config");
  });
});

describe("getMachine", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("fetches machine by ID", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockMachine,
    } as Response);

    const result = await getMachine(TOKEN, APP, "machine-123");
    expect(result.id).toBe("machine-123");
    expect(result.state).toBe("started");

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`https://api.machines.dev/v1/apps/${APP}/machines/machine-123`);
  });

  it("throws on 404", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => "not found",
    } as Response);

    await expect(getMachine(TOKEN, APP, "nonexistent"))
      .rejects.toThrow("Failed to get machine nonexistent (404)");
  });
});

describe("listMachines", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns array of machines", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => [mockMachine],
    } as Response);

    const result = await listMachines(TOKEN, APP);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("machine-123");

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`https://api.machines.dev/v1/apps/${APP}/machines`);
  });

  it("returns empty array when no machines", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as Response);

    const result = await listMachines(TOKEN, APP);
    expect(result).toHaveLength(0);
  });
});

describe("stopMachine", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("sends POST to stop endpoint", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);

    await stopMachine(TOKEN, APP, "machine-123");

    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`https://api.machines.dev/v1/apps/${APP}/machines/machine-123/stop`);
    expect((opts as RequestInit).method).toBe("POST");
  });

  it("throws on error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 409,
      text: async () => "machine not running",
    } as Response);

    await expect(stopMachine(TOKEN, APP, "machine-123"))
      .rejects.toThrow("Failed to stop machine machine-123 (409)");
  });
});

describe("destroyMachine", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("sends DELETE with force=true by default", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);

    await destroyMachine(TOKEN, APP, "machine-123");

    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`https://api.machines.dev/v1/apps/${APP}/machines/machine-123?force=true`);
    expect((opts as RequestInit).method).toBe("DELETE");
  });

  it("sends DELETE with force=false when specified", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);

    await destroyMachine(TOKEN, APP, "machine-123", false);

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`https://api.machines.dev/v1/apps/${APP}/machines/machine-123?force=false`);
  });

  it("throws on error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => "not found",
    } as Response);

    await expect(destroyMachine(TOKEN, APP, "machine-123"))
      .rejects.toThrow("Failed to destroy machine machine-123 (404)");
  });
});

describe("waitForMachine", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("sends GET with state and timeout params", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);

    await waitForMachine(TOKEN, APP, "machine-123", "started", 30);

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`https://api.machines.dev/v1/apps/${APP}/machines/machine-123/wait?state=started&timeout=30`);
  });

  it("uses default 60s timeout", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);

    await waitForMachine(TOKEN, APP, "machine-123", "stopped");

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain("timeout=60");
  });

  it("throws on timeout", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 408,
      text: async () => "timeout",
    } as Response);

    await expect(waitForMachine(TOKEN, APP, "machine-123", "started"))
      .rejects.toThrow('Timeout waiting for machine machine-123 to reach state "started"');
  });
});

describe("generateSessionToken", () => {
  it("produces a base64url string", () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBe(43); // 32 bytes → 43 base64url chars
  });

  it("produces unique values", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
  });
});

describe("generateMachineNonce", () => {
  it("produces a hex string", () => {
    const nonce = generateMachineNonce();
    expect(nonce).toMatch(/^[0-9a-f]+$/);
    expect(nonce.length).toBe(32); // 16 bytes → 32 hex chars
  });

  it("produces unique values", () => {
    const a = generateMachineNonce();
    const b = generateMachineNonce();
    expect(a).not.toBe(b);
  });
});

describe("listAppSecrets", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns array of secrets with name/digest/created_at via GraphQL", async () => {
    const secrets = [
      { name: "ENG_DATABASE_URL", digest: "abc123", createdAt: "2026-01-01T00:00:00Z" },
      { name: "ENG_STRIPE_KEY", digest: "def456", createdAt: "2026-01-02T00:00:00Z" },
    ];
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { app: { secrets } } }),
    } as Response);

    const result = await listAppSecrets(TOKEN, APP);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("ENG_DATABASE_URL");
    expect(result[0].created_at).toBe("2026-01-01T00:00:00Z");

    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.fly.io/graphql");
    expect((opts as RequestInit).method).toBe("POST");
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.variables.appName).toBe(APP);
  });

  it("returns empty array when app has no secrets", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { app: { secrets: [] } } }),
    } as Response);

    const result = await listAppSecrets(TOKEN, APP);
    expect(result).toEqual([]);
  });

  it("returns empty array when app is null", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { app: null } }),
    } as Response);

    const result = await listAppSecrets(TOKEN, APP);
    expect(result).toEqual([]);
  });

  it("throws on HTTP error response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "forbidden",
    } as Response);

    await expect(listAppSecrets(TOKEN, APP))
      .rejects.toThrow("Fly API request failed (403): forbidden");
  });
});

describe("setAppSecrets", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("sends GraphQL mutation with secrets and returns null version", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { setSecrets: { release: { version: 42 } } } }),
    } as Response);

    const version = await setAppSecrets(TOKEN, APP, { ENG_DATABASE_URL: "postgres://localhost/db" });

    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.fly.io/graphql");
    expect((opts as RequestInit).method).toBe("POST");
    expect(version).toBeNull();

    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.variables.input.appId).toBe(APP);
    expect(body.variables.input.secrets[0].key).toBe("ENG_DATABASE_URL");
    expect(body.variables.input.secrets[0].value).toBe("postgres://localhost/db");
  });

  it("throws on HTTP error response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () => "invalid secret name",
    } as Response);

    await expect(setAppSecrets(TOKEN, APP, { BAD: "val" }))
      .rejects.toThrow("Fly API request failed (422): invalid secret name");
  });
});

describe("unsetAppSecret", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("sends GraphQL mutation to unset secret and returns null version", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { unsetSecrets: { release: { version: 43 } } } }),
    } as Response);

    const version = await unsetAppSecret(TOKEN, APP, "ENG_DATABASE_URL");

    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.fly.io/graphql");
    expect((opts as RequestInit).method).toBe("POST");
    expect(version).toBeNull();

    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.variables.input.appId).toBe(APP);
    expect(body.variables.input.keys[0]).toBe("ENG_DATABASE_URL");
  });

  it("throws on HTTP error response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "internal server error",
    } as Response);

    await expect(unsetAppSecret(TOKEN, APP, "MISSING_SECRET"))
      .rejects.toThrow("Fly API request failed (500): internal server error");
  });

  it("throws when GraphQL reports the secret was not found", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errors: [{ message: "Could not find secret MISSING_SECRET" }] }),
    } as Response);

    await expect(unsetAppSecret(TOKEN, APP, "MISSING_SECRET"))
      .rejects.toThrow("Could not find secret MISSING_SECRET");
  });

  it("throws on any GraphQL error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errors: [{ message: "Unauthorized" }] }),
    } as Response);

    await expect(unsetAppSecret(TOKEN, APP, "ENG_DATABASE_URL"))
      .rejects.toThrow("Unauthorized");
  });
});

describe("buildSessionMachineConfig", () => {
  const baseInput: SessionMachineInput = {
    image: "ghcr.io/builddownai/ai-implement-runner:latest",
    issueId: "uuid-123",
    issueIdentifier: "ENG-42",
    issueTitle: "Add feature X",
    issueDescription: "Implement the feature",
    owner: "test-org",
    repo: "test-repo",
    defaultBranch: "main",
    githubAppId: "12345",
    githubAppPrivateKey: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
    sessionToken: "tok_abc",
    machineNonce: "nonce_def",
    linearApiKey: "lin_api_test",
    anthropicApiKey: "sk-ant-test",
  };

  it("maps issue metadata to env vars", () => {
    const result = buildSessionMachineConfig(baseInput);
    const env = result.config.env!;

    expect(env.ISSUE_ID).toBe("uuid-123");
    expect(env.ISSUE_IDENTIFIER).toBe("ENG-42");
    expect(env.ISSUE_TITLE).toBe("Add feature X");
    expect(env.ISSUE_DESCRIPTION).toBe("Implement the feature");
    expect(env.GITHUB_OWNER).toBe("test-org");
    expect(env.GITHUB_REPO).toBe("test-repo");
    expect(env.GITHUB_DEFAULT_BRANCH).toBe("main");
    expect(env.GITHUB_APP_ID).toBe("12345");
    expect(env.SESSION_MODE).toBe("autonomous");
    expect(env.LINEAR_API_KEY).toBe("lin_api_test");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
  });

  it("sets OAuth token when provided", () => {
    const result = buildSessionMachineConfig({
      ...baseInput,
      claudeOAuthToken: "oauth-token",
      anthropicApiKey: undefined,
    });

    expect(result.config.env!.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
    expect(result.config.env!.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("uses default guest spec", () => {
    const result = buildSessionMachineConfig(baseInput);
    expect(result.config.guest).toEqual({ cpu_kind: "shared", cpus: 1, memory_mb: 1024 });
  });

  it("allows custom guest spec", () => {
    const result = buildSessionMachineConfig({ ...baseInput, cpus: 2, memoryMb: 2048 });
    expect(result.config.guest).toEqual({ cpu_kind: "shared", cpus: 2, memory_mb: 2048 });
  });

  it("generates sanitized machine name from issue identifier", () => {
    const result = buildSessionMachineConfig(baseInput);
    expect(result.name).toBe("session-eng-42");
  });

  it("defaults region to iad", () => {
    const result = buildSessionMachineConfig(baseInput);
    expect(result.region).toBe("iad");
  });

  it("passes sessionMode through to env", () => {
    const result = buildSessionMachineConfig({ ...baseInput, sessionMode: "hybrid" });
    expect(result.config.env!.SESSION_MODE).toBe("hybrid");
  });

  it("defaults sessionMode to autonomous", () => {
    const result = buildSessionMachineConfig(baseInput);
    expect(result.config.env!.SESSION_MODE).toBe("autonomous");
  });

  it("sets auto_destroy false and no-restart policy", () => {
    const result = buildSessionMachineConfig(baseInput);
    expect(result.config.auto_destroy).toBe(false);
    expect(result.config.restart).toEqual({ policy: "no" });
  });

  it("sets metadata for filtering", () => {
    const result = buildSessionMachineConfig(baseInput);
    expect(result.config.metadata).toEqual({
      purpose: "session",
      issue_id: "uuid-123",
      issue_identifier: "ENG-42",
      repo: "test-org/test-repo",
      session_mode: "autonomous",
    });
  });

  it("includes session_mode in metadata", () => {
    const result = buildSessionMachineConfig({ ...baseInput, sessionMode: "shadow" });
    expect(result.config.metadata!.session_mode).toBe("shadow");
  });

  it("includes orchestrator_app in metadata when provided", () => {
    const result = buildSessionMachineConfig({ ...baseInput, orchestratorApp: "my-orchestrator" });
    expect(result.config.metadata!.orchestrator_app).toBe("my-orchestrator");
  });

  it("omits orchestrator_app from metadata when not provided", () => {
    const result = buildSessionMachineConfig(baseInput);
    expect(result.config.metadata!.orchestrator_app).toBeUndefined();
  });

  it("maps team-prefixed secrets with prefix stripped", () => {
    const result = buildSessionMachineConfig({
      ...baseInput,
      teamKey: "ENG",
      teamSecretNames: ["ENG_DATABASE_URL", "ENG_STRIPE_KEY", "OTHER_TEAM_SECRET"],
    });
    expect(result.config.processes).toEqual([{
      secrets: [
        { env_var: "DATABASE_URL", name: "ENG_DATABASE_URL" },
        { env_var: "STRIPE_KEY", name: "ENG_STRIPE_KEY" },
      ],
    }]);
  });

  it("omits process-level secrets when teamSecretNames is empty", () => {
    const result = buildSessionMachineConfig({
      ...baseInput,
      teamKey: "ENG",
      teamSecretNames: [],
    });
    expect(result.config.processes).toBeUndefined();
  });

  it("omits process-level secrets when no names match the team prefix", () => {
    const result = buildSessionMachineConfig({
      ...baseInput,
      teamKey: "ENG",
      teamSecretNames: ["OTHER_TEAM_SECRET", "ANOTHER_VAR"],
    });
    expect(result.config.processes).toBeUndefined();
  });

  it("omits process-level secrets when teamKey is not provided", () => {
    const result = buildSessionMachineConfig({
      ...baseInput,
      teamSecretNames: ["ENG_DATABASE_URL"],
    });
    expect(result.config.processes).toBeUndefined();
  });

  it("passes min_secrets_version when provided", () => {
    const result = buildSessionMachineConfig({
      ...baseInput,
      minSecretsVersion: 44,
    });
    expect(result.min_secrets_version).toBe(44);
  });

  it("injects extraEnv into the env block", () => {
    const result = buildSessionMachineConfig({
      ...baseInput,
      extraEnv: { DEDUP_DB_PATH: "/tmp/dedup.sqlite", CUSTOM_VAR: "hello" },
    });
    expect(result.config.env!.DEDUP_DB_PATH).toBe("/tmp/dedup.sqlite");
    expect(result.config.env!.CUSTOM_VAR).toBe("hello");
  });

  it("extraEnv overrides standard env vars when keys collide", () => {
    const result = buildSessionMachineConfig({
      ...baseInput,
      extraEnv: { SESSION_MODE: "overridden" },
    });
    expect(result.config.env!.SESSION_MODE).toBe("overridden");
  });

  it("omitting extraEnv leaves standard env vars unchanged", () => {
    const result = buildSessionMachineConfig(baseInput);
    expect(result.config.env!.SESSION_MODE).toBe("autonomous");
    expect(result.config.env!.DEDUP_DB_PATH).toBeUndefined();
  });

  it("includes tenant_id in metadata when provided", () => {
    const result = buildSessionMachineConfig({ ...baseInput, tenantId: "buildownai" });
    expect(result.config.metadata!.tenant_id).toBe("buildownai");
  });

  it("omits tenant_id from metadata when not provided", () => {
    const result = buildSessionMachineConfig(baseInput);
    expect(result.config.metadata!.tenant_id).toBeUndefined();
  });

  it("includes expected_ttl_seconds as a string in metadata when provided", () => {
    const result = buildSessionMachineConfig({ ...baseInput, expectedTtlSeconds: 14400 });
    expect(result.config.metadata!.expected_ttl_seconds).toBe("14400");
  });

  it("omits expected_ttl_seconds from metadata when not provided", () => {
    const result = buildSessionMachineConfig(baseInput);
    expect(result.config.metadata!.expected_ttl_seconds).toBeUndefined();
  });

  it("smoke test: metadata has all required keys with correct types", () => {
    const result = buildSessionMachineConfig({
      ...baseInput,
      orchestratorApp: "ai-implement-prod",
      tenantId: "acme-corp",
      expectedTtlSeconds: 14400,
    });
    const meta = result.config.metadata!;
    expect(typeof meta.purpose).toBe("string");
    expect(typeof meta.issue_id).toBe("string");
    expect(typeof meta.issue_identifier).toBe("string");
    expect(typeof meta.repo).toBe("string");
    expect(typeof meta.session_mode).toBe("string");
    expect(typeof meta.orchestrator_app).toBe("string");
    expect(typeof meta.tenant_id).toBe("string");
    expect(typeof meta.expected_ttl_seconds).toBe("string");
    expect(meta.purpose).toBe("session");
    expect(meta.issue_id).toBe(baseInput.issueId);
    expect(meta.issue_identifier).toBe(baseInput.issueIdentifier);
    expect(meta.repo).toBe(`${baseInput.owner}/${baseInput.repo}`);
    expect(meta.session_mode).toBe("autonomous");
    expect(meta.orchestrator_app).toBe("ai-implement-prod");
    expect(meta.tenant_id).toBe("acme-corp");
    expect(meta.expected_ttl_seconds).toBe("14400");
  });
});

describe("updateMachineMetadata", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("sends POST to the metadata key endpoint with JSON value body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);

    await updateMachineMetadata(TOKEN, APP, "machine-123", "pr_number", "42");

    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`https://api.machines.dev/v1/apps/${APP}/machines/machine-123/metadata/pr_number`);
    expect((opts as RequestInit).method).toBe("POST");
    expect((opts as RequestInit).body).toBe(JSON.stringify({ value: "42" }));
    expect(((opts as RequestInit).headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(((opts as RequestInit).headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("throws on error response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => "machine not found",
    } as Response);

    await expect(updateMachineMetadata(TOKEN, APP, "machine-xyz", "pr_number", "7"))
      .rejects.toThrow("updateMachineMetadata failed (404)");
  });

  it("stamps pr_number extracted from a GitHub PR URL", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);

    const prUrl = "https://github.com/org/repo/pull/99";
    const prNumberMatch = prUrl.match(/\/pull\/(\d+)$/);
    expect(prNumberMatch).not.toBeNull();

    await updateMachineMetadata(TOKEN, APP, "machine-123", "pr_number", prNumberMatch![1]);

    const [, opts] = vi.mocked(fetch).mock.calls[0];
    expect((opts as RequestInit).body).toBe(JSON.stringify({ value: "99" }));
  });
});

describe("fetchMachineLogs", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("appends ?lines=N to the URL to prevent streaming hang", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => '{"message":"hello"}\n{"message":"world"}\n',
    } as Response);

    await fetchMachineLogs(TOKEN, APP, "machine-123");

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(
      `https://api.machines.dev/v1/apps/${APP}/machines/machine-123/logs?lines=100`,
    );
  });

  it("uses custom lastN when provided", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => '{"message":"line"}\n',
    } as Response);

    await fetchMachineLogs(TOKEN, APP, "machine-123", 50);

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain("?lines=50");
  });

  it("parses NDJSON and extracts message fields", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        '{"message":"starting server"}\n{"message":"listening on :3000"}\n',
    } as Response);

    const result = await fetchMachineLogs(TOKEN, APP, "machine-123");
    expect(result).toBe("starting server\nlistening on :3000");
  });

  it("falls back to raw line when JSON parse fails", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => "not-json-at-all\n",
    } as Response);

    const result = await fetchMachineLogs(TOKEN, APP, "machine-123");
    expect(result).toBe("not-json-at-all");
  });

  it("falls back to raw line when parsed JSON has no message field", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => '{"level":"info","ts":1234}\n',
    } as Response);

    const result = await fetchMachineLogs(TOKEN, APP, "machine-123");
    expect(result).toBe('{"level":"info","ts":1234}');
  });

  it("returns empty string for blank body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => "   \n  ",
    } as Response);

    const result = await fetchMachineLogs(TOKEN, APP, "machine-123");
    expect(result).toBe("");
  });

  it("throws on error response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => "not found",
    } as Response);

    await expect(fetchMachineLogs(TOKEN, APP, "machine-123"))
      .rejects.toThrow("Failed to fetch logs for machine machine-123 (404)");
  });
});
