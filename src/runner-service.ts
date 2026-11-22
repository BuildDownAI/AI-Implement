/**
 * The runner's Restate endpoint (AII-2034): one service per run, named
 * `Runner_<runId>`, serving the one `run` handler a workflow calls. The
 * pipeline itself is unchanged: `runAutonomous()` reads the same RunConfig
 * environment it reads from `run-autonomous.js` today. This module owns only
 * the bridge from that pipeline to Restate.
 *
 * The bridge is a flight per invocation id plus a queue of events. The handler
 * takes one event at a time through a journaled `ctx.run("ev-i")`, so every
 * Restate command has a fixed order and a server restart replays the journal
 * instead of starting the pipeline again. Events carry step progress, model
 * invocations, results, settlement, or a sanitized failure message.
 *
 * No workflow calls this mode yet. AII-2048 supplies the launch wiring.
 */
import * as http2 from "node:http2";
import * as restate from "@restatedev/restate-sdk";
import { createEndpointHandler } from "@restatedev/restate-sdk/node";
import type { ServiceDefinition } from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";
import { setInvocationListener } from "./pipeline/job-accounting.js";
import { RestateStepReporter } from "./pipeline/reporter.js";
import type { Step, InvocationRecordV1 } from "./pipeline/types.js";
import { runAutonomous, type RunAutonomousResult } from "./run-autonomous.js";

/** The run id is the dispatch id, set by the launch (AII-2048). */
export const RUNNER_ID_ENV = "AI_IMPLEMENT_RUNNER_ID";
/** The public half of the Restate server's request-identity key (`publickeyv1_...`). */
export const RUNNER_IDENTITY_KEY_ENV = "RESTATE_IDENTITY_KEY";
/** The container has no other listener; the orchestrator's server dials this port. */
export const RUNNER_SERVICE_PORT = 9080;
/** `::` reaches the container through a Docker published port and the Fly private network (IPv6). */
export const RUNNER_SERVICE_HOST = "::";

/**
 * The longest configured job timeout is 360 minutes (`MAX_JOB_TIMEOUT_MINUTES`),
 * and ImplementationRun gives a stopped run a 10-minute margin. The event loop
 * must outlast both, or Restate suspends a handler that is waiting for the next
 * pipeline event and restarts it forever (AII-2033 T4).
 */
export const RUNNER_SERVICE_INACTIVITY_TIMEOUT_MS = 7 * 60 * 60 * 1000;
export const RUNNER_SERVICE_ABORT_TIMEOUT_MS = 8 * 60 * 60 * 1000;

/** A dead runner must end the workflow; unbounded retries would never let it end (AII-2033 T2). */
export const RUNNER_SERVICE_RETRY_POLICY = { maxAttempts: 3, onMaxAttempts: "kill" } as const;

/** The `run` input. It holds no token or secret: model keys stay in `/runner/model-auth/*`, GitHub tokens in nonce vending. */
export const runnerRunInputSchema = z.object({ workflowKey: z.string().min(1) }).strict();
export type RunnerRunInput = z.infer<typeof runnerRunInputSchema>;

export type RunnerEvent =
  | { kind: "step"; step: Step }
  | { kind: "invocation"; record: InvocationRecordV1 }
  | { kind: "result"; result: import("./runner-callback.js").RunnerResultBody }
  | { kind: "settled" }
  | { kind: "failed"; message: string };

export interface RunnerServiceDeps {
  /** The dispatch id this service is named for. */
  runId: string;
  /** The pipeline. Tests pass a fake; production leaves it unset. */
  runAutonomous?: (options: import("./run-autonomous.js").RunAutonomousOptions) => Promise<RunAutonomousResult>;
  /**
   * Observes each execution of an `ev-i` step's callback. The engine does not run a
   * callback whose completion is already journaled, so a count above one proves the
   * step was retried. Tests use it; production leaves it unset.
   */
  onEventStep?: (index: number) => void;
  /** Test seams; production keeps the values above. */
  retryInitialIntervalMs?: number;
  inactivityTimeoutMs?: number;
  abortTimeoutMs?: number;
  /** Test seam for the failure-message scrubber; production reads `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const MAX_FAILURE_MESSAGE_CHARS = 2_000;
const SECRET_ENV_NAME = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE|PEM|NONCE|API_KEY|ACCESS_KEY)/i;
const TOKEN_LIKE = [
  /\b(?:ghs|ghp|gho|ghu|ghr|github_pat)_[A-Za-z0-9_]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bnpm_[A-Za-z0-9]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

/**
 * A failure event carries a message, never a raw error or its stack. Remove any
 * configured secret value and token-shaped strings before the message reaches
 * the journal: a pipeline error can quote a URL or a process environment.
 */
export function sanitizeRunnerFailure(err: unknown, env: NodeJS.ProcessEnv = process.env): string {
  let message: string;
  try {
    message = err instanceof Error ? err.message : String(err);
  } catch {
    message = "pipeline failed";
  }
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !SECRET_ENV_NAME.test(name)) continue;
    message = message.split(value).join("[redacted]");
  }
  for (const pattern of TOKEN_LIKE) message = message.replace(pattern, "[redacted]");
  message = message.replace(/\s+/g, " ").trim();
  if (message.length === 0) return "pipeline failed";
  return message.length > MAX_FAILURE_MESSAGE_CHARS ? `${message.slice(0, MAX_FAILURE_MESSAGE_CHARS)}…` : message;
}

