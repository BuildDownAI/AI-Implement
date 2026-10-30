import * as restate from "@restatedev/restate-sdk";
import { queryNonCompletedInvocations } from "../../restate/endpoint.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSelfDeploy, type SelfDeployRecord, type SelfDeployStartResult } from "../../restate/self-deploy.js";
import { callObject, callService, killInvocation, gate, eventually, queryInvocations, replaceEndpoint, startRetryEnabled, setObjectState, startVariants, stopAll, VARIANTS, type RestateEnvironment } from "./harness.js";
import { COMMIT, deployFixture } from "./self-deploy-fixture.js";

describe("SelfDeploy durable phase machine", () => {
  let f = deployFixture();
  // Each scenario resets its fakes; the object factory still reads the current injected dependencies.
  const object = () => createSelfDeploy(new Proxy({} as typeof f.deps, { get: (_t, key) => f.deps[key as keyof typeof f.deps] }));
  let envs: Map<string, RestateEnvironment>;
  beforeAll(async () => { envs = await startVariants([object()]); }, 60_000);
  afterAll(async () => stopAll(envs));
  const call = <T>(env: RestateEnvironment, handler: string, body: unknown = {}) => callObject<T>(env.baseUrl(), "SelfDeploy", "test-app", handler, body);
  const start = (env: RestateEnvironment) => call<SelfDeployStartResult>(env, "start", { branch: "testing", requestedBy: "owner" });
  const read = (env: RestateEnvironment) => call<SelfDeployRecord | null>(env, "status");
  const terminal = async (env: RestateEnvironment, fixture: ReturnType<typeof deployFixture>, expected: string, reason: SelfDeployRecord["reason"] = null) => {
    const record = await phase(env, expected);
    await eventually(async () => fixture.state.outcomes, outcomes => outcomes.some(r => r.deployId === record!.deployId), { label: "terminal callback" });
    expect(record).toMatchObject({ phase: expected, reason, finishedAt: expect.any(Number) });
    expect(record!.finishedAt!).toBeGreaterThanOrEqual(record!.startedAt);
    expect(fixture.state.outcomes.filter(r => r.deployId === record!.deployId)).toEqual([record]);
    expect(fixture.deps.onOutcome).toHaveBeenCalledWith(record);
    return record;
  };
  const phase = (env: RestateEnvironment, value: string) => eventually(() => read(env), r => r?.phase === value, { label: value });
  it.each(VARIANTS)("holds, deduplicates, drains without sleeping, preserves full config and succeeds (%s)", async label => {
    f = deployFixture();
    const env = envs.get(label)!;
    const before = structuredClone(f.machine.config);
    const first = await start(env);
    expect(first).toMatchObject({ alreadyActive: false, commit: COMMIT });
    expect(f.state.held).toBe(true);
    expect(await start(env)).toEqual({ ...first, alreadyActive: true });
    await eventually(() => queryInvocations(env.adminAPIBaseUrl(), "target_service_name = 'SelfDeploy' AND target_handler_name = 'checkDrain' AND status = 'scheduled'"), r => r.length > 0, { label: "scheduled drain" });
    const open = await queryInvocations(env.adminAPIBaseUrl(), "target_service_name = 'SelfDeploy' AND status != 'completed' AND status != 'scheduled'");
    expect(open.every(r => r.target_handler_name === "checkDrain")).toBe(true);
    expect(f.deps.drainProbes).toHaveBeenCalledWith(expect.any(String));
    f.state.work = false;
    await phase(env, "verifying");
    expect(await start(env)).toEqual({ ...first, alreadyActive: true });
    expect(await call(env, "cancel", { requestedBy: "owner" })).toEqual({ cancelled: false, reason: "too-late" });
    await terminal(env, f, "succeeded");
    expect(f.state.held).toBe(false);
    expect(f.state.outcomes).toHaveLength(1);
    expect(f.deps.fly.updateMachine).toHaveBeenCalledExactlyOnceWith("secret-fly", "test-app", "m1", { ...before, image: (first as { image: string }).image });
  });
  it.each(VARIANTS)("refuses missing images/auth, unknown head and missing configuration without hold or Fly (%s)", async label => {
    f = deployFixture(); const env = envs.get(label)!;
    const warnings = vi.spyOn(console, "warn");
    const previous = await read(env);
    for (const status of [404, 401, 403]) {
      f.state.status = status;
      expect(await start(env)).toEqual({ reason: "image-not-published" });
    }
    for (const status of [401, 403]) expect(warnings.mock.calls.flat().join("\n")).toContain(`image-not-published HTTP ${status}`);
    warnings.mockRestore();
    f.state.head = null;
    expect(await start(env)).toEqual({ reason: "head-unknown" });
    f.config.flyDeployToken = undefined;
    expect(await start(env)).toEqual({ reason: "not-configured" });
    expect(await read(env)).toEqual(previous);
    expect(f.deps.setHold).not.toHaveBeenCalled();
    expect(f.deps.fly.listMachines).not.toHaveBeenCalled();
  });
  it.each(VARIANTS)("every drain probe must prove zero, including unknown results (%s)", async label => {
    const env = envs.get(label)!;
    for (const name of ["oldDeploymentInvocations", "unresolvedLaunches", "unresolvedTerminations", "activeOwners"] as const) {
      for (const count of [1, null]) {
        f = deployFixture(); f.state.work = false;
        const probes = f.deps.drainProbes("unused");
        probes[name] = async () => count;
        f.deps.drainProbes = vi.fn(() => probes);
        await start(env);
        await eventually(async () => vi.mocked(f.deps.drainProbes).mock.calls.length, n => n > 0, { label: "blocking probe" });
        expect((await read(env))?.phase).toBe("draining");
        expect(f.deps.fly.updateMachine).not.toHaveBeenCalled();
        await call(env, "cancel", { requestedBy: "owner" });
      }
    }
  });
  it("cancel clears the hold and its stale timer cannot advance a new deploy in either variant", async () => {
    const fixture = deployFixture();
    fixture.deps.limits!.drainPollMs = 3_000;
    const local = await startVariants([createSelfDeploy(fixture.deps)]);
    try { for (const env of local.values()) {
      await start(env);
      const pending = await eventually(() => queryInvocations(env.adminAPIBaseUrl(), "target_service_name = 'SelfDeploy' AND target_handler_name = 'checkDrain' AND status = 'scheduled'"), rows => rows.length > 0, { label: "old drain timer" });
      const oldTimerId = String(pending[0].id);
      expect(await call(env, "cancel", { requestedBy: "owner" })).toEqual({ cancelled: true });
      await terminal(env, fixture, "cancelled");
      expect(fixture.state.held).toBe(false);
      expect(await call(env, "cancel", { requestedBy: "owner" })).toEqual({ cancelled: false, reason: "no-active-deploy" });
      await start(env);
      await eventually(() => queryInvocations(env.adminAPIBaseUrl(), `id = '${oldTimerId}'`), rows => rows[0]?.status === "completed", { label: "stale timer completed" });
      expect(vi.mocked(fixture.deps.drainProbes).mock.calls.flat()).not.toContain(oldTimerId);
      expect((await read(env))?.phase).toBe("draining");
      await call(env, "cancel", { requestedBy: "owner" });
    } } finally { await stopAll(local); }
  }, 60_000);
  it.each(VARIANTS)("honors control plane config ownership and verify times out after five reads (%s)", async label => {
    f = deployFixture(); const env = envs.get(label)!;
    const warnings = vi.spyOn(console, "warn");
    f.config.imageApp = "owned-images"; f.state.toml = true; f.state.work = false; f.state.commit = "old";
    await start(env);
    await terminal(env, f, "failed", "verify-timeout");
    expect(warnings.mock.calls.flat().filter(line => String(line).includes("deploy_apply_fly_toml refused: control plane owns machine config"))).toHaveLength(1);
    warnings.mockRestore();
    expect((await read(env))?.reason).toBe("verify-timeout");
    expect(f.state.reads).toBe(5);
    expect(f.deps.flyctl).not.toHaveBeenCalled();
    expect(f.deps.fly.updateMachine).toHaveBeenCalledOnce();
    expect(f.state.held).toBe(false);
  });
  it.each(VARIANTS)("builds KG images with source stamps and secret (%s)", async label => {
    f = deployFixture(); const env = envs.get(label)!;
    f.config.kgSourceRepo = "owner/kg"; f.state.work = false;
    await start(env); await terminal(env, f, "succeeded");
    expect(f.deps.registryHead).not.toHaveBeenCalled();
    expect(f.deps.flyctl).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(["--build-only", "--push", "--image-label", "deploy-abcdef0", "kg_token=secret-kg", `SOURCE_COMMIT=${COMMIT}`, "SOURCE_REPO=owner/repo", "SOURCE_BRANCH=testing"]), "secret-fly");
  });
  it.each(VARIANTS)("a Fly 4xx ends failed and clears the hold (%s)", async label => {
    f = deployFixture(); const env = envs.get(label)!; f.state.work = false;
    vi.mocked(f.deps.fly.updateMachine).mockRejectedValue(Object.assign(new Error("denied"), { status: 403 }));
    await start(env); await terminal(env, f, "failed", "apply-failed");
    expect((await read(env))?.reason).toBe("apply-failed"); expect(f.state.held).toBe(false);
  });
  it.each(VARIANTS)("uses detached fly.toml mode only for independently owned machines (%s)", async label => {
    f = deployFixture(); const env = envs.get(label)!; f.state.work = false; f.state.toml = true;
    await start(env); await terminal(env, f, "succeeded");
    expect(f.deps.fly.updateMachine).not.toHaveBeenCalled();
    expect(f.deps.flyctl).toHaveBeenCalledWith(expect.anything(), ["deploy", "--image", "registry.fly.io/builddown-orchestrator-image:testing-abcdef0", "--detach", "--app", "test-app"], "secret-fly");
  });
  it.each(VARIANTS)("already-target machines need no update (%s)", async label => {
    f = deployFixture(); const env = envs.get(label)!; f.state.work = false;
    f.machine.config.image = "registry.fly.io/builddown-orchestrator-image:testing-abcdef0";
    await start(env); await terminal(env, f, "succeeded");
    expect(f.deps.fly.updateMachine).not.toHaveBeenCalled();
  });
  it.each(VARIANTS)("applying is deduplicated and cannot be cancelled (%s)", async label => {
    f = deployFixture(); const env = envs.get(label)!;
    const record: SelfDeployRecord = { deployId: "seed-applying", phase: "applying", target: { branch: "testing", commit: COMMIT, image: "image", source: "published" }, requestedBy: "owner", startedAt: 1, finishedAt: null, reason: null };
    await setObjectState(env.adminAPIBaseUrl(), "SelfDeploy", "test-app", "deploy", record);
    expect(await start(env)).toEqual({ deployId: record.deployId, commit: COMMIT, image: "image", alreadyActive: true });
    expect(await call(env, "cancel", { requestedBy: "owner" })).toEqual({ cancelled: false, reason: "too-late" });
    expect(f.deps.head).not.toHaveBeenCalled();
    await setObjectState(env.adminAPIBaseUrl(), "SelfDeploy", "test-app", "deploy", { ...record, phase: "cancelled" });
  });
  it.each(VARIANTS)("preserves each machine's complete configuration (%s)", async label => {
    f = deployFixture(); const env = envs.get(label)!; f.state.work = false;
    const machines = [structuredClone(f.machine), { ...structuredClone(f.machine), id: "m2", config: { ...structuredClone(f.machine.config), env: { OTHER: "value" }, mounts: [{ volume: "data", path: "/data" }] } }];
    const before = structuredClone(machines);
    vi.mocked(f.deps.fly.listMachines).mockResolvedValue(machines);
    vi.mocked(f.deps.fly.getMachine).mockImplementation(async (_token, _app, id) => structuredClone(machines.find(m => m.id === id)!));
    const result = await start(env);
    await terminal(env, f, "succeeded");
    expect(f.deps.fly.updateMachine).toHaveBeenCalledTimes(2);
    for (const machine of before) expect(f.deps.fly.updateMachine).toHaveBeenCalledWith("secret-fly", "test-app", machine.id, { ...machine.config, image: (result as { image: string }).image });
  });
  it("checks every inactive internal-handler/phase pair and shared status in both variants", async () => {
    const fixture = deployFixture();
    const obj = createSelfDeploy(fixture.deps);
    const driver = restate.service({ name: "PhaseDriver", handlers: {
      invoke: async (ctx: restate.Context, input: { key: string; handler: "checkDrain" | "apply" | "verify" }) => {
        const client = ctx.objectClient(obj, input.key);
        const headers = { "self-deploy-id": "matrix" };
        if (input.handler === "verify") await client.verify({ attempt: 1 }, restate.rpc.opts({ headers }));
        else await client[input.handler](restate.rpc.opts({ headers }));
      },
    } });
    const local = await startVariants([obj, driver]);
    try { for (const env of local.values()) {
      for (const current of [null, "draining", "applying", "verifying", "succeeded", "failed", "cancelled"] as const) {
        const key = `matrix-${current}`;
        const record: SelfDeployRecord | null = current === null ? null : { deployId: "matrix", phase: current, target: { branch: "testing", commit: COMMIT, image: "image", source: "published" }, requestedBy: "owner", startedAt: 1, finishedAt: null, reason: null };
        if (record) await setObjectState(env.adminAPIBaseUrl(), "SelfDeploy", key, "deploy", record);
        for (const handler of ["checkDrain", "apply", "verify"] as const) {
          if ((handler === "checkDrain" && current === "draining") || (handler === "apply" && current === "applying") || (handler === "verify" && current === "verifying")) continue;
          await callService(env.baseUrl(), "PhaseDriver", "invoke", { key, handler });
          expect(await callObject(env.baseUrl(), "SelfDeploy", key, "status", {})).toEqual(record);
        }
        if (current !== "draining") expect(await callObject(env.baseUrl(), "SelfDeploy", key, "cancel", { requestedBy: "owner" })).toEqual({ cancelled: false, reason: current === "applying" || current === "verifying" ? "too-late" : "no-active-deploy" });
      }
      expect(fixture.deps.fly.listMachines).not.toHaveBeenCalled();
      expect(fixture.deps.onOutcome).not.toHaveBeenCalled();
      expect(fixture.deps.drainProbes).not.toHaveBeenCalled();
    } } finally { await stopAll(local); }
  }, 60_000);
  it("uses the real drain query to exclude only itself while other open work blocks, in both variants", async () => {
    const fixture = deployFixture(); fixture.state.work = false;
    const blocker = restate.service({ name: "DrainBlocker", handlers: { wait: async (ctx: restate.Context) => { await ctx.sleep(60_000); } } });
    const local = await startVariants([createSelfDeploy(fixture.deps), blocker]);
    try { for (const env of local.values()) {
      const uri = `http://127.0.0.1:${env.endpointPort()}`;
      const probeGate = gate("running quiet probe");
      const observations: Array<{ own: string; excluded: number | null; defaultCount: number | null }> = [];
      fixture.deps.drainProbes = vi.fn(own => ({
        oldDeploymentInvocations: async () => {
          await probeGate.wait();
          const excluded = await queryNonCompletedInvocations(fetch, env.adminAPIBaseUrl(), uri, own);
          const defaultCount = await queryNonCompletedInvocations(fetch, env.adminAPIBaseUrl(), uri);
          observations.push({ own, excluded, defaultCount });
          return excluded;
        }, unresolvedLaunches: async () => 0, unresolvedTerminations: async () => 0, activeOwners: async () => 0,
      }));
      await callService(env.baseUrl(), "DrainBlocker", "wait/send", {});
      const blockers = await eventually(() => queryInvocations(env.adminAPIBaseUrl(), "target_service_name = 'DrainBlocker' AND status != 'completed' AND status != 'scheduled'"), rows => rows.length === 1, { label: "open blocker" });
      await start(env);
      await probeGate.reached();
      // A shared read must complete while the exclusive checkDrain is still running.
      try {
        expect((await read(env))?.phase).toBe("draining");
        const open = await queryInvocations(env.adminAPIBaseUrl(), "target_service_name = 'SelfDeploy' AND status != 'completed' AND status != 'scheduled'");
        expect(open).toHaveLength(1);
        expect(open[0]).toMatchObject({ id: vi.mocked(fixture.deps.drainProbes).mock.calls[0][0], target_handler_name: "checkDrain" });
      } finally { probeGate.release(); }
      await eventually(async () => observations, rows => rows.some(r => r.excluded === 1 && r.defaultCount === 2), { label: "self excluded but blocker counted" });
      expect((await read(env))?.phase).toBe("draining");
      const scheduled = await eventually(() => queryInvocations(env.adminAPIBaseUrl(), "target_service_name = 'SelfDeploy' AND status = 'scheduled'"), rows => rows.length > 0, { label: "scheduled drain" });
      expect(scheduled.every(r => r.target_handler_name === "checkDrain")).toBe(true);
      await eventually(() => queryNonCompletedInvocations(fetch, env.adminAPIBaseUrl(), uri), count => count === 1, { label: "default query still counts blocker" });
      await killInvocation(env.adminAPIBaseUrl(), String(blockers[0].id));
      await terminal(env, fixture, "succeeded");
      expect(observations.some(r => r.excluded === 0 && r.defaultCount === 1)).toBe(true);
      expect(fixture.deps.drainProbes).toHaveBeenCalledWith(expect.stringMatching(/^inv_/));
    } } finally { await stopAll(local); }
  }, 60_000);
  it.each(VARIANTS)("validates branch and requester (%s)", async label => {
    const env = envs.get(label)!;
    for (const body of [{ branch: "other", requestedBy: "owner" }, { branch: "main", requestedBy: "" }, { branch: "main", requestedBy: "x".repeat(201) }]) {
      await expect(call(env, "start", body)).rejects.toThrow();
    }
  });
  it("times out a blocked drain using injected limits", async () => {
    const fixture = deployFixture(); fixture.deps.limits!.drainTimeoutMs = 0;
    const local = await startVariants([createSelfDeploy(fixture.deps)]);
    try { for (const env of local.values()) {
      await start(env); await terminal(env, fixture, "failed", "drain-timeout");
      expect((await read(env))?.reason).toBe("drain-timeout"); expect(fixture.state.held).toBe(false);
    } } finally { await stopAll(local); }
  }, 60_000);
  it.each(["drain", "accepted update"])("survives endpoint and server restart during %s", async point => {
    const fixture = deployFixture();
    fixture.deps.limits!.verifyInitialMs = 2_000;
    const obj = createSelfDeploy(fixture.deps);
    const env = await startRetryEnabled([obj]);
    let replacement: Awaited<ReturnType<typeof replaceEndpoint>> | undefined;
    let accepted = false;
    const originalUpdate = fixture.deps.fly.updateMachine;
    if (point === "accepted update") {
      fixture.state.work = false;
      fixture.deps.fly.updateMachine = vi.fn(async (token, app, id, config) => {
        await originalUpdate(token, app, id, config); accepted = true;
        // Never acknowledge the accepted update to the old endpoint.
        await new Promise(() => {});
      });
    }
    try {
      const result = await start(env);
      if (point === "drain") await phase(env, "draining");
      else await eventually(async () => accepted, Boolean, { label: "accepted update" });
      expect(fixture.state.held).toBe(true);
      replacement = await replaceEndpoint(env, [createSelfDeploy(fixture.deps)]);
      await env.startedRestateServer.restart();
      expect(fixture.state.held).toBe(true);
      fixture.state.work = false;
      expect(await start(env)).toEqual({ ...result, alreadyActive: true });
      await terminal(env, fixture, "succeeded");
      expect(fixture.deps.fly.updateMachine).toHaveBeenCalledOnce();
      expect(fixture.state.held).toBe(false);
    } finally { replacement?.close(); await env.stop(); }
  }, 120_000);
});
