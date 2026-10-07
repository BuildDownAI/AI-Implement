import { describe, expect, it } from "vitest";
import { FLY_MACHINE_PROFILE_DEFAULTS, mergeProfile, type FlyMachineProfileConfig } from "../restate/fly-machine-profile.js";

const base: FlyMachineProfileConfig = FLY_MACHINE_PROFILE_DEFAULTS["kg-refresh"];

describe("mergeProfile", () => {
  it("keeps the rest when a partial changes one field", () => {
    expect(mergeProfile(base, { memoryMb: 4096 })).toEqual({ ...base, memoryMb: 4096 });
  });

  it("rejects cpus: 3 naming the field", () => {
    expect(() => mergeProfile(base, { cpus: 3 })).toThrow(/cpus/);
  });

  it.each([100, 255, 65537, 1024.5])("rejects memoryMb %s naming the field", (memoryMb) => {
    expect(() => mergeProfile(base, { memoryMb })).toThrow(/memoryMb/);
  });

  it("accepts the memoryMb boundaries on shared", () => {
    expect(mergeProfile(base, { cpuKind: "shared", cpus: 1, memoryMb: 256 }).memoryMb).toBe(256);
    expect(mergeProfile(base, { cpuKind: "shared", memoryMb: 65536 }).memoryMb).toBe(65536);
  });

  it("rejects performance with under 2048 MB per CPU, naming memoryMb", () => {
    expect(() => mergeProfile(base, { memoryMb: 1024 })).toThrow(/memoryMb/);
    expect(() => mergeProfile(null, { cpuKind: "performance", cpus: 2, memoryMb: 1024, idleTimeoutMs: 60_000 })).toThrow(/memoryMb/);
  });

  it("checks the merged result: raising only cpus past the memory fails", () => {
    expect(() => mergeProfile(base, { cpus: 8 })).toThrow(/memoryMb/);
  });

  it("allows low memory once cpuKind is shared", () => {
    expect(mergeProfile(base, { cpuKind: "shared", memoryMb: 1024 }).cpuKind).toBe("shared");
  });

  it("enforces the idleTimeoutMs floor", () => {
    expect(() => mergeProfile(base, { idleTimeoutMs: 59_999 })).toThrow(/idleTimeoutMs/);
    expect(mergeProfile(base, { idleTimeoutMs: 60_000 }).idleTimeoutMs).toBe(60_000);
  });

  it("with no base requires a complete config", () => {
    expect(() => mergeProfile(null, { memoryMb: 4096 })).toThrow(/seed|missing/);
    expect(mergeProfile(null, base)).toEqual(base);
  });
});
