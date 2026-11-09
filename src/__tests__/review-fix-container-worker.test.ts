import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeRunConfig } from "../run-config.js";
import { testDb } from "./helpers/test-db.js";
import { makeMapping, makeScopedPrIdentity } from "./helpers/builders.js";
import type { ContainerReviewFixWorkerDeps } from "../review-fix-container-worker.js";
import type { WorkerLaunchPlan } from "../review-fix-ports.js";

vi.mock("../fly-machines.js", async (original) => ({ ...await original<typeof import("../fly-machines.js")>(), createMachine: vi.fn(), listMachines: vi.fn(), getMachine: vi.fn(), listAppSecrets: vi.fn().mockResolvedValue([]), generateMachineNonce: () => "sentinel-nonce" }));
vi.mock("../repo-image.js", async (original) => ({ ...await original<typeof import("../repo-image.js")>(), resolveSessionImage: vi.fn().mockResolvedValue({ image: "runner", source: "default" }) }));
vi.mock("../local-docker.js", async (original) => ({ ...await original<typeof import("../local-docker.js")>(), startLocalRunnerContainer: vi.fn(), inspectLocalContainer: vi.fn(), stopLocalContainer: vi.fn(), findLocalContainerIdByName: vi.fn() }));
vi.mock("../backend-run.js", async (original) => ({ ...await original<typeof import("../backend-run.js")>(), stopBackendRun: vi.fn() }));

