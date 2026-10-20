// Unit tests for the three KG refresh senders (AII-1148). Fakes for every dependency: no Docker, Fly, or GitHub.
import { describe, expect, it, vi } from "vitest";
import { createKgRefreshSenders, type KgRefreshSendInput, type KgRefreshSenderDeps } from "../restate/kg-refresh-senders.js";
import { syncRowToMachineNonce, type KeptMachineFly } from "../restate/kg-refresh-production.js";
import type { CreateMachineOpts, Machine } from "../fly-machines.js";
import { buildKgRefreshRunConfig, decodeRunConfig, type RunConfigV1 } from "../run-config.js";
import { makeAppConfig, makeScopedInstallationToken } from "./helpers/builders.js";

vi.mock("../restate/kg-refresh-production.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../restate/kg-refresh-production.js")>()),
  syncRowToMachineNonce: vi.fn(),
}));

const IDENTIFIER = "KG-REFRESH · x9";
const NONCE = "nonce-secret-123";
const TOKENS = { runToken: "run-tok", progressToken: "progress-tok", publicationToken: "pub-tok" };

const CALLBACK_BASE = "https://orch.example";
const envelope = buildKgRefreshRunConfig({ kgSourceRepo: "acme/kg", issueIdentifier: IDENTIFIER, runnerCallbackUrl: CALLBACK_BASE });

function makeInput(overrides: Partial<KgRefreshSendInput> = {}): KgRefreshSendInput {
  return {
    envelope,
    tokens: TOKENS,
    dispatchId: "d-1",
    machine: { cpuKind: "performance", cpus: 4, memoryMb: 16384, idleTimeoutMs: 1000 },
    jobTimeoutMinutes: 240,
    machineId: null,
    machineNonce: NONCE,
    ...overrides,
  };
}

function makeFly() {
  const created: CreateMachineOpts[] = [];
  const fly: KeptMachineFly = {
    getMachine: vi.fn(async (id: string) => ({ id, state: "stopped" }) as unknown as Machine),
    listMachines: vi.fn(async () => [] as Machine[]),
    createMachine: vi.fn(async (c: CreateMachineOpts) => { created.push(c); return { id: "m-new" } as unknown as Machine; }),
    updateMachine: vi.fn(async () => ({})),
    startMachine: vi.fn(async () => {}),
    waitSettled: vi.fn(async (id: string) => ({ id, state: "stopped" }) as unknown as Machine),
    waitForStopped: vi.fn(async () => {}),
  };
  return { fly, created };
}

