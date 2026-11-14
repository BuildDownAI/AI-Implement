import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testDb } from "./helpers/test-db.js";
import { makeMapping } from "./helpers/builders.js";

const modules = {
  admin: () => import("../admin.js"), sessions: () => import("../admin-session.js"),
  accounts: () => import("../agent-config-store.js"), config: () => import("../config.js"),
  secrets: () => import("../model-protected-secrets.js"), dedup: () => import("../dedup.js"),
};
let loaded: import("./helpers/test-db.js").LoadedModules<typeof modules>;
let token: string;
const KEY = "sk-openrouter-SENTINEL-key";
beforeEach(async () => {
  loaded = (await testDb({ modules })).modules;
  vi.stubEnv("RUNNER_TOKEN_SECRET", "test-openrouter-encryption-secret");
  token = loaded.sessions.createSession();
});

afterEach(() => vi.unstubAllEnvs());

function request(method: string, url: string, body?: unknown): Promise<{ status: number; body: any; text: string }> {
  return new Promise(resolve => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url, headers: { authorization: `Bearer ${token}` } });
    let status = 0;
    const res = {
      writeHead(code: number) { status = code; },
      end(text: string) { resolve({ status, body: JSON.parse(text), text }); },
    };
    loaded.admin.handleAdminRequest(req as IncomingMessage, res as ServerResponse,
      { adminAccessCode: "test" } as never, {} as never);
  });
}

it.each(["claude", "codex"] as const)("creates %s OpenRouter accounts and stores an encrypted, write-only key", async agent => {
  const created = await request("POST", "/api/model-accounts", {
    profileId: agent, identity: `Router ${agent}`, agent, provider: "openrouter", authMode: "openrouter-api-key",
  });
  expect(created.status).toBe(201);
  expect((await request("PUT", `/api/model-accounts/${agent}/credential`, { apiKey: KEY })).status).toBe(200);
  const head = loaded.accounts.getAccountProfile(agent)!;
  const ref = loaded.accounts.lookupCredentialReference(agent, head.revision);
  expect(ref).toBe(`model-account:${agent}`);
  expect(loaded.secrets.createModelProtectedSecrets({ env: process.env }).resolve(ref!)).toBe(KEY);
  const row = loaded.dedup.getDb().prepare("SELECT ciphertext FROM model_protected_secrets WHERE secret_ref = ?").get(ref) as { ciphertext: Buffer };
  expect(row.ciphertext.includes(Buffer.from(KEY))).toBe(false);
  const listed = await request("GET", "/api/model-accounts");
  expect(listed.status).toBe(200);
  expect(listed.body.accounts).toMatchObject([{ profileId: agent, credentialSet: true }]);
  for (const response of [created, listed]) {
    expect(response.text).not.toContain(KEY);
    expect(response.text).not.toContain("credentialRef");
    expect(response.text).not.toContain(ref!);
  }
});

it.each(["github-actions", "fly-machines", "local"] as const)("resolves OpenRouter defaults and project overrides on %s", async executionMode => {
  for (const agent of ["claude", "codex"] as const) {
    expect((await request("POST", "/api/model-accounts", {
      profileId: agent, identity: `Router ${agent}`, agent, provider: "openrouter", authMode: "openrouter-api-key",
    })).status).toBe(201);
  }
  vi.stubEnv("RUNNER_MODE", executionMode === "local" ? "local" : "default");
  loaded.config.upsertMapping("AII", makeMapping({ executionMode: executionMode === "local" ? "github-actions" : executionMode }));
  const selection = (agent: "claude" | "codex") => ({ agent, provider: "openrouter" as const, model: "model", accountProfileId: agent, invocationTimeoutMs: 60000 });
  expect((await request("PUT", "/api/agent-defaults", { mode: "configured", stages: {
    planning: selection("claude"), implementation: selection("claude"), review: selection("claude"),
  } })).status).toBe(200);
  loaded.accounts.setProjectStageConfig("AII", { version: 1, mode: "configured", stages: { implementation: selection("codex") } });
  const resolved = await request("GET", "/api/mappings/AII/agent-config/resolved");
  expect(resolved.status).toBe(200);
  expect(resolved.body.resolved).toBe(true);
  expect(resolved.body.stages.planning.entries).toMatchObject([{ accountProfileId: "claude", passes: true }]);
  expect(resolved.body.stages.implementation.entries[0]).toMatchObject({ accountProfileId: "codex", passes: true });
});
