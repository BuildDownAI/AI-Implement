// Unit tests for the three KG refresh senders (AII-1148). Fakes for every dependency: no Docker, Fly, or GitHub.
import { describe, expect, it, vi } from "vitest";
import { createKgRefreshSenders, type KgRefreshSendInput, type KgRefreshSenderDeps } from "../restate/kg-refresh-senders.js";
import { syncRowToMachineNonce, type KeptMachineFly } from "../restate/kg-refresh-production.js";
import type { CreateMachineOpts, Machine } from "../fly-machines.js";
import { decodeRunConfig, type RunConfigV1 } from "../run-config.js";

vi.mock("../restate/kg-refresh-production.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../restate/kg-refresh-production.js")>()),
  syncRowToMachineNonce: vi.fn(),
}));

const IDENTIFIER = "KG-REFRESH · x9";
const NONCE = "nonce-secret-123";
const TOKENS = { runToken: "run-tok", progressToken: "progress-tok", publicationToken: "pub-tok" };

const envelope: RunConfigV1 = {
  v: 1,
  issue: { id: "kg-refresh", identifier: IDENTIFIER, title: "KG ingest", description: "" },
  runnerPhase: "kg-refresh",
  kgSourceRepo: "acme/kg",
};

function makeInput(overrides: Partial<KgRefreshSendInput> = {}): KgRefreshSendInput {
  return {
    envelope,
    tokens: TOKENS,
    dispatchId: "d-1",
    machine: { cpuKind: "performance", cpus: 4, memoryMb: 16384, idleTimeoutMs: 1000 },
    machineId: null,
    machineNonce: NONCE,
    ...overrides,
  };
}

function makeFly() {
  const created: CreateMachineOpts[] = [];
  const fly: KeptMachineFly = {
    getMachine: vi.fn(async (id: string) => ({ id, state: "stopped" }) as unknown as Machine),
    createMachine: vi.fn(async (c: CreateMachineOpts) => { created.push(c); return { id: "m-new" } as unknown as Machine; }),
    updateMachine: vi.fn(async () => ({})),
    startMachine: vi.fn(async () => {}),
  };
  return { fly, created };
}

function makeDeps(overrides: Partial<KgRefreshSenderDeps> = {}, configOverrides: Partial<KgRefreshSenderDeps["config"]> = {}) {
  const { fly, created } = makeFly();
  const deps = {
    config: {
      githubAppId: "1", githubAppPrivateKey: "key", flySessionsToken: "fly-token", flySessionsApp: "fly-app",
      flySessionsRegion: "iad", localRunnerImage: "local:img", localRunnerOrchestratorUrl: null,
      runnerCallbackBaseUrl: "https://orch.example", healthPort: 8080, sessionImage: "img", runnerImageExplicit: false,
      anthropicApiKey: null, claudeOAuthToken: null, kgSourceRepo: "acme/kg",
      ...configOverrides,
    },
    getInstallationToken: vi.fn(async () => "gh-secret-token"),
    mintToken: vi.fn(async () => ({ token: "gh-secret-token", expiresAt: "" })),
    fetchDefaultBranch: vi.fn(async () => "trunk"),
    resolveRunnerImage: vi.fn(async () => "runner:test"),
    resolveWorkflowCapabilities: vi.fn(async () => ({ supportsRunPublicationToken: true })),
    postWorkflowDispatch: vi.fn(async () => ({ success: true, outcome: "accepted" as const, runId: 42, runUrl: "https://gh/run/42" })),
    keptMachineFly: vi.fn(() => fly),
    startLocalRunnerContainer: vi.fn(async () => ({ containerId: "c-1" })),
    ...overrides,
  } as unknown as KgRefreshSenderDeps;
  return { deps, fly, created };
}

