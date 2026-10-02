import type { Step, StepReporter } from "./types.js";

interface RunSignalSenderOptions {
  fetchImpl?: typeof fetch;
  retryDelaysMs?: number[];
}

/**
 * Tells the orchestrator a run that a Restate workflow owns has started. Posts `{}` to
 * `/runner/progress` with the reusable progress token; the result keeps `postRunnerResult`.
 * Never throws: a failed signal must not fail the run.
 */
export class RunSignalSender {
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelaysMs: number[];

  constructor(
    private readonly callbackUrl: string,
    private readonly progressToken: string,
    opts: RunSignalSenderOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.retryDelaysMs = opts.retryDelaysMs ?? [250, 1000, 2500];
  }

  async signal(name: "progress"): Promise<boolean> {
    const url = `${this.callbackUrl.replace(/\/$/, "")}/runner/${name}`;
    const attempts = this.retryDelaysMs.length + 1;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.progressToken}`,
          },
          body: "{}",
        });
        if (res.ok) return true;
        if (!isRetryableStatus(res.status) || attempt === attempts) {
          console.error(`[RunSignal] ${name}: HTTP ${res.status}`);
          return false;
        }
      } catch (err) {
        if (attempt === attempts) {
          console.error(`[RunSignal] Failed to send ${name} after ${attempts} attempts: ${errorSummary(err)}`);
          return false;
        }
      }

      await sleep(this.retryDelaysMs[attempt - 1] ?? 0);
    }
    return false;
  }
}

/** A StepReporter that signals "progress" on each step report until one call succeeds. Sends no step body. */
export function progressOnFirstStep(sender: RunSignalSender): StepReporter {
  let sent = false;
  return {
    async report(_step: Step): Promise<void> {
      if (sent) return;
      sent = await sender.signal("progress");
    },
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function errorSummary(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause;
    const causeMessage = cause instanceof Error ? `: ${cause.message}` : "";
    return `${err.name}: ${err.message}${causeMessage}`;
  }
  return String(err);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
