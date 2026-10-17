import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createMachine,
  getMachine,
  listMachines,
  stopMachine,
  startMachine,
  updateMachine,
  clearMachineEnv,
  MAX_RATE_LIMIT_WAIT_MS,
  waitForMachineSettled,
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
  readMachineExit,
} from "../fly-machines.js";
import type { Machine, MachineEvent, SessionMachineInput, SettleOptions } from "../fly-machines.js";
import { buildImplRunConfig, buildKgRefreshRunConfig, encodeRunConfig, decodeRunConfig, type RunConfigV1 } from "../run-config.js";
import { branchPrefixRunnerEnv, capRunnerEnv, skillsRepoRunnerEnv } from "../github.js";
import { DEFAULT_RETRY_POLICY } from "../pipeline/retry-backoff.js";
import { DURABLE_UNTIL_KEY, SCRUB_SETTLE_MS } from "../restate/fly-machine-profile.js";
import { makeMapping } from "./helpers/builders.js";
import { fakeFetch, type ReplyInit } from "./helpers/fake-fetch.js";

const TOKEN = "fly-test-token";
const APP = "ai-implement-sessions-test";
// The orchestrator's runner callback base URL, which production also passes as the orchestrator URL.
const ORCH = "https://orchestrator.example";

// Route keys match the path alone; the Machines API (api.machines.dev) and the GraphQL API
// (api.fly.io) are told apart by each test's url.href assertion.
const MACHINES = `/v1/apps/${APP}/machines`;
const MACHINE = `${MACHINES}/machine-123`;
const MACHINES_URL = `https://api.machines.dev${MACHINES}`;
const MACHINE_URL = `https://api.machines.dev${MACHINE}`;

// An implementation session for ENG-42, the input every issue dispatch builds its machine from.
const baseInput: SessionMachineInput = {
  image: "ghcr.io/builddownai/ai-implement-runner:latest",
  issueId: "uuid-123",
  issueIdentifier: "ENG-42",
  issueTitle: "Add feature X",
  issueDescription: "Implement the feature",
  owner: "test-org",
  repo: "test-repo",
  defaultBranch: "main",
  githubToken: "ghs_test_token",
  sessionToken: "tok_abc",
  machineNonce: "nonce_def",
  anthropicApiKey: "sk-ant-test",
};
const session = buildSessionMachineConfig(baseInput);

// The kg-refresh pipeline's kept runner, as its Fly sender builds it (src/restate/kg-refresh-senders.ts).
const KG_ENVELOPE = buildKgRefreshRunConfig({ kgSourceRepo: "acme/kg", issueIdentifier: "KG-REFRESH · trigger-1", runnerCallbackUrl: ORCH });
const kgRefreshInput: SessionMachineInput = {
  image: "ghcr.io/builddownai/ai-implement-runner:latest",
  issueId: "kg-refresh",
  issueIdentifier: KG_ENVELOPE.issue.identifier,
  issueTitle: "KG ingest",
  issueDescription: "",
  owner: "acme",
  repo: "kg",
  defaultBranch: "main",
  anthropicApiKey: "sk-ant-test",
  githubToken: "ghs_test_token",
  sessionToken: "tok_abc",
  machineNonce: "nonce_def",
  phase: "kg-refresh",
  orchestratorUrl: ORCH,
  runnerCallbackUrl: ORCH,
  runToken: "run-tok",
  expectedTtlSeconds: 4 * 60 * 60,
  extraEnv: { AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig(KG_ENVELOPE), RUN_PROGRESS_TOKEN: "progress-tok" },
  cpuKind: "performance",
  cpus: 2,
  memoryMb: 4096,
  purpose: "durable-runner",
  pipeline: "kg-refresh",
  dispatchId: "d1",
};

// Fly's answer for a machine: the requested name, region and config, plus the id, state, instance and timestamps it assigns.
const INSTANCE = "01G3SHPYE8XZ58GD4XRRF9CCKC";
const UPDATED_INSTANCE = "01G3SHQ2W8QKV6C0R4XN9T5Z7M";
function flyMachine(opts: ReturnType<typeof buildSessionMachineConfig>, state: string): Machine {
  return {
    id: "machine-123",
    name: opts.name!,
    region: opts.region!,
    state,
    instance_id: INSTANCE,
    created_at: "2026-04-04T00:00:00Z",
    updated_at: "2026-04-04T00:00:00Z",
    config: opts.config,
  };
}
const mockMachine = flyMachine(session, "started");

describe("createMachine", () => {
  it("sends POST with correct URL and body", async () => {
    // Fly answers a create with the new machine in state "created".
    const fly = fakeFetch({ [`POST ${MACHINES}`]: { json: flyMachine(session, "created") } }).install();

    const result = await createMachine(TOKEN, APP, session);

    expect(result.id).toBe("machine-123");
    expect(result.name).toBe(session.name);
    expect(fly.calls[0].url.href).toBe(MACHINES_URL);
    expect(JSON.parse(fly.calls[0].body)).toEqual(session);
  });

  it("sends correct auth header", async () => {
    const fly = fakeFetch({ [`POST ${MACHINES}`]: { json: flyMachine(session, "created") } }).install();

    await createMachine(TOKEN, APP, session);

    expect(fly.calls[0].headers.get("Authorization")).toBe("Bearer fly-test-token");
  });

  it("throws on error response", async () => {
    fakeFetch({ [`POST ${MACHINES}`]: { status: 422, text: "invalid config" } }).install();

    await expect(createMachine(TOKEN, APP, session))
      .rejects.toThrow("Failed to create machine in ai-implement-sessions-test (422): invalid config");
  });
});

describe("getMachine", () => {
  it("fetches machine by ID", async () => {
    const fly = fakeFetch({ [`GET ${MACHINE}`]: { json: mockMachine } }).install();

    const result = await getMachine(TOKEN, APP, "machine-123");
    expect(result.id).toBe("machine-123");
    expect(result.state).toBe("started");
    expect(fly.calls[0].url.href).toBe(MACHINE_URL);
  });

  it("throws on 404", async () => {
    fakeFetch({ [`GET ${MACHINES}/nonexistent`]: { status: 404, text: "not found" } }).install();

    await expect(getMachine(TOKEN, APP, "nonexistent"))
      .rejects.toThrow("Failed to get machine nonexistent (404)");
  });
});

