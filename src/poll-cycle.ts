// Poll cycle state and deadline management.
// Extracted from src/index.ts so deadline and guard logic is testable
// without importing the full server module.

let _pollCount = 0;
let _pollInProgress = false;
let _currentCycleId = 0;
let _lastPollStartedAt: Date | null = null;
let _lastPollFinishedAt: Date | null = null;

/** Returns current poll cycle statistics for the health endpoint and observability. */
export function getPollStats(): {
  pollCount: number;
  lastPollStartedAt: Date | null;
  lastPollFinishedAt: Date | null;
} {
  return {
    pollCount: _pollCount,
    lastPollStartedAt: _lastPollStartedAt,
    lastPollFinishedAt: _lastPollFinishedAt,
  };
}

/** True when `cycleId` is still the active cycle (no newer cycle has started). */
export function isCurrentCycle(cycleId: number): boolean {
  return cycleId === _currentCycleId;
}

/**
 * Marks the start of a new poll cycle.
 * Returns null when a cycle is already in progress (caller should skip and return).
 * Returns { cycleId, started } for deadline tracking and log lines.
 */
export function beginCycle(): { cycleId: number; started: number } | null {
  if (_pollInProgress) return null;
  _pollInProgress = true;
  const cycleId = ++_pollCount;
  _currentCycleId = cycleId;
  _lastPollStartedAt = new Date();
  return { cycleId, started: Date.now() };
}

/**
 * Marks a normal (non-abandoned) cycle completion.
 * Cycle-aware: a stale background body finishing after its deadline will not
 * clobber `pollInProgress` for the cycle that replaced it, and will not update
 * `lastPollFinishedAt` (which reflects only completed cycles).
 */
export function endCycle(cycleId: number): void {
  if (cycleId !== _currentCycleId) return;
  _pollInProgress = false;
  _lastPollFinishedAt = new Date();
}

/**
 * Marks a deadline abandonment: clears `pollInProgress` so the next tick can
 * start a new cycle. Does NOT update `lastPollFinishedAt` — an external probe
 * can detect a hung cycle by comparing `lastPollStartedAt` to `lastPollFinishedAt`.
 */
export function abandonCycle(): void {
  _pollInProgress = false;
}

/**
 * Races `body` against a deadline timer.
 *
 * - Body wins: the timeout is cleared and `endCycle` is called via the body's finally.
 * - Deadline wins: `abandonCycle` clears the lock, `onTimeout` fires, and
 *   `runWithDeadline` resolves so the next tick can start. The body promise keeps
 *   running in the background; its `endCycle(cycleId)` call is a no-op once a newer
 *   cycle has set a different `currentCycleId`.
 */
export async function runWithDeadline(
  cycleId: number,
  started: number,
  timeoutMs: number,
  body: () => Promise<void>,
  onTimeout: (cycleId: number, elapsedSeconds: number) => void,
): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const deadlinePromise = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => {
      const elapsed = Math.round((Date.now() - started) / 1000);
      abandonCycle();
      onTimeout(cycleId, elapsed);
      resolve();
    }, timeoutMs);
  });

  const bodyPromise = (async () => {
    try {
      await body();
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      endCycle(cycleId);
    }
  })();

  await Promise.race([bodyPromise, deadlinePromise]);
}

/** Resets all state to initial values. Call in test beforeEach to isolate cases. */
export function _resetPollCycleState(): void {
  _pollCount = 0;
  _pollInProgress = false;
  _currentCycleId = 0;
  _lastPollStartedAt = null;
  _lastPollFinishedAt = null;
}
