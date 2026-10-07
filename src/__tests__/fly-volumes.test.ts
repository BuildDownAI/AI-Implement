import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  applyVolumeSnapshotRetention,
  applyVolumeSnapshotRetentionAtBoot,
} from "../fly-volumes.js";

const TOKEN = "fly-test-token";
const APP = "ai-implement-test";

function ok(json: unknown): Response {
  return { ok: true, json: async () => json } as Response;
}

describe("applyVolumeSnapshotRetention", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("PUTs only volumes whose retention differs", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(ok([
        { id: "vol_a", name: "dedup_data", snapshot_retention: 5 },
        { id: "vol_b", name: "other", snapshot_retention: 14 },
      ]))
      .mockResolvedValueOnce(ok({}));

    const result = await applyVolumeSnapshotRetention(TOKEN, APP, 14);

    expect(result).toEqual({ applied: ["vol_a"], skipped: "" });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, opts] = vi.mocked(fetch).mock.calls[1];
    expect(url).toBe(`https://api.machines.dev/v1/apps/${APP}/volumes/vol_a`);
    expect((opts as RequestInit).method).toBe("PUT");
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({ snapshot_retention: 14 });
    expect(((opts as RequestInit).headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("treats an undefined retention as differing", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(ok([{ id: "vol_a", name: "dedup_data" }]))
      .mockResolvedValueOnce(ok({}));
    const result = await applyVolumeSnapshotRetention(TOKEN, APP, 14);
    expect(result.applied).toEqual(["vol_a"]);
  });

  it("returns a 403 from the list as skipped without throwing", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 403, text: async () => "forbidden" } as Response);
    const result = await applyVolumeSnapshotRetention(TOKEN, APP, 14);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toMatch(/^HTTP 403/);
    expect(result.skipped).not.toContain(TOKEN);
  });

  it("keeps already-applied ids when a later PUT fails", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(ok([
        { id: "vol_a", name: "a", snapshot_retention: 5 },
        { id: "vol_b", name: "b", snapshot_retention: 5 },
      ]))
      .mockResolvedValueOnce(ok({}))
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" } as Response);
    const result = await applyVolumeSnapshotRetention(TOKEN, APP, 14);
    expect(result.applied).toEqual(["vol_a"]);
    expect(result.skipped).toMatch(/^HTTP 500/);
  });

  it("returns a network rejection as skipped", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network down"));
    const result = await applyVolumeSnapshotRetention(TOKEN, APP, 14);
    expect(result).toEqual({ applied: [], skipped: "network down" });
  });
});

describe("applyVolumeSnapshotRetentionAtBoot", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("logs the not-applied line and calls nothing without a token", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await applyVolumeSnapshotRetentionAtBoot(null, APP, () => 14);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[fly-volumes\] snapshot retention not applied: /));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("logs the not-applied line without FLY_APP_NAME", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await applyVolumeSnapshotRetentionAtBoot(TOKEN, undefined, () => 14);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/not applied: FLY_APP_NAME/));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("logs the applied ids on success", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(fetch)
      .mockResolvedValueOnce(ok([{ id: "vol_a", name: "a", snapshot_retention: 5 }]))
      .mockResolvedValueOnce(ok({}));
    await applyVolumeSnapshotRetentionAtBoot(TOKEN, APP, () => 14);
    expect(log).toHaveBeenCalledWith("[fly-volumes] snapshot retention 14 days applied to vol_a");
  });
});