describe("listMachines", () => {
  it("returns array of machines", async () => {
    const fly = fakeFetch({ [`GET ${MACHINES}`]: { json: [mockMachine] } }).install();

    const result = await listMachines(TOKEN, APP);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("machine-123");
    expect(fly.calls[0].url.href).toBe(MACHINES_URL);
  });

  it("returns empty array when no machines", async () => {
    fakeFetch({ [`GET ${MACHINES}`]: { json: [] } }).install();

    const result = await listMachines(TOKEN, APP);
    expect(result).toHaveLength(0);
  });
});

describe("stopMachine", () => {
  it("sends POST to stop endpoint", async () => {
    const fly = fakeFetch({ [`POST ${MACHINE}/stop`]: {} }).install();

    await stopMachine(TOKEN, APP, "machine-123");

    expect(fly.calls[0].url.href).toBe(`${MACHINE_URL}/stop`);
  });

  it("throws on error", async () => {
    fakeFetch({ [`POST ${MACHINE}/stop`]: { status: 409, text: "machine not running" } }).install();

    await expect(stopMachine(TOKEN, APP, "machine-123"))
      .rejects.toThrow("Failed to stop machine machine-123 (409)");
  });
});

describe("destroyMachine", () => {
  it("sends DELETE with force=true by default", async () => {
    const fly = fakeFetch({ [`DELETE ${MACHINE}`]: {} }).install();

    await destroyMachine(TOKEN, APP, "machine-123");

    expect(fly.calls[0].url.href).toBe(`${MACHINE_URL}?force=true`);
  });

  it("sends DELETE with force=false when specified", async () => {
    const fly = fakeFetch({ [`DELETE ${MACHINE}`]: {} }).install();

    await destroyMachine(TOKEN, APP, "machine-123", false);

    expect(fly.calls[0].url.href).toBe(`${MACHINE_URL}?force=false`);
  });

  it("throws on error", async () => {
    fakeFetch({ [`DELETE ${MACHINE}`]: { status: 404, text: "not found" } }).install();

    await expect(destroyMachine(TOKEN, APP, "machine-123"))
      .rejects.toThrow("Failed to destroy machine machine-123 (404)");
  });
});

