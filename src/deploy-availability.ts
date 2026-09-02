import { mintSourceTokenOrJwt } from "./github-app-auth.js";
import { getRefSha, compareCommits } from "./github.js";
import type { DeployPolicy } from "./deploy-policy.js";

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      AI_IMPLEMENT_SOURCE_COMMIT?: string;
      AI_IMPLEMENT_SOURCE_REPO?: string;
      AI_IMPLEMENT_SOURCE_BRANCH?: string;
    }
  }
}

export interface DeploymentAvailability {
  available: boolean | null; // null when either commit is unknown — never assume "up to date".
  runningCommit: string | null;
  headCommit: string | null;
  checkedAt: number;
  isDowngrade: boolean | null; // null when either commit is unknown or comparison failed.
}

/** Where to look for a new deployment, separate from how we authenticate to look. */
export interface SelfDeployTarget {
  owner: string;
  repo: string;
  branch: string;
  runningCommit: DeploymentAvailability["runningCommit"];
}

export interface AvailabilityInput extends SelfDeployTarget {
  appId: string;
  privateKey: string;
}

/**
 * Reads the build stamps into a target, or null when the image carries none.
 * Not in loadConfig: index.ts runs main() on import, so nothing there is testable.
 */
export function readStampedTarget(
  env: Pick<
    NodeJS.ProcessEnv,
    "AI_IMPLEMENT_SOURCE_COMMIT" | "AI_IMPLEMENT_SOURCE_REPO" | "AI_IMPLEMENT_SOURCE_BRANCH"
  >,
): SelfDeployTarget | null {
  // "unknown" is the Dockerfile default for an unstamped build.
  const stamp = (value: string | undefined): string | null =>
    value && value !== "unknown" ? value : null;

  const stampedRepo = stamp(env.AI_IMPLEMENT_SOURCE_REPO);
  const branch = stamp(env.AI_IMPLEMENT_SOURCE_BRANCH);
  if (!stampedRepo || !branch) return null;

  const [owner, repo] = stampedRepo.split("/");
  if (!owner || !repo) {
    console.warn(
      `[deploy] image stamped with a malformed AI_IMPLEMENT_SOURCE_REPO ("${stampedRepo}"); self-deploy disabled`,
    );
    return null;
  }

  // A missing commit stamp is not disqualifying — the target is still known, and
  // availability reports unknown rather than the feature going silent.
  return { owner, repo, branch, runningCommit: stamp(env.AI_IMPLEMENT_SOURCE_COMMIT) };
}

/**
 * Returns the deploy target to use for availability checks and "Deploy now".
 * When both watchedRepo and watchedRef are set, the override takes precedence over stamps.
 * Falls back to the stamped target on malformed input or missing fields.
 */
export function resolveDeployTarget(
  stamped: SelfDeployTarget | null,
  policy: Pick<DeployPolicy, "watchedRepo" | "watchedRef">,
): SelfDeployTarget | null {
  const { watchedRepo, watchedRef } = policy;
  if (watchedRepo && watchedRef) {
    const parts = watchedRepo.split("/");
    if (parts.length === 2 && parts[0] && parts[1]) {
      const [owner, repo] = parts;
      return { owner, repo, branch: watchedRef, runningCommit: stamped?.runningCommit ?? null };
    }
    // Malformed watchedRepo — fall through to stamps
  }
  return stamped;
}

export function decideAvailability(
  runningCommit: DeploymentAvailability["runningCommit"],
  headCommit: DeploymentAvailability["headCommit"],
): DeploymentAvailability["available"] {
  if (!runningCommit || !headCommit) return null;
  return runningCommit !== headCommit;
}

let current: DeploymentAvailability | null = null;
// ETag from the last public-mode poll; paired with the SHA it was received with.
// Sent as If-None-Match on subsequent polls so 304s do not consume the unauthenticated
// rate limit (60 req/hour per IP) when the branch tip is stable.
let etag: string | null = null;
let etagSha: string | null = null;

/** Last computed availability, or null before the first poll of this process. */
export function getAvailability(): DeploymentAvailability | null {
  return current;
}

export async function refreshAvailability(input: AvailabilityInput): Promise<DeploymentAvailability> {
  const { appId, privateKey, owner, repo, branch, runningCommit } = input;
  // Scoped to the single repository whose branch this reads. Falls back to unauthenticated
  // when the App is not installed on the source repo's owner, enabling public-repo reads.
  // On the installation path the options match the deploy path's mint exactly, so the
  // two share one cache entry.
  const sourceAuth = await mintSourceTokenOrJwt(appId, privateKey, owner, {
    permissions: { contents: "read" },
    repositories: [repo],
  });

  let headCommit: string | null;
  if (sourceAuth.authMode === "public") {
    // Unauthenticated reads are 60/hour per IP. Send If-None-Match so 304s do not
    // consume the budget when the branch tip is stable between polls.
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ai-implement",
    };
    if (etag) headers["If-None-Match"] = etag;
    const url = `https://api.github.com/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=1`;
    const refRes = await fetch(url, { headers });
    if (refRes.status === 304) {
      headCommit = etagSha; // branch tip unchanged; reuse cached SHA without a rate-limit hit
    } else if (refRes.ok) {
      const newEtag = refRes.headers.get("ETag");
      if (newEtag) etag = newEtag;
      const data = (await refRes.json()) as Array<{ sha?: unknown }>;
      const sha = data[0]?.sha;
      headCommit = typeof sha === "string" ? sha : null;
      if (headCommit) etagSha = headCommit;
    } else {
      // 404 = private repo or missing branch; private repos not accessible without install.
      headCommit = null;
    }
  } else {
    // null on 404 or unknown ref — a deleted/renamed branch or a tag that doesn't exist.
    headCommit = await getRefSha(sourceAuth.token, owner, repo, branch);
  }

  let isDowngrade: boolean | null = null;
  if (runningCommit && headCommit) {
    const comparison = await compareCommits(sourceAuth.token, owner, repo, runningCommit, headCommit);
    isDowngrade = comparison !== null ? comparison.behindBy > 0 : null;
  }

  current = {
    available: decideAvailability(runningCommit, headCommit),
    runningCommit,
    headCommit,
    checkedAt: Date.now(),
    isDowngrade,
  };

  return current;
}
