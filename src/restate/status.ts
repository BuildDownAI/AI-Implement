// Status contract for the Restate sidecar and its endpoint registration, split out of
// AII-724 so the shape lands independently of any consumer. Modeled after
// `sidecarHealth` in ../kg-provider.ts (module-level mutable state, a getter that copies
// out), but private to this module and with an explicit reset seam — see AII-773.
// No wiring into server.ts/endpoint.ts here; AII-724 and AII-807 consume this later.

export type RestateSidecarStatus =
  | { state: "starting" }
  | { state: "ready" }
  | { state: "timeout" }
  | { state: "exited"; code: number | null; signal: string | null }
  | { state: "missing-binary" };

export type RestateRegistrationStatus =
  | { state: "registered" }
  | { state: "declined-conflict" }
  | { state: "unreachable" }
  | { state: "not-attempted" };

export interface RestateStatus {
  sidecar: RestateSidecarStatus;
  registration: RestateRegistrationStatus;
}

function initialStatus(): RestateStatus {
  return {
    sidecar: { state: "starting" },
    registration: { state: "not-attempted" },
  };
}

let status: RestateStatus = initialStatus();

/** Deep-copied so a caller mutating the return value (including nested `exited` fields) cannot affect subsequent reads. */
export function getRestateStatus(): RestateStatus {
  return {
    sidecar: { ...status.sidecar },
    registration: { ...status.registration },
  };
}

/** Merges the supplied field(s) independently — a patch naming only one of `sidecar`/`registration` leaves the other untouched. */
export function setRestateStatus(patch: Partial<RestateStatus>): void {
  if (patch.sidecar !== undefined) status = { ...status, sidecar: { ...patch.sidecar } };
  if (patch.registration !== undefined) {
    status = { ...status, registration: { ...patch.registration } };
  }
}

/** Deterministic test seam: restores the honest starting/not-attempted default regardless of prior writes. */
export function resetRestateStatus(): void {
  status = initialStatus();
}
