import type { InvocationRecordV1 } from "./types.js";

/**
 * Run-scoped accounting state for the one job a runner process executes: every model invocation the
 * stage executor made, and the commits the push step published. `postRunnerResult` reads both, so
 * every terminal result path (success, failure, planning) reports them without threading parameters.
 */
let invocations: InvocationRecordV1[] = [];
let pushedCommits: string[] | null = null;

export function recordInvocation(record: InvocationRecordV1): void {
  invocations.push(record);
}

export function collectedInvocations(): readonly InvocationRecordV1[] {
  return invocations;
}

/** `null` = the push step never reported (unknown); `[]` = it ran and pushed nothing. */
export function recordPushedCommits(shas: string[]): void {
  pushedCommits = shas;
}

export function collectedPushedCommits(): readonly string[] | null {
  return pushedCommits;
}

export function resetJobAccounting(): void {
  invocations = [];
  pushedCommits = null;
}
