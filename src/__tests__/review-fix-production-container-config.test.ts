import { afterEach, describe, expect, it, vi } from "vitest";
import { makeAppConfig, makeMapping, makeScopedPrIdentity } from "./helpers/builders.js";
import { testDb } from "./helpers/test-db.js";
import type { PreparedReviewFixAttempt } from "../review-fix-ports.js";

const mocks = vi.hoisted(() => ({
  fly: vi.fn(), local: vi.fn(), admission: vi.fn(),
}));
vi.mock("../gapfill-launch.js", () => ({ dispatchFlyGapfill: mocks.fly }));
vi.mock("../local-gapfill.js", () => ({ dispatchLocalGapfill: mocks.local }));
vi.mock("../dispatch-admission.js", async (original) => ({
  ...await original<typeof import("../dispatch-admission.js")>(), read: mocks.admission,
}));
vi.mock("../github-app-auth.js", () => ({
  getInstallation: async () => ({ token: "github-token", installationId: 1 }),
  getInstallationToken: async () => "github-token", getInstallationId: async () => 1,
}));
vi.mock("../runner-tokens.js", async (original) => ({
  ...await original<typeof import("../runner-tokens.js")>(),
  mintPreparedReviewFixToken: () => ({ token: "callback-token" }),
}));
vi.mock("../github.js", async (original) => ({
  ...await original<typeof import("../github.js")>(), getPullRequestState: async () => ({ state: "open", merged: false }),
}));
vi.mock("../managed-dispatch-auth.js", async (original) => ({
  ...await original<typeof import("../managed-dispatch-auth.js")>(), isManagedProject: () => false,
}));

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

async function setup(backend: "fly-machines" | "github-actions" | "local-docker" = "fly-machines") {
  const { modules: { config, production, storeModule, mode, workerModule } } = await testDb({ modules: {
    config: () => import("../config.js"),
    production: () => import("../restate/review-fix-production.js"),
    storeModule: () => import("../review-fix-attempt-store.js"),
    mode: () => import("../runner-mode.js"),
    workerModule: () => import("../review-fix-worker.js"),
  } });
  config.upsertMapping("AII", makeMapping({ owner: "acme", repo: "app", executionMode: "fly-machines", reviewFixLifecycle: "restate" }));
  mode.setRunnerMode("fly");
  let app: string | null = null;
  let region: string | null = null;
  const settings = makeAppConfig({ flySessionsToken: "fly-token", localRunnerImage: "local-image", runnerCallbackBaseUrl: "https://callbacks.example", runnerTokenSecret: "test-secret" });
  Object.defineProperties(settings, {
    flySessionsApp: { enumerable: true, get: () => app },
    flySessionsRegion: { enumerable: true, get: () => region },
  });
  const store = new storeModule.SqliteReviewFixAttemptStore();
  const worker = production.createProductionReviewFixWorker(settings, store);
  const attempt: PreparedReviewFixAttempt = { attemptId: "attempt-config", scope: makeScopedPrIdentity({
    installationId: 1, repository: "acme/app",
  }), taskText: "Fix findings", findings: [], owner: "attempt-config", deadlineAt: Date.now() + 60_000,
  executionBackend: backend };
  mocks.admission.mockImplementation(() => ({ backend: attempt.executionBackend, releasedAt: null,
    mappingKey: "AII", scope: { kind: "pr", repository: "acme/app" }, generation: 1 }));
  // Stop at the external launch boundary: no machine, staging, network or model call.
  mocks.fly.mockRejectedValue(new Error("test launch boundary"));
  mocks.local.mockRejectedValue(new Error("test launch boundary"));
  return { settings, store, worker, attempt, production, mode, workerModule,
    load: () => { app = "configured-sessions"; region = "iad"; } };
}

describe("production container configuration", () => {
  it("resolves cache-backed Fly app and region after composition at routed launch", async () => {
    const s = await setup();
    expect(s.settings.flySessionsApp).toBeNull();
    expect(s.settings.flySessionsRegion).toBeNull();
    const plan = await s.worker.prepare(s.attempt);
    s.load();
    expect(await s.production.canAdmit(s.attempt.scope, s.settings)).toBe("admit");
    await s.worker.launch(plan);
    expect(mocks.fly).toHaveBeenCalledWith(expect.objectContaining({
      flySessionsApp: "configured-sessions", flySessionsRegion: "iad", flySessionsToken: "fly-token",
    }));
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it.each(["app", "token"])("defers missing Fly %s without reserving or launching", async missing => {
    const s = await setup();
    if (missing === "token") { s.load(); s.settings.flySessionsToken = null; }
    const reserve = vi.spyOn(s.store, "admit");
    expect(await s.production.canAdmit(s.attempt.scope, s.settings)).toBe("defer");
    expect(await s.production.admitReviewFix({ scope: s.attempt.scope,
      feedback: { taskText: "Fix", findings: [] }, jobTimeoutMinutes: 30 }, s.settings, s.store))
      .toEqual({ status: "deferred", reason: "paused" });
    expect(reserve).not.toHaveBeenCalled();
    expect(mocks.fly).not.toHaveBeenCalled();
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it.each(["github-actions", "local-docker"] as const)("preserves prepared %s routing after runner mode changes", async backend => {
    const s = await setup(backend);
    const gha = vi.spyOn(s.workerModule.GithubReviewFixWorker.prototype, "launch").mockResolvedValue({ status: "unknown" });
    s.mode.setRunnerMode(backend === "github-actions" ? "gha" : "local");
    const plan = await s.worker.prepare(s.attempt);
    s.load();
    s.mode.setRunnerMode("fly");
    await s.worker.launch(plan);
    expect(mocks.fly).not.toHaveBeenCalled();
    if (backend === "github-actions") {
      expect(gha).toHaveBeenCalledWith(plan);
      expect(mocks.local).not.toHaveBeenCalled();
    } else {
      expect(gha).not.toHaveBeenCalled();
      expect(mocks.local).toHaveBeenCalledWith(expect.objectContaining({ image: "local-image" }));
    }
  });
});