describe("fly-machines sender", () => {
  it("throws when the machine nonce is missing", async () => {
    const { deps, created } = makeDeps();
    await expect(createKgRefreshSenders(deps)["fly-machines"](makeInput({ machineNonce: null }))).rejects.toThrow(/machineNonce is required/);
    expect(deps.getInstallationToken).not.toHaveBeenCalled();
    expect(created).toBeDefined();
  });

  it("passes the machine config and creates a machine when none is kept", async () => {
    const { deps, created } = makeDeps();
    const result = await createKgRefreshSenders(deps)["fly-machines"](makeInput());
    expect(created).toHaveLength(1);
    const cfg = created[0]!.config as unknown as { env: Record<string, string>; guest: Record<string, unknown>; metadata: Record<string, string> };
    expect(cfg.env.MACHINE_NONCE).toBe(NONCE);
    expect(cfg.env.ISSUE_IDENTIFIER).toBe(IDENTIFIER);
    expect(cfg.env.RUN_PROGRESS_TOKEN).toBe("progress-tok");
    expect(decodeRunConfig(cfg.env.AI_IMPLEMENT_RUN_CONFIG!)?.issue.identifier).toBe(IDENTIFIER);
    expect(cfg.guest).toMatchObject({ cpu_kind: "performance", cpus: 4, memory_mb: 16384 });
    expect(JSON.stringify(created[0])).toContain("d-1");
    expect(JSON.stringify(created[0])).toContain("durable-runner");
    expect(JSON.stringify(created[0])).toContain("kg-refresh");
    expect(result).toEqual({
      outcome: "accepted", jobId: "m-new", machineId: "m-new", created: true,
      runUrl: "https://fly.io/apps/fly-app/machines/m-new", executionMode: "fly-machines",
    });
  });

  it("reconciles the kept machine and reports a replacement", async () => {
    const { deps, fly } = makeDeps();
    (fly.getMachine as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Fly API error (404)"));
    const result = await createKgRefreshSenders(deps)["fly-machines"](makeInput({ machineId: "m-old" }));
    expect(fly.getMachine).toHaveBeenCalledWith("m-old");
    expect(result).toMatchObject({ jobId: "m-new", machineId: "m-new", created: true, replaced: "m-old" });
  });

  it("reuses a stopped kept machine", async () => {
    const { deps, fly } = makeDeps();
    const result = await createKgRefreshSenders(deps)["fly-machines"](makeInput({ machineId: "m-kept" }));
    expect(fly.getMachine).toHaveBeenCalledWith("m-kept");
    expect(fly.startMachine).toHaveBeenCalledWith("m-kept");
    expect(result).toMatchObject({ jobId: "m-kept", machineId: "m-kept", created: false });
    expect(result.replaced).toBeUndefined();
  });

  it("re-arms the row to the nonce a reused started machine carries", async () => {
    const { deps, fly } = makeDeps();
    (fly.getMachine as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "m-kept", state: "started",
      config: { metadata: { dispatch_id: "d-1" }, env: { MACHINE_NONCE: "attempt-1-nonce" } },
    });
    const result = await createKgRefreshSenders(deps)["fly-machines"](makeInput({ machineId: "m-kept" }));
    expect(syncRowToMachineNonce).toHaveBeenCalledWith("d-1", NONCE, "attempt-1-nonce");
    expect(JSON.stringify(result)).not.toContain("attempt-1-nonce");
  });

  it("returns no nonce and no token in the journaled result", async () => {
    const { deps } = makeDeps();
    const result = await createKgRefreshSenders(deps)["fly-machines"](makeInput());
    const json = JSON.stringify(result);
    for (const secret of [NONCE, "run-tok", "progress-tok", "pub-tok", "gh-secret-token"]) expect(json).not.toContain(secret);
  });

  it.each([{ flySessionsToken: null }, { flySessionsApp: null }])("rejects when Fly is unconfigured (%o)", async (cfg) => {
    const { deps } = makeDeps({}, cfg);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await createKgRefreshSenders(deps)["fly-machines"](makeInput());
    err.mockRestore();
    expect(result).toEqual({ outcome: "rejected", jobId: null, executionMode: "fly-machines" });
    expect(deps.getInstallationToken).not.toHaveBeenCalled();
    expect(deps.keptMachineFly).not.toHaveBeenCalled();
  });
});