/**
 * One pipeline run for one invocation id. The pipeline starts once; retries and
 * replayed steps read the same events. A retry after a kill must not start it a
 * second time in this process: the workflow's container cleanup, not the
 * handler, is what ends a killed run.
 */
export class RunnerFlight {
  private readonly events: RunnerEvent[] = [];
  private readonly waiters = new Map<number, Array<{ resolve: (event: RunnerEvent) => void; reject: (err: Error) => void }>>();
  private readonly detachInvocationListener: () => void;
  private started = false;
  private terminal = false;
  private cancelled: Error | undefined;

  constructor(
    private readonly run: (options: import("./run-autonomous.js").RunAutonomousOptions) => Promise<RunAutonomousResult>,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    // Installed for this flight, not for the process: `runAutonomous()` resets the
    // accounting list when it starts, and `resetJobAccounting()` must leave the
    // listener attached so calls made after the reset still reach the journal.
    this.detachInvocationListener = setInvocationListener((record) => this.push({ kind: "invocation", record }));
  }

  /** Starts the pipeline on the first call; every later call, including a retry, is a no-op. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.execute();
  }

  private async execute(): Promise<void> {
    try {
      await this.run({
        reporter: new RestateStepReporter((event) => this.push(event)),
        resultSink: (result) => { this.push({ kind: "result", result }); },
      });
      this.push({ kind: "settled" });
    } catch (err) {
      this.push({ kind: "failed", message: sanitizeRunnerFailure(err, this.env) });
    } finally {
      this.detachInvocationListener();
    }
  }

  private push(event: RunnerEvent): void {
    if (this.terminal) return;
    const index = this.events.length;
    this.events.push(event);
    if (event.kind === "settled" || event.kind === "failed") this.terminal = true;
    const waiting = this.waiters.get(index);
    if (waiting) {
      this.waiters.delete(index);
      for (const waiter of waiting) waiter.resolve(event);
    }
  }

  /** Event `index`, waiting for the live queue when the pipeline has not pushed it yet. */
  next(index: number): Promise<RunnerEvent> {
    if (this.cancelled) return Promise.reject(this.cancelled);
    const event = this.events[index];
    if (event) return Promise.resolve(event);
    return new Promise<RunnerEvent>((resolve, reject) => {
      const waiting = this.waiters.get(index) ?? [];
      waiting.push({ resolve, reject });
      this.waiters.set(index, waiting);
    });
  }

  /** Only a Restate cancellation aborts a flight; an attempt abort (kill or retry) must not. */
  cancel(reason = "runner invocation cancelled"): void {
    if (this.cancelled) return;
    this.cancelled = new restate.TerminalError(reason, { errorCode: 409 });
    for (const waiting of this.waiters.values()) {
      for (const waiter of waiting) waiter.reject(this.cancelled);
    }
    this.waiters.clear();
  }
}

export function runnerServiceName(runId: string): string {
  return `Runner_${runId}`;
}

