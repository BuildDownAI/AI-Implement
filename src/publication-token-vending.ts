import { getScopedInstallationToken } from "./github-app-auth.js";
import { verifyPreparedReviewFixToken, verifyRunToken } from "./runner-tokens.js";

export interface HandlePublicationTokenInput {
  authorization: string | undefined;
  secret: string;
  githubAppId: string;
  githubAppPrivateKey: string;
  repository?: string;
  githubRunId?: number;
  githubRunAttempt?: number;
}

export interface HandlePublicationTokenOutput {
  status: number;
  body: Record<string, unknown>;
}

const AUTH_FAILURE: HandlePublicationTokenOutput = {
  status: 403,
  body: { error: "Unauthorized" },
};

function parseBearerToken(authorization: string | undefined): string | null {
  if (!authorization || !authorization.startsWith("Bearer")) return null;
  let i = "Bearer".length;
  while (i < authorization.length && authorization.charCodeAt(i) <= 32) i += 1;
  if (i === "Bearer".length || i === authorization.length) return null;
  return authorization.slice(i);
}

/**
 * Exchange a dedicated, single-use runner credential for a fresh GitHub App
 * token scoped to the exact repository signed into the credential at dispatch.
 */
export async function handlePublicationTokenRequest(
  input: HandlePublicationTokenInput,
): Promise<HandlePublicationTokenOutput> {
  const bearerToken = parseBearerToken(input.authorization);
  if (!bearerToken) {
    console.warn("[publication-token] Missing or malformed Authorization header");
    return AUTH_FAILURE;
  }

  // Legacy keeps its original consume-before-mint behavior. The pilot checks
  // authority first, then consumes after a successful mint so mint failures
  // can retry without resetting the consumed claim.
  const identified = verifyRunToken(bearerToken, input.secret, "publication", { consume: false });
  if (!identified.ok) return AUTH_FAILURE;
  const pilot = Boolean(identified.claims.attemptId);
  const execution = pilot ? publicationExecution(input) : null;
  if (pilot && !execution) return AUTH_FAILURE;
  const verified = pilot
    ? verifyPreparedReviewFixToken(bearerToken, input.secret, "publication", {
        publicationExecution: execution!,
      })
    : verifyRunToken(bearerToken, input.secret, "publication", { consume: true });
  if (!verified.ok) {
    console.warn(`[publication-token] Token verification failed: ${verified.reason}`);
    return AUTH_FAILURE;
  }
  if (verified.claims.phase === "planning") {
    console.warn("[publication-token] Planning dispatch cannot vend a publication credential");
    return AUTH_FAILURE;
  }

  const repository = verified.claims.repository;
  if (!repository) {
    console.warn("[publication-token] Credential has no repository binding");
    return AUTH_FAILURE;
  }
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) return AUTH_FAILURE;

  try {
    const { token, expiresAt } = await getScopedInstallationToken(
      input.githubAppId,
      input.githubAppPrivateKey,
      owner,
      {
        // workflows:write is load-bearing (AII-450): the push step refreshes to THIS
        // credential immediately before pushing, so its permission set — not the
        // workflow-side mint's — decides what the runner can push. Without it, any
        // run touching .github/workflows/ dies at push with a buried remote-reject
        // (three live occurrences before the omission was found).
        // checks:read is load-bearing for the same reason: post-push review runs on this
        // credential and polls check runs for the external review and failing CI. Without
        // it every poll 403s, the gate fails closed, and every clean PR ends as
        // "external review did not complete within the wait budget".
        permissions: { contents: "write", pull_requests: "write", workflows: "write", checks: "read" },
        repositories: [repo],
        forceRefresh: true,
      },
    );
    // A failed external mint must leave the pilot's credential available for a
    // later retry. Consume only after a token exists, then recheck authority in
    // the same transaction as consumption; a concurrent loser never receives it.
    if (pilot && !verifyPreparedReviewFixToken(bearerToken, input.secret, "publication", {
      consumePublication: true, publicationExecution: execution!,
    }).ok) return AUTH_FAILURE;
    return { status: 200, body: { token, expires_at: expiresAt } };
  } catch (err) {
    console.error("[publication-token] Failed to mint installation token:", err);
    return { status: 500, body: { error: "Failed to mint token" } };
  }
}

function publicationExecution(input: HandlePublicationTokenInput): {
  repository: string; githubRunId: number; githubRunAttempt: number;
} | null {
  if (!input.repository?.match(/^[^/\s]+\/[^/\s]+$/)
    || !Number.isSafeInteger(input.githubRunId) || (input.githubRunId ?? 0) <= 0
    || !Number.isSafeInteger(input.githubRunAttempt) || (input.githubRunAttempt ?? 0) <= 0) return null;
  return { repository: input.repository, githubRunId: input.githubRunId!, githubRunAttempt: input.githubRunAttempt! };
}

/** Recheck current pilot authority before each external write, including later
 * review-fix pushes after the one-shot publication credential has been cleared. */
export function handlePublicationAuthorityCheck(
  input: HandlePublicationTokenInput,
): HandlePublicationTokenOutput {
  const bearerToken = parseBearerToken(input.authorization);
  const execution = publicationExecution(input);
  if (!bearerToken || !execution) return AUTH_FAILURE;
  const verified = verifyPreparedReviewFixToken(bearerToken, input.secret, "result", {
    publicationExecution: execution,
  });
  return verified.ok && verified.claims.attemptId
    ? { status: 200, body: { authorized: true } }
    : AUTH_FAILURE;
}
