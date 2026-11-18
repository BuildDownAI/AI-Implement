import { describe, it, expect, vi, afterEach } from "vitest";
import {
  applyVolumeSnapshotRetention,
  applyVolumeSnapshotRetentionAtBoot,
} from "../fly-volumes.js";
import { fakeFetch, type Reply } from "./helpers/fake-fetch.js";

const TOKEN = "fly-test-token";
const APP = "ai-implement-test";

const VOLUMES = `GET /v1/apps/${APP}/volumes` as const;
const volume = (id: string) => `PUT /v1/apps/${APP}/volumes/${id}` as const;

const UPDATED: Reply = { json: {} };

describe("applyVolumeSnapshotRetention", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("PUTs only volumes whose retention differs", async () => {
    const fake = fakeFetch({
      [VOLUMES]: [{
        json: [
          { id: "vol_a", name: "dedup_data", snapshot_retention: 5 },
          { id: "vol_b", name: "other", snapshot_retention: 14 },
        ],
      }],
      [volume("vol_a")]: [UPDATED],
    }).install();

    const result = await applyVolumeSnapshotRetention(TOKEN, APP, 14);

    expect(result).toEqual({ applied: ["vol_a"], skipped: "" });
    expect(fake.calls).toHaveLength(2);
    const put = fake.calls[1];
    expect(put.url.href).toBe(`https://api.machines.dev/v1/apps/${APP}/volumes/vol_a`);
    expect(put.method).toBe("PUT");
    expect(JSON.parse(put.body)).toEqual({ snapshot_retention: 14 });
    expect(put.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("treats an undefined retention as differing", async () => {
    fakeFetch({
      [VOLUMES]: [{ json: [{ id: "vol_a", name: "dedup_data" }] }],
      [volume("vol_a")]: [UPDATED],
    }).install();
    const result = await applyVolumeSnapshotRetention(TOKEN, APP, 14);
    expect(result.applied).toEqual(["vol_a"]);
  });

  it("returns a 403 from the list as skipped without throwing", async () => {
    fakeFetch({ [VOLUMES]: [{ status: 403, text: "forbidden" }] }).install();
    const result = await applyVolumeSnapshotRetention(TOKEN, APP, 14);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toMatch(/^HTTP 403/);
    expect(result.skipped).not.toContain(TOKEN);
  });

  it("keeps already-applied ids when a later PUT fails", async () => {
    fakeFetch({
      [VOLUMES]: [{
        json: [
          { id: "vol_a", name: "a", snapshot_retention: 5 },
          { id: "vol_b", name: "b", snapshot_retention: 5 },
        ],
      }],
      [volume("vol_a")]: [UPDATED],
      [volume("vol_b")]: [{ status: 500, text: "boom" }],
    }).install();
    const result = await applyVolumeSnapshotRetention(TOKEN, APP, 14);
    expect(result.applied).toEqual(["vol_a"]);
    expect(result.skipped).toMatch(/^HTTP 500/);
  });

  it("returns a network rejection as skipped", async () => {
    fakeFetch({
      [VOLUMES]: [() => {
        throw new Error("network down");
      }],
    }).install();
    const result = await applyVolumeSnapshotRetention(TOKEN, APP, 14);
    expect(result).toEqual({ applied: [], skipped: "network down" });
  });
});

describe("applyVolumeSnapshotRetentionAtBoot", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("logs the not-applied line and calls nothing without a token", async () => {
    // No routes: any Fly request fails the test.
    const fake = fakeFetch({}).install();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await applyVolumeSnapshotRetentionAtBoot(null, APP, () => 14);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[fly-volumes\] snapshot retention not applied: /));
    expect(fake.calls).toHaveLength(0);
  });

  it("logs the not-applied line without FLY_APP_NAME", async () => {
    const fake = fakeFetch({}).install();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await applyVolumeSnapshotRetentionAtBoot(TOKEN, undefined, () => 14);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/not applied: FLY_APP_NAME/));
    expect(fake.calls).toHaveLength(0);
  });

  it("logs the applied ids on success", async () => {
    fakeFetch({
      [VOLUMES]: [{ json: [{ id: "vol_a", name: "a", snapshot_retention: 5 }] }],
      [volume("vol_a")]: [UPDATED],
    }).install();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await applyVolumeSnapshotRetentionAtBoot(TOKEN, APP, () => 14);
    expect(log).toHaveBeenCalledWith("[fly-volumes] snapshot retention 14 days applied to vol_a");
  });
});