async function setup(backend: "fly-machines" | "local-docker", attemptId = "attempt-1") {
  const { modules: m } = await testDb({ modules: {
    worker: () => import("../review-fix-container-worker.js"), config: () => import("../config.js"), admission: () => import("../dispatch-admission.js"), log: () => import("../log.js"), fly: () => import("../fly-machines.js"), docker: () => import("../local-docker.js"), control: () => import("../backend-run.js"), accounting: () => import("../job-accounting.js"), managed: () => import("../managed-dispatch-auth.js"),
  } });
  m.config.upsertMapping("AII", makeMapping({ owner: "owner", repo: "repo" }));
  const scope = makeScopedPrIdentity({ repository: "owner/repo" });
  m.admission.acquire({ dispatchId: attemptId, mappingKey: "AII", scope: { kind: "pr", issueId: "issue", installationId: String(scope.installationId), repository: scope.repository, prNumber: scope.prNumber }, kind: "gap-fill", backend, lifecycleOwner: { kind: "restate", attemptId }, cap: 10 });
  const deps: ContainerReviewFixWorkerDeps = {
    credentials: { resolve: vi.fn().mockResolvedValue({ token: "sentinel-github", installationId: scope.installationId }) },
    callbackInputs: vi.fn().mockResolvedValue({ run_token: "sentinel-result", run_progress_token: "sentinel-progress", run_publication_token: "sentinel-publication", runner_callback_url: "https://callback" }),
    fly: { flySessionsToken: "fly", flySessionsApp: "sessions", flySessionsRegion: null, flyOrchestratorApp: null, sessionImage: "runner", runnerCallbackBaseUrl: "https://callback", tenantId: null, anthropicApiKey: "key", claudeOAuthToken: null },
    local: { image: "runner", orchestratorUrl: "https://callback", anthropicApiKey: "key" },
    getPullRequestHeadSha: vi.fn().mockResolvedValue("a".repeat(40)),
  };
  vi.mocked(m.fly.createMachine).mockResolvedValue({ id: "machine", name: "review-fix-attempt-1" } as Awaited<ReturnType<typeof m.fly.createMachine>>);
  vi.mocked(m.docker.startLocalRunnerContainer).mockImplementation(async input => { input.onBeforeLaunch?.(); return { containerId: "container", containerName: input.containerName! }; });
  const plan: WorkerLaunchPlan = { executionBackend: backend, attemptId, scope, taskText: "fix findings", deadlineAt: Date.now() + 60000 };
  return { ...m, deps, plan, instance: new m.worker.ContainerReviewFixWorker(deps), execution: { backend, runRef: backend === "fly-machines" ? "machine" : "container" } };
}
function seedLaunchIntent(s: Awaited<ReturnType<typeof setup>>) {
  s.log.appendLogIfAbsent({ issueId: "review-fix:attempt-1", dispatchId: "attempt-1", machineNonce: "sentinel-nonce", admissionGeneration: s.admission.read("attempt-1")!.generation, executionMode: s.plan.executionBackend, phase: "gap-analysis" });
}
beforeEach(() => vi.clearAllMocks());
const backends = ["fly-machines", "local-docker"] as const;
for (const backend of backends) describe(backend, () => {
  for (const field of ["runner_callback_url", "run_token"] as const) {
    for (const value of [undefined, "", "   "]) it(`does not launch with ${field}=${JSON.stringify(value)}`, async () => {
      const s = await setup(backend);
      vi.mocked(s.deps.callbackInputs).mockResolvedValue({
        runner_callback_url: "https://callback", run_token: "sentinel-result", [field]: value,
      });
      expect(await s.instance.launch(s.plan)).toEqual({ status: "unknown" });
      expect(s.fly.createMachine).not.toHaveBeenCalled();
      expect(s.docker.startLocalRunnerContainer).not.toHaveBeenCalled();
      expect(s.log.getJobByDispatchId(s.plan.attemptId)).toBeNull();
    });
  }
  it("launches fresh execution with marker and required nonce row, without journaled credentials", async () => {
    const s = await setup(backend);
    const prepared = await s.instance.prepare({ ...s.plan, findings: [], owner: s.plan.attemptId });
    expect(s.deps.callbackInputs).not.toHaveBeenCalled();
    const launch = await s.instance.launch(prepared);
    expect(launch).toEqual({ status: "accepted", execution: s.execution });
    const row = s.log.getJobByDispatchId("attempt-1")!;
    expect(row).toMatchObject({ machineId: s.execution.runRef, machineNonce: "sentinel-nonce", dispatchId: "attempt-1", admissionGeneration: s.admission.read("attempt-1")!.generation, phase: "gap-analysis", prUrl: null });
    const request = backend === "fly-machines" ? vi.mocked(s.fly.createMachine).mock.calls[0][2] : vi.mocked(s.docker.startLocalRunnerContainer).mock.calls[0][0];
    expect(JSON.stringify(request)).toContain("review-fix-attempt-1");
    const envelope = backend === "fly-machines"
      ? vi.mocked(s.fly.createMachine).mock.calls[0][2].config.env!.AI_IMPLEMENT_RUN_CONFIG
      : vi.mocked(s.docker.startLocalRunnerContainer).mock.calls[0][0].extraEnv!.AI_IMPLEMENT_RUN_CONFIG;
    expect(decodeRunConfig(envelope).reviewFix).toEqual({
      version: 1, attemptId: s.plan.attemptId, installationId: s.plan.scope.installationId,
      repository: s.plan.scope.repository, prNumber: s.plan.scope.prNumber,
      deadlineAt: s.plan.deadlineAt, executionBackend: backend,
    });
    expect(JSON.stringify(request)).toContain("sentinel-result");
    const reconciled = await s.instance.reconcile("attempt-1", s.plan.scope);
    expect(reconciled).toEqual({ status: "found", execution: s.execution });
    expect(s.fly.listMachines).not.toHaveBeenCalled();
    const outputs = JSON.stringify([prepared, launch, reconciled]);
    for (const sentinel of ["sentinel-nonce", "sentinel-result", "sentinel-progress", "sentinel-publication", "sentinel-github", "sentinel-bootstrap"]) expect(outputs).not.toContain(sentinel);
  });
  for (const failure of ["lost acknowledgement", "attachment failure"] as const) it(`recovers after ${failure} and worker restart`, async () => {
    const s = await setup(backend);
    const assertIntent = () => {
      expect(s.log.getJobByNonce("sentinel-nonce")).toMatchObject({ dispatchId: "attempt-1", machineId: null, status: "dispatched", admissionGeneration: s.admission.read("attempt-1")!.generation });
    };
    if (failure === "lost acknowledgement") {
      vi.mocked(s.fly.createMachine).mockImplementation(async () => { assertIntent(); throw new Error("lost acknowledgement"); });
      vi.mocked(s.docker.startLocalRunnerContainer).mockImplementation(async input => { input.onBeforeLaunch?.(); assertIntent(); throw new Error("lost acknowledgement"); });
    } else {
      vi.spyOn(s.log, "setJobMachineId").mockImplementationOnce(() => { throw new Error("(400) persistence failed"); });
    }
    expect(await s.instance.launch(s.plan)).toEqual({ status: "unknown" });
    assertIntent();
    vi.mocked(s.fly.listMachines).mockResolvedValue([{ id: s.execution.runRef, name: "review-fix-attempt-1" }] as Awaited<ReturnType<typeof s.fly.listMachines>>);
    vi.mocked(s.docker.findLocalContainerIdByName).mockResolvedValue(s.execution.runRef);
    const restarted = new s.worker.ContainerReviewFixWorker(s.deps);
    expect(await restarted.launch(s.plan)).toEqual({ status: "unknown" });
    expect(await restarted.reconcile("attempt-1", s.plan.scope)).toEqual({ status: "found", execution: s.execution });
    expect(s.log.getJobByNonce("sentinel-nonce")).toMatchObject({ machineId: s.execution.runRef, status: "dispatched", admissionGeneration: s.admission.read("attempt-1")!.generation });
  });
  it("uses the admitted mapping when unmanaged siblings share the repository", async () => {
    const s = await setup(backend);
    vi.spyOn(s.config, "getMappings").mockReturnValue({
      SIBLING: makeMapping({ owner: "owner", repo: "repo" }),
      AII: makeMapping({ owner: "owner", repo: "repo" }),
    });
    const managed = vi.spyOn(s.managed, "isManagedProject").mockImplementation(key => key === "AII");
    expect(await s.instance.launch(s.plan)).toEqual({ status: "rejected", reason: `managed review-fix on ${backend} not supported yet` });
    expect(managed).toHaveBeenCalledWith("AII", "attempt-1");
    expect(s.deps.credentials.resolve).not.toHaveBeenCalled();
  });
  it("refuses a mapping that no longer targets the admitted repository", async () => {
    const s = await setup(backend);
    s.config.upsertMapping("AII", makeMapping({ owner: "owner", repo: "other" }));
    expect(await s.instance.launch(s.plan)).toEqual({ status: "unknown" });
    expect(s.deps.callbackInputs).not.toHaveBeenCalled();
  });
  it("rejects managed launches before minting tokens", async () => {
    const s = await setup(backend);
    vi.spyOn(s.managed, "isManagedProject").mockReturnValueOnce(true);
    expect(await s.instance.launch(s.plan)).toEqual({ status: "rejected", reason: `managed review-fix on ${backend} not supported yet` });
    expect(s.deps.callbackInputs).not.toHaveBeenCalled();
  });
  it("does not report an execution without a durable nonce row", async () => {
    const s = await setup(backend);
    vi.mocked(s.fly.listMachines).mockResolvedValue([{ id: "orphan", name: "review-fix-attempt-1" }] as Awaited<ReturnType<typeof s.fly.listMachines>>);
    vi.mocked(s.docker.findLocalContainerIdByName).mockResolvedValue("orphan");
    expect(await s.instance.reconcile("attempt-1", s.plan.scope)).toEqual({ status: "unknown" });
  });
  it("keeps reconciliation lookup errors secret and preserves launch intent", async () => {
    const s = await setup(backend);
    seedLaunchIntent(s);
    const row = s.log.getJobByDispatchId(s.plan.attemptId);
    const sentinels = ["sentinel-result", "sentinel-progress", "sentinel-publication", "sentinel-nonce", "sentinel-bootstrap", "sentinel-github"];
    const error = new Error(sentinels.join(" "));
    vi.mocked(s.fly.listMachines).mockRejectedValue(error);
    vi.mocked(s.docker.findLocalContainerIdByName).mockRejectedValue(error);

    const result = await s.instance.reconcile(s.plan.attemptId, s.plan.scope);

    expect(result).toEqual({ status: "unknown" });
    for (const sentinel of sentinels) expect(JSON.stringify(result)).not.toContain(sentinel);
    if (backend === "fly-machines") expect(s.fly.listMachines).toHaveBeenCalledWith("fly", "sessions");
    else expect(s.docker.findLocalContainerIdByName).toHaveBeenCalledWith("review-fix-attempt-1");
    expect(s.log.getJobByNonce("sentinel-nonce")).toEqual(row);
    expect(s.admission.read(s.plan.attemptId)!.releasedAt).toBeNull();
  });
  for (const count of [0, 1, 2]) it(`reconciles ${count} exact name candidates conservatively`, async () => {
    const s = await setup(backend);
    seedLaunchIntent(s);
    const ids = Array.from({ length: count }, (_, i) => `id-${i}`);
    vi.mocked(s.fly.listMachines).mockResolvedValue(ids.map(id => ({ id, name: "review-fix-attempt-1" })) as Awaited<ReturnType<typeof s.fly.listMachines>>);
    const worker = new s.worker.ContainerReviewFixWorker({ ...s.deps, localCandidates: async name => { expect(name).toBe("review-fix-attempt-1"); return ids; } });
    expect(await worker.reconcile("attempt-1", s.plan.scope)).toEqual(count === 1 ? { status: "found", execution: { backend, runRef: "id-0" } } : { status: "unknown" });
  });
  for (const exit of [0, 1, null, "running", "missing", "error"] as const) it(`inspects ${exit}`, async () => {
    const s = await setup(backend, "11111111-1111-1111-1111-111111111111");
    await s.instance.launch(s.plan);
    if (exit === "missing" || exit === "error") {
      vi.mocked(s.fly.getMachine).mockRejectedValue(new Error(exit === "missing" ? "404" : "sentinel-result"));
      vi.mocked(s.docker.inspectLocalContainer).mockRejectedValue(new Error(exit === "missing" ? "No such container" : "sentinel-result"));
    } else {
      vi.mocked(s.fly.getMachine).mockResolvedValue({ state: exit === "running" ? "started" : "stopped", events: [{ type: "exit", timestamp: Date.now(), request: { exit_event: { exit_code: typeof exit === "number" ? exit : undefined } } }] } as Awaited<ReturnType<typeof s.fly.getMachine>>);
      vi.mocked(s.docker.inspectLocalContainer).mockResolvedValue({ status: exit === "running" ? "running" : "exited", running: exit === "running", exitCode: typeof exit === "number" ? exit : null });
    }
    const result = await s.instance.inspectTerminal(s.execution);
    expect(result).toEqual(exit === "running" || exit === "error" ? { reached: false } : exit === 0 ? { reached: true, outcome: { status: "succeeded", outputCommit: "a".repeat(40) } } : { reached: true, outcome: { status: "failed", reason: "Container review-fix run failed" } });
    expect(JSON.stringify(result)).not.toContain("sentinel");
    const row = s.log.getJobByDispatchId(s.plan.attemptId)!;
    expect(row.completedAt !== null).toBe(exit !== "running" && exit !== "error");
    expect(row.machineNonce).toBe(exit === "running" || exit === "error" ? "sentinel-nonce" : null);
    expect(row.conclusion).not.toBe("runner_approved");
    expect(row.approved).toBe(false);
    expect(s.admission.read(s.plan.attemptId)!.releasedAt).toBeNull();
    expect(s.accounting.listJobAccounting({ includeUnsettled: true }).records).toHaveLength(exit === "running" || exit === "error" ? 0 : 1);
    const saved = { ...row };
    await s.instance.inspectTerminal(s.execution);
    expect(s.log.getJobByDispatchId(s.plan.attemptId)).toEqual(saved);
    expect(s.accounting.listJobAccounting({ includeUnsettled: true }).records).toHaveLength(exit === "running" || exit === "error" ? 0 : 1);
  });
  it("leaves success unreached when PR head cannot be read", async () => {
    const s = await setup(backend);
    await s.instance.launch(s.plan);
    vi.mocked(s.fly.getMachine).mockResolvedValue({ state: "stopped", events: [{ type: "exit", request: { exit_event: { exit_code: 0 } } }] } as Awaited<ReturnType<typeof s.fly.getMachine>>);
    vi.mocked(s.docker.inspectLocalContainer).mockResolvedValue({ status: "exited", running: false, exitCode: 0 });
    vi.mocked(s.deps.getPullRequestHeadSha!).mockResolvedValue(null);
    expect(await s.instance.inspectTerminal(s.execution)).toEqual({ reached: false });
  });
  for (const throws of [false, true]) it(`cancel ${throws ? "throws" : "acknowledged"}`, async () => {
    const s = await setup(backend);
    vi.mocked(s.control.stopBackendRun).mockImplementation(async () => { if (throws) throw new Error("sentinel-bootstrap"); return true; });
    expect(await s.instance.cancel("attempt-1", s.execution)).toEqual({ status: throws ? "unknown" : "cancelled" });
    expect(s.control.stopBackendRun).toHaveBeenCalledWith(s.deps.fly, backend, s.execution.runRef);
  });
});
for (const status of [400, 503, null]) it(`Fly launch error ${status}`, async () => {
  const s = await setup("fly-machines");
  vi.mocked(s.fly.createMachine).mockRejectedValue(new Error(status ? `create (${status}) sentinel-result` : "sentinel-result"));
  const result = await s.instance.launch(s.plan);
  expect(result.status).toBe(status === 400 ? "rejected" : "unknown");
  expect(JSON.stringify(result)).not.toContain("sentinel");
  const row = s.log.getJobByDispatchId(s.plan.attemptId)!;
  expect(row).toMatchObject(status === 400
    ? { status: "dispatch-failed", machineNonce: null, machineId: null, completedAt: expect.any(Number) }
    : { status: "dispatched", machineNonce: "sentinel-nonce", machineId: null, completedAt: null });
  expect(s.log.getJobByNonce("sentinel-nonce")).toEqual(status === 400 ? null : row);
  expect(s.admission.read(s.plan.attemptId)!.releasedAt).toBeNull();
});
for (const started of [false, true]) it(`local error ${started ? "after" : "before"} launch boundary`, async () => {
  const s = await setup("local-docker");
  vi.mocked(s.docker.startLocalRunnerContainer).mockImplementation(async input => { if (started) input.onBeforeLaunch?.(); throw new Error("sentinel-bootstrap"); });
  const result = await s.instance.launch(s.plan);
  expect(result.status).toBe(started ? "unknown" : "rejected");
  expect(s.log.getJobByDispatchId(s.plan.attemptId)).toEqual(started ? expect.objectContaining({ status: "dispatched", machineNonce: "sentinel-nonce", completedAt: null }) : null);
  expect(s.admission.read(s.plan.attemptId)!.releasedAt).toBeNull();
  expect(JSON.stringify(result)).not.toContain("sentinel");
});
it("Fly reconciliation excludes prefix and suffix name matches", async () => {
  const s = await setup("fly-machines");
  seedLaunchIntent(s);
  vi.mocked(s.fly.listMachines).mockResolvedValue([{ id: "wrong", name: "review-fix-attempt-1-extra" }] as Awaited<ReturnType<typeof s.fly.listMachines>>);
  expect(await s.instance.reconcile("attempt-1", s.plan.scope)).toEqual({ status: "unknown" });
});
it("local reconciliation uses Docker's exact-name helper by default", async () => {
  const s = await setup("local-docker");
  seedLaunchIntent(s);
  vi.mocked(s.docker.findLocalContainerIdByName).mockResolvedValue("found");
  expect(await s.instance.reconcile("attempt-1", s.plan.scope)).toEqual({ status: "found", execution: { backend: "local-docker", runRef: "found" } });
  expect(s.docker.findLocalContainerIdByName).toHaveBeenCalledWith("review-fix-attempt-1");
});
it("pre-launch persistence failure prevents external creation", async () => {
  const s = await setup("fly-machines");
  vi.spyOn(s.log, "appendLogIfAbsent").mockImplementationOnce(() => { throw new Error("(400) sentinel-nonce"); });
  expect(await s.instance.launch(s.plan)).toEqual({ status: "rejected", reason: "Container review-fix launch rejected" });
  expect(s.fly.createMachine).not.toHaveBeenCalled();
});

