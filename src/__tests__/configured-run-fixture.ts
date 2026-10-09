/** Synthetic fixtures for opted-in runner tests. No real credential, network or paid model call. */
import { vi } from "vitest";
import type { ModelAuthClient, ModelInvocation } from "../model-auth-client.js";
import type { ModelAuthGrantBootstrapV1 } from "../model-auth-contract.js";
import { encodeTrustedRunConfig, type ResolvedAgentSnapshotV1 } from "../run-config.js";
import type { AccountAuthMode } from "../agent-config.js";

export const SENTINEL_BEARER = "SENTINELbearer0123456789abcdefghijklmnop";
export const NOW = 1_700_000_000_000;
export const EXPECTED = { dispatchId: "disp-1", projectKey: "proj", snapshotId: "snap-1", backend: "fly" as const };

const rev = { configRevisionId: "rev-1", revision: 1 };

export function makeSnapshot(implAuth: AccountAuthMode = "openai-api-key"): ResolvedAgentSnapshotV1 {
  return {
    version: 1,
    snapshotId: "snap-1",
    configRevisions: { orchestratorDefault: rev, project: rev },
    stages: {
      planning: { agent: "claude", provider: "anthropic", model: "claude-plan", accountProfileId: "p-plan", invocationTimeoutMs: 1000 },
      implementation: { agent: "codex", provider: "openai", model: "gpt-impl", accountProfileId: "p-impl", invocationTimeoutMs: 2000 },
      review: { agent: "claude", provider: "anthropic", model: "claude-review", accountProfileId: "p-rev", invocationTimeoutMs: 3000 },
    },
    sources: Object.fromEntries(
      ["planning", "implementation", "review"].map((st) => [
        st,
        { agent: "project", provider: "project", model: "project", accountProfileId: "project", invocationTimeoutMs: "job-deadline" },
      ]),
    ) as ResolvedAgentSnapshotV1["sources"],
    profiles: {
      planning: { id: "p-plan", identity: "a", revision: 1, agent: "claude", provider: "anthropic", authMode: "anthropic-api-key" },
      implementation: { id: "p-impl", identity: "b", revision: 1, agent: "codex", provider: "openai", authMode: implAuth },
      review: { id: "p-rev", identity: "c", revision: 1, agent: "claude", provider: "anthropic", authMode: "anthropic-api-key" },
    },
  };
}

export function makeGrant(snapshot: ResolvedAgentSnapshotV1, over: Partial<ModelAuthGrantBootstrapV1> = {}): ModelAuthGrantBootstrapV1 {
  return {
    version: 1,
    audience: "model-auth",
    grantId: "grant-1",
    dispatchId: EXPECTED.dispatchId,
    projectKey: EXPECTED.projectKey,
    snapshotId: snapshot.snapshotId,
    backend: EXPECTED.backend,
    expiresAt: NOW + 60_000,
    bearer: SENTINEL_BEARER,
    bindings: (["planning", "implementation", "review"] as const).map((stage) => {
      const p = snapshot.profiles[stage];
      return {
        stage,
        profileId: p.id,
        profileRevision: p.revision,
        authMode: p.authMode,
        ...(p.authMode === "claude-subscription" ? { ownerGeneration: 3 } : {}),
      };
    }),
    ...over,
  };
}

export function envelopeEnv(snapshot: ResolvedAgentSnapshotV1 | undefined, grant: ModelAuthGrantBootstrapV1 | undefined): Record<string, string> {
  return {
    AI_IMPLEMENT_RUN_CONFIG: encodeTrustedRunConfig({
      v: 1,
      issue: { id: "i1", identifier: "AII-1", title: "t", description: "d" },
      ...(snapshot ? { agentConfig: snapshot } : {}),
      ...(grant ? { credentials: { version: 1, modelAuthGrant: grant } } : {}),
    }),
    AI_IMPLEMENT_MODEL_AUTH_DISPATCH_ID: EXPECTED.dispatchId,
    AI_IMPLEMENT_MODEL_AUTH_PROJECT_KEY: EXPECTED.projectKey,
    AI_IMPLEMENT_MODEL_AUTH_BACKEND: EXPECTED.backend,
    AI_IMPLEMENT_MODEL_AUTH_URL: "https://orchestrator.invalid/model-auth",
  };
}

export type FakeClient = ModelAuthClient & {
  checkout: ReturnType<typeof vi.fn>;
  invoke: ReturnType<typeof vi.fn>;
  finish: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  states: Map<string, string>;
};

/** Records calls; `invoke` runs the callback with a synthetic selected environment. */
export function fakeClient(): FakeClient {
  const states = new Map<string, string>();
  const client = {
    states,
    checkout: vi.fn(async ({ profileId }: { profileId: string }) => void states.set(profileId, "ready")),
    invoke: vi.fn(async <T>(_id: string, run: (i: ModelInvocation) => Promise<T>) => run({ env: { PATH: "/bin" }, strippedKeys: [] })),
    reconcile: vi.fn(async () => undefined),
    finish: vi.fn(async (id: string) => void states.set(id, "finished")),
    dispose: vi.fn(async () => undefined),
    status: vi.fn((id: string) => (states.get(id) ?? "unknown") as never),
  };
  return client as unknown as FakeClient;
}
