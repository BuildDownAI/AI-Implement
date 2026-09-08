import type { RepoMapping } from "./config.js";
import { getScopedInstallationToken } from "./github-app-auth.js";
import { GitHubApiError } from "./github-errors.js";
import { verifyRunToken } from "./runner-tokens.js";

export interface HandleReferenceTokenInput {
  authorization: string | undefined;
  secret: string;
  githubAppId: string;
  githubAppPrivateKey: string;
  resolveMapping: (mappingTeamKey: string) => RepoMapping | undefined;
}

export interface ReferenceTokenOwnerEntry {
  owner: string;
  token: string | null;
  expiresAt: string | null;
  authMode: "installation" | "public" | "error";
}

export interface HandleReferenceTokenOutput {
  status: number;
  body: Record<string, unknown>;
}

// All authentication and authorization failures return the same body and status
// to prevent caller enumeration — the specific reason is logged server-side only.
const AUTH_FAILURE: HandleReferenceTokenOutput = {
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

export async function handleReferenceTokenRequest(
  input: HandleReferenceTokenInput,
): Promise<HandleReferenceTokenOutput> {
  const bearerToken = parseBearerToken(input.authorization);
  if (!bearerToken) {
    console.warn("[reference-token] Missing or malformed Authorization header");
    return AUTH_FAILURE;
  }

  const verified = verifyRunToken(bearerToken, input.secret, "progress", { consume: false });
  if (!verified.ok) {
    console.warn(`[reference-token] Token verification failed: ${verified.reason}`);
    return AUTH_FAILURE;
  }

  const mapping = input.resolveMapping(verified.mappingTeamKey);
  if (!mapping) {
    console.warn(`[reference-token] No mapping for teamKey=${verified.mappingTeamKey}`);
    return AUTH_FAILURE;
  }

  const referenceRepos = mapping.referenceRepos;
  if (!referenceRepos || referenceRepos.length === 0) {
    console.warn(`[reference-token] No referenceRepos configured for teamKey=${verified.mappingTeamKey}`);
    return AUTH_FAILURE;
  }

  // Group repository names by owner, preserving declaration order.
  const ownerRepos = new Map<string, string[]>();
  for (const entry of referenceRepos) {
    // repo is normalized to https://github.com/owner/repo
    const url = new URL(entry.repo);
    const parts = url.pathname.replace(/^\//, "").split("/");
    const owner = parts[0];
    const repoName = parts[1];
    if (!owner || !repoName) continue;
    const existing = ownerRepos.get(owner);
    if (existing) {
      existing.push(repoName);
    } else {
      ownerRepos.set(owner, [repoName]);
    }
  }

  const owners: ReferenceTokenOwnerEntry[] = await Promise.all(
    Array.from(ownerRepos.entries()).map(async ([owner, repos]) => {
      try {
        const { token, expiresAt } = await getScopedInstallationToken(
          input.githubAppId,
          input.githubAppPrivateKey,
          owner,
          { permissions: { contents: "read" }, repositories: repos, forceRefresh: true },
        );
        return { owner, token, expiresAt, authMode: "installation" as const };
      } catch (err) {
        if (err instanceof GitHubApiError && err.status === 404) {
          console.log(`[reference-token] App not installed on "${owner}"; proceeding without token (public)`);
          return { owner, token: null, expiresAt: null, authMode: "public" as const };
        }
        console.error(`[reference-token] Failed to mint token for owner "${owner}":`, err);
        return { owner, token: null, expiresAt: null, authMode: "error" as const };
      }
    }),
  );

  return { status: 200, body: { owners } };
}