for (const status of ["created", "restarting", "paused", "running", "removing", "unknown"]) it(`local ${status} with zero exit code is not terminal`, async () => {
  const s = await setup("local-docker");
  await s.instance.launch(s.plan);
  vi.mocked(s.docker.inspectLocalContainer).mockResolvedValue({ status, running: false, exitCode: 0 });
  expect(await s.instance.inspectTerminal(s.execution)).toEqual({ reached: false });
  expect(s.deps.getPullRequestHeadSha).not.toHaveBeenCalled();
});

for (const guard of ["terminal", "bound", "generation", "nonce", "backend", "dispatch"] as const) it(`definite refusal preserves ${guard} row and fails closed`, async () => {
  const s = await setup("fly-machines");
  let protectedRow: ReturnType<typeof s.log.getJobByDispatchId>;
  vi.mocked(s.fly.createMachine).mockImplementation(async () => {
    const row = s.log.getJobByDispatchId(s.plan.attemptId)!;
    if (guard === "terminal") s.log.updateJobStatus(row.id, "completed", "runner_approved");
    if (guard === "bound") s.log.setJobMachineId(row.id, "existing-execution");
    if (guard === "nonce") s.log.setJobMachineNonce(row.id, "replacement-nonce");
    if (["generation", "backend", "dispatch"].includes(guard)) {
      const { getDb } = await import("../dedup.js");
      const column = { generation: "admission_generation", backend: "execution_mode", dispatch: "dispatch_id" }[guard as "generation" | "backend" | "dispatch"];
      getDb().prepare(`UPDATE dispatch_log SET ${column} = ? WHERE id = ?`).run(guard === "generation" ? row.admissionGeneration! + 1 : "other", row.id);
    }
    protectedRow = s.log.getJobById(row.id);
    throw new Error("create (400) sentinel-result");
  });
  expect(await s.instance.launch(s.plan)).toEqual({ status: "unknown" });
  expect(s.log.getJobById(protectedRow!.id)).toEqual(protectedRow!);
  expect(s.admission.read(s.plan.attemptId)!.releasedAt).toBeNull();
});

