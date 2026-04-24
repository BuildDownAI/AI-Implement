import type { Step, StepReporter } from "./types.js";

export interface StepReport {
  nonce: string;
  step: Step;
}

export class HttpStepReporter implements StepReporter {
  constructor(
    private readonly orchestratorUrl: string,
    private readonly nonce: string,
  ) {}

  async report(step: Step): Promise<void> {
    const url = `${this.orchestratorUrl}/api/step-report`;
    const body: StepReport = { nonce: this.nonce, step };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.error(`[StepReporter] ${step.id} (${step.status}): HTTP ${res.status}`);
      }
    } catch (err) {
      console.error(`[StepReporter] Failed to report step ${step.id}:`, err);
    }
  }
}

export class NoopStepReporter implements StepReporter {
  async report(_step: Step): Promise<void> {}
}
