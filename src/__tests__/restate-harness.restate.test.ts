// Restate harness (AII-612): boots RestateTestEnvironment and proves the durable-execution
// engine works end to end before any run kind migrates onto it (ADR 017, ADR 018). No live
// callback URL or credential is used anywhere here — the suite setup
// (src/__tests__/setup/clear-runner-credentials.ts) clears RUN_TOKEN, RUNNER_CALLBACK_URL,
// and RUN_PROGRESS_TOKEN before every test (AII-567).
//
// Run with `npm run test:restate` (Docker required); excluded from `npm test`.
import { randomUUID } from "node:crypto";
import * as restate from "@restatedev/restate-sdk";
import { RestateContainer, RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Pinned to match the image cached by .github/workflows/unit-tests.yml's restate-tests job.
const RESTATE_IMAGE_VERSION = "1.7.10";

interface EchoInput {
  value: string;
}

interface EchoOutput {
  echoed: string;
}

const echoService = restate.service({
  name: "restateHarnessEcho",
  handlers: {
    ping: async (_ctx: restate.Context, input: EchoInput): Promise<EchoOutput> => ({
      echoed: input.value,
    }),
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
  name: "restateHarnessProbe",
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

async function callService<T>(baseUrl: string, service: string, handler: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/restate/call/${service}/${handler}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${service}/${handler} failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function callWorkflow<T>(baseUrl: string, workflow: string, key: string, handler: string): Promise<T> {
  const response = await fetch(`${baseUrl}/restate/call/${workflow}/${key}/${handler}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(`${workflow}/${key}/${handler} failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

// Both options are proven for AII-683: each environment boots the same trivial
// services with one of the two test options RestateTestEnvironment.start supports.
const VARIANTS = [
  ["alwaysReplay", { alwaysReplay: true as const }],
  ["disableRetries", { disableRetries: true as const }],
] satisfies Array<[string, Record<string, boolean>]>;

describe("Restate harness", () => {
  const environments = new Map<string, RestateTestEnvironment>();

  beforeAll(async () => {
    const started = await Promise.all(
      VARIANTS.map(async ([label, options]) => {
        const env = await RestateTestEnvironment.start({
          services: [echoService, probeWorkflow],
          container: () => new RestateContainer(RESTATE_IMAGE_VERSION),
          ...options,
        });
        return [label, env] as const;
      }),
    );
    for (const [label, env] of started) {
      environments.set(label, env);
    }
  }, 60_000);

  afterAll(async () => {
    await Promise.all([...environments.values()].map((env) => env.stop()));
  });

  it.each(VARIANTS.map(([label]) => label))(
    "boots and round-trips a call to the trivial service (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const result = await callService<EchoOutput>(env.baseUrl(), "restateHarnessEcho", "ping", {
        value: "pong",
      });
      expect(result).toEqual({ echoed: "pong" });
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "resolves .orTimeout() on a workflow's durable promise directly (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const result = await callWorkflow<{ timedOut: boolean }>(
        env.baseUrl(),
        "restateHarnessProbe",
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
      await callWorkflow(env.baseUrl(), "restateHarnessProbe", randomUUID(), "run");
      const response = await fetch(`${env.adminAPIBaseUrl()}/services/restateHarnessProbe`);
      expect(response.ok).toBe(true);
      const metadata = (await response.json()) as Record<string, unknown>;
      expect(metadata.inactivity_timeout).toBeTruthy();
      expect(metadata.abort_timeout).toBeTruthy();
      expect(metadata.workflow_completion_retention).toBeTruthy();
    },
  );
});
