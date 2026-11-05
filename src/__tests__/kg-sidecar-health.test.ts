import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as deployNotify from "../deploy-notify.js";
import { testDb } from "./helpers/test-db.js";
import http from "node:http";
import { SidecarMemoryProvider, setKgMemoryProvider, sidecarHealth } from "../kg-provider.js";
import { checkKgSidecarHealth, probeKgSidecarIfUnavailable } from "../restate/kg-sidecar-health.js";
import { resetRestateStatus, setRestateStatus } from "../restate/status.js";

describe("checkKgSidecarHealth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetRestateStatus();
  });
  const ok = () => vi.fn(async () => new Response("{}", { status: 200 }));
  const base = { deployHeld: () => false, restateReady: () => true, unavailable: () => true };

  it("reads the orchestrator's own Restate status when no readiness is passed", async () => {
    const { restateReady: _ready, ...unready } = base;
    const fetchImpl = ok();
    await checkKgSidecarHealth({ ...unready, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "registered" } });
    await checkKgSidecarHealth({ ...unready, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends one POST to the check handler when unavailable and ready", async () => {
    const fetchImpl = ok();
    await checkKgSidecarHealth({ ...base, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)[0];
    expect(url).toMatch(/\/KgSidecarHealth\/sidecar\/check\/send$/);
    expect(init.method).toBe("POST");
  });

  it("still schedules recovery when another probe cleared the health flag", async () => {
    vi.spyOn(deployNotify, "hasKgRecoveryNotice").mockReturnValue(true);
    const fetchImpl = ok();
    await checkKgSidecarHealth({ deployHeld: () => false, restateReady: () => true, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("makes no call when the sidecar is available", async () => {
    const fetchImpl = ok();
    await checkKgSidecarHealth({ ...base, unavailable: () => false, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("makes no call while a deploy holds", async () => {
    const fetchImpl = ok();
    await checkKgSidecarHealth({ ...base, deployHeld: () => true, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("makes no call while Restate is not ready", async () => {
    const fetchImpl = ok();
    await checkKgSidecarHealth({ ...base, restateReady: () => false, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("resolves on a rejected fetch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connection refused"));
    await expect(checkKgSidecarHealth({ ...base, fetchImpl })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("probeKgSidecarIfUnavailable", () => {
  const reset = () => {
    sidecarHealth.reachable = false;
    sidecarHealth.toolsListed = false;
    sidecarHealth.lastError = null;
    sidecarHealth.checkedAt = null;
    setKgMemoryProvider(null);
  };
  beforeEach(reset);
  afterEach(() => {
    vi.restoreAllMocks();
    reset();
  });

  it("sends no sidecar request when the sidecar is not marked unavailable", async () => {
    const request = vi.spyOn(http, "request");
    setKgMemoryProvider(new SidecarMemoryProvider("http://127.0.0.1:8765/mcp", async () => "https://kg.example.test/"));
    await expect(probeKgSidecarIfUnavailable()).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("returns null without throwing when there is no sidecar provider", async () => {
    sidecarHealth.lastError = "boom";
    await expect(probeKgSidecarIfUnavailable()).resolves.toBeNull();
  });
});


describe("KG recovery deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(["warning", "recovery"])("bounds a stalled %s webhook and aborts a recovery send", async (stage) => {
    const { modules: { deploy, dedup, kg } } = await testDb({ modules: {
      deploy: () => import("../deploy-notify.js"),
      dedup: () => import("../dedup.js"),
      kg: () => import("../kg-provider.js"),
    } });
    vi.useFakeTimers();
    vi.stubEnv("FLY_IMAGE_REF", "new-image");
    dedup.getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("deploy_last_image_ref", "old-image");
    Object.assign(kg.sidecarHealth, { reachable: false, toolsListed: false, lastError: "timeout", checkedAt: 1 });
    let recoverySignal: AbortSignal | null | undefined;
    const send = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const recovery = String(init?.body).includes("serving again");
      if (recovery) recoverySignal = init?.signal;
      if (stage === "warning" || recovery) return new Promise<Response>(() => {});
      return new Response("ok");
    });
    void deploy.postBootNotice({ notifyType: "slack", notifyWebhookUrl: "https://notice.example.test", kgSidecarUrl: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(deploy.hasKgRecoveryNotice()).toBe(true);
    const result = expect(deploy.postKgRecoveryNotice(25)).rejects.toThrow("KG recovery notice timed out");
    await vi.advanceTimersByTimeAsync(25);
    await result;
    expect(send).toHaveBeenCalledTimes(stage === "warning" ? 1 : 2);
    if (stage === "recovery") expect(recoverySignal?.aborted).toBe(true);
    // The Restate handler owns abandonment after bounded retries.
    expect(deploy.hasKgRecoveryNotice()).toBe(true);
    deploy.clearKgRecoveryNotice();
  });
});
