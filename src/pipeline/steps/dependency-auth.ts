import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";

/** Installed location of the credential helper shell script (baked into the session image). */
const CREDENTIAL_HELPER_PATH = "/opt/ai-implement/git-credential-helper.sh";

interface DependencyAuthInputs extends Record<string, unknown> {
  dependencyTokenScope: string | undefined;
  callbackUrl: string | null | undefined;
  /** Test-only injectable fetch implementation. */
  fetchImpl?: typeof fetch;
  /** Test-only injectable spawnSync implementation. */
  spawnSyncImpl?: typeof spawnSync;
  /** Test-only injectable fs.writeFileSync implementation. */
  writeFileSyncImpl?: (path: string, data: string, options?: { mode?: number }) => void;
  /** Override credential helper executable path (test environments only). */
  credentialHelperPath?: string;
}

interface DependencyAuthOutputs extends Record<string, unknown> {
  acquired: boolean;
  expiresAt: string | null;
}

export interface DependencyTokenResponse {
  token: string;
  expires_at: string;
}

/**
 * Fetches a short-lived read-only dependency token from the orchestrator.
 * Exported separately so the credential helper can call the same endpoint
 * on token expiry without going through the step wrapper.
 */
export async function fetchDependencyToken(params: {
  callbackBase: string;
  progressToken: string;
  fetchImpl?: typeof fetch;
}): Promise<DependencyTokenResponse> {
  const { callbackBase, progressToken, fetchImpl: fetchFn = fetch } = params;
  const url = `${callbackBase.replace(/\/+$/, "")}/api/runner/dependency-token`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${progressToken}` },
  });
  if (!res.ok) {
    throw new Error(`dependency-token endpoint returned ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as Record<string, unknown>).token !== "string" ||
    typeof (body as Record<string, unknown>).expires_at !== "string"
  ) {
    throw new Error("dependency-token response missing token or expires_at");
  }
  return body as DependencyTokenResponse;
}

export const dependencyAuthStep: StepModule<DependencyAuthInputs, DependencyAuthOutputs> = {
  async run(
    context: PipelineContext,
    inputs: DependencyAuthInputs,
    _reporter: StepReporter,
  ): Promise<DependencyAuthOutputs> {
    const {
      dependencyTokenScope,
      callbackUrl,
      fetchImpl,
      spawnSyncImpl: spawnFn = spawnSync,
      writeFileSyncImpl: writeFn = writeFileSync,
      credentialHelperPath = CREDENTIAL_HELPER_PATH,
    } = inputs;

    // Read the bearer secret directly from the environment so it never appears
    // in step inputs, which are persisted to the step log and served by the admin API.
    const progressToken = process.env.RUN_PROGRESS_TOKEN?.trim() || null;

    if (!dependencyTokenScope) {
      console.log("[dependency-auth] no scope configured; skipping");
      return { acquired: false, expiresAt: null };
    }
    if (!callbackUrl) {
      console.log("[dependency-auth] no callback URL; skipping");
      return { acquired: false, expiresAt: null };
    }
    if (!progressToken) {
      console.log("[dependency-auth] no progress token (RUN_PROGRESS_TOKEN); skipping");
      return { acquired: false, expiresAt: null };
    }

    try {
      const result = await fetchDependencyToken({
        callbackBase: callbackUrl,
        progressToken,
        fetchImpl,
      });

      if (process.env.GITHUB_ACTIONS === "true") {
        console.log(`::add-mask::${result.token}`);
      }

      // Store on context rather than in outputs so the token is never persisted
      // to the step log or served by the admin API.
      context.data.dependencyToken = result.token;
      context.data.dependencyTokenExpiresAt = result.expires_at;

      // Write a token cache file that the credential helper reads on each git
      // invocation.  The helper overwrites this file when it refreshes.
      const tokenFilePath = join("/tmp", `ai-implement-dep-token-${process.pid}.json`);
      writeFn(tokenFilePath, JSON.stringify({ token: result.token, expires_at: result.expires_at }), {
        mode: 0o600,
      });
      process.env.GIT_DEPENDENCY_TOKEN_FILE = tokenFilePath;
      process.env.GIT_DEPENDENCY_CALLBACK_URL = callbackUrl.replace(/\/+$/, "");

      // Register credential helper for https://github.com so git-based composer
      // installs can reach private sibling repos.
      // Safety: clone.ts and push.ts build remote URLs as
      //   https://x-access-token:<TOKEN>@github.com/…
      // Git bypasses credential helpers when the URL already carries a userinfo
      // component, so this helper is NEVER consulted for the target repo's own
      // clone or push operations — only for unauthenticated HTTPS requests.
      const configResult = spawnFn(
        "git",
        ["config", "--global", "credential.https://github.com.helper", credentialHelperPath],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      if ((configResult.status ?? 1) !== 0) {
        console.warn(
          `[dependency-auth] failed to register git credential helper (exit ${configResult.status ?? "null"})`,
        );
      }

      // Export COMPOSER_AUTH for composer's API-based (dist) downloads.
      // This is a snapshot of the token at fetch time; valid until the endpoint's
      // expires_at (GitHub's real token expiry, ~1 hour on a fresh mint).
      // Dependency installs run early in the pipeline, so this is acceptable
      // in practice — adding refresh machinery for COMPOSER_AUTH is not needed.
      process.env.COMPOSER_AUTH = JSON.stringify({ "github-oauth": { "github.com": result.token } });

      console.log(`[dependency-auth] token fetched; expires=${result.expires_at}`);
      return { acquired: true, expiresAt: result.expires_at };
    } catch (err) {
      console.warn(
        `[dependency-auth] failed to fetch token: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { acquired: false, expiresAt: null };
    }
  },
};
