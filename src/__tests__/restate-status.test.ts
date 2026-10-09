import { afterEach, describe, expect, it } from "vitest";
import {
  getRestateStatus,
  resetRestateStatus,
  setRestateStatus,
  type RestateRegistrationStatus,
  type RestateSidecarStatus,
} from "../restate/status.js";

afterEach(() => {
  resetRestateStatus();
});

describe("initial state", () => {
  it("is honest starting/not-attempted before any write", () => {
    expect(getRestateStatus()).toEqual({
      sidecar: { state: "starting" },
      registration: { state: "not-attempted" },
    });
  });
});

describe("independent round-trip", () => {
  const sidecarVariants: RestateSidecarStatus[] = [
    { state: "starting" },
    { state: "ready" },
    { state: "timeout" },
    { state: "exited", code: 1, signal: null },
    { state: "exited", code: null, signal: "SIGKILL" },
    { state: "missing-binary" },
  ];

  const registrationVariants: RestateRegistrationStatus[] = [
    { state: "registered" },
    { state: "declined-conflict" },
    { state: "unreachable" },
    { state: "not-attempted" },
  ];

  for (const sidecar of sidecarVariants) {
    for (const registration of registrationVariants) {
      it(`preserves registration=${registration.state} when sidecar is set to ${sidecar.state} (and vice versa)`, () => {
        setRestateStatus({ registration });
        setRestateStatus({ sidecar });
        expect(getRestateStatus()).toEqual({ sidecar, registration });

        resetRestateStatus();

        setRestateStatus({ sidecar });
        setRestateStatus({ registration });
        expect(getRestateStatus()).toEqual({ sidecar, registration });
      });
    }
  }
});

describe("no leaked mutable state", () => {
  it("does not let a mutated getter return affect a later read", () => {
    setRestateStatus({
      sidecar: { state: "exited", code: 1, signal: null },
      registration: { state: "registered" },
    });

    const first = getRestateStatus();
    // @ts-expect-error -- exercising a state-narrowed field only present on "exited"
    first.sidecar.code = 999;
    // @ts-expect-error -- exercising a state-narrowed field only present on "exited"
    first.sidecar.signal = "SIGKILL";
    first.registration = { state: "unreachable" };

    expect(getRestateStatus()).toEqual({
      sidecar: { state: "exited", code: 1, signal: null },
      registration: { state: "registered" },
    });
  });
});

describe("resetRestateStatus", () => {
  it("restores the initial defaults regardless of prior writes", () => {
    setRestateStatus({
      sidecar: { state: "missing-binary" },
      registration: { state: "declined-conflict" },
    });

    resetRestateStatus();

    expect(getRestateStatus()).toEqual({
      sidecar: { state: "starting" },
      registration: { state: "not-attempted" },
    });
  });
});

describe("exited payload nullability", () => {
  it("round-trips a signal-killed child (code: null, signal set)", () => {
    setRestateStatus({ sidecar: { state: "exited", code: null, signal: "SIGKILL" } });
    expect(getRestateStatus().sidecar).toEqual({ state: "exited", code: null, signal: "SIGKILL" });
  });

  it("round-trips a normal exit (code set, signal: null)", () => {
    setRestateStatus({ sidecar: { state: "exited", code: 0, signal: null } });
    expect(getRestateStatus().sidecar).toEqual({ state: "exited", code: 0, signal: null });
  });
});
