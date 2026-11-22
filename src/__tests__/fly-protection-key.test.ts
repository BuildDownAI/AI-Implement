import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as KeyModule from "../fly-protection-key.js";
import { MODEL_AUTH_ENV } from "../model-auth-contract.js";
import { deriveModelAuthProtectionKey } from "../model-session-keys.js";
import { buildSessionMachineConfig } from "../fly-machines.js";
import { buildImplRunConfig } from "../run-config.js";
import { DEFAULT_RETRY_POLICY } from "../pipeline/retry-backoff.js";
import { makeIssue, makeMapping } from "./helpers/builders.js";
import { fakeFetch, type FakeFetch, type Reply } from "./helpers/fake-fetch.js";
import { makeGrant, makeSnapshot } from "./helpers/fixtures/configured-run.js";
import { flySecretsUpdated } from "./helpers/replies/fly.js";
import { testDb } from "./helpers/test-db.js";

let mod: typeof KeyModule;
const SECRET_A = "runner-token-secret-A-0123456789";
const SECRET_B = "runner-token-secret-B-0123456789";

const keyB64 = (secret: string) => deriveModelAuthProtectionKey({ RUNNER_TOKEN_SECRET: secret } as NodeJS.ProcessEnv)!.toString("base64url");

/** Fly's secrets endpoint for `app`, answering each write with the next of `replies`. */
const flySecrets = (app: string, ...replies: Reply[]): FakeFetch =>
  fakeFetch({ [`POST /v1/apps/${app}/secrets` as const]: replies }).install();

beforeEach(async () => {
  vi.stubEnv("RUNNER_TOKEN_SECRET", SECRET_A);
  ({ mod } = (await testDb({ modules: { mod: () => import("../fly-protection-key.js") } })).modules);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("ensureProtectionKeySecret", () => {
  it("writes once, then reuses the stored version", async () => {
    const fly = flySecrets("sessions", flySecretsUpdated(5));
    const first = await mod.ensureProtectionKeySecret({ token: "t", app: "sessions" });
    const second = await mod.ensureProtectionKeySecret({ token: "t", app: "sessions" });
    expect(first).toEqual({ name: MODEL_AUTH_ENV.protectionKey, available: true, version: 5 });
    expect(second).toEqual(first);
    expect(fly.calls).toHaveLength(1);
    expect(fly.calls[0]!.url.href).toBe("https://api.machines.dev/v1/apps/sessions/secrets");
    expect(JSON.parse(fly.calls[0]!.body)).toEqual({
      values: { [MODEL_AUTH_ENV.protectionKey]: keyB64(SECRET_A) },
    });
  });

  it("writes again when RUNNER_TOKEN_SECRET changes", async () => {
    const fly = flySecrets("s", flySecretsUpdated(5), flySecretsUpdated(6));
    await mod.ensureProtectionKeySecret({ token: "t", app: "s" });
    vi.stubEnv("RUNNER_TOKEN_SECRET", SECRET_B);
    const r = await mod.ensureProtectionKeySecret({ token: "t", app: "s" });
    expect(r.version).toBe(6);
    expect(fly.calls).toHaveLength(2);
  });

  it("throws value-free errors and logs no key", async () => {
    flySecrets("s", { status: 500, text: keyB64(SECRET_A) }, { json: {} }, flySecretsUpdated(2));
    const err = await mod.ensureProtectionKeySecret({ token: "t", app: "s" }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(keyB64(SECRET_A));
    await expect(mod.ensureProtectionKeySecret({ token: "t", app: "s" })).rejects.toThrow(/version/);
    await mod.ensureProtectionKeySecret({ token: "t", app: "s" });
    const logged = JSON.stringify(vi.mocked(console.log).mock.calls);
    expect(logged).toContain("version 2");
    expect(logged).not.toContain(keyB64(SECRET_A));
  });

  it("rejects when RUNNER_TOKEN_SECRET is unset", async () => {
    vi.stubEnv("RUNNER_TOKEN_SECRET", undefined);
    const fly = fakeFetch({}).install();
    await expect(mod.ensureProtectionKeySecret({ token: "t", app: "s" })).rejects.toThrow(/protection_key_unavailable/);
    expect(fly.calls).toHaveLength(0);
  });
});

describe("buildProtectedFlyBootstrap", () => {
  it("returns builder input that passes validation end to end", async () => {
    flySecrets("s", flySecretsUpdated(9));
    // As dispatchFlyMachine builds them: the envelope carries the snapshot, and the project is the issue's scope.
    const issue = makeIssue();
    const mapping = makeMapping({ executionMode: "fly-machines" });
    const snapshot = makeSnapshot("codex-subscription");
    const runConfig = buildImplRunConfig({ issue, mapping, baseBranch: "main", retryPolicy: DEFAULT_RETRY_POLICY, agentConfig: snapshot });
    const bootstrap = makeGrant(snapshot, { dispatchId: "d1", projectKey: issue.scopeKey });
    const pb = await mod.buildProtectedFlyBootstrap({
      token: "t", app: "s", bootstrap, projectKey: issue.scopeKey, runConfig, modelAuthUrl: "https://orch.example/model-auth",
    });
    const cfg = buildSessionMachineConfig({
      image: "img", issueId: issue.id, issueIdentifier: issue.identifier, issueTitle: issue.title, issueDescription: issue.title,
      owner: mapping.owner, repo: mapping.repo, defaultBranch: mapping.defaultBranch,
      githubToken: "gt", sessionToken: "st", machineNonce: "n", dispatchId: "d1", protectedModelBootstrap: pb,
    });
    expect(cfg.min_secrets_version).toBe(9);
    expect(cfg.config.env![MODEL_AUTH_ENV.baseUrl]).toBe("https://orch.example/model-auth");
    expect(JSON.stringify(cfg)).not.toContain(keyB64(SECRET_A));
  });
});
