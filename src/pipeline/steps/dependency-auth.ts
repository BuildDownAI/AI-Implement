import type { PipelineContext, StepModule, StepReporter } from "../types.js";

interface DependencyAuthInputs extends Record<string, unknown> {
  dependencyTokenScope: string | undefined;
  callbackUrl: string | null | undefined;
  /** Test-only injectable fetch implementation. */
  fetchImpl?: typeof fetch;
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
 * Exported separately so the next-issue's credential-helper can call it again
 * on token expiry without going through the step wrapper.
 */
export async function fetchDependencyToken(params: {
  callbackBase: string;
  progressToken: string;
  fetchImpl?: typeof fetch;
}): Promise<DependencyTokenResponse> {
  const { callbackBase, progressToken, fetchImpl: fetchFn = fetch } = params;
  const url = `${callbackBase.replace(/\/$/, "")}/api/runner/dependency-token`;
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
    const { dependencyTokenScope, callbackUrl, fetchImpl } = inputs;
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