describe("local-docker sender", () => {
  it("throws when the machine nonce is missing", async () => {
    const { deps } = makeDeps();
    await expect(createKgRefreshSenders(deps)["local-docker"](makeInput({ machineNonce: null }))).rejects.toThrow(/machineNonce is required/);
    expect(deps.startLocalRunnerContainer).not.toHaveBeenCalled();
  });

  it("passes the nonce and identifier and returns the container id", async () => {
    const { deps } = makeDeps();
    const result = await createKgRefreshSenders(deps)["local-docker"](makeInput());
    const arg = (deps.startLocalRunnerContainer as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.machineNonce).toBe(NONCE);
    expect(arg.issueIdentifier).toBe(IDENTIFIER);
    expect(arg.defaultBranch).toBe("trunk");
    expect(result).toEqual({ outcome: "accepted", jobId: "c-1", executionMode: "local-docker", machineId: null, created: false });
    expect(JSON.stringify(result)).not.toContain(NONCE);
  });

  it("throws with no local runner image", async () => {
    const { deps } = makeDeps({}, { localRunnerImage: undefined });
    await expect(createKgRefreshSenders(deps)["local-docker"](makeInput())).rejects.toThrow(/LOCAL_RUNNER_IMAGE/);
  });
});

describe("github-actions sender", () => {
  const postedInputs = (deps: KgRefreshSenderDeps) =>
    (deps.postWorkflowDispatch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { returnRunDetails: boolean; ref: string; inputs: Record<string, string> };

  it("posts with returnRunDetails and includes the publication token when supported", async () => {
    const { deps } = makeDeps();
    const result = await createKgRefreshSenders(deps)["github-actions"](makeInput({ machineNonce: null }));
    const posted = postedInputs(deps);
    expect(posted.returnRunDetails).toBe(true);
    expect(posted.ref).toBe("trunk");
    expect(posted.inputs.run_publication_token).toBe("pub-tok");
    expect(posted.inputs.issue_identifier).toBe(IDENTIFIER);
    expect(posted.inputs.runner_phase).toBe("kg-refresh");
    expect(posted.inputs.job_timeout_minutes).toBe("240");
    expect(result).toEqual({ outcome: "accepted", runId: 42, runUrl: "https://gh/run/42", jobId: "42", executionMode: "github-actions" });
  });

  it("omits the publication token when the probe says unsupported", async () => {
    const { deps } = makeDeps({ resolveWorkflowCapabilities: vi.fn(async () => ({ supportsRunPublicationToken: false })) as never });
    await createKgRefreshSenders(deps)["github-actions"](makeInput({ machineNonce: null }));
    expect(postedInputs(deps).inputs).not.toHaveProperty("run_publication_token");
  });

  it("dispatches on the envelope's kgSourceRef and falls back to main when the default branch lookup fails", async () => {
    const { deps } = makeDeps({ fetchDefaultBranch: vi.fn(async () => { throw new Error("boom"); }) as never });
    await createKgRefreshSenders(deps)["github-actions"](makeInput({ machineNonce: null }));
    expect(postedInputs(deps).ref).toBe("main");
    const { deps: deps2 } = makeDeps();
    await createKgRefreshSenders(deps2)["github-actions"](makeInput({ machineNonce: null, envelope: { ...envelope, kgSourceRef: "feature" } }));
    expect(postedInputs(deps2).ref).toBe("feature");
  });

  it("has a null jobId when GitHub reports no run id", async () => {
    const { deps } = makeDeps({ postWorkflowDispatch: vi.fn(async () => ({ success: true })) as never });
    const result = await createKgRefreshSenders(deps)["github-actions"](makeInput({ machineNonce: null }));
    expect(result.jobId).toBeNull();
    expect(result.outcome).toBe("accepted");
  });
});
