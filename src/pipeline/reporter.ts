import type { Step, StepReporter } from "./types.js";

export interface StepReport {
  nonce: string;
  step: Step;
}

interface HttpStepReporterOptions {
  fetchImpl?: typeof fetch;
  retryDelaysMs?: number[];
}

export class HttpStepReporter implements StepReporter {
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelaysMs: number[];

  constructor(
    private readonly orchestratorUrl: string,
    private readonly nonce: string,
    options: HttpStepReporterOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelaysMs = options.retryDelaysMs ?? [250, 1000, 2500];
  }

  async report(step: Step): Promise<void> {
    const url = `${this.orchestratorUrl}/api/step-report`;
    const body: StepReport = { nonce: this.nonce, step };
    const attempts = this.retryDelaysMs.length + 1;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) return;
        if (!isRetryableStatus(res.status) || attempt === attempts) {
          console.error(`[StepReporter] ${step.id} (${step.status}): HTTP ${res.status}`);
          return;
        }
      } catch (err) {
        if (attempt === attempts) {
          console.error(`[StepReporter] Failed to report step ${step.id} after ${attempts} attempts: ${errorSummary(err)}`);
          return;
        }
      }

      await sleep(this.retryDelaysMs[attempt - 1] ?? 0);
    }
  }
}

export class NoopStepReporter implements StepReporter {
  async report(_step: Step): Promise<void> {}
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
