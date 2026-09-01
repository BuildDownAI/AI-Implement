import { getScopedInstallationToken } from "./github-app-auth.js";
import { verifyRunToken } from "./runner-tokens.js";

export interface HandlePublicationTokenInput {
  authorization: string | undefined;
  secret: string;
  githubAppId: string;
  githubAppPrivateKey: string;
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

  // Consume before the external mint. This gives the credential at-most-once
  // semantics even when concurrent runner requests race.
  const verified = verifyRunToken(bearerToken, input.secret, "publication", { consume: true });
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
        permissions: { contents: "write", pull_requests: "write", workflows: "write" },
        repositories: [repo],
        forceRefresh: true,
      },
    );
    return { status: 200, body: { token, expires_at: expiresAt } };
  } catch (err) {
    console.error("[publication-token] Failed to mint installation token:", err);
    return { status: 500, body: { error: "Failed to mint token" } };
  }
}