describe("waitForMachine", () => {
  it("sends GET with state and timeout params", async () => {
    const fly = fakeFetch({ [`GET ${MACHINE}/wait`]: {} }).install();

    await waitForMachine(TOKEN, APP, "machine-123", "started", 30);

    expect(fly.calls[0].url.href).toBe(`${MACHINE_URL}/wait?state=started&timeout=30`);
  });

  it("uses default 60s timeout", async () => {
    const fly = fakeFetch({ [`GET ${MACHINE}/wait`]: {} }).install();

    // As the kept runner's dispatch waits: for the replaced instance to stop. Fly requires the instance id for "stopped".
    await waitForMachine(TOKEN, APP, "machine-123", "stopped", undefined, UPDATED_INSTANCE);

    expect(fly.calls[0].url.href).toBe(`${MACHINE_URL}/wait?instance_id=${UPDATED_INSTANCE}&state=stopped&timeout=60`);
  });

  it("throws on timeout", async () => {
    fakeFetch({ [`GET ${MACHINE}/wait`]: { status: 408, text: "timeout" } }).install();

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
  it("returns array of secrets with name/digest/created_at via GraphQL", async () => {
    const secrets = [
      { name: "ENG_DATABASE_URL", digest: "abc123", createdAt: "2026-01-01T00:00:00Z" },
      { name: "ENG_STRIPE_KEY", digest: "def456", createdAt: "2026-01-02T00:00:00Z" },
    ];
    const fly = fakeFetch({ "POST /graphql": { json: { data: { app: { secrets } } } } }).install();

    const result = await listAppSecrets(TOKEN, APP);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("ENG_DATABASE_URL");
    expect(result[0].created_at).toBe("2026-01-01T00:00:00Z");

    expect(fly.calls[0].url.href).toBe("https://api.fly.io/graphql");
    const body = JSON.parse(fly.calls[0].body);
    expect(body.variables.appName).toBe(APP);
  });

  it("returns empty array when app has no secrets", async () => {
    fakeFetch({ "POST /graphql": { json: { data: { app: { secrets: [] } } } } }).install();

    const result = await listAppSecrets(TOKEN, APP);
    expect(result).toEqual([]);
  });

  it("returns empty array when app is null", async () => {
    fakeFetch({ "POST /graphql": { json: { data: { app: null } } } }).install();

    const result = await listAppSecrets(TOKEN, APP);
    expect(result).toEqual([]);
  });

  it("throws on HTTP error response", async () => {
    fakeFetch({ "POST /graphql": { status: 403, text: "forbidden" } }).install();

    await expect(listAppSecrets(TOKEN, APP))
      .rejects.toThrow("Fly API request failed (403): forbidden");
  });
});

describe("setAppSecrets", () => {
  it("sends GraphQL mutation with secrets and returns null version", async () => {
    const fly = fakeFetch({ "POST /graphql": { json: { data: { setSecrets: { release: { version: 42 } } } } } }).install();

    const version = await setAppSecrets(TOKEN, APP, { ENG_DATABASE_URL: "postgres://localhost/db" });

    expect(fly.calls[0].url.href).toBe("https://api.fly.io/graphql");
    expect(version).toBeNull();

    const body = JSON.parse(fly.calls[0].body);
    expect(body.variables.input.appId).toBe(APP);
    expect(body.variables.input.secrets[0].key).toBe("ENG_DATABASE_URL");
    expect(body.variables.input.secrets[0].value).toBe("postgres://localhost/db");
  });

  it("throws on HTTP error response", async () => {
    fakeFetch({ "POST /graphql": { status: 422, text: "invalid secret name" } }).install();

    await expect(setAppSecrets(TOKEN, APP, { BAD: "val" }))
      .rejects.toThrow("Fly API request failed (422): invalid secret name");
  });
});

describe("unsetAppSecret", () => {
  it("sends GraphQL mutation to unset secret and returns null version", async () => {
    const fly = fakeFetch({ "POST /graphql": { json: { data: { unsetSecrets: { release: { version: 43 } } } } } }).install();

    const version = await unsetAppSecret(TOKEN, APP, "ENG_DATABASE_URL");

    expect(fly.calls[0].url.href).toBe("https://api.fly.io/graphql");
    expect(version).toBeNull();

    const body = JSON.parse(fly.calls[0].body);
    expect(body.variables.input.appId).toBe(APP);
    expect(body.variables.input.keys[0]).toBe("ENG_DATABASE_URL");
  });

  it("throws on HTTP error response", async () => {
    fakeFetch({ "POST /graphql": { status: 500, text: "internal server error" } }).install();

    await expect(unsetAppSecret(TOKEN, APP, "MISSING_SECRET"))
      .rejects.toThrow("Fly API request failed (500): internal server error");
  });

  it("throws when GraphQL reports the secret was not found", async () => {
    fakeFetch({ "POST /graphql": { json: { errors: [{ message: "Could not find secret MISSING_SECRET" }] } } }).install();

    await expect(unsetAppSecret(TOKEN, APP, "MISSING_SECRET"))
      .rejects.toThrow("Could not find secret MISSING_SECRET");
  });

  it("throws on any GraphQL error", async () => {
    fakeFetch({ "POST /graphql": { json: { errors: [{ message: "Unauthorized" }] } } }).install();

    await expect(unsetAppSecret(TOKEN, APP, "ENG_DATABASE_URL"))
      .rejects.toThrow("Unauthorized");
  });
});

describe("buildSessionMachineConfig", () => {
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
    expect(env.GITHUB_TOKEN).toBe("ghs_test_token");
    // The App private key must never reach a runner — only the short-lived install token.
    expect(env.GITHUB_APP_ID).toBeUndefined();
    expect(env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(env.SESSION_MODE).toBe("autonomous");
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

  it("allows performance cpu kind", () => {
    // Only the kg-refresh sender passes a cpu kind, from the kept runner's profile.
    const result = buildSessionMachineConfig(kgRefreshInput);
    expect(result.config.guest).toEqual({ cpu_kind: "performance", cpus: 2, memory_mb: 4096 });
  });

  it("allows custom guest spec", () => {
    const result = buildSessionMachineConfig({ ...baseInput, cpus: 2, memoryMb: 2048 });
    expect(result.config.guest).toEqual({ cpu_kind: "shared", cpus: 2, memory_mb: 2048 });
  });

  it("generates sanitized machine name from issue identifier", () => {
    const result = buildSessionMachineConfig(baseInput);
    expect(result.name).toBe("session-eng-42");
  });

  it("uses an explicit machineName instead of the issue-key name", () => {
    // Only a planning launch names its machine, after its dispatch id (planningSessionName).
    expect(buildSessionMachineConfig({ ...baseInput, phase: "planning", machineName: "planning-d-1" }).name).toBe("planning-d-1");
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

  it("defaults RUNNER_PHASE to implementation", () => {
    const result = buildSessionMachineConfig(baseInput);
    expect(result.config.env!.RUNNER_PHASE).toBe("implementation");
  });

  it("sets RUNNER_PHASE=planning when phase is planning", () => {
    const result = buildSessionMachineConfig({ ...baseInput, phase: "planning" });
    expect(result.config.env!.RUNNER_PHASE).toBe("planning");
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

  it("stamps purpose, pipeline and dispatch_id for a durable runner", () => {
    const result = buildSessionMachineConfig(kgRefreshInput);
    expect(result.config.metadata).toMatchObject({ purpose: "durable-runner", pipeline: "kg-refresh", dispatch_id: "d1" });
  });

  it("leaves pipeline and dispatch_id out of a default session machine", () => {
    const metadata = buildSessionMachineConfig(baseInput).config.metadata!;
    expect(metadata.purpose).toBe("session");
    expect(metadata).not.toHaveProperty("pipeline");
    expect(metadata).not.toHaveProperty("dispatch_id");
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

  it("separates foreign secrets from global secrets: own remapped, foreign listed for unset, global absent", () => {
    // SAN_QA_PROBE = own-team (prefix SAN_), ENG_DB_URL = foreign (team ENG), NPM_TOKEN = global (no team prefix)
    const result = buildSessionMachineConfig({
      ...baseInput,
      teamKey: "SAN",
      allTeamKeys: ["SAN", "ENG"],
      teamSecretNames: ["SAN_QA_PROBE", "ENG_DB_URL", "NPM_TOKEN"],
    });
    expect(result.config.env!.AI_IMPLEMENT_TEAM_SECRET_PREFIX).toBe("SAN_");
    // Foreign: ENG_DB_URL (starts with ENG_). Global NPM_TOKEN is absent from both lists.
    expect(result.config.env!.AI_IMPLEMENT_FOREIGN_SECRET_NAMES).toBe("ENG_DB_URL");
    expect(result.config.env!.AI_IMPLEMENT_ALL_SECRET_NAMES).toBeUndefined();
    expect(result.config.processes).toBeUndefined();
  });

  it("omits FOREIGN_SECRET_NAMES when teamSecretNames is empty", () => {
    const result = buildSessionMachineConfig({
      ...baseInput,
      teamKey: "ENG",
      allTeamKeys: ["ENG", "SAN"],
      teamSecretNames: [],
    });
    expect(result.config.env!.AI_IMPLEMENT_TEAM_SECRET_PREFIX).toBeUndefined();
    expect(result.config.env!.AI_IMPLEMENT_FOREIGN_SECRET_NAMES).toBeUndefined();
    expect(result.config.env!.AI_IMPLEMENT_ALL_SECRET_NAMES).toBeUndefined();
    expect(result.config.processes).toBeUndefined();
  });

  it("omits FOREIGN_SECRET_NAMES when all secret names belong to own team (no cross-team names)", () => {
    const result = buildSessionMachineConfig({
      ...baseInput,
      teamKey: "ENG",
      allTeamKeys: ["ENG", "SAN"],
      teamSecretNames: ["ENG_DATABASE_URL", "ENG_STRIPE_KEY"],
    });
    expect(result.config.env!.AI_IMPLEMENT_TEAM_SECRET_PREFIX).toBe("ENG_");
    expect(result.config.env!.AI_IMPLEMENT_FOREIGN_SECRET_NAMES).toBeUndefined();
    expect(result.config.processes).toBeUndefined();
  });

  it("lists only cross-team names in FOREIGN_SECRET_NAMES when no own-team names are present", () => {
    const result = buildSessionMachineConfig({
      ...baseInput,
      teamKey: "ENG",
      allTeamKeys: ["ENG", "SAN"],
      teamSecretNames: ["SAN_QA_PROBE"],
    });
    expect(result.config.env!.AI_IMPLEMENT_TEAM_SECRET_PREFIX).toBe("ENG_");
    expect(result.config.env!.AI_IMPLEMENT_FOREIGN_SECRET_NAMES).toBe("SAN_QA_PROBE");
    expect(result.config.processes).toBeUndefined();
  });

  it("omits team secret env vars when teamKey is not provided", () => {
    const result = buildSessionMachineConfig({
      ...baseInput,
      teamSecretNames: ["ENG_DATABASE_URL"],
      allTeamKeys: ["ENG"],
    });
    expect(result.config.env!.AI_IMPLEMENT_TEAM_SECRET_PREFIX).toBeUndefined();
    expect(result.config.env!.AI_IMPLEMENT_FOREIGN_SECRET_NAMES).toBeUndefined();
    expect(result.config.env!.AI_IMPLEMENT_ALL_SECRET_NAMES).toBeUndefined();
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

  it("injects runner callback env when provided", () => {
    // Production sets the callback URL, the run token and the orchestrator URL together.
    const result = buildSessionMachineConfig({
      ...baseInput,
      orchestratorUrl: ORCH,
      runnerCallbackUrl: ORCH,
      runToken: "run-token",
    });
    expect(result.config.env!.RUNNER_CALLBACK_URL).toBe("https://orchestrator.example");
    expect(result.config.env!.RUN_TOKEN).toBe("run-token");
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

  describe("AI_IMPLEMENT_RUN_CONFIG envelope", () => {
    // An implementation dispatch's envelope and flat variables, built as the Fly dispatch builds them (src/index.ts).
    const implMapping = makeMapping({
      owner: "test-org", repo: "test-repo", defaultBranch: "main",
      maxTurns: 30, maxIterations: 2, branchPrefix: "pr", skillsRepo: "https://github.com/org/skills",
    });
    const implEnvelope = buildImplRunConfig({
      issue: { id: "uuid-123", identifier: "ENG-42", title: "Add feature X", description: "Implement the feature" },
      mapping: implMapping,
      baseBranch: implMapping.defaultBranch,
      runnerCallbackUrl: ORCH,
      retryPolicy: DEFAULT_RETRY_POLICY,
    });
    const implInput: SessionMachineInput = {
      ...baseInput,
      orchestratorUrl: ORCH,
      runnerCallbackUrl: ORCH,
      runToken: "run-tok",
      extraEnv: {
        ...capRunnerEnv(implMapping),
        ...branchPrefixRunnerEnv(implMapping),
        ...skillsRepoRunnerEnv(implMapping),
        AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig(implEnvelope),
      },
    };

    it("passes through AI_IMPLEMENT_RUN_CONFIG from extraEnv and is decodable", () => {
      const result = buildSessionMachineConfig(implInput);
      const env = result.config.env!;

      expect(env.AI_IMPLEMENT_RUN_CONFIG).toBeDefined();
      const decoded = decodeRunConfig(env.AI_IMPLEMENT_RUN_CONFIG);
      expect(decoded.issue.id).toBe("uuid-123");
      expect(decoded.issue.identifier).toBe("ENG-42");
      expect(decoded.maxTurns).toBe(30);
      expect(decoded.maxIterations).toBe(2);
      expect(decoded.branchPrefix).toBe("pr");
      expect(decoded.skillsRepo).toBe("https://github.com/org/skills");
      expect(decoded.runnerCallbackUrl).toBe(ORCH);
      expect(decoded.runnerPhase).toBe("implementation");
    });

    it("flat legacy vars remain alongside the envelope", () => {
      const result = buildSessionMachineConfig(implInput);
      const env = result.config.env!;

      expect(env.ISSUE_ID).toBe("uuid-123");
      expect(env.RUNNER_CALLBACK_URL).toBe(ORCH);
      expect(env.AI_IMPLEMENT_MAX_TURNS).toBe("30");
      expect(env.AI_IMPLEMENT_BRANCH_PREFIX).toBe("pr");
      expect(env.AI_IMPLEMENT_SKILLS_REPO).toBe("https://github.com/org/skills");
      expect(env.AI_IMPLEMENT_RUN_CONFIG).toBeDefined();
    });

    it("planning session envelope has runnerPhase=planning and no branchPrefix/skillsRepo", () => {
      // No exported builder makes the planning envelope (planning-launch.ts builds it inline); this mirrors that
      // build, which always carries planningContext from the same source as the PARENT/SIBLINGS/DEPENDENCIES variables.
      const planningConfig: RunConfigV1 = {
        v: 1,
        issue: { id: "uuid-123", identifier: "ENG-42", title: "Add feature X", description: "Implement the feature" },
        runnerPhase: "planning",
        maxTurns: 20,
        runnerCallbackUrl: ORCH,
        planningContext: { parent: "ENG-40", siblings: "", dependencies: "" },
      };
      const result = buildSessionMachineConfig({
        ...baseInput,
        phase: "planning",
        orchestratorUrl: ORCH,
        runnerCallbackUrl: ORCH,
        runToken: "run-tok",
        extraEnv: {
          PARENT: "ENG-40",
          SIBLINGS: "",
          DEPENDENCIES: "",
          ...capRunnerEnv(makeMapping({ maxTurns: 20 })),
          AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig(planningConfig),
        },
      });
      const env = result.config.env!;

      const decoded = decodeRunConfig(env.AI_IMPLEMENT_RUN_CONFIG);
      expect(decoded.runnerPhase).toBe("planning");
      expect(decoded.branchPrefix).toBeUndefined();
      expect(decoded.skillsRepo).toBeUndefined();
      expect(env.PARENT).toBe("ENG-40");
      expect(env.AI_IMPLEMENT_MAX_TURNS).toBe("20");
    });

    it("secrets are not present in the decoded envelope", () => {
      const result = buildSessionMachineConfig(implInput);
      const env = result.config.env!;
      const decoded = decodeRunConfig(env.AI_IMPLEMENT_RUN_CONFIG) as Record<string, unknown>;
      expect(decoded.SESSION_TOKEN).toBeUndefined();
      expect(decoded.GITHUB_TOKEN).toBeUndefined();
      expect(decoded.ANTHROPIC_API_KEY).toBeUndefined();
      expect(decoded.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });
  });

  describe("flyProcessLevelSecrets flag", () => {
    it("flag off (explicit false): output is byte-identical to today (no processes, AI_IMPLEMENT_* env vars set)", () => {
      const result = buildSessionMachineConfig({
        ...baseInput,
        teamKey: "SAN",
        allTeamKeys: ["SAN", "AII"],
        teamSecretNames: ["SAN_QA_PROBE", "AII_PROBE_FOREIGN", "NPM_TOKEN"],
        flyProcessLevelSecrets: false,
      });
      expect(result.config.processes).toBeUndefined();
      expect(result.config.env!.AI_IMPLEMENT_TEAM_SECRET_PREFIX).toBe("SAN_");
      expect(result.config.env!.AI_IMPLEMENT_FOREIGN_SECRET_NAMES).toBe("AII_PROBE_FOREIGN");
      expect(result.config.env!.AI_IMPLEMENT_FORWARDED_SECRETS).toBeUndefined();
    });

    it("flag on: acceptance criterion fixture — own remapped, foreign excluded, global passed through", () => {
      const result = buildSessionMachineConfig({
        ...baseInput,
        teamKey: "SAN",
        allTeamKeys: ["SAN", "AII"],
        teamSecretNames: ["SAN_QA_PROBE", "AII_PROBE_FOREIGN", "NPM_TOKEN"],
        flyProcessLevelSecrets: true,
      });
      expect(result.config.processes).toBeDefined();
      expect(result.config.processes![0].ignore_app_secrets).toBe(true);
      expect(result.config.processes![0].secrets).toEqual([
        { env_var: "QA_PROBE", name: "SAN_QA_PROBE" },
        { env_var: "NPM_TOKEN" },
      ]);
      expect(result.config.env!.AI_IMPLEMENT_TEAM_SECRET_PREFIX).toBeUndefined();
      expect(result.config.env!.AI_IMPLEMENT_FOREIGN_SECRET_NAMES).toBeUndefined();
      expect(result.config.env!.AI_IMPLEMENT_FORWARDED_SECRETS).toBe("QA_PROBE");
    });

    it("flag on: no teamKey → no processes", () => {
      const result = buildSessionMachineConfig({
        ...baseInput,
        teamSecretNames: ["NPM_TOKEN"],
        allTeamKeys: ["ENG"],
        flyProcessLevelSecrets: true,
      });
      expect(result.config.processes).toBeUndefined();
      expect(result.config.env!.AI_IMPLEMENT_FORWARDED_SECRETS).toBeUndefined();
    });

    it("flag on: own-team secrets only, no globals", () => {
      const result = buildSessionMachineConfig({
        ...baseInput,
        teamKey: "ENG",
        allTeamKeys: ["ENG", "SAN"],
        teamSecretNames: ["ENG_DATABASE_URL", "ENG_STRIPE_KEY"],
        flyProcessLevelSecrets: true,
      });
      expect(result.config.processes![0].ignore_app_secrets).toBe(true);
      expect(result.config.processes![0].secrets).toEqual([
        { env_var: "DATABASE_URL", name: "ENG_DATABASE_URL" },
        { env_var: "STRIPE_KEY", name: "ENG_STRIPE_KEY" },
      ]);
      expect(result.config.env!.AI_IMPLEMENT_FORWARDED_SECRETS).toBe("DATABASE_URL,STRIPE_KEY");
    });

    it("flag on: all foreign secrets → empty secrets list, FORWARDED_SECRETS unset", () => {
      const result = buildSessionMachineConfig({
        ...baseInput,
        teamKey: "SAN",
        allTeamKeys: ["SAN", "AII"],
        teamSecretNames: ["AII_PROBE_FOREIGN"],
        flyProcessLevelSecrets: true,
      });
      expect(result.config.processes![0].ignore_app_secrets).toBe(true);
      expect(result.config.processes![0].secrets).toEqual([]);
      expect(result.config.env!.AI_IMPLEMENT_FORWARDED_SECRETS).toBeUndefined();
    });

    it("flag on: teamSecretNames [] (fetch-failure fallback) → fail-closed: ignore_app_secrets true, secrets empty", () => {
      const result = buildSessionMachineConfig({
        ...baseInput,
        teamKey: "SAN",
        allTeamKeys: ["SAN", "AII"],
        teamSecretNames: [],
        flyProcessLevelSecrets: true,
      });
      expect(result.config.processes).toBeDefined();
      expect(result.config.processes![0].ignore_app_secrets).toBe(true);
      expect(result.config.processes![0].secrets).toEqual([]);
      expect(result.config.env!.AI_IMPLEMENT_FORWARDED_SECRETS).toBeUndefined();
    });

    it("flag on: extraEnv cannot override AI_IMPLEMENT_FORWARDED_SECRETS", () => {
      const result = buildSessionMachineConfig({
        ...baseInput,
        teamKey: "SAN",
        allTeamKeys: ["SAN", "AII"],
        teamSecretNames: ["SAN_QA_PROBE", "AII_PROBE_FOREIGN", "NPM_TOKEN"],
        flyProcessLevelSecrets: true,
        extraEnv: { AI_IMPLEMENT_FORWARDED_SECRETS: "ATTACKER_INJECTED" },
      });
      expect(result.config.env!.AI_IMPLEMENT_FORWARDED_SECRETS).toBe("QA_PROBE");
      expect(result.config.processes![0].secrets).toEqual([
        { env_var: "QA_PROBE", name: "SAN_QA_PROBE" },
        { env_var: "NPM_TOKEN" },
      ]);
    });
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
  it("sends POST to the metadata key endpoint with JSON value body", async () => {
    const fly = fakeFetch({ [`POST ${MACHINE}/metadata/pr_number`]: {} }).install();

    await updateMachineMetadata(TOKEN, APP, "machine-123", "pr_number", "42");

    expect(fly.calls[0].url.href).toBe(`${MACHINE_URL}/metadata/pr_number`);
    expect(fly.calls[0].body).toBe(JSON.stringify({ value: "42" }));
    expect(fly.calls[0].headers.get("Content-Type")).toBe("application/json");
    expect(fly.calls[0].headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("throws on error response", async () => {
    fakeFetch({ [`POST ${MACHINES}/machine-xyz/metadata/pr_number`]: { status: 404, text: "machine not found" } }).install();

    await expect(updateMachineMetadata(TOKEN, APP, "machine-xyz", "pr_number", "7"))
      .rejects.toThrow("updateMachineMetadata failed (404)");
  });

  it("stamps pr_number extracted from a GitHub PR URL", async () => {
    const fly = fakeFetch({ [`POST ${MACHINE}/metadata/pr_number`]: {} }).install();

    const prUrl = "https://github.com/org/repo/pull/99";
    const prNumberMatch = prUrl.match(/\/pull\/(\d+)$/);
    expect(prNumberMatch).not.toBeNull();

    await updateMachineMetadata(TOKEN, APP, "machine-123", "pr_number", prNumberMatch![1]);

    expect(fly.calls[0].body).toBe(JSON.stringify({ value: "99" }));
  });
});

describe("fetchMachineLogs", () => {
  const LOGS = `GET ${MACHINE}/logs` as const;

  it("appends ?lines=N to the URL to prevent streaming hang", async () => {
    const fly = fakeFetch({ [LOGS]: { text: '{"message":"hello"}\n{"message":"world"}\n' } }).install();

    await fetchMachineLogs(TOKEN, APP, "machine-123");

    expect(fly.calls[0].url.href).toBe(`${MACHINE_URL}/logs?lines=100`);
  });

  it("uses custom lastN when provided", async () => {
    const fly = fakeFetch({ [LOGS]: { text: '{"message":"line"}\n' } }).install();

    await fetchMachineLogs(TOKEN, APP, "machine-123", 50);

    expect(fly.calls[0].url.search).toBe("?lines=50");
  });

  it("parses NDJSON and extracts message fields", async () => {
    fakeFetch({ [LOGS]: { text: '{"message":"starting server"}\n{"message":"listening on :3000"}\n' } }).install();

    const result = await fetchMachineLogs(TOKEN, APP, "machine-123");
    expect(result).toBe("starting server\nlistening on :3000");
  });

  it("falls back to raw line when JSON parse fails", async () => {
    fakeFetch({ [LOGS]: { text: "not-json-at-all\n" } }).install();

    const result = await fetchMachineLogs(TOKEN, APP, "machine-123");
    expect(result).toBe("not-json-at-all");
  });

  it("falls back to raw line when parsed JSON has no message field", async () => {
    fakeFetch({ [LOGS]: { text: '{"level":"info","ts":1234}\n' } }).install();

    const result = await fetchMachineLogs(TOKEN, APP, "machine-123");
    expect(result).toBe('{"level":"info","ts":1234}');
  });

  it("returns empty string for blank body", async () => {
    fakeFetch({ [LOGS]: { text: "   \n  " } }).install();

    const result = await fetchMachineLogs(TOKEN, APP, "machine-123");
    expect(result).toBe("");
  });

  it("throws on error response", async () => {
    fakeFetch({ [LOGS]: { status: 404, text: "not found" } }).install();

    await expect(fetchMachineLogs(TOKEN, APP, "machine-123"))
      .rejects.toThrow("Failed to fetch logs for machine machine-123 (404)");
  });
});

describe("readMachineExit", () => {
  const withEvents = (events?: MachineEvent[]): Machine => ({ ...mockMachine, events });
  const nulls = { exitCode: null, signal: null, oomKilled: null, timestamp: null };

  it("returns all-null for missing or empty events", () => {
    expect(readMachineExit(withEvents(undefined))).toEqual(nulls);
    expect(readMachineExit(withEvents([]))).toEqual(nulls);
  });

  it("reads exit code, signal, oom flag, and timestamp from the first exit event", () => {
    const m = withEvents([
      { type: "start", timestamp: 9 },
      { type: "crash", timestamp: 5, request: { exit_event: { exit_code: -1, guest_signal: 9, oom_killed: true } } },
      { type: "exit", timestamp: 1, request: { exit_event: { exit_code: 3 } } },
    ]);
    expect(readMachineExit(m)).toEqual({ exitCode: -1, signal: 9, oomKilled: true, timestamp: 5 });
  });

  it("leaves exitCode null for a clean exit", () => {
    expect(readMachineExit(withEvents([{ type: "exit", timestamp: 2, request: { exit_event: {} } }])))
      .toEqual({ exitCode: null, signal: null, oomKilled: null, timestamp: 2 });
  });
});

describe("startMachine / updateMachine (AII-1123)", () => {
  it("startMachine posts to /start with no body", async () => {
    const fly = fakeFetch({ [`POST ${MACHINE}/start`]: {} }).install();
    await startMachine(TOKEN, APP, "machine-123");
    expect(fly.calls[0].url.href).toBe(`${MACHINE_URL}/start`);
    expect(fly.calls[0].body).toBe("");
  });

  it("startMachine throws with status and body", async () => {
    // The 412 Fly sends a start during the replace window (docs/fly-machine-lifecycle.md), which its caller matches on.
    fakeFetch({ [`POST ${MACHINE}/start`]: { status: 412, text: "machine getting replaced" } }).install();
    await expect(startMachine(TOKEN, APP, "machine-123"))
      .rejects.toThrow("Failed to start machine machine-123 (412): machine getting replaced");
  });

  it("updateMachine posts { config } and returns the machine", async () => {
    // Fly answers an update with the machine on its new instance, which its caller then waits on.
    const fly = fakeFetch({ [`POST ${MACHINE}`]: { json: { ...mockMachine, state: "starting", instance_id: UPDATED_INSTANCE } } }).install();
    const result = await updateMachine(TOKEN, APP, "machine-123", mockMachine.config);
    expect(result.id).toBe("machine-123");
    expect(result.instance_id).toBe(UPDATED_INSTANCE);
    expect(fly.calls[0].url.href).toBe(MACHINE_URL);
    expect(JSON.parse(fly.calls[0].body)).toEqual({ config: mockMachine.config });
  });

  it("updateMachine throws with status and body", async () => {
    fakeFetch({ [`POST ${MACHINE}`]: { status: 422, text: "invalid config" } }).install();
    await expect(updateMachine(TOKEN, APP, "machine-123", mockMachine.config))
      .rejects.toThrow("Failed to update machine machine-123 (422): invalid config");
  });
});

// clearMachineEnv reads the machine (GET), updates it (POST) and reads it back (GET), all on the machine's path,
// so each test lists the GET replies in read order and the POST replies in update order.
// Its one production caller, FlyMachineProfile.release, scrubs the kg-refresh pipeline's kept runner once it has
// stopped, stamping a durable_until in epoch seconds, with the settle options below.
describe("clearMachineEnv", () => {
  afterEach(() => { vi.useRealTimers(); });

  const READ = `GET ${MACHINE}` as const;
  const UPDATE = `POST ${MACHINE}` as const;
  const ok = (body: unknown): ReplyInit => ({ json: body });
  const fail = (status: number, text: string, headers: Record<string, string> = {}): ReplyInit => ({ status, text, headers });
  const SCRUB: SettleOptions = { until: ["stopped", "destroyed"], timeoutMs: SCRUB_SETTLE_MS, intervalMs: 1 };
  const DURABLE = { [DURABLE_UNTIL_KEY]: "1792000000" };
  // The kept runner after its run: stopped, its env still holding the run's credentials.
  const kept = flyMachine(buildSessionMachineConfig(kgRefreshInput), "stopped");
  // The same machine once Fly has applied a scrub carrying `metadata`.
  const scrubbed = (m: Machine, metadata: Record<string, string> = DURABLE): Machine =>
    ({ ...m, config: { ...m.config, env: {}, metadata: { ...m.config.metadata, ...metadata } } });

  it("settles, posts the same config with env: {}, reads back; never starts it", async () => {
    const fly = fakeFetch({
      [READ]: [ok(kept), ok(scrubbed(kept))],
      [UPDATE]: [ok(kept)],
    }).install();

    await clearMachineEnv(TOKEN, APP, "machine-123", DURABLE, SCRUB);

    // The strict routes also prove nothing called /start.
    expect(fly.calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
    expect(fly.calls[0].url.href).toBe(MACHINE_URL);
    expect(JSON.parse(fly.calls[1].body)).toEqual({ config: scrubbed(kept).config });
  });

  it("waits out `replacing` reads, then makes exactly one update", async () => {
    const replacing = { ...kept, state: "replacing" };
    const fly = fakeFetch({
      [READ]: [ok(replacing), ok(replacing), ok(kept), ok(scrubbed(kept))],
      [UPDATE]: [ok(kept)],
    }).install();
    await clearMachineEnv(TOKEN, APP, "machine-123", DURABLE, SCRUB);
    expect(fly.calls.map((c) => c.method)).toEqual(["GET", "GET", "GET", "POST", "GET"]);
  });

  it("merges metadata into the one update, never calls the metadata endpoint, and verifies it", async () => {
    // A runner kept before: its metadata already carries an earlier durable_until, which the scrub replaces.
    const m = { ...kept, config: { ...kept.config, metadata: { ...kept.config.metadata, [DURABLE_UNTIL_KEY]: "1791000000" } } };
    const fly = fakeFetch({ [READ]: [ok(m), ok(scrubbed(m))], [UPDATE]: [ok(m)] }).install();

    await clearMachineEnv(TOKEN, APP, "machine-123", DURABLE, SCRUB);

    // No /metadata route exists, so a call to it would fail the test.
    expect(JSON.parse(fly.calls[1].body)).toEqual({
      config: { ...m.config, env: {}, metadata: { ...kept.config.metadata, [DURABLE_UNTIL_KEY]: "1792000000" } },
    });
  });

  it("adds metadata when the machine has none", async () => {
    const m = { ...kept, config: { ...kept.config, metadata: undefined } };
    const fly = fakeFetch({ [READ]: [ok(m), ok(scrubbed(m))], [UPDATE]: [ok(m)] }).install();
    await clearMachineEnv(TOKEN, APP, "machine-123", DURABLE, SCRUB);
    const body = JSON.parse(fly.calls[1].body);
    expect(body.config.metadata).toEqual(DURABLE);
  });

  it("treats a 409 concurrent update as a wait and succeeds once the env is clear", async () => {
    const fly = fakeFetch({
      [READ]: [ok(kept), ok(scrubbed(kept))],
      [UPDATE]: [fail(409, '{"error":"aborted: machine is replacing: concurrent update in progress"}')],
    }).install();
    await expect(clearMachineEnv(TOKEN, APP, "machine-123", DURABLE, SCRUB)).resolves.toBeUndefined();
    expect(fly.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("waits the retry-after interval on a 429, then re-reads", async () => {
    vi.useFakeTimers();
    const fly = fakeFetch({
      [READ]: [ok(kept), ok(scrubbed(kept))],
      [UPDATE]: [fail(429, "resource_exhausted: rate limit exceeded", { "retry-after": "7" })],
    }).install();
    const p = clearMachineEnv(TOKEN, APP, "machine-123", DURABLE, SCRUB);
    await vi.advanceTimersByTimeAsync(6_900);
    expect(fly.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toBeUndefined();
  });

  it("caps a 429 retry-after at the maximum wait", async () => {
    vi.useFakeTimers();
    const fly = fakeFetch({
      [READ]: [ok(kept), ok(scrubbed(kept))],
      [UPDATE]: [fail(429, "rate limit", { "retry-after": "3600" })],
    }).install();
    const p = clearMachineEnv(TOKEN, APP, "machine-123", DURABLE, SCRUB);
    await vi.advanceTimersByTimeAsync(MAX_RATE_LIMIT_WAIT_MS - 100);
    expect(fly.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toBeUndefined();
  });

  it("treats a 409 'machine is replacing' without the concurrent-update text as a wait", async () => {
    fakeFetch({ [READ]: [ok(kept), ok(scrubbed(kept))], [UPDATE]: [fail(409, '{"error":"machine is replacing"}')] }).install();
    await expect(clearMachineEnv(TOKEN, APP, "machine-123", DURABLE, SCRUB)).resolves.toBeUndefined();
  });

  it("still throws on an unrelated 409", async () => {
    fakeFetch({ [READ]: [ok(kept)], [UPDATE]: [fail(409, '{"error":"something else"}')] }).install();
    await expect(clearMachineEnv(TOKEN, APP, "machine-123", DURABLE, SCRUB)).rejects.toThrow(/409/);
  });

  it("waits 2 s on a 429 without retry-after", async () => {
    vi.useFakeTimers();
    const fly = fakeFetch({ [READ]: [ok(kept), ok(scrubbed(kept))], [UPDATE]: [fail(429, "rate limit")] }).install();
    const p = clearMachineEnv(TOKEN, APP, "machine-123", DURABLE, SCRUB);
    await vi.advanceTimersByTimeAsync(1_900);
    expect(fly.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toBeUndefined();
  });

  it("with until: stopped, sends the update only after the machine reads stopped", async () => {
    const started = { ...kept, state: "started" };
    const fly = fakeFetch({
      [READ]: [ok(started), ok(kept), ok(scrubbed(kept))],
      [UPDATE]: [ok(kept)],
    }).install();

    await clearMachineEnv(TOKEN, APP, "machine-123", DURABLE, SCRUB);

    expect(fly.calls.map((c) => c.method)).toEqual(["GET", "GET", "POST", "GET"]);
  });

  it("with until: stopped, a machine that stays started times out with no update sent", async () => {
    const started = { ...kept, state: "started" };
    // No update route: an update would fail the test.
    const fly = fakeFetch({ [READ]: ok(started) }).install();
    await expect(
      clearMachineEnv(TOKEN, APP, "machine-123", DURABLE, { ...SCRUB, timeoutMs: 20 }),
    ).rejects.toThrow(/machine-123.*state=started/);
    expect(fly.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("throws naming the machine and state when the env never clears", async () => {
    fakeFetch({ [READ]: ok(kept), [UPDATE]: ok(kept) }).install();
    await expect(clearMachineEnv(TOKEN, APP, "machine-123", DURABLE, SCRUB)).rejects.toThrow(/machine-123.*state=stopped/);
  });

  it("skips the update when the env is already clear and the metadata present", async () => {
    const fly = fakeFetch({ [READ]: [ok(scrubbed(kept))] }).install();
    await clearMachineEnv(TOKEN, APP, "machine-123", DURABLE, SCRUB);
    expect(fly.calls).toHaveLength(1);
  });

  it("throws when the read fails, without posting", async () => {
    const fly = fakeFetch({ [READ]: [fail(404, "gone")] }).install();
    await expect(clearMachineEnv(TOKEN, APP, "machine-123", DURABLE, SCRUB)).rejects.toThrow("(404)");
    expect(fly.calls).toHaveLength(1);
  });

  it("ends at once, without polling, on a machine Fly reports as destroyed", async () => {
    const fly = fakeFetch({ [READ]: [ok({ ...kept, state: "destroyed" })] }).install();
    await expect(clearMachineEnv(TOKEN, APP, "machine-123", DURABLE, SCRUB)).rejects.toThrow(/gone before the scrub/);
    expect(fly.calls).toHaveLength(1);
  });

  it("throws when the update fails with a non-wait status", async () => {
    fakeFetch({ [READ]: [ok(kept)], [UPDATE]: [fail(500, "boom")] }).install();
    await expect(clearMachineEnv(TOKEN, APP, "machine-123", DURABLE, SCRUB)).rejects.toThrow("(500)");
  });
});

describe("waitForMachineSettled", () => {
  it("returns null when the machine is gone", async () => {
    fakeFetch({ [`GET ${MACHINES}/m`]: { status: 404, text: "nope" } }).install();
    expect(await waitForMachineSettled(TOKEN, APP, "m", { intervalMs: 1 })).toBeNull();
  });

  it("throws on timeout naming the machine and the state", async () => {
    fakeFetch({ [`GET ${MACHINE}`]: { json: { ...mockMachine, state: "replacing" } } }).install();
    await expect(waitForMachineSettled(TOKEN, APP, "machine-123", { intervalMs: 5, timeoutMs: 20 })).rejects.toThrow(/machine-123.*replacing/);
  });
});
