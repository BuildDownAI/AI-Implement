// Durable registration of a local runner's Restate deployment (AII-2066). A serve-mode
// runner needs time before its published port accepts HTTP/2, so the caller cannot treat
// one `registerRunnerDeployment()` attempt as final. Each attempt is its own journaled
// step and the wait between attempts is a `ctx.sleep`: a retry loop inside one `ctx.run`
// would be one long step that the invoker inactivity timeout can stop (AII-2036).
//
// This module has no production caller yet. The caller supplies the URI and container
// state readers, because those belong to local Docker; this helper owns only the bounded
// attempt sequence. Pattern anchors: `registerRunnerDeployment` in endpoint.ts and the
// tick loop of `awaitOwnedRun` in owned-run-wait.ts.
import type { WorkflowContext } from "@restatedev/restate-sdk";
import type { BackendRunState } from "../backend-run.js";
import {
  registerRunnerDeployment,
  type RegisterRunnerDeploymentResult,
} from "./endpoint.js";

/** One registration attempt. The default is `registerRunnerDeployment`. */
export type RegisterRunnerDeploymentAttempt = (
  uri: string,
) => Promise<RegisterRunnerDeploymentResult>;

export interface RunnerDeploymentRegistrationOptions {
  /** The runner's Restate URI, or `null` while Docker has not published its port. */
  readUri: () => string | null | Promise<string | null>;
  /** Reads the container state; the caller passes `classifyLocalContainer`. */
  readContainerState: () => BackendRunState | Promise<BackendRunState>;
  /** Epoch milliseconds. No attempt starts at or after this time. */
  bootstrapDeadlineAt: number;
  /** Time between an unreachable attempt and the next one. */
  sleepMs: number;
  /** Test seam; defaults to `registerRunnerDeployment`. */
  register?: RegisterRunnerDeploymentAttempt;
}

export type RunnerDeploymentRegistrationResult =
  | { ok: true; deploymentId: string }
  | { ok: false; reason: "exited" }
  | { ok: false; reason: "bootstrap timeout" }
  | { ok: false; reason: "rejected"; status: number };

/** A ctx.run failure is not retried without limit; the attempt has already decided its outcome. */
const STEP_ATTEMPTS = 1;

/**
 * Registers a local runner's deployment, retrying while it is unreachable until the
 * bootstrap deadline. One attempt is one `register-N` step: it reads the URI and calls
 * the register function, and a throw (or a null URI) is that attempt's `unreachable`
 * answer. After an unreachable attempt, a separate `state-N` step reads the container;
 * `ended` returns `exited`. Otherwise the helper sleeps in a `sleep-N` timer and tries
 * again, unless the bootstrap deadline has arrived.
 *
 * A `rejected` answer stops at once with its HTTP status. A success returns the
 * deployment id.
 */
export async function registerRunnerDeploymentWithRetry(
  ctx: WorkflowContext,
  opts: RunnerDeploymentRegistrationOptions,
): Promise<RunnerDeploymentRegistrationResult> {
  const register = opts.register ?? registerRunnerDeployment;

  for (let attempt = 1; ; attempt++) {
    // `ctx.date.now()` is journaled, so replay checks the same deadline decision.
    if ((await ctx.date.now()) >= opts.bootstrapDeadlineAt) {
      return { ok: false, reason: "bootstrap timeout" };
    }

    const result = await ctx.run(
      `register-${attempt}`,
      async (): Promise<RegisterRunnerDeploymentResult> => {
        // A URI that Docker has not published yet is one unreachable attempt too.
        const uri = await opts.readUri();
        if (uri === null) return { ok: false, reason: "unreachable" };
        try {
          return await register(uri);
        } catch {
          // A throwing fetch is one unreachable attempt, not a reason to retry this step.
          return { ok: false, reason: "unreachable" };
        }
      },
      { maxRetryAttempts: STEP_ATTEMPTS },
    );

    if (result.ok) return { ok: true, deploymentId: result.deploymentId };
    if (result.reason === "rejected") return { ok: false, reason: "rejected", status: result.status };

    const state = await ctx.run(
      `state-${attempt}`,
      () => opts.readContainerState(),
      { maxRetryAttempts: STEP_ATTEMPTS },
    );
    if (state === "ended") return { ok: false, reason: "exited" };

    const now = await ctx.date.now();
    if (now >= opts.bootstrapDeadlineAt) return { ok: false, reason: "bootstrap timeout" };
    const waitMs = Math.max(1, Math.min(opts.sleepMs, opts.bootstrapDeadlineAt - now));
    await ctx.sleep(waitMs, `sleep-${attempt}`);
  }
}
