import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import type * as KeyModule from "../fly-protection-key.js";
import type * as DedupModule from "../dedup.js";
import { MODEL_AUTH_ENV } from "../model-auth-contract.js";
import { deriveModelAuthProtectionKey } from "../model-session-keys.js";
import { buildSessionMachineConfig } from "../fly-machines.js";

let mod: typeof KeyModule;
let dedup: typeof DedupModule;
const origSecret = process.env.RUNNER_TOKEN_SECRET;
const SECRET_A = "runner-token-secret-A-0123456789";
const SECRET_B = "runner-token-secret-B-0123456789";

const keyB64 = (secret: string) => deriveModelAuthProtectionKey({ RUNNER_TOKEN_SECRET: secret } as NodeJS.ProcessEnv)!.toString("base64url");

beforeEach(async () => {
  process.env.DEDUP_DB_PATH = path.join(os.tmpdir(), `fly-protection-key-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.RUNNER_TOKEN_SECRET = SECRET_A;
  vi.resetModules();
  dedup = await import("../dedup.js");
  mod = await import("../fly-protection-key.js");
  vi.stubGlobal("fetch", vi.fn());
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  dedup.closeDb();
  vi.restoreAllMocks();
  if (origSecret === undefined) delete process.env.RUNNER_TOKEN_SECRET;
  else process.env.RUNNER_TOKEN_SECRET = origSecret;
});

const ok = (version: number) => ({ ok: true, json: async () => ({ version }) }) as Response;

describe("ensureProtectionKeySecret", () => {
  it("writes once, then reuses the stored version", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok(5));
    const first = await mod.ensureProtectionKeySecret({ token: "t", app: "sessions" });
    const second = await mod.ensureProtectionKeySecret({ token: "t", app: "sessions" });
    expect(first).toEqual({ name: MODEL_AUTH_ENV.protectionKey, available: true, version: 5 });
    expect(second).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.machines.dev/v1/apps/sessions/secrets");
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({
      values: { [MODEL_AUTH_ENV.protectionKey]: keyB64(SECRET_A) },
    });
  });

  it("writes again when RUNNER_TOKEN_SECRET changes", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok(5)).mockResolvedValueOnce(ok(6));
    await mod.ensureProtectionKeySecret({ token: "t", app: "s" });
    process.env.RUNNER_TOKEN_SECRET = SECRET_B;
    const r = await mod.ensureProtectionKeySecret({ token: "t", app: "s" });
    expect(r.version).toBe(6);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws value-free errors and logs no key", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500, text: async () => keyB64(SECRET_A) } as Response);
    const err = await mod.ensureProtectionKeySecret({ token: "t", app: "s" }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(keyB64(SECRET_A));
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response);
    await expect(mod.ensureProtectionKeySecret({ token: "t", app: "s" })).rejects.toThrow(/version/);
    vi.mocked(fetch).mockResolvedValueOnce(ok(2));
    await mod.ensureProtectionKeySecret({ token: "t", app: "s" });
    const logged = JSON.stringify(vi.mocked(console.log).mock.calls);
    expect(logged).toContain("version 2");
    expect(logged).not.toContain(keyB64(SECRET_A));
  });

  it("rejects when RUNNER_TOKEN_SECRET is unset", async () => {
    delete process.env.RUNNER_TOKEN_SECRET;
    await expect(mod.ensureProtectionKeySecret({ token: "t", app: "s" })).rejects.toThrow(/protection_key_unavailable/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("buildProtectedFlyBootstrap", () => {
  it("returns builder input that passes validation end to end", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok(9));
    const bootstrap = {
      version: 1, audience: "model-auth", grantId: "g1", dispatchId: "d1", projectKey: "proj", snapshotId: "s1",
      backend: "fly", expiresAt: 1_700_000_060_000, bearer: "SENTINELbearer0123456789abcdefghijklmnop",
      bindings: [{ stage: "implementation", profileId: "sub", profileRevision: 1, authMode: "claude-subscription", ownerGeneration: 3 }],
    } as never;
    const runConfig = { v: 1, issue: { id: "i", identifier: "ENG-1", title: "t", description: "d" } } as never;
    const pb = await mod.buildProtectedFlyBootstrap({
      token: "t", app: "s", bootstrap, projectKey: "proj", runConfig, modelAuthUrl: "https://orch.example/model-auth",
    });
    const cfg = buildSessionMachineConfig({
      image: "img", issueId: "i", issueIdentifier: "ENG-1", issueTitle: "t", issueDescription: "d", owner: "o", repo: "r",
      defaultBranch: "main", githubToken: "gt", sessionToken: "st", machineNonce: "n", dispatchId: "d1", protectedModelBootstrap: pb,
    });
    expect(cfg.min_secrets_version).toBe(9);
    expect(cfg.config.env![MODEL_AUTH_ENV.baseUrl]).toBe("https://orch.example/model-auth");
    expect(JSON.stringify(cfg)).not.toContain(keyB64(SECRET_A));
  });
});
