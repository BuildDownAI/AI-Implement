import { spawnSync } from "node:child_process";
import { clearPublicationCredential } from "./publication-credential.js";

const DEFAULT_TOKEN_REQUEST_TIMEOUT_MS = 5_000;
/** Backoff for the fail-closed exchange, mirroring push.ts's LS_REMOTE_RETRY_DELAYS_MS. */
const TOKEN_REQUEST_RETRY_DELAYS_MS = [250, 1_000];

interface RefreshRunnerGithubTokenInputs {
  currentToken: string;
  orchestratorUrl?: string;
  machineNonce?: string;
  callbackUrl?: string;
  publicationToken?: string;
  owner: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Fail instead of retaining the current token. Intended for the explicit refresh CLI. */
  strict?: boolean;
}

interface RefreshRunnerGithubCredentialsInputs extends RefreshRunnerGithubTokenInputs {
  repo: string;
  workspaceDir: string;
}

/**
 * Obtain a current GitHub installation token for a runner.
 *
 * Fly/local-docker runners authenticate with their machine nonce. GitHub
 * Actions runners may instead exchange a dedicated single-use publication
 * credential through the callback URL. Machine-nonce vending remains
 * best-effort so a temporary orchestrator outage does not discard a usable
 * boot token. Publication-credential exchange fails closed because falling
 * back would recreate the expired-token publication failure it is designed
 * to prevent.
 */
export async function refreshRunnerGithubToken(
  inputs: RefreshRunnerGithubTokenInputs,
): Promise<string> {
  const orchestratorUrl = inputs.orchestratorUrl?.trim();
  const machineNonce = inputs.machineNonce?.trim();
  const callbackUrl = inputs.callbackUrl?.trim();
  const publicationToken = inputs.publicationToken?.trim();
  const canUseMachineNonce = Boolean(orchestratorUrl && machineNonce);
  const canUsePublicationToken = Boolean(callbackUrl && publicationToken);
  if (!canUseMachineNonce && !canUsePublicationToken) return inputs.currentToken;
  // A dispatched publication credential is an explicit, repository-bound
  // authorization gate. Never bypass its rejection with the older workflow
  // token. Machine-nonce vending retains its historical best-effort behavior.
  const failClosed = inputs.strict === true || (!canUseMachineNonce && canUsePublicationToken);

  const fetchImpl = inputs.fetchImpl ?? fetch;
  const timeoutMs = inputs.timeoutMs ?? DEFAULT_TOKEN_REQUEST_TIMEOUT_MS;

  const requestOnce = (): Promise<Response> =>
    canUseMachineNonce
      ? fetchImpl(`${orchestratorUrl!.replace(/\/$/, "")}/api/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nonce: machineNonce, owner: inputs.owner }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      : fetchImpl(`${callbackUrl!.replace(/\/$/, "")}/api/runner/publication-token`, {
          method: "POST",
          headers: { Authorization: `Bearer ${publicationToken}` },
          signal: AbortSignal.timeout(timeoutMs),
        });

  // The fail-closed exchange is the one request in a run that no later poll can
  // retry, and failing it discards the whole completed run — so it gets a bounded
  // retry. Retry ONLY transport failures (connect/timeout: the request may never
  // have reached the server) and 5xx/429 responses; never any other 4xx. The
  // publication credential is consumed BEFORE the mint, so a processed request
  // must not be replayed into `already_consumed` — and if a retried 5xx does land
  // there, the resulting 403 falls through to the normal rejection path.
  // The best-effort machine-nonce path keeps its single attempt: it has a
  // fallback (the boot token), and stacked timeouts would just delay it.
  const retryDelaysMs = failClosed ? TOKEN_REQUEST_RETRY_DELAYS_MS : [];
  let response: Response | undefined;
  let transportError: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      transportError = undefined;
      response = await requestOnce();
    } catch (err) {
      transportError = err;
      response = undefined;
    }
    const retryable = response === undefined || response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= retryDelaysMs.length) break;
    const cause = response ? `HTTP ${response.status}` : (transportError instanceof Error ? transportError.message : String(transportError));
    console.warn(`[runner-token] Token refresh attempt ${attempt + 1} failed (${cause}); retrying in ${retryDelaysMs[attempt]}ms`);
    await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
  }
  if (response === undefined) {
    const reason = transportError instanceof Error ? transportError.message : String(transportError);
    if (failClosed) {
      throw new Error(`[runner-token] Token refresh unavailable (${reason})`);
    }
    console.warn(`[runner-token] Token refresh unavailable (${reason}); using the previous token.`);
    return inputs.currentToken;
  }

  if (!response.ok) {
    const message = `[runner-token] Token refresh rejected with HTTP ${response.status}`;
    if (failClosed) {
      throw new Error(message);
    }
    const canRetainBootToken = response.status === 403
      || response.status === 404
      || response.status === 429
      || response.status >= 500;
    if (canRetainBootToken) {
      console.warn(`${message}; using the previous token.`);
      return inputs.currentToken;
    }
    throw new Error(message);
  }

  let body: { token?: unknown };
  try {
    body = (await response.json()) as { token?: unknown };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (failClosed) {
      throw new Error(`[runner-token] Token refresh returned invalid JSON (${reason})`);
    }
    console.warn(`[runner-token] Token refresh returned invalid JSON (${reason}); using the previous token.`);
    return inputs.currentToken;
  }
  if (typeof body.token !== "string" || body.token.length === 0) {
    if (failClosed) {
      throw new Error("[runner-token] Token refresh returned no token");
    }
    console.warn("[runner-token] Token refresh returned no token; using the previous token.");
    return inputs.currentToken;
  }

  console.log("[runner-token] Obtained a current GitHub token from the orchestrator.");
  return body.token;
}

/**
 * Refresh the token and apply it to the credential paths used by later runner
 * steps: `gh` reads GH_TOKEN, while post-push git operations use `origin`.
 */
export async function refreshRunnerGithubCredentials(
  inputs: RefreshRunnerGithubCredentialsInputs,
): Promise<string> {
  const canVend = Boolean(
    (inputs.orchestratorUrl?.trim() && inputs.machineNonce?.trim())
      || (inputs.callbackUrl?.trim() && inputs.publicationToken?.trim()),
  );
  const token = await refreshRunnerGithubToken(inputs);
  if (!canVend) return token;

  // Only clear the single-use publication credential when it was the path
  // actually exchanged: requestOnce prefers the machine nonce whenever one is
  // available, and a caller supplying both must not burn an unused credential.
  const usedPublicationToken =
    Boolean(inputs.publicationToken?.trim()) && !(inputs.orchestratorUrl?.trim() && inputs.machineNonce?.trim());
  if (usedPublicationToken && token !== inputs.currentToken) {
    clearPublicationCredential();
  }

  process.env.GITHUB_TOKEN = token;
  process.env.GH_TOKEN = token;

  const remote = `https://x-access-token:${token}@github.com/${inputs.owner}/${inputs.repo}.git`;
  const result = spawnSync("git", ["remote", "set-url", "origin", remote], {
    cwd: inputs.workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const stderr = (result.stderr?.toString() ?? "").replaceAll(token, "***");
    throw new Error(`git remote set-url failed (exit ${result.status ?? "null"}): ${stderr}`);
  }

  return token;
}
