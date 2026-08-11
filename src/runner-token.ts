import { spawnSync } from "node:child_process";

const DEFAULT_TOKEN_REQUEST_TIMEOUT_MS = 5_000;

interface RefreshRunnerGithubTokenInputs {
  currentToken: string;
  orchestratorUrl?: string;
  machineNonce?: string;
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
 * Obtain a current GitHub installation token for a Fly/local-docker runner.
 *
 * GitHub Actions intentionally has no orchestrator URL or machine nonce, so it
 * keeps using the workflow-minted token. Vending is best-effort: a temporary
 * orchestrator outage must not discard a boot token that may still be valid.
 */
export async function refreshRunnerGithubToken(
  inputs: RefreshRunnerGithubTokenInputs,
): Promise<string> {
  const orchestratorUrl = inputs.orchestratorUrl?.trim();
  const machineNonce = inputs.machineNonce?.trim();
  if (!orchestratorUrl || !machineNonce) return inputs.currentToken;

  const fetchImpl = inputs.fetchImpl ?? fetch;
  const timeoutMs = inputs.timeoutMs ?? DEFAULT_TOKEN_REQUEST_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetchImpl(`${orchestratorUrl.replace(/\/$/, "")}/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: machineNonce, owner: inputs.owner }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (inputs.strict) {
      throw new Error(`[runner-token] Token refresh unavailable (${reason})`);
    }
    console.warn(`[runner-token] Token refresh unavailable (${reason}); using the previous token.`);
    return inputs.currentToken;
  }

  if (!response.ok) {
    const message = `[runner-token] Token refresh rejected with HTTP ${response.status}`;
    if (inputs.strict) {
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
    if (inputs.strict) {
      throw new Error(`[runner-token] Token refresh returned invalid JSON (${reason})`);
    }
    console.warn(`[runner-token] Token refresh returned invalid JSON (${reason}); using the previous token.`);
    return inputs.currentToken;
  }
  if (typeof body.token !== "string" || body.token.length === 0) {
    if (inputs.strict) {
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
  const canVend = Boolean(inputs.orchestratorUrl?.trim() && inputs.machineNonce?.trim());
  const token = await refreshRunnerGithubToken(inputs);
  if (!canVend) return token;

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
