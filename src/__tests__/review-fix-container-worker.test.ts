import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { decodeRunConfig } from "../run-config.js";
import { testDb } from "./helpers/test-db.js";
import { makeMapping, makeScopedPrIdentity, makeChatGptPlanRecord } from "./helpers/builders.js";
import type { ContainerReviewFixWorkerDeps } from "../review-fix-container-worker.js";
import type { WorkerLaunchPlan } from "../review-fix-ports.js";

vi.mock("../fly-machines.js", async (original) => ({ ...await original<typeof import("../fly-machines.js")>(), createMachine: vi.fn(), listMachines: vi.fn(), getMachine: vi.fn(), listAppSecrets: vi.fn().mockResolvedValue([]), generateMachineNonce: () => "sentinel-nonce" }));
vi.mock("../repo-image.js", async (original) => ({ ...await original<typeof import("../repo-image.js")>(), resolveSessionImage: vi.fn().mockResolvedValue({ image: "runner", source: "default" }) }));
vi.mock("../local-docker.js", async (original) => ({ ...await original<typeof import("../local-docker.js")>(), startLocalRunnerContainer: vi.fn(), inspectLocalContainer: vi.fn(), stopLocalContainer: vi.fn(), findLocalContainerIdByName: vi.fn() }));
vi.mock("../fly-protection-key.js", () => ({ buildProtectedFlyBootstrap: vi.fn(async input => {
  const { sealModelAuthBootstrap } = await import("../model-auth-seal.js");
  const { MODEL_AUTH_ENV } = await import("../model-auth-contract.js");
  return { ...input, sealed: sealModelAuthBootstrap({ grant: input.bootstrap, protectionKey: { ref: MODEL_AUTH_ENV.protectionKey, key: Buffer.alloc(32, 1) } }), secret: { name: MODEL_AUTH_ENV.protectionKey, available: true, version: 1 } };
}) }));
vi.mock("../backend-run.js", async (original) => ({ ...await original<typeof import("../backend-run.js")>(), stopBackendRun: vi.fn() }));

