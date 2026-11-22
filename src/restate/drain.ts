/** The admission barrier for replacing an incompatible Restate endpoint (AII-809).
 * Callers must check permitsExternalCall() immediately before starting an external
 * invocation. Result/cancel delivery and internal completion remain permitted while
 * the old deployment drains; AII-810 wires those call sites to this coordinator.
 */
export type RestateDrainState =
  | "admission-open"
  | "quiescing"
  | "draining"
  | "drained"
  | "unknown";

export type RestateDrainProbeName =
  | "old-deployment-invocations"
  | "unresolved-launches"
  | "unresolved-terminations"
  | "active-owners";

/** null means the probe cannot establish a safe count, never zero. */
export type RestateDrainProbe = () => Promise<number | null>;

export interface RestateDrainProbes {
  oldDeploymentInvocations: RestateDrainProbe;
  unresolvedLaunches: RestateDrainProbe;
  unresolvedTerminations: RestateDrainProbe;
  activeOwners: RestateDrainProbe;
}

export interface RestateDrainStatus {
  state: RestateDrainState;
  /** Counts are null if their probe failed or returned an invalid value. */
  counts: Record<RestateDrainProbeName, number | null>;
}

const EMPTY_COUNTS: RestateDrainStatus["counts"] = {
  "old-deployment-invocations": null,
  "unresolved-launches": null,
  "unresolved-terminations": null,
  "active-owners": null,
};

function validCount(value: number | null): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** A probe failure is unknown occupancy, not evidence of a drained endpoint. */
async function countOrUnknown(probe: RestateDrainProbe): Promise<number | null> {
  try {
    return validCount(await probe());
  } catch {
    return null;
  }
}

export class RestateDrainCoordinator {
  private state: RestateDrainState = "admission-open";
  private counts = { ...EMPTY_COUNTS };
  private generation = 0;
  private probeSequence = 0;
  private completed = false;

  constructor(private readonly probes: RestateDrainProbes) {}

  /** Closes admission synchronously, before any asynchronous drain probe can run. */
  begin(): RestateDrainStatus {
    if (this.state === "admission-open") {
      this.generation++;
      this.state = "quiescing";
      this.counts = { ...EMPTY_COUNTS };
      this.completed = false;
    }
    return this.snapshot();
  }

  permitsExternalCall(): boolean {
    return this.state === "admission-open";
  }

  /** Callback/result/cancel delivery and already-running internal completion can drain. */
  permitsCompletion(): boolean {
    return true;
  }

  snapshot(): RestateDrainStatus {
    return { state: this.state, counts: { ...this.counts } };
  }

  /** Refreshes all evidence. Only a current generation's latest probe may publish. */
  async status(): Promise<RestateDrainStatus> {
    if (this.state === "admission-open" || this.completed) return this.snapshot();
    const generation = this.generation;
    const sequence = ++this.probeSequence;
    const [invocations, launches, terminations, owners] = await Promise.all([
      countOrUnknown(this.probes.oldDeploymentInvocations),
      countOrUnknown(this.probes.unresolvedLaunches),
      countOrUnknown(this.probes.unresolvedTerminations),
      countOrUnknown(this.probes.activeOwners),
    ]);
    if (generation !== this.generation || sequence !== this.probeSequence) return this.snapshot();

    this.counts = {
      "old-deployment-invocations": invocations,
      "unresolved-launches": launches,
      "unresolved-terminations": terminations,
      "active-owners": owners,
    };
    const values = Object.values(this.counts);
    this.state = values.some((value) => value === null)
      ? "unknown"
      : values.some((value) => value! > 0) ? "draining" : "drained";
    return this.snapshot();
  }

  /** A successful replacement keeps admission closed until the new process takes over. */
  complete(): RestateDrainStatus {
    if (this.state !== "drained") throw new Error("Restate endpoint is not proven drained");
    this.completed = true;
    return this.snapshot();
  }

  /** A failed/aborted deployment reopens admission; stale probes cannot close it. */
  abort(): RestateDrainStatus {
    if (this.completed) throw new Error("Cannot abort a completed Restate endpoint drain");
    if (this.state !== "admission-open") {
      this.generation++;
      this.state = "admission-open";
      this.counts = { ...EMPTY_COUNTS };
    }
    return this.snapshot();
  }
}
