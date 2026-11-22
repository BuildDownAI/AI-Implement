import { describe, expect, it } from "vitest";
import { RestateDrainCoordinator, type RestateDrainProbes } from "../restate/drain.js";

function probes(overrides: Partial<RestateDrainProbes> = {}): RestateDrainProbes {
  return {
    oldDeploymentInvocations: async () => 0,
    unresolvedLaunches: async () => 0,
    unresolvedTerminations: async () => 0,
    activeOwners: async () => 0,
    ...overrides,
  };
}

describe("RestateDrainCoordinator", () => {
  it("closes new external admission synchronously while leaving completion paths open", async () => {
    const drain = new RestateDrainCoordinator(probes());
    expect(drain.permitsExternalCall()).toBe(true);
    expect(drain.begin().state).toBe("quiescing");
    expect(drain.permitsExternalCall()).toBe(false);
    expect(drain.permitsCompletion()).toBe(true);
    expect((await drain.status()).state).toBe("drained");
    expect(drain.permitsExternalCall()).toBe(false);
  });

  it("blocks a queued/running/suspended old-deployment invocation", async () => {
    for (const count of [1, 3]) {
      const drain = new RestateDrainCoordinator(probes({ oldDeploymentInvocations: async () => count }));
      drain.begin();
      expect(await drain.status()).toMatchObject({
        state: "draining",
        counts: { "old-deployment-invocations": count },
      });
      expect(() => drain.complete()).toThrow("not proven drained");
    }
  });

  it("keeps launch, termination and owner uncertainty occupied after Restate invocations end", async () => {
    for (const key of ["unresolvedLaunches", "unresolvedTerminations", "activeOwners"] as const) {
      const drain = new RestateDrainCoordinator(probes({ [key]: async () => 1 }));
      drain.begin();
      expect((await drain.status()).state).toBe("draining");
      expect(drain.permitsExternalCall()).toBe(false);
    }
  });

  it("fails closed on a thrown, null or invalid probe result", async () => {
    for (const probe of [async () => { throw new Error("sidecar down"); }, async () => null, async () => -1, async () => NaN]) {
      const drain = new RestateDrainCoordinator(probes({ oldDeploymentInvocations: probe }));
      drain.begin();
      expect(await drain.status()).toMatchObject({
        state: "unknown",
        counts: { "old-deployment-invocations": null },
      });
      expect(() => drain.complete()).toThrow("not proven drained");
    }
  });

  it("is idempotent across begin, refresh, complete and abort", async () => {
    const drain = new RestateDrainCoordinator(probes());
    drain.begin();
    drain.begin();
    expect((await drain.status()).state).toBe("drained");
    drain.complete();
    expect(drain.complete().state).toBe("drained");
    expect(drain.permitsExternalCall()).toBe(false);
    expect(() => drain.abort()).toThrow("Cannot abort");
  });

  it("abort reopens admission and a late probe cannot close it again", async () => {
    let resolveProbe!: (count: number) => void;
    const delayed = new Promise<number>((resolve) => { resolveProbe = resolve; });
    const drain = new RestateDrainCoordinator(probes({ oldDeploymentInvocations: () => delayed }));
    drain.begin();
    const pending = drain.status();
    expect(drain.abort().state).toBe("admission-open");
    expect(drain.abort().state).toBe("admission-open");
    resolveProbe(0);
    expect((await pending).state).toBe("admission-open");
    expect(drain.permitsExternalCall()).toBe(true);
  });

  it("does not allow an older probe to overwrite a later unknown result", async () => {
    let resolveFirst!: (count: number) => void;
    const first = new Promise<number>((resolve) => { resolveFirst = resolve; });
    let calls = 0;
    const drain = new RestateDrainCoordinator(probes({
      oldDeploymentInvocations: () => ++calls === 1 ? first : Promise.resolve(null),
    }));
    drain.begin();
    const stale = drain.status();
    expect((await drain.status()).state).toBe("unknown");
    resolveFirst(0);
    expect((await stale).state).toBe("unknown");
  });
});
