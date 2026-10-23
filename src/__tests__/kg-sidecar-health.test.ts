import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { SidecarMemoryProvider, setKgMemoryProvider, sidecarHealth } from "../kg-provider.js";
import { checkKgSidecarHealth, probeKgSidecarIfUnavailable } from "../restate/kg-sidecar-health.js";

describe("checkKgSidecarHealth", () => {
  afterEach(() => vi.restoreAllMocks());
  const ok = () => vi.fn(async () => new Response("{}", { status: 200 }));
  const base = { deployHeld: () => false, restateReady: () => true, unavailable: () => true };

  it("sends one POST to the check handler when unavailable and ready", async () => {
    const fetchImpl = ok();
    await checkKgSidecarHealth({ ...base, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)[0];
    expect(url).toMatch(/\/KgSidecarHealth\/sidecar\/check\/send$/);
    expect(init.method).toBe("POST");
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
