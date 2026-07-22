import { AsyncLocalStorage } from "node:async_hooks";
import type { LogLevel, Step, StepReporter } from "./types.js";

export interface TimingRecord {
  /** Step id or sub-phase span label. */
  label: string;
  /** Parent step id for spans and nested substeps; null for top-level steps. */
  parentId: string | null;
  ms: number;
  kind: "step" | "span";
  /** True when the step was skipped (rendered as "skipped", excluded from dominant). */
  skipped?: boolean;
}

/** Human duration: sub-second precision below 10s, `MmSSs` at/above. */
export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m${rem.toString().padStart(2, "0")}s` : `${rem}s`;
}

/** Run-scoped sink for step durations and sub-phase spans. */
export class TimingCollector {
  readonly level: LogLevel;
  private readonly _records: TimingRecord[] = [];
  private readonly _seenSteps = new Set<string>();

  constructor(level: LogLevel) {
    this.level = level;
  }

  record(r: TimingRecord): void {
    if (r.kind === "step") {
      // Steps report a terminal status once; guard against a double record.
      if (this._seenSteps.has(r.label)) return;
      this._seenSteps.add(r.label);
    }
    this._records.push(r);
  }

  records(): readonly TimingRecord[] {
    return this._records;
  }
}

const PREFIX = "[timing]";

/**
 * Render the collector as an indented summary. Top-level steps (parentId null)
 * are listed in completion order — which equals pipeline order, since steps run
 * sequentially. Each step's children (records whose parentId === step.label) are
 * listed beneath it, indented, in insertion order. The total counts top-level
 * steps only (children are already inside their parent's wall-clock).
 */
export function formatSummary(collector: TimingCollector, identifier: string, disposition?: string): string {
  const records = collector.records();
  const topLevel = records.filter((r) => r.kind === "step" && r.parentId === null);
  const totalMs = topLevel.reduce((sum, r) => sum + r.ms, 0);
  const dominant = topLevel.filter((r) => !r.skipped).reduce<TimingRecord | null>(
    (max, r) => (max === null || r.ms > max.ms ? r : max),
    null,
  );

  const lines: string[] = [
    `${PREFIX} ── run summary (${identifier}) — total ${formatDuration(totalMs)} ──`,
  ];

  for (const step of topLevel) {
    // Only flag a dominant step when there's more than one to compare against;
    // a single-step run has nothing to be "dominant" over. Skipped steps are
    // never dominant (they render "skipped" in place of a duration).
    const mark = !step.skipped && topLevel.length > 1 && step === dominant ? "   ⚠ dominant" : "";
    const duration = step.skipped ? "skipped" : formatDuration(step.ms);
    lines.push(`${PREFIX}   ${step.label.padEnd(18)} ${duration.padStart(7)}${mark}`);
    const children = records.filter((r) => r.parentId === step.label);
    children.forEach((child, i) => {
      const branch = i === children.length - 1 ? "└" : "├";
      lines.push(`${PREFIX}     ${branch} ${child.label.padEnd(16)} ${formatDuration(child.ms).padStart(7)}`);
    });
  }

  if (disposition) lines.push(`${PREFIX}   outcome: ${disposition}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Run-scoped ALS context for span() nesting
// ---------------------------------------------------------------------------

interface TimingScope {
  collector: TimingCollector;
  currentStepId: string | null;
}

const timingStore = new AsyncLocalStorage<TimingScope>();

/** Establish the run-scoped timing context so span() can find the collector. */
export function runWithTiming<T>(collector: TimingCollector, fn: () => Promise<T>): Promise<T> {
  return timingStore.run({ collector, currentStepId: null }, fn);
}

/**
 * Time an async sub-phase, recording it under the current step. The active
 * collector and current step id come from the run scope (set by
 * TimingStepReporter on each "running" report). A transparent pass-through when
 * no run scope is active (e.g. a unit test calling a step directly).
 *
 * Call span() only after the enclosing step has reported "running" (the runner
 * does this before invoking a step's run()). A span recorded before then has a
 * null parentId and is silently dropped from formatSummary, which only nests
 * spans under a known step id.
 */
export async function span<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const scope = timingStore.getStore();
  if (!scope) return await fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const ms = performance.now() - start;
    scope.collector.record({ label, parentId: scope.currentStepId, ms, kind: "span" });
    if (scope.collector.level === "stream") {
      console.error(`${PREFIX} ${scope.currentStepId ?? "?"} › ${label}: ${formatDuration(ms)}`);
    }
  }
}

/**
 * StepReporter decorator: forwards every report to the inner reporter unchanged,
 * tracks the current step id for span() nesting, and records each step's
 * duration when it reaches a terminal status.
 */
export class TimingStepReporter implements StepReporter {
  constructor(
    private readonly inner: StepReporter,
    private readonly collector: TimingCollector,
  ) {}

  async report(step: Step): Promise<void> {
    if (step.status === "running") {
      const scope = timingStore.getStore();
      if (scope) scope.currentStepId = step.id;
    } else if (step.status === "passed" || step.status === "failed") {
      if (step.ended_at) {
        const ms = Date.parse(step.ended_at) - Date.parse(step.started_at);
        if (Number.isFinite(ms) && ms >= 0) {
          this.collector.record({
            label: step.id,
            parentId: step.parent_step_id,
            ms,
            kind: "step",
          });
        }
      }
    } else if (step.status === "skipped") {
      this.collector.record({
        label: step.id,
        parentId: step.parent_step_id,
        ms: 0,
        kind: "step",
        skipped: true,
      });
    }
    await this.inner.report(step);
  }
}
