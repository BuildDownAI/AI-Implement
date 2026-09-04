import { getScopedInstallationToken } from "./github-app-auth.js";
import { verifyRunToken } from "./runner-tokens.js";

export interface HandleKgPushTokenInput {
  authorization: string | undefined;
  secret: string;
  githubAppId: string;
  githubAppPrivateKey: string;
  /** owner/repo of the KG source repo, from config.kgSourceRepo. */
  kgSourceRepo: string | null;
}

export interface HandleKgPushTokenOutput {
  status: number;
  body: Record<string, unknown>;
}

// All authentication and authorization failures return the same body and status
// to prevent caller enumeration — the specific reason is logged server-side only.
const AUTH_FAILURE: HandleKgPushTokenOutput = {
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
 * Vends a write-capable GitHub token scoped to the KG source repo, callable
 * only by runs of kind kg-refresh.
 *
 * The progress token is multi-use (consume: false) so the git credential helper
 * can re-mint on expiry without consuming the token. The minted token always has
 * `contents: write` on the single KG source repo — no other repo is in scope.
 */
export async function handleKgPushTokenRequest(
  input: HandleKgPushTokenInput,
): Promise<HandleKgPushTokenOutput> {
  const bearerToken = parseBearerToken(input.authorization);
  if (!bearerToken) {
    console.warn("[kg-push-token] Missing or malformed Authorization header");
    return AUTH_FAILURE;
  }

  const verified = verifyRunToken(bearerToken, input.secret, "progress", { consume: false });
  if (!verified.ok) {
    console.warn(`[kg-push-token] Token verification failed: ${verified.reason}`);
    return AUTH_FAILURE;
  }

  if (verified.claims.phase !== "kg-refresh") {
    console.warn(`[kg-push-token] Phase gate: expected kg-refresh, got ${verified.claims.phase}`);
    return AUTH_FAILURE;
  }

  if (!input.kgSourceRepo) {
    console.warn("[kg-push-token] kgSourceRepo not configured");
    return AUTH_FAILURE;
  }

  const slashIdx = input.kgSourceRepo.indexOf("/");
  if (slashIdx <= 0 || slashIdx === input.kgSourceRepo.length - 1) {
    console.warn(`[kg-push-token] Invalid kgSourceRepo format: ${input.kgSourceRepo}`);
    return AUTH_FAILURE;
  }
  const owner = input.kgSourceRepo.slice(0, slashIdx);
  const repo = input.kgSourceRepo.slice(slashIdx + 1);

  try {
    // forceRefresh ensures the credential helper always receives a full-lifetime
    // token, never a cache hit that might be minutes from expiry.
    const { token, expiresAt } = await getScopedInstallationToken(
      input.githubAppId,
      input.githubAppPrivateKey,
      owner,
      {
        permissions: { contents: "write" },
        repositories: [repo],
        forceRefresh: true,
      },
    );
    return { status: 200, body: { token, expires_at: expiresAt } };
  } catch (err) {
    console.error("[kg-push-token] Failed to mint installation token:", err);
    return { status: 500, body: { error: "Failed to mint token" } };
  }
}
