// Restate harness (AII-612): boots RestateTestEnvironment and proves the durable-execution
// engine works end to end before any run kind migrates onto it (ADR 017, ADR 018). No live
// callback URL or credential is used anywhere here — the suite setup
// (src/__tests__/setup/clear-runner-credentials.ts) clears RUN_TOKEN, RUNNER_CALLBACK_URL,
// and RUN_PROGRESS_TOKEN before every test (AII-567).
//
// Run with `npm run test:restate` (Docker required); excluded from `npm test`.
import { randomUUID } from "node:crypto";
import * as restate from "@restatedev/restate-sdk";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VARIANTS, callService, callWorkflow, startVariants, stopAll } from "./harness.js";

interface EchoInput {
  value: string;
}

interface EchoOutput {
  echoed: string;
}

const echoService = restate.service({
  name: "harnessEcho",
  handlers: {
    ping: async (_ctx: restate.Context, input: EchoInput): Promise<EchoOutput> => ({
      echoed: input.value,
    }),
    // A void handler, used below to prove callService resolves an empty 2xx body to
    // `undefined` instead of throwing a JSON-parse error (the AII-709 regression).
    noop: async (): Promise<void> => {
      return;
    },
  },
});

// Explicit values so the harness can read them back from the admin API below —
// this is the spike unknown on the `options` shape for restate.workflow.
const PROBE_WORKFLOW_OPTIONS = {
  inactivityTimeout: 61_000,
  abortTimeout: 62_000,
  workflowRetention: 63_000,
};

// Spike unknown: a workflow's durable promise does not accept `.orTimeout` directly —
// `ctx.promise(name)` returns a DurablePromise (plain awaitable + resolve/reject/peek),
// and `.orTimeout` lives on the RestatePromise obtained via `.get()`. This handler
// exercises that working form: nothing ever resolves the promise, so it times out and
// the handler resolves the round trip with `{ timedOut: true }` instead of throwing.
const probeWorkflow = restate.workflow({
  name: "harnessProbe",
  handlers: {
    run: async (ctx: restate.WorkflowContext): Promise<{ timedOut: boolean }> => {
      try {
        await ctx.promise<never>("never-resolved").get().orTimeout(200);
        return { timedOut: false };
      } catch (error) {
        if (error instanceof restate.TimeoutError) {
          return { timedOut: true };
        }
        throw error;
      }
    },
  },
  options: PROBE_WORKFLOW_OPTIONS,
});

// The admin API's own serialization format for these durations isn't part of the
// SDK's TypeScript surface (the SDK types describe what the endpoint discovery manifest
// sends in, not what the server's admin API echoes back), so this accepts either a
// plain millisecond number or a humantime-style string (e.g. "61s", "1m1s").
const DURATION_UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  ms: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
};

function durationStringToMs(value: string): number {
  const pattern = /(\d+(?:\.\d+)?)\s*([a-zµ]+)/gi;
  let total = 0;
  let matched = false;
  for (const match of value.matchAll(pattern)) {
    matched = true;
    const [, amount, unit] = match;
    const unitMs = DURATION_UNIT_MS[unit.toLowerCase()];
    if (unitMs === undefined) {
      throw new Error(`unrecognized duration unit "${unit}" in "${value}"`);
    }
    total += Number(amount) * unitMs;
  }
  if (!matched) {
    throw new Error(`could not parse duration "${value}"`);
  }
  return total;
}

function expectDurationMs(actual: unknown, expectedMs: number, field: string): void {
  if (typeof actual === "number") {
    expect(actual, field).toBe(expectedMs);
    return;
  }
  if (typeof actual === "string") {
    expect(durationStringToMs(actual), field).toBe(expectedMs);
    return;
  }
  throw new Error(`unexpected type for ${field}: ${typeof actual}`);
}

describe("Restate harness", () => {
  let environments: Map<string, RestateTestEnvironment>;

  beforeAll(async () => {
    environments = await startVariants([echoService, probeWorkflow]);
  }, 60_000);

  afterAll(async () => {
    await stopAll(environments);
  });

  it.each(VARIANTS.map(([label]) => label))(
    "boots and round-trips a call to the trivial service (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const result = await callService<EchoOutput>(env.baseUrl(), "harnessEcho", "ping", {
        value: "pong",
      });
      expect(result).toEqual({ echoed: "pong" });
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "returns undefined on an empty 2xx body from a void handler (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const result = await callService<void>(env.baseUrl(), "harnessEcho", "noop", {});
      expect(result).toBeUndefined();
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "resolves .orTimeout() on a workflow's durable promise directly (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const result = await callWorkflow<{ timedOut: boolean }>(
        env.baseUrl(),
        "harnessProbe",
        randomUUID(),
        "run",
      );
      expect(result).toEqual({ timedOut: true });
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "registers explicit workflow options and reads them back from the admin API (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      // Deploy only happens once a service has been invoked at least once against
      // this environment, so run the metadata check after the round-trip tests.
      await callWorkflow(env.baseUrl(), "harnessProbe", randomUUID(), "run");
      const response = await fetch(`${env.adminAPIBaseUrl()}/services/harnessProbe`);
      expect(response.ok).toBe(true);
      const metadata = (await response.json()) as Record<string, unknown>;
      expectDurationMs(metadata.inactivity_timeout, PROBE_WORKFLOW_OPTIONS.inactivityTimeout, "inactivity_timeout");
      expectDurationMs(metadata.abort_timeout, PROBE_WORKFLOW_OPTIONS.abortTimeout, "abort_timeout");
      expectDurationMs(
        metadata.workflow_completion_retention,
        PROBE_WORKFLOW_OPTIONS.workflowRetention,
        "workflow_completion_retention",
      );
    },
  );
});