function makeDeps(overrides: Partial<KgRefreshSenderDeps> = {}, configOverrides: Partial<KgRefreshSenderDeps["config"]> = {}) {
  const { fly, created } = makeFly();
  const deps = {
    config: makeAppConfig({
      githubAppId: "1", githubAppPrivateKey: "key", flySessionsToken: "fly-token", flySessionsApp: "fly-app",
      flySessionsRegion: "iad", localRunnerImage: "local:img", runnerCallbackBaseUrl: CALLBACK_BASE,
      sessionImage: "img", kgSourceRepo: "acme/kg",
      ...configOverrides,
    }),
    getInstallationToken: vi.fn(async () => "gh-secret-token"),
    getScopedInstallationToken: vi.fn(async () => makeScopedInstallationToken({ token: "scoped-boot-token" })),
    mintToken: vi.fn(async () => makeScopedInstallationToken({ token: "gh-secret-token" })),
    fetchDefaultBranch: vi.fn(async () => "trunk"),
    resolveRunnerImage: vi.fn(async () => "runner:test"),
    resolveWorkflowCapabilities: vi.fn(async () => ({ contract: "envelope", supportsRunPublicationToken: true, supportsAttemptCorrelation: false })),
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
    expect(cfg.env.RUN_TOKEN).toBe("run-tok");
    expect(cfg.env.RUN_PROGRESS_TOKEN).toBe("progress-tok");
    expect(cfg.env.RUN_PUBLICATION_TOKEN).toBe("pub-tok");
    // The runner keeps the nonce route only while both are present, so the publication token stays inert.
    expect(cfg.env.ORCHESTRATOR_URL).toBe("https://orch.example");
    expect(decodeRunConfig(cfg.env.AI_IMPLEMENT_RUN_CONFIG!)?.issue.identifier).toBe(IDENTIFIER);
    expect(cfg.guest).toMatchObject({ cpu_kind: "performance", cpus: 4, memory_mb: 16384 });
    expect(JSON.stringify(created[0])).toContain("d-1");
    expect(JSON.stringify(created[0])).toContain("durable-runner");
    expect(JSON.stringify(created[0])).toContain("kg-refresh");
    expect(result).toEqual({
      outcome: "accepted", jobId: "m-new", machineId: "m-new", created: true, app: "fly-app",
      runUrl: "https://fly.io/apps/fly-app/machines/m-new", executionMode: "fly-machines",
    });
  });

  it("reconciles the kept machine and reports a replacement", async () => {
    const { deps, fly } = makeDeps();
    (fly.getMachine as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Fly API error (404)"));
    const result = await createKgRefreshSenders(deps)["fly-machines"](makeInput({ machineId: "m-old" }));
    expect(fly.getMachine).toHaveBeenCalledWith("m-old");
    expect(result).toMatchObject({ jobId: "m-new", machineId: "m-new", created: true, replaced: "m-old", app: "fly-app" });
  });

  it("reuses a stopped kept machine", async () => {
    const { deps, fly } = makeDeps();
    const result = await createKgRefreshSenders(deps)["fly-machines"](makeInput({ machineId: "m-kept" }));
    expect(fly.getMachine).toHaveBeenCalledWith("m-kept");
    expect(fly.startMachine).toHaveBeenCalledWith("m-kept");
    expect(result).toMatchObject({ jobId: "m-kept", machineId: "m-kept", created: false, app: "fly-app" });
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

  it("adopts the machine tagged with the dispatch id, re-arms its nonce and logs it", async () => {
    const { deps, fly, created } = makeDeps();
    (fly.listMachines as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: "m-orphan", state: "started", config: { metadata: { dispatch_id: "d-1", purpose: "durable-runner" }, env: { MACHINE_NONCE: "orphan-nonce" } } },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await createKgRefreshSenders(deps)["fly-machines"](makeInput());
    expect(created).toHaveLength(0);
    expect(result).toMatchObject({ machineId: "m-orphan", created: true });
    expect(syncRowToMachineNonce).toHaveBeenCalledWith("d-1", NONCE, "orphan-nonce");
    expect(log.mock.calls.flat().join("\n")).toContain("(adopted machine m-orphan)");
    expect(JSON.stringify(result)).not.toContain("orphan-nonce");
    log.mockRestore();
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
    expect(arg).toMatchObject({ runToken: "run-tok", runProgressToken: "progress-tok", runPublicationToken: "pub-tok", runnerCallbackUrl: "https://orch.example" });
    expect(arg.orchestratorUrl).toBe("https://orch.example");
    expect(arg.extraEnv).not.toHaveProperty("RUN_PROGRESS_TOKEN");
    expect(result).toEqual({ outcome: "accepted", jobId: "c-1", executionMode: "local-docker", machineId: null, created: false });
    expect(JSON.stringify(result)).not.toContain(NONCE);
  });

  it("throws with no local runner image", async () => {
    const { deps } = makeDeps({}, { localRunnerImage: undefined });
    await expect(createKgRefreshSenders(deps)["local-docker"](makeInput())).rejects.toThrow(/LOCAL_RUNNER_IMAGE/);
  });
});

// AII-990: a Fly or local runner boots with a token scoped to the KG repository alone; the
// installation-wide token stays on control-plane reads.
describe("KG runner boot token (AII-990)", () => {
  it("Fly boot uses the scoped token and keeps the broad token for control-plane work", async () => {
    const { deps, created } = makeDeps();
    await createKgRefreshSenders(deps)["fly-machines"](makeInput());
    expect(deps.getScopedInstallationToken).toHaveBeenCalledWith("1", "key", "acme", { repositories: ["kg"] });
    expect(deps.fetchDefaultBranch).toHaveBeenCalledWith("gh-secret-token", "acme", "kg");
    expect(deps.resolveRunnerImage).toHaveBeenCalledWith(expect.objectContaining({ token: "scoped-boot-token" }));
    const json = JSON.stringify(created[0]!.config);
    expect(json).toContain("scoped-boot-token");
    expect(json).not.toContain("gh-secret-token");
  });

  it("local boot uses the scoped token", async () => {
    const { deps } = makeDeps();
    await createKgRefreshSenders(deps)["local-docker"](makeInput());
    expect(deps.getScopedInstallationToken).toHaveBeenCalledWith("1", "key", "acme", { repositories: ["kg"] });
    const arg = (deps.startLocalRunnerContainer as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.githubToken).toBe("scoped-boot-token");
  });

  it("Fly: a narrow-mint failure launches nothing and never uses the broad token", async () => {
    const { deps, created } = makeDeps({
      getScopedInstallationToken: vi.fn(async () => { throw new Error("mint failed"); }) as never,
    });
    await expect(createKgRefreshSenders(deps)["fly-machines"](makeInput())).rejects.toThrow("mint failed");
    expect(created).toHaveLength(0);
    expect(deps.resolveRunnerImage).not.toHaveBeenCalled();
  });

  it("local: a narrow-mint failure launches nothing", async () => {
    const { deps } = makeDeps({
      getScopedInstallationToken: vi.fn(async () => { throw new Error("mint failed"); }) as never,
    });
    await expect(createKgRefreshSenders(deps)["local-docker"](makeInput())).rejects.toThrow("mint failed");
    expect(deps.startLocalRunnerContainer).not.toHaveBeenCalled();
  });
});

describe("github-actions sender", () => {
  const postedInputs = (deps: KgRefreshSenderDeps) =>
    (deps.postWorkflowDispatch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { returnRunDetails: boolean; ref: string; inputs: Record<string, string> };

  it("posts with returnRunDetails and includes the publication token when supported", async () => {
    const { deps } = makeDeps();
    await createKgRefreshSenders(deps)["github-actions"](makeInput({ machineNonce: null }));
    const posted = postedInputs(deps);
    expect(posted.returnRunDetails).toBe(true);
    expect(posted.ref).toBe("trunk");
    expect(posted.inputs.run_publication_token).toBe("pub-tok");
    expect(posted.inputs.issue_identifier).toBe(IDENTIFIER);
    expect(posted.inputs.runner_phase).toBe("kg-refresh");
    expect(posted.inputs.job_timeout_minutes).toBe("240");
  });

  it("sends the profile's jobTimeoutMinutes as job_timeout_minutes", async () => {
    const { deps } = makeDeps();
    await createKgRefreshSenders(deps)["github-actions"](makeInput({ machineNonce: null, jobTimeoutMinutes: 120 }));
    expect(postedInputs(deps).inputs.job_timeout_minutes).toBe("120");
  });

  it("refuses to dispatch without a profile timeout", async () => {
    const { deps } = makeDeps();
    await expect(createKgRefreshSenders(deps)["github-actions"](makeInput({ machineNonce: null, jobTimeoutMinutes: null }))).rejects.toThrow(/jobTimeoutMinutes/);
  });

  it("returns the accepted run", async () => {
    const { deps } = makeDeps();
    const result = await createKgRefreshSenders(deps)["github-actions"](makeInput({ machineNonce: null }));
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

describe("model-auth refusal", () => {
  const modes = [["fly-machines", "fly-machines"], ["local-docker", "local-docker"], ["github-actions", "github-actions"]] as const;
  const variants: Array<[string, Partial<RunConfigV1>]> = [
    ["agentConfig", { agentConfig: { v: 1 } as never }],
    ["modelAuthGrant", { credentials: { version: 1, modelAuthGrant: { v: 1 } as never } as never }],
  ];
  for (const [mode] of modes) {
    for (const [label, extra] of variants) {
      it(`${mode} rejects an envelope with ${label} before any call`, async () => {
        const { deps, fly } = makeDeps({}, mode === "local-docker" ? { localRunnerImage: undefined as never } : {});
        const err = vi.spyOn(console, "error").mockImplementation(() => {});
        const result = await createKgRefreshSenders(deps)[mode](makeInput({ envelope: { ...envelope, ...extra }, machineNonce: null }));
        expect(result).toEqual({ outcome: "rejected", jobId: null, executionMode: mode });
        expect(err).toHaveBeenCalledWith("[kg-refresh] refused: a KG refresh envelope carries model authentication");
        for (const spy of [deps.getScopedInstallationToken, deps.getInstallationToken, deps.mintToken, deps.fetchDefaultBranch,
          deps.resolveRunnerImage, deps.postWorkflowDispatch, deps.keptMachineFly, deps.startLocalRunnerContainer]) {
          expect(spy).not.toHaveBeenCalled();
        }
        expect(fly.createMachine).not.toHaveBeenCalled();
        err.mockRestore();
      });
    }
  }

  it("does not refuse an envelope whose credentials carry no modelAuthGrant", async () => {
    const { deps } = makeDeps();
    const result = await createKgRefreshSenders(deps)["github-actions"](makeInput({
      machineNonce: null, envelope: { ...envelope, credentials: { version: 1 } as never } }));
    expect(result.outcome).toBe("accepted");
  });
});
