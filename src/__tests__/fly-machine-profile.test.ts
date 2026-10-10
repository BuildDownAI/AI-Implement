import { describe, expect, it } from "vitest";
import { FLY_MACHINE_PROFILE_DEFAULTS, decideAttach, decideClaim, decideExpire, mergeProfile, type KeptMachineState, type FlyMachineProfileConfig, OBJECT_INACTIVITY_TIMEOUT_MS, OBJECT_ABORT_TIMEOUT_MS } from "../restate/fly-machine-profile.js";
import { CLEAR_MACHINE_ENV_MAX_MS } from "../fly-machines.js";

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

const held = (machineId: string | undefined, dispatchId: string, attempt: number, lastUsedAt = 100): KeptMachineState => ({
  ...(machineId ? { machineId } : {}),
  lastUsedAt,
  heldBy: { dispatchId, attempt },
});
const idle = (machineId: string, lastUsedAt = 100): KeptMachineState => ({ machineId, lastUsedAt, heldBy: null });

describe("decideClaim", () => {
  it("same dispatch and attempt: same answer, state unchanged", () => {
    const m = held("A", "d1", 1);
    const d = decideClaim(m, "d1", 1, 500);
    expect(d).toEqual({ kind: "grant", machineId: "A", next: m });
    if (d.kind === "grant") expect(d.next).toBe(m);
  });
  it("same dispatch, higher attempt: bumps the attempt, answers the recorded machine", () => {
    expect(decideClaim(held("A", "d1", 1), "d1", 2, 500)).toEqual({ kind: "grant", machineId: "A", next: held("A", "d1", 2, 500) });
  });
  it("same dispatch, lower attempt: conflict", () => {
    expect(decideClaim(held("A", "d1", 2), "d1", 1, 500).kind).toBe("conflict");
  });
  it("another dispatch while held: conflict naming the holder and attempt", () => {
    const d = decideClaim(held("A", "d1", 2), "d2", 5, 500);
    expect(d).toEqual({ kind: "conflict", message: "machine held by d1 attempt 2" });
  });
  it("machine present, no hold: takes the hold", () => {
    expect(decideClaim(idle("A"), "d1", 1, 500)).toEqual({ kind: "grant", machineId: "A", next: held("A", "d1", 1, 500) });
  });
  it("no machine: answers null and records the hold with the id unset", () => {
    expect(decideClaim(null, "d1", 1, 500)).toEqual({ kind: "grant", machineId: null, next: held(undefined, "d1", 1, 500) });
  });
  it("same dispatch re-claims a pending (no id) hold at the same attempt", () => {
    expect(decideClaim(held(undefined, "d1", 1), "d1", 1, 500)).toMatchObject({ kind: "grant", machineId: null });
  });
});

describe("decideAttach", () => {
  it("not the holder (or no hold): conflict", () => {
    expect(decideAttach(held("A", "d1", 1), "d2", "B", 1, 500).kind).toBe("conflict");
    expect(decideAttach(idle("A"), "d1", "B", 1, 500).kind).toBe("conflict");
    expect(decideAttach(null, "d1", "B", 1, 500).kind).toBe("conflict");
  });
  it("same machine id is idempotent at any attempt", () => {
    expect(decideAttach(held("A", "d1", 2), "d1", "A", 2, 500)).toEqual({ kind: "unchanged" });
    expect(decideAttach(held("A", "d1", 2), "d1", "A", 1, 500)).toEqual({ kind: "unchanged" });
  });
  it("first attach after a null claim records the machine", () => {
    expect(decideAttach(held(undefined, "d1", 1), "d1", "A", 1, 500)).toEqual({ kind: "record", next: held("A", "d1", 1, 500), replaced: null });
  });
  it("different id at a higher attempt replaces", () => {
    expect(decideAttach(held("A", "d1", 1), "d1", "B", 2, 500)).toEqual({ kind: "record", next: held("B", "d1", 1, 500), replaced: "A" });
  });
  it("replaces: the recorded machine replaces it at attempt 1; anything else stays a conflict", () => {
    expect(decideAttach(held("A", "d1", 1), "d1", "B", 1, 500, "A")).toEqual({ kind: "record", next: held("B", "d1", 1, 500), replaced: "A" });
    expect(decideAttach(held("A", "d1", 1), "d1", "B", 1, 500).kind).toBe("conflict");
    expect(decideAttach(held("A", "d1", 1), "d1", "B", 1, 500, "X").kind).toBe("conflict");
    expect(decideAttach(held("A", "d1", 1), "d2", "B", 1, 500, "A").kind).toBe("conflict");
    expect(decideAttach(held("B", "d1", 1), "d1", "B", 1, 500, "A")).toEqual({ kind: "unchanged" });
  });
  it("different id at the hold's attempt > 1 replaces", () => {
    expect(decideAttach(held("A", "d1", 2), "d1", "B", 2, 500)).toMatchObject({ kind: "record", replaced: "A" });
  });
  it("different id at attempt 1 with hold attempt 1: conflict", () => {
    expect(decideAttach(held("A", "d1", 1), "d1", "B", 1, 500).kind).toBe("conflict");
  });
  it("different id at a lower attempt than the hold: conflict", () => {
    expect(decideAttach(held("A", "d1", 2), "d1", "B", 1, 500).kind).toBe("conflict");
  });
});

describe("decideExpire", () => {
  it("destroys when released at that stamp and not held", () => {
    expect(decideExpire(idle("A", 100), 100)).toEqual({ kind: "destroy", machineId: "A" });
  });
  it("no-op on a mismatched stamp, a held machine, or no machine", () => {
    expect(decideExpire(idle("A", 200), 100)).toEqual({ kind: "noop" });
    expect(decideExpire(held("A", "d1", 1, 100), 100)).toEqual({ kind: "noop" });
    expect(decideExpire(null, 100)).toEqual({ kind: "noop" });
    expect(decideExpire(held(undefined, "d1", 1, 100), 100)).toEqual({ kind: "noop" });
  });
});

describe("object invocation timeouts", () => {
  it("outlast one capped scrub call, and abort after inactivity", () => {
    expect(OBJECT_INACTIVITY_TIMEOUT_MS).toBeGreaterThan(CLEAR_MACHINE_ENV_MAX_MS);
    expect(OBJECT_ABORT_TIMEOUT_MS).toBeGreaterThanOrEqual(OBJECT_INACTIVITY_TIMEOUT_MS);
  });
});
