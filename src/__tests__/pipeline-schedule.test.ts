import { afterEach, describe, expect, it, vi } from "vitest";
import { checkPipelineSchedules, latestOccurrence, nextOccurrence } from "../restate/pipeline-schedule.js";

const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

describe("latestOccurrence", () => {
  it("returns today's time on a plain day once it has passed", () => {
    expect(latestOccurrence(utc(2026, 10, 14, 14), "03:00", "UTC")).toBe("2026-10-14T03:00:00.000Z");
  });

  it("returns yesterday's time before today's has arrived", () => {
    expect(latestOccurrence(utc(2026, 10, 14, 2, 59), "03:00", "UTC")).toBe("2026-10-13T03:00:00.000Z");
  });

  it("returns the occurrence itself when now is exactly the time", () => {
    expect(latestOccurrence(utc(2026, 10, 14, 3), "03:00", "UTC")).toBe("2026-10-14T03:00:00.000Z");
  });

  it("gives one occurrence, the latest, after three missed days", () => {
    expect(latestOccurrence(utc(2026, 10, 17, 9), "03:00", "UTC")).toBe("2026-10-17T03:00:00.000Z");
  });

  it("maps a local time inside the spring-forward gap to the first instant after it (America/Denver 02:30)", () => {
    // 2026-03-08: 02:00 MST jumps to 03:00 MDT at 09:00Z.
    expect(latestOccurrence(utc(2026, 3, 8, 20), "02:30", "America/Denver")).toBe("2026-03-08T09:00:00.000Z");
  });

  it("maps a repeated local time at fall-back to the first one (America/Denver 01:30)", () => {
    // 2026-11-01: 02:00 MDT falls back to 01:00 MST at 08:00Z; 01:30 MDT is 07:30Z.
    expect(latestOccurrence(utc(2026, 11, 1, 20), "01:30", "America/Denver")).toBe("2026-11-01T07:30:00.000Z");
  });

  it("steps back a calendar day across a DST change when today's occurrence is ahead", () => {
    // 2026-03-08 06:00Z is 23:00 MST on Mar 7, before Mar 8's 03:00 local.
    expect(latestOccurrence(utc(2026, 3, 8, 6), "03:00", "America/Denver")).toBe("2026-03-07T10:00:00.000Z");
  });
});

describe("nextOccurrence", () => {
  it("returns the first occurrence after now", () => {
    expect(nextOccurrence(utc(2026, 10, 14, 14), "03:00", "UTC")).toBe("2026-10-15T03:00:00.000Z");
    expect(nextOccurrence(utc(2026, 10, 14, 2), "03:00", "UTC")).toBe("2026-10-14T03:00:00.000Z");
  });
});

describe("checkPipelineSchedules", () => {
  afterEach(() => vi.restoreAllMocks());
  const ok = () => vi.fn(async () => new Response("{}", { status: 200 }));

  it("makes no call while a deploy holds", async () => {
    const fetchImpl = ok();
    await checkPipelineSchedules(["kg-refresh"], { deployHeld: () => true, restateReady: () => true, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("makes no call while Restate is not ready", async () => {
    const fetchImpl = ok();
    await checkPipelineSchedules(["kg-refresh"], { deployHeld: () => false, restateReady: () => false, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs once per key to the check handler", async () => {
    const fetchImpl = ok();
    await checkPipelineSchedules(["kg-refresh", "a/b"], { deployHeld: () => false, restateReady: () => true, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0][0]).toMatch(/\/PipelineSchedule\/kg-refresh\/check$/);
    expect(calls[1][0]).toMatch(/\/PipelineSchedule\/a%2Fb\/check$/);
    expect(calls.every(([, init]) => init.method === "POST")).toBe(true);
  });

  it("logs a rejected fetch, does not throw, and still checks the later keys", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error("connection refused")).mockResolvedValue(new Response("{}"));
    await expect(
      checkPipelineSchedules(["one", "two"], { deployHeld: () => false, restateReady: () => true, fetchImpl }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("connection refused");
  });
});
