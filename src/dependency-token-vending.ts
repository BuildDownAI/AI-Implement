import type { RepoMapping } from "./config.js";
import { getScopedInstallationToken } from "./github-app-auth.js";
import { verifyRunToken } from "./runner-tokens.js";

export interface HandleDependencyTokenInput {
  authorization: string | undefined;
  secret: string;
  githubAppId: string;
  githubAppPrivateKey: string;
  resolveMapping: (mappingTeamKey: string) => RepoMapping | undefined;
}

export interface HandleDependencyTokenOutput {
  status: number;
  body: Record<string, unknown>;
}

// All authentication and authorization failures return the same body and status
// to prevent caller enumeration — the specific reason is logged server-side only.
const AUTH_FAILURE: HandleDependencyTokenOutput = {
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

export async function handleDependencyTokenRequest(
  input: HandleDependencyTokenInput,
): Promise<HandleDependencyTokenOutput> {
  const bearerToken = parseBearerToken(input.authorization);
  if (!bearerToken) {
    console.warn("[dependency-token] Missing or malformed Authorization header");
    return AUTH_FAILURE;
  }

  const verified = verifyRunToken(bearerToken, input.secret, "progress", { consume: false });
  if (!verified.ok) {
    console.warn(`[dependency-token] Token verification failed: ${verified.reason}`);
    return AUTH_FAILURE;
  }

  const mapping = input.resolveMapping(verified.mappingTeamKey);
  if (!mapping) {
    console.warn(`[dependency-token] No mapping for teamKey=${verified.mappingTeamKey}`);
    return AUTH_FAILURE;
  }

  if (mapping.dependencyTokenScope !== "installation") {
    console.warn(`[dependency-token] dependencyTokenScope not enabled for teamKey=${verified.mappingTeamKey}`);
    return AUTH_FAILURE;
  }

  try {
    const token = await getScopedInstallationToken(
      input.githubAppId,
      input.githubAppPrivateKey,
      mapping.owner,
      { permissions: { contents: "read" } },
    );
    const expires_at = new Date(Date.now() + 55 * 60 * 1000).toISOString();
    return { status: 200, body: { token, expires_at } };
  } catch (err) {
    console.error("[dependency-token] Failed to mint installation token:", err);
    return { status: 500, body: { error: "Failed to mint token" } };
  }
}