async function setup(backend: "fly-machines" | "local-docker", attemptId = "attempt-1", readmissions?: number) {
  const { modules: m } = await testDb({ modules: {
    store: () => import("../review-fix-attempt-store.js"), worker: () => import("../review-fix-container-worker.js"), config: () => import("../config.js"), admission: () => import("../dispatch-admission.js"), log: () => import("../log.js"), fly: () => import("../fly-machines.js"), docker: () => import("../local-docker.js"), control: () => import("../backend-run.js"), accounting: () => import("../job-accounting.js"), managed: () => import("../managed-dispatch-auth.js"),
  } });
  const previousMode = process.env.RUNNER_MODE;
  process.env.RUNNER_MODE = backend === "local-docker" ? "local" : "default";
  onTestFinished(() => {
    if (previousMode === undefined) delete process.env.RUNNER_MODE;
    else process.env.RUNNER_MODE = previousMode;
  });
  m.config.upsertMapping("AII", makeMapping({ owner: "owner", repo: "repo", executionMode: "fly-machines" }));
  const scope = makeScopedPrIdentity({ repository: "owner/repo" });
  if (readmissions !== undefined) {
    const store = new m.store.SqliteReviewFixAttemptStore();
    let base = "";
    for (let i = 0; i <= readmissions; i++) {
      const admitted = await store.admit({ scope, feedback: { taskText: "fix findings", findings: [] }, jobTimeoutMinutes: 90 });
      if (admitted.status !== "prepared") throw new Error(`Admission failed: ${admitted.reason}`);
      expect(admitted.attempt.executionBackend).toBe(backend);
      attemptId = admitted.attempt.attemptId;
      if (i === 0) { base = attemptId; expect(base).toMatch(/^reviewfix-[0-9a-f]{64}$/); }
      else expect(attemptId).toBe(`${base}-${i}`);
      if (i < readmissions) expect(await store.releaseOwner(attemptId, "cancelled")).toEqual({ status: "released" });
    }
  } else {
    m.admission.acquire({ dispatchId: attemptId, mappingKey: "AII", scope: { kind: "pr", issueId: "issue", installationId: String(scope.installationId), repository: scope.repository, prNumber: scope.prNumber }, kind: "gap-fill", backend, lifecycleOwner: { kind: "restate", attemptId }, cap: 10 });
  }
  const deps: ContainerReviewFixWorkerDeps = {
    credentials: { resolve: vi.fn().mockResolvedValue({ token: "sentinel-github", installationId: scope.installationId }) },
    callbackInputs: vi.fn().mockResolvedValue({ run_token: "sentinel-result", run_progress_token: "sentinel-progress", run_publication_token: "sentinel-publication", runner_callback_url: "https://callback" }),
    fly: { flySessionsToken: "fly", flySessionsApp: "sessions", flySessionsRegion: null, flyOrchestratorApp: null, sessionImage: "runner", runnerCallbackBaseUrl: "https://callback", tenantId: null, anthropicApiKey: "key", claudeOAuthToken: null },
    local: { image: "runner", orchestratorUrl: "https://callback", anthropicApiKey: "key" },
    getPullRequestHeadSha: vi.fn().mockResolvedValue("a".repeat(40)),
  };
  vi.mocked(m.fly.createMachine).mockResolvedValue({ id: "machine", name: expectedName(attemptId) } as Awaited<ReturnType<typeof m.fly.createMachine>>);
  vi.mocked(m.docker.startLocalRunnerContainer).mockImplementation(async input => { input.onBeforeLaunch?.(); return { containerId: "container", containerName: input.containerName! }; });
  const plan: WorkerLaunchPlan = { executionBackend: backend, attemptId, scope, taskText: "fix findings", deadlineAt: Date.now() + 60000 };
  return { ...m, deps, plan, instance: new m.worker.ContainerReviewFixWorker(deps), execution: { backend, runRef: backend === "fly-machines" ? "machine" : "container" } };
}
function expectedName(attemptId: string) {
  return `review-fix-${createHash("sha256").update(attemptId).digest("hex").slice(0, 48)}`;
}
function createdName(s: Awaited<ReturnType<typeof setup>>) {
  return s.plan.executionBackend === "fly-machines"
    ? vi.mocked(s.fly.createMachine).mock.calls.at(-1)![2].name!
    : vi.mocked(s.docker.startLocalRunnerContainer).mock.calls.at(-1)![0].containerName!;
}
function seedLaunchIntent(s: Awaited<ReturnType<typeof setup>>) {
  s.log.appendLogIfAbsent({ issueId: `review-fix:${s.plan.attemptId}`, dispatchId: s.plan.attemptId, machineNonce: "sentinel-nonce", admissionGeneration: s.admission.read(s.plan.attemptId)!.generation, executionMode: s.plan.executionBackend, phase: "gap-analysis" });
}
beforeEach(() => vi.clearAllMocks());
const backends = ["fly-machines", "local-docker"] as const;
it("persists the launched Fly guest size for accounting", async () => {
  const s = await setup("fly-machines", "11111111-1111-1111-1111-111111111111");
  s.config.upsertMapping("AII", makeMapping({ owner: "owner", repo: "repo", machineCpus: 4, machineMemoryMb: 8192 }));
  expect(await s.instance.launch(s.plan)).toEqual({ status: "accepted", execution: s.execution });
  const guest = vi.mocked(s.fly.createMachine).mock.calls[0][2].config.guest!;
  expect(guest).toMatchObject({ cpus: 4, memory_mb: 8192 });
  const { getDb } = await import("../dedup.js");
  expect(getDb().prepare("SELECT machine_cpu_kind, machine_cpus, machine_memory_mb FROM dispatch_log WHERE dispatch_id = ?").get(s.plan.attemptId)).toEqual({
    machine_cpu_kind: guest.cpu_kind, machine_cpus: guest.cpus, machine_memory_mb: guest.memory_mb,
  });
  vi.mocked(s.fly.getMachine).mockResolvedValue({ state: "stopped", events: [{ type: "exit", request: { exit_event: { exit_code: 0 } } }] } as Awaited<ReturnType<typeof s.fly.getMachine>>);
  expect(await s.instance.inspectTerminal(s.execution)).toMatchObject({ reached: true });
  const records = s.accounting.listJobAccounting({ includeUnsettled: true }).records;
  expect(records).toHaveLength(1);
  expect(records[0].compute).toMatchObject({ cpuKind: guest.cpu_kind, cpus: guest.cpus, memoryMb: guest.memory_mb });
});
for (const backend of backends) describe(backend, () => {
  it("bounds names for SQLite content IDs and preserves suffix and shared-prefix identity", async () => {
    const names: string[] = [];
    let base = "";
    for (const suffix of [0, 1, 2]) {
      const s = await setup(backend, undefined, suffix);
      if (suffix === 0) base = s.plan.attemptId;
      else expect(s.plan.attemptId).toBe(`${base}-${suffix}`);
      expect(await s.instance.launch(s.plan)).toEqual({ status: "accepted", execution: s.execution });
      const name = createdName(s);
      expect(name).toBe(expectedName(s.plan.attemptId));
      expect(name.length).toBeLessThanOrEqual(63);
      expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      names.push(name);
    }
    const other = await setup(backend, `${base.slice(0, -1)}${base.endsWith("0") ? "1" : "0"}`);
    await other.instance.launch(other.plan);
    names.push(createdName(other));
    expect(new Set(names).size).toBe(4);
    const repeated = await setup(backend, undefined, 0);
    await repeated.instance.launch(repeated.plan);
    expect(createdName(repeated)).toBe(names[0]);
  });

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
    const s = await setup(backend, undefined, 2);
    const prepared = await s.instance.prepare({ ...s.plan, findings: [], owner: s.plan.attemptId });
    expect(s.deps.callbackInputs).not.toHaveBeenCalled();
    const launch = await s.instance.launch(prepared);
    expect(launch).toEqual({ status: "accepted", execution: s.execution });
    const row = s.log.getJobByDispatchId(s.plan.attemptId)!;
    expect(row).toMatchObject({ machineId: s.execution.runRef, machineNonce: "sentinel-nonce", dispatchId: s.plan.attemptId, admissionGeneration: s.admission.read(s.plan.attemptId)!.generation, phase: "gap-analysis", prUrl: null });
    const request = backend === "fly-machines" ? vi.mocked(s.fly.createMachine).mock.calls[0][2] : vi.mocked(s.docker.startLocalRunnerContainer).mock.calls[0][0];
    expect(createdName(s)).toBe(expectedName(s.plan.attemptId));
    expect(s.deps.callbackInputs).toHaveBeenCalledWith(s.plan.attemptId);
    const envelope = backend === "fly-machines"
      ? vi.mocked(s.fly.createMachine).mock.calls[0][2].config.env!.AI_IMPLEMENT_RUN_CONFIG
      : vi.mocked(s.docker.startLocalRunnerContainer).mock.calls[0][0].extraEnv!.AI_IMPLEMENT_RUN_CONFIG;
    expect(decodeRunConfig(envelope).reviewFix).toEqual({
      version: 1, attemptId: s.plan.attemptId, installationId: s.plan.scope.installationId,
      repository: s.plan.scope.repository, prNumber: s.plan.scope.prNumber,
      deadlineAt: s.plan.deadlineAt, executionBackend: backend,
    });
    expect(JSON.stringify(request)).toContain("sentinel-result");
    const restarted = new s.worker.ContainerReviewFixWorker(s.deps);
    expect(await restarted.launch(s.plan)).toEqual({ status: "unknown" });
    const reconciled = await restarted.reconcile(s.plan.attemptId, s.plan.scope);
    expect(reconciled).toEqual({ status: "found", execution: s.execution });
    expect(s.fly.listMachines).not.toHaveBeenCalled();
    expect(s.log.getJobByDispatchId(s.plan.attemptId)).toEqual(row);
    if (backend === "fly-machines") expect(s.fly.createMachine).toHaveBeenCalledTimes(1);
    else expect(s.docker.startLocalRunnerContainer).toHaveBeenCalledTimes(1);
    const outputs = JSON.stringify([prepared, launch, reconciled]);
    for (const sentinel of ["sentinel-nonce", "sentinel-result", "sentinel-progress", "sentinel-publication", "sentinel-github", "sentinel-bootstrap"]) expect(outputs).not.toContain(sentinel);
  });
  for (const failure of ["lost acknowledgement", "attachment failure"] as const) it(`recovers after ${failure} and worker restart`, async () => {
    const s = await setup(backend, undefined, 2);
    const assertIntent = () => {
      expect(s.log.getJobByNonce("sentinel-nonce")).toMatchObject({ dispatchId: s.plan.attemptId, machineId: null, status: "dispatched", admissionGeneration: s.admission.read(s.plan.attemptId)!.generation });
    };
    if (failure === "lost acknowledgement") {
      vi.mocked(s.fly.createMachine).mockImplementation(async () => { assertIntent(); throw new Error("lost acknowledgement"); });
      vi.mocked(s.docker.startLocalRunnerContainer).mockImplementation(async input => { input.onBeforeLaunch?.(); assertIntent(); throw new Error("lost acknowledgement"); });
    } else {
      vi.spyOn(s.log, "setJobMachineId").mockImplementationOnce(() => { throw new Error("(400) persistence failed"); });
    }
    expect(await s.instance.launch(s.plan)).toEqual({ status: "unknown" });
    assertIntent();
    vi.mocked(s.fly.listMachines).mockResolvedValue([{ id: s.execution.runRef, name: expectedName(s.plan.attemptId) }] as Awaited<ReturnType<typeof s.fly.listMachines>>);
    vi.mocked(s.docker.findLocalContainerIdByName).mockResolvedValue(s.execution.runRef);
    const original = s.log.getJobByDispatchId(s.plan.attemptId)!;
    const name = createdName(s);
    const restarted = new s.worker.ContainerReviewFixWorker(s.deps);
    expect(await restarted.launch(s.plan)).toEqual({ status: "unknown" });
    expect(await restarted.reconcile(s.plan.attemptId, s.plan.scope)).toEqual({ status: "found", execution: s.execution });
    expect(createdName(s)).toBe(name);
    if (backend === "fly-machines") expect(s.fly.createMachine).toHaveBeenCalledTimes(1);
    else {
      expect(s.docker.startLocalRunnerContainer).toHaveBeenCalledTimes(1);
      expect(s.docker.findLocalContainerIdByName).toHaveBeenCalledWith(name);
    }
    expect(s.log.getJobByDispatchId(s.plan.attemptId)!.id).toBe(original.id);
    expect(s.log.getJobByNonce("sentinel-nonce")).toMatchObject({ machineId: s.execution.runRef, status: "dispatched", admissionGeneration: s.admission.read(s.plan.attemptId)!.generation });
  });
  it("uses the admitted mapping when unmanaged siblings share the repository", async () => {
    const s = await setup(backend);
    vi.spyOn(s.config, "getMappings").mockReturnValue({
      SIBLING: makeMapping({ owner: "owner", repo: "repo" }),
      AII: makeMapping({ owner: "owner", repo: "repo" }),
    });
    const managed = vi.spyOn(s.managed, "isManagedProject").mockImplementation(key => key === "AII");
    expect(await s.instance.launch(s.plan)).toEqual({ status: "unknown" });
    expect(managed).toHaveBeenCalledWith("AII", "attempt-1");
    expect(s.fly.createMachine).not.toHaveBeenCalled();
  });
  it("refuses a mapping that no longer targets the admitted repository", async () => {
    const s = await setup(backend);
    s.config.upsertMapping("AII", makeMapping({ owner: "owner", repo: "other" }));
    expect(await s.instance.launch(s.plan)).toEqual({ status: "unknown" });
    expect(s.deps.callbackInputs).not.toHaveBeenCalled();
  });
  it("holds managed launches without a runtime", async () => {
    const s = await setup(backend);
    vi.spyOn(s.managed, "isManagedProject").mockReturnValueOnce(true);
    expect(await s.instance.launch(s.plan)).toEqual({ status: "unknown" });
    expect(s.fly.createMachine).not.toHaveBeenCalled();
  });
  it("does not report an execution without a durable nonce row", async () => {
    const s = await setup(backend);
    vi.mocked(s.fly.listMachines).mockResolvedValue([{ id: "orphan", name: expectedName(s.plan.attemptId) }] as Awaited<ReturnType<typeof s.fly.listMachines>>);
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
    else expect(s.docker.findLocalContainerIdByName).toHaveBeenCalledWith(expectedName(s.plan.attemptId));
    expect(s.log.getJobByNonce("sentinel-nonce")).toEqual(row);
    expect(s.admission.read(s.plan.attemptId)!.releasedAt).toBeNull();
  });
  for (const count of [0, 1, 2]) it(`reconciles ${count} exact name candidates conservatively`, async () => {
    const s = await setup(backend);
    seedLaunchIntent(s);
    const ids = Array.from({ length: count }, (_, i) => `id-${i}`);
    vi.mocked(s.fly.listMachines).mockResolvedValue(ids.map(id => ({ id, name: expectedName(s.plan.attemptId) })) as Awaited<ReturnType<typeof s.fly.listMachines>>);
    const worker = new s.worker.ContainerReviewFixWorker({ ...s.deps, localCandidates: async name => { expect(name).toBe(expectedName(s.plan.attemptId)); return ids; } });
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
for (const status of [400, 401, 403, 422]) it(`retains safe Fly create evidence for ${status}`, async () => {
  const s = await setup("fly-machines");
  const logs = ["log", "warn", "error"].map(method => vi.spyOn(console, method as "log" | "warn" | "error").mockImplementation(() => {}));
  const secrets = ["sentinel-github", "sentinel-result", "sentinel-progress", "sentinel-publication", "sentinel-api", "sentinel-oauth", "sentinel-bootstrap"];
  vi.mocked(s.fly.createMachine).mockRejectedValue(new Error(`Failed to create machine in sessions (${status}): invalid config: {"task":"private-task", "envelope":"private-envelope", "credentials":"${secrets.join(" ")}"}\n${"private-config".repeat(1000)}`));
  const result = await s.instance.launch(s.plan);
  expect(result).toMatchObject({ status: "rejected", reason: expect.stringContaining(`fly-machines create rejected [HTTP_${status}]`) });
  if (result.status === "rejected") {
    expect(result.reason.length).toBeLessThanOrEqual(320);
    expect(result.reason).toContain(status === 401 || status === 403 ? "authorization" : "validation");
  }
  const evidence = JSON.stringify([result, ...logs.map(log => log.mock.calls)]);
  for (const secret of [...secrets, "private-task", "private-envelope", "private-config"]) expect(evidence).not.toContain(secret);
  expect(s.log.getJobByDispatchId(s.plan.attemptId)).toMatchObject({ status: "dispatch-failed", conclusion: "failure", machineNonce: null, machineId: null });
  expect(s.admission.read(s.plan.attemptId)!.releasedAt).toBeNull();
  logs.forEach(log => log.mockRestore());
});
for (const backend of backends) it(`${backend} preparation errors omit non-Error payloads`, async () => {
  const s = await setup(backend);
  vi.mocked(s.deps.credentials.resolve).mockRejectedValue({ task: "private-task", token: "sentinel-bootstrap" });
  expect(await s.instance.launch(s.plan)).toEqual({ status: "rejected", reason: `${backend} preparation rejected [PREPARATION_FAILED]: launch preparation failed` });
});
it("retains an allowlisted Fly image cause without echoed values", async () => {
  const s = await setup("fly-machines");
  vi.mocked(s.fly.createMachine).mockRejectedValue(new Error('create (422): image not found: private-image {"task":"private-task"}'));
  expect(await s.instance.launch(s.plan)).toEqual({ status: "rejected", reason: "fly-machines create rejected [HTTP_422]: Fly image validation refused" });
});
for (const started of [false, true]) it(`local error ${started ? "after" : "before"} launch boundary`, async () => {
  const s = await setup("local-docker");
  vi.mocked(s.docker.startLocalRunnerContainer).mockImplementation(async input => { if (started) input.onBeforeLaunch?.(); throw new Error("sentinel-bootstrap"); });
  const result = await s.instance.launch(s.plan);
  expect(result).toEqual(started ? { status: "unknown" } : { status: "rejected", reason: "local-docker preparation rejected [PREPARATION_FAILED]: launch preparation failed" });
  expect(s.log.getJobByDispatchId(s.plan.attemptId)).toEqual(started ? expect.objectContaining({ status: "dispatched", machineNonce: "sentinel-nonce", completedAt: null }) : null);
  expect(s.admission.read(s.plan.attemptId)!.releasedAt).toBeNull();
  expect(JSON.stringify(result)).not.toContain("sentinel");
});
it("Fly reconciliation excludes prefix and suffix name matches", async () => {
  const s = await setup("fly-machines", undefined, 2);
  seedLaunchIntent(s);
  vi.mocked(s.fly.listMachines).mockResolvedValue([{ id: "wrong", name: `${expectedName(s.plan.attemptId)}-extra` }, { id: "also-wrong", name: `extra-${expectedName(s.plan.attemptId)}` }] as Awaited<ReturnType<typeof s.fly.listMachines>>);
  expect(await s.instance.reconcile(s.plan.attemptId, s.plan.scope)).toEqual({ status: "unknown" });
});
it("local reconciliation uses Docker's exact-name helper by default", async () => {
  const s = await setup("local-docker");
  seedLaunchIntent(s);
  vi.mocked(s.docker.findLocalContainerIdByName).mockResolvedValue("found");
  expect(await s.instance.reconcile("attempt-1", s.plan.scope)).toEqual({ status: "found", execution: { backend: "local-docker", runRef: "found" } });
  expect(s.docker.findLocalContainerIdByName).toHaveBeenCalledWith(expectedName(s.plan.attemptId));
});
it("pre-launch persistence failure prevents external creation", async () => {
  const s = await setup("fly-machines");
  vi.spyOn(s.log, "appendLogIfAbsent").mockImplementationOnce(() => { throw new Error("(400) sentinel-nonce"); });
  expect(await s.instance.launch(s.plan)).toEqual({ status: "rejected", reason: "fly-machines preparation rejected [PREPARATION_FAILED]: launch preparation failed" });
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

async function managedSetup(backend: typeof backends[number], mode: "api" | "plan" | "mixed") {
  const s = await setup(backend);
  const profiles = await import("../agent-config-store.js");
  const { createModelAuthRuntime } = await import("../model-auth-runtime.js");
  const runtime = createModelAuthRuntime({ config: { githubAppId: "1", githubAppPrivateKey: "fake", sessionImage: "runner" }, env: { RUNNER_TOKEN_SECRET: "synthetic-runtime-secret" } });
  runtime.credentials.resolveProtectedSecret = () => "sentinel-api-key";
  runtime.preparationDeps = vi.fn(() => ({ ownership: runtime.ownership, credentials: runtime.credentials,
    checkRunnerCapability: async () => true, readDefaultBranchWorkflows: async () => ({}) }));
  profiles.saveAccountProfileRevision({ profileId: "api", identity: "api", revision: 1, agent: "codex", provider: "openai", authMode: "openai-api-key", metadata: { credentialRef: "model-account:api" } });
  profiles.saveAccountProfileRevision({ profileId: "claude", identity: "claude", revision: 1, agent: "claude", provider: "anthropic", authMode: "anthropic-api-key", metadata: { credentialRef: "model-account:claude" } });
  profiles.saveAccountProfileRevision({ profileId: "plan", identity: "plan", revision: 1, agent: "codex", provider: "openai", authMode: "codex-subscription" });
  expect(runtime.sessionStore.writePlanRecord({ profileId: "plan", expectedSequence: null, sessionData: JSON.stringify(makeChatGptPlanRecord({ accessToken: "sentinel-access" })) }).ok).toBe(true);
  const stage = (id: string) => ({ agent: "codex" as const, provider: "openai" as const, model: "gpt-6-luna", fallbackModel: "gpt-5.4", accountProfileId: id, invocationTimeoutMs: 60000 });
  profiles.setOrchestratorDefaults({ version: 1, mode: "configured", stages: { planning: stage(mode === "api" ? "api" : "plan"), implementation: stage(mode === "plan" ? "plan" : "api"), review: mode === "mixed" ? { ...stage("claude"), agent: "claude", provider: "anthropic" } : stage(mode === "api" ? "api" : "plan") } });
  profiles.setProjectOptIn("AII", true);
  s.deps.modelAuthRuntime = runtime;
  return { ...s, runtime, profiles };
}
for (const backend of backends) describe(`managed ${backend}`, () => {
  it.each(["api", "plan", "mixed"] as const)("launches protected %s with one frozen snapshot", async mode => {
    const s = await managedSetup(backend, mode);
    const prepared = await s.instance.prepare({ ...s.plan, findings: [], owner: s.plan.attemptId });
    const result = await s.instance.launch(prepared);
    expect(result).toEqual({ status: "accepted", execution: s.execution });
    const { loadStoredSnapshot } = await import("../agent-run-preparation.js");
    const frozen = loadStoredSnapshot(s.plan.attemptId);
    expect(frozen?.stages.implementation.accountProfileId).toBe(mode === "plan" ? "plan" : "api");
    s.profiles.setProjectOptIn("AII", false);
    expect(await new s.worker.ContainerReviewFixWorker(s.deps).launch(prepared)).toEqual({ status: "unknown" });
    expect(loadStoredSnapshot(s.plan.attemptId)).toEqual(frozen);
    expect(s.runtime.preparationDeps).toHaveBeenCalledTimes(1);
    const protectedInput = backend === "fly-machines" ? vi.mocked((await import("../fly-protection-key.js")).buildProtectedFlyBootstrap).mock.calls.at(-1)?.[0] : vi.mocked(s.docker.startLocalRunnerContainer).mock.calls[0][0].protectedModelAuth;
    expect(protectedInput).toBeDefined();
    expect(protectedInput?.runConfig.agentConfig).toEqual(frozen);
    expect(protectedInput?.runConfig.modelFallbacks).toEqual({ planning: "gpt-5.4", implementation: "gpt-5.4", review: "gpt-5.4" });
    expect(JSON.stringify([prepared, result])).not.toMatch(/sentinel-(api-key|access|bootstrap)/);
  });
  it.each(["lost acknowledgement", "attachment failure"])("settles and reconciles %s without a second grant", async failure => {
    const s = await managedSetup(backend, "mixed");
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    if (failure === "lost acknowledgement") {
      vi.mocked(s.fly.createMachine).mockRejectedValue(new Error("lost ack sentinel-api-key"));
      vi.mocked(s.docker.startLocalRunnerContainer).mockImplementation(async input => { input.onBeforeLaunch?.(); throw new Error("lost ack sentinel-access"); });
    } else vi.spyOn(s.log, "setJobMachineId").mockImplementationOnce(() => { throw new Error("attach failed"); });
    const launchResult = await s.instance.launch(s.plan);
    expect(launchResult).toEqual({ status: "unknown" });
    const { getDb } = await import("../dedup.js");
    expect(getDb().prepare("SELECT revoked_at FROM model_credential_grants WHERE dispatch_id = ?").get(s.plan.attemptId)).toEqual({ revoked_at: failure === "lost acknowledgement" ? expect.any(Number) : null });
    vi.mocked(s.fly.listMachines).mockResolvedValue([{ id: s.execution.runRef, name: expectedName(s.plan.attemptId) }] as Awaited<ReturnType<typeof s.fly.listMachines>>);
    vi.mocked(s.docker.findLocalContainerIdByName).mockResolvedValue(s.execution.runRef);
    const restarted = new s.worker.ContainerReviewFixWorker(s.deps);
    expect(await restarted.launch(s.plan)).toEqual({ status: "unknown" });
    expect(await restarted.reconcile(s.plan.attemptId, s.plan.scope)).toEqual({ status: "found", execution: s.execution });
    expect(s.runtime.preparationDeps).toHaveBeenCalledTimes(1);
    const protectedInput = backend === "fly-machines"
      ? vi.mocked((await import("../fly-protection-key.js")).buildProtectedFlyBootstrap).mock.calls.at(-1)![0]
      : vi.mocked(s.docker.startLocalRunnerContainer).mock.calls[0][0].protectedModelAuth!;
    const bearer = protectedInput.bootstrap.bearer;
    expect(bearer).toBeTruthy();
    expect(backend === "fly-machines" ? s.fly.createMachine : s.docker.startLocalRunnerContainer).toHaveBeenCalledTimes(1);
    for (const secret of [bearer, "sentinel-api-key", "sentinel-access"])
      expect(JSON.stringify([launchResult, logs.mock.calls, errors.mock.calls, warnings.mock.calls])).not.toContain(secret);
  });
  if (backend === "fly-machines") it("omits managed bootstrap and credential payloads from definitive rejection evidence", async () => {
    const s = await managedSetup(backend, "mixed");
    const logs = ["log", "warn", "error"].map(method => vi.spyOn(console, method as "log" | "warn" | "error").mockImplementation(() => {}));
    let bearer = "";
    vi.mocked(s.fly.createMachine).mockImplementation(async () => {
      const input = vi.mocked((await import("../fly-protection-key.js")).buildProtectedFlyBootstrap).mock.calls.at(-1)![0];
      bearer = input.bootstrap.bearer;
      throw new Error(`create (422): invalid config ${bearer} sentinel-api-key sentinel-access sentinel-bootstrap`);
    });
    const result = await s.instance.launch(s.plan);
    expect(result).toEqual({ status: "rejected", reason: "fly-machines create rejected [HTTP_422]: Fly request validation refused" });
    expect(bearer).toBeTruthy();
    const evidence = JSON.stringify([result, ...logs.map(log => log.mock.calls)]);
    for (const secret of [bearer, "sentinel-api-key", "sentinel-access", "sentinel-bootstrap"]) expect(evidence).not.toContain(secret);
    expect(s.runtime.preparationDeps).toHaveBeenCalledTimes(1);
    expect(s.admission.read(s.plan.attemptId)!.releasedAt).toBeNull();
    logs.forEach(log => log.mockRestore());
  });
  it("refuses a disabled profile without creating an execution", async () => {
    const s = await managedSetup(backend, "api");
    s.profiles.retireAccountProfile("api");
    expect(await s.instance.launch(s.plan)).toMatchObject({ status: "rejected" });
    expect(s.fly.createMachine).not.toHaveBeenCalled();
    expect(s.docker.startLocalRunnerContainer).not.toHaveBeenCalled();
  });
  if (backend === "fly-machines") it("refuses repository image overrides before creating a machine", async () => {
    const s = await managedSetup(backend, "api");
    const images = await import("../repo-image.js");
    vi.mocked(images.resolveSessionImage).mockResolvedValueOnce({ image: "untrusted", source: "override" });
    expect(await s.instance.launch(s.plan)).toMatchObject({ status: "rejected" });
    expect(s.fly.createMachine).not.toHaveBeenCalled();
    const { getDb } = await import("../dedup.js");
    expect(getDb().prepare("SELECT revoked_at FROM model_credential_grants WHERE dispatch_id = ?").get(s.plan.attemptId)).toEqual({ revoked_at: expect.any(Number) });
  });

});