for (const backend of backends) describe(`${backend} terminal bookkeeping`, () => {
  function ended(s: Awaited<ReturnType<typeof setup>>) {
    vi.mocked(s.fly.getMachine).mockResolvedValue({ state: "stopped", events: [{ type: "exit", request: { exit_event: { exit_code: 0 } } }] } as Awaited<ReturnType<typeof s.fly.getMachine>>);
    vi.mocked(s.docker.inspectLocalContainer).mockResolvedValue({ status: "exited", running: false, exitCode: 0 });
  }
  for (const headFailure of ["null", "throws"] as const) it(`settles even when head read ${headFailure}, and can retry the outcome`, async () => {
    const s = await setup(backend);
    await s.instance.launch(s.plan);
    ended(s);
    if (headFailure === "null") vi.mocked(s.deps.getPullRequestHeadSha!).mockResolvedValueOnce(null);
    else vi.mocked(s.deps.getPullRequestHeadSha!).mockRejectedValueOnce(new Error("unavailable"));
    expect(await s.instance.inspectTerminal(s.execution)).toEqual({ reached: false });
    const row = s.log.getJobByDispatchId(s.plan.attemptId)!;
    expect(row).toMatchObject({ completedAt: expect.any(Number), machineNonce: null, approved: false });
    expect(await s.instance.inspectTerminal(s.execution)).toMatchObject({ reached: true });
    expect(s.log.getJobByDispatchId(s.plan.attemptId)).toEqual(row);
    expect(s.admission.read(s.plan.attemptId)!.releasedAt).toBeNull();
  });
  for (const state of ["ended", "missing", "running", "error"] as const) it(`cancel acknowledgement with ${state} observation`, async () => {
    const s = await setup(backend);
    await s.instance.launch(s.plan);
    ended(s);
    if (state === "running") {
      vi.mocked(s.fly.getMachine).mockResolvedValue({ state: "started" } as Awaited<ReturnType<typeof s.fly.getMachine>>);
      vi.mocked(s.docker.inspectLocalContainer).mockResolvedValue({ status: "running", running: true, exitCode: 0 });
    }
    if (state === "missing" || state === "error") {
      vi.mocked(s.fly.getMachine).mockRejectedValue(new Error(state === "missing" ? "404" : "unavailable"));
      vi.mocked(s.docker.inspectLocalContainer).mockRejectedValue(new Error(state === "missing" ? "No such container" : "unavailable"));
    }
    vi.mocked(s.control.stopBackendRun).mockResolvedValue(true);
    expect(await s.instance.cancel(s.plan.attemptId, s.execution)).toEqual({ status: "cancelled" });
    const row = s.log.getJobByDispatchId(s.plan.attemptId)!;
    expect(row.completedAt !== null).toBe(state === "ended" || state === "missing");
    expect(row.machineNonce).toBe(state === "ended" || state === "missing" ? null : "sentinel-nonce");
    expect(row.approved).toBe(false);
    expect(s.admission.read(s.plan.attemptId)!.releasedAt).toBeNull();
  });
  for (const guard of ["terminal", "generation", "backend", "execution", "nonce", "dispatch", "owner"] as const) it(`fences concurrent ${guard} changes`, async () => {
    const s = await setup(backend);
    await s.instance.launch(s.plan);
    ended(s);
    const { getDb } = await import("../dedup.js");
    let saved: ReturnType<typeof s.log.getJobByDispatchId>;
    const mutate = () => {
      const row = s.log.getJobByDispatchId(s.plan.attemptId)!;
      if (guard === "terminal") s.log.updateJobStatus(row.id, "completed", "runner_approved", undefined, { skipAdmissionRelease: true });
      else if (guard === "owner") getDb().prepare("UPDATE dispatch_admissions SET lifecycle_owner = ? WHERE dispatch_id = ?").run("legacy", s.plan.attemptId);
      else {
        const column = { generation: "admission_generation", backend: "execution_mode", execution: "machine_id", nonce: "machine_nonce", dispatch: "dispatch_id" }[guard];
        getDb().prepare(`UPDATE dispatch_log SET ${column} = ? WHERE id = ?`).run(guard === "generation" ? 999 : "replacement", row.id);
      }
      saved = s.log.getJobById(row.id);
    };
    if (backend === "fly-machines") {
      const value = await s.fly.getMachine("fly", "sessions", s.execution.runRef);
      vi.mocked(s.fly.getMachine).mockImplementationOnce(async () => { mutate(); return value; });
    } else {
      vi.mocked(s.docker.inspectLocalContainer).mockImplementationOnce(async () => { mutate(); return { status: "exited", running: false, exitCode: 0 }; });
    }
    expect(await s.instance.inspectTerminal(s.execution)).toEqual({ reached: false });
    expect(s.log.getJobById(saved!.id)).toEqual(saved!);
  });
  it("retries a failed transactional settlement", async () => {
    const s = await setup(backend);
    await s.instance.launch(s.plan);
    ended(s);
    vi.spyOn(s.log, "updateJobStatus").mockImplementationOnce(() => { throw new Error("busy"); });
    expect(await s.instance.inspectTerminal(s.execution)).toEqual({ reached: false });
    expect(s.log.getJobByDispatchId(s.plan.attemptId)).toMatchObject({ completedAt: null, machineNonce: "sentinel-nonce" });
    expect(await s.instance.inspectTerminal(s.execution)).toMatchObject({ reached: true });
    expect(s.log.getJobByDispatchId(s.plan.attemptId)).toMatchObject({ completedAt: expect.any(Number), machineNonce: null });
  });
});
