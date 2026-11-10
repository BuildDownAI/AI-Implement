import { getJobByDispatchId } from "../log.js";
import type { RepoMapping } from "../config.js";
import { read, release, type DispatchAdmissionReleaseReason } from "../dispatch-admission.js";
import { implementationIntentStore } from "./implementation-launch-intent.js";
import type { ImplementationFinishOutcome, ImplementationFinishResult, ImplementationRunInput } from "./implementation-run-workflow.js";

/** Private allowlisted authority, separate from launch credentials and Restate journal retention. */
export interface ImplementationRunOwner {
  input: ImplementationRunInput;
  generation: number;
  createdAt: number;
  jobId: string | null;
  state: "reserved" | "launching" | "closed";
  finishOutcome?: ImplementationFinishOutcome;
  finalized?: boolean;
  finishResult?: ImplementationFinishResult;
  mapping?: RepoMapping;
  flyApp?: string | null;
}
const key = (dispatchId: string) => `owner:${dispatchId}`;
export function readImplementationRunOwner(dispatchId: string): ImplementationRunOwner | null {
  return implementationIntentStore().read<ImplementationRunOwner>(key(dispatchId))?.snapshot ?? null;
}
export function requireImplementationRunOwner(input: ImplementationRunInput, initialState: "reserved" | "launching" = "launching"): ImplementationRunOwner {
  const admission = read(input.dispatchId);
  if (!admission || admission.releasedAt !== null || admission.mappingKey !== input.teamKey || admission.backend !== input.backend ||
      admission.lifecycleOwner.kind !== "restate" || admission.lifecycleOwner.attemptId !== input.dispatchId) {
    throw new Error(`implementation owner mismatch: ${input.dispatchId}`);
  }
  if (input.gapFill) {
    if (admission.scope.kind !== "pr" || admission.scope.installationId !== input.gapFill.installationId ||
        admission.scope.repository !== input.gapFill.repository || admission.scope.prNumber !== input.gapFill.prNumber) {
      throw new Error(`implementation PR scope mismatch: ${input.dispatchId}`);
    }
  } else if (admission.scope.kind !== "issue" || admission.scope.issueId !== input.issueId) {
    throw new Error(`implementation issue scope mismatch: ${input.dispatchId}`);
  }
  let owner = readImplementationRunOwner(input.dispatchId);
  if (!owner) {
    // Historical reserve outcomes lack this record. Only the original generation may be
    // reconstructed without an existing authority; never adopt a replacement generation.
    const store = implementationIntentStore();
    const recordedGeneration = store.readPreparation(input.dispatchId)?.generation
      ?? store.read<{ context?: { generation?: number } }>(input.dispatchId)?.snapshot.context?.generation;
    if (admission.generation !== 0 && recordedGeneration !== admission.generation) throw new Error(`missing original implementation owner: ${input.dispatchId}`);
    owner = { input: { ...input, launchContext: {} }, generation: admission.generation, createdAt: admission.createdAt, jobId: null, state: initialState };
    implementationIntentStore().write(key(input.dispatchId), owner);
  }
  if (owner.generation !== admission.generation || owner.input.backend !== input.backend || owner.input.teamKey !== input.teamKey || owner.input.issueId !== input.issueId || JSON.stringify(owner.input.gapFill) !== JSON.stringify(input.gapFill)) {
    throw new Error(`stale implementation owner: ${input.dispatchId}`);
  }
  const job = getJobByDispatchId(input.dispatchId);
  if (job && ((job.admissionGeneration !== null && job.admissionGeneration !== owner.generation) ||
      (job.admissionGeneration === null && owner.generation !== 0) ||
      (job.executionMode !== null && job.executionMode !== input.backend))) {
    throw new Error(`implementation job generation mismatch: ${input.dispatchId}`);
  }
  return owner;
}
export function updateImplementationRunOwner(owner: ImplementationRunOwner): void {
  const current = requireImplementationRunOwner(owner.input);
  if (owner.generation !== current.generation || (current.jobId !== null && owner.jobId !== current.jobId)) {
    throw new Error(`implementation execution identity is frozen: ${owner.input.dispatchId}`);
  }
  implementationIntentStore().replacePrivateOwner(key(owner.input.dispatchId), owner);
}
export function releaseImplementationRunOwner(dispatchId: string, reason: DispatchAdmissionReleaseReason): void {
  const admission = read(dispatchId);
  if (!admission || admission.releasedAt !== null) return;
  const owner = readImplementationRunOwner(dispatchId);
  if (!owner) throw new Error(`missing implementation release authority: ${dispatchId}`);
  release(dispatchId, { kind: "restate", attemptId: dispatchId }, owner.generation, reason);
}
