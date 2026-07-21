/**
 * Best-effort startup self-check for RUNNER_CALLBACK_BASE_URL.
 *
 * When the callback URL is set but not actually reachable (typo'd host, tunnel
 * down, wrong port), runners complete without ever reporting results and the
 * orchestrator re-dispatches planning forever with no signal that the callback
 * path is broken. This check fetches the health endpoint at the configured base
 * URL shortly after startup and warns loudly if it fails. It is advisory only —
 * never fatal.
 */

export type CallbackSelfCheckResult =
  | { status: "skipped"; reason: string }
  | { status: "ok"; httpStatus: number }
  | { status: "unreachable"; error: string };

export interface CallbackSelfCheckOptions {
  baseUrl: string | null;
  runnerMode: string;
  fetchImpl: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Pure reachability probe: fetches `${baseUrl}/` (the health endpoint) with a
 * short timeout. Skips in local mode — host.docker.internal is resolvable from
 * containers but typically not from the host itself, so a self-fetch would
 * false-positive there.
 */
export async function checkRunnerCallbackReachable(
  opts: CallbackSelfCheckOptions,
): Promise<CallbackSelfCheckResult> {
  const { baseUrl, runnerMode, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  if (!baseUrl) {
    return { status: "skipped", reason: "not configured" };
  }
  if (runnerMode === "local") {
    return { status: "skipped", reason: "local runner mode (host.docker.internal is not resolvable from the host)" };
  }
  if (baseUrl.includes("host.docker.internal")) {
    return { status: "skipped", reason: "URL targets host.docker.internal (not resolvable from the host)" };
  }

  const healthUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(healthUrl, { signal: controller.signal });
    if (!response.ok) {
      return { status: "unreachable", error: `HTTP ${response.status}` };
    }
    return { status: "ok", httpStatus: response.status };
  } catch (err) {
    return { status: "unreachable", error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs the reachability probe and logs the outcome. Fire-and-forget from
 * startup; never throws.
 */
export async function runRunnerCallbackSelfCheck(opts: {
  baseUrl: string | null;
  runnerMode: string;
  timeoutMs?: number;
}): Promise<void> {
  try {
    const result = await checkRunnerCallbackReachable({ ...opts, fetchImpl: fetch });
    if (result.status === "ok") {
      console.log(`[main] Runner callback self-check OK: ${opts.baseUrl} is reachable`);
    } else if (result.status === "unreachable") {
      console.warn(
        `[main] WARNING: RUNNER_CALLBACK_BASE_URL (${opts.baseUrl}) is NOT reachable from the orchestrator (${result.error}). ` +
        `Runners must be able to reach this URL to report results — if it is wrong (typo, tunnel down, wrong port), ` +
        `planning auto-advance and the feature-branch cascade will silently stall and issues will be re-dispatched forever. ` +
        `Verify the URL resolves and serves the health endpoint. This check is advisory; the URL may still be reachable ` +
        `from the runners' network even if not from here.`,
      );
    }
  } catch (err) {
    // Advisory only — never let the self-check disturb startup.
    console.warn(`[main] Runner callback self-check failed to run:`, err);
  }
}