export function createRunnerService(deps: RunnerServiceDeps): ServiceDefinition<string, unknown> {
  const runId = deps.runId.trim();
  if (!runId) throw new Error(`${RUNNER_ID_ENV} is required to name a runner service`);
  const runPipeline = deps.runAutonomous ?? runAutonomous;
  const env = deps.env ?? process.env;
  const flights = new Map<string, RunnerFlight>();

  const flightFor = (invocationId: string): RunnerFlight => {
    let flight = flights.get(invocationId);
    if (!flight) {
      flight = new RunnerFlight(runPipeline, env);
      flights.set(invocationId, flight);
    }
    flight.start();
    return flight;
  };

  async function run(ctx: restate.Context, input: RunnerRunInput): Promise<import("./runner-callback.js").RunnerResultBody | null> {
    if (!input?.workflowKey?.trim()) throw new restate.TerminalError("workflowKey is required");
    const invocationId = ctx.request().id;
    const flight = flightFor(invocationId);
    // `explicitCancellation` keeps an attempt abort (a kill or a retry) from
    // reaching the pipeline. Only the cancellation arm below aborts a flight.
    const cancellation = (): restate.RestatePromise<never> =>
      (ctx as unknown as restate.internal.ContextInternal).cancellation().map((): never => {
        flight.cancel();
        throw new restate.TerminalError("Cancelled", { errorCode: 409 });
      });

    let result: import("./runner-callback.js").RunnerResultBody | null = null;
    for (let i = 0; ; i++) {
      const event = await restate.RestatePromise.race([
        ctx.run(`ev-${i}`, () => {
          deps.onEventStep?.(i);
          return flight.next(i);
        }),
        cancellation(),
      ]);
      if (event.kind === "result") result = event.result;
      if (event.kind === "settled") return result;
      if (event.kind === "failed") throw new restate.TerminalError(event.message);
      if (event.kind === "step") {
        ctx.genericSend({
          service: "ImplementationRun",
          method: "step",
          key: input.workflowKey,
          parameter: event.step,
          inputSerde: restate.serde.json,
        });
      }
      if (event.kind === "invocation") {
        ctx.genericSend({
          service: "ImplementationRun",
          method: "recordInvocation",
          key: input.workflowKey,
          parameter: event.record,
          inputSerde: restate.serde.json,
        });
      }
    }
  }

  return restate.service({
    name: runnerServiceName(runId),
    handlers: {
      run: restate.handlers.handler({ input: serde.zod(runnerRunInputSchema) }, run),
    },
    options: {
      retryPolicy: {
        ...RUNNER_SERVICE_RETRY_POLICY,
        ...(deps.retryInitialIntervalMs === undefined ? {} : { initialInterval: deps.retryInitialIntervalMs }),
      },
      inactivityTimeout: deps.inactivityTimeoutMs ?? RUNNER_SERVICE_INACTIVITY_TIMEOUT_MS,
      abortTimeout: deps.abortTimeoutMs ?? RUNNER_SERVICE_ABORT_TIMEOUT_MS,
      explicitCancellation: true,
    },
  }) as ServiceDefinition<string, unknown>;
}

export interface RunnerServiceEndpointConfig {
  runId: string;
  identityKey: string;
}

export type RunnerServiceConfigResult = { ok: true; config: RunnerServiceEndpointConfig } | { ok: false; missing: string[] };

/** Fail closed: a host-reachable runner port must not accept an unsigned call from any local process. */
export function resolveRunnerServiceConfig(env: NodeJS.ProcessEnv = process.env): RunnerServiceConfigResult {
  const runId = env[RUNNER_ID_ENV]?.trim();
  const identityKey = env[RUNNER_IDENTITY_KEY_ENV]?.trim();
  const missing: string[] = [];
  if (!runId) missing.push(RUNNER_ID_ENV);
  if (!identityKey) missing.push(RUNNER_IDENTITY_KEY_ENV);
  if (!runId || !identityKey) return { ok: false, missing };
  return { ok: true, config: { runId, identityKey } };
}

/**
 * The process entry's listener. `::` is deliberate: the orchestrator endpoint
 * binds `127.0.0.1`, which a Docker published port never reaches from the host;
 * `::` covers both a published IPv4 port and the Fly private network.
 */
export function startRunnerServiceServer(
  config: RunnerServiceEndpointConfig,
  deps: Pick<RunnerServiceDeps, "runAutonomous"> = {},
): http2.Http2Server {
  const service = createRunnerService({ runId: config.runId, ...deps });
  const server = http2.createServer(createEndpointHandler({ services: [service], identityKeys: [config.identityKey] }));
  server.listen(RUNNER_SERVICE_PORT, RUNNER_SERVICE_HOST);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const resolved = resolveRunnerServiceConfig();
  if (!resolved.ok) {
    console.error(`[runner-service] refusing to start: missing ${resolved.missing.join(", ")}`);
    process.exitCode = 1;
  } else {
    try {
      const server = startRunnerServiceServer(resolved.config);
      server.once("error", (err) => {
        console.error(`[runner-service] failed to listen on ${RUNNER_SERVICE_HOST}:${RUNNER_SERVICE_PORT}: ${err.message}`);
        process.exitCode = 1;
      });
      console.log(`[runner-service] ${runnerServiceName(resolved.config.runId)} listening on ${RUNNER_SERVICE_HOST}:${RUNNER_SERVICE_PORT}`);
    } catch (err) {
      console.error(`[runner-service] failed to start: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }
}
