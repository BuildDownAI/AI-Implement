import { mintSourceTokenOrJwt } from "./github-app-auth.js";
import { getRefSha, compareCommits, defaultFetchSignal, srcHeaders } from "./github.js";
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

/**
 * The published image of a commit: in a control-plane machine's Fly image app when it has one, otherwise in the GHCR namespace the owner's publish job pushes to.
 * Registry repository names are lowercase (the OCI distribution spec), while an owner keeps its casing.
 */
export function publishedImage(owner: string, branch: string, commit: string, imageApp?: string): string {
  const tag = `${branch}-${commit.slice(0, 7)}`;
  return imageApp ? `registry.fly.io/${imageApp}:${tag}` : `ghcr.io/${owner.toLowerCase()}/ai-implement-orchestrator:${tag}`;
}

/**
 * The commit status the publish job sets once an image's copy is in place, one per registry, so neither copy's status stands for the other:
 * the GHCR copy's once anyone can pull it, the Fly image app's (a control-plane machine's) once it is pushed there.
 */
export function publicationContext(image: string): "orchestrator-image/public" | "orchestrator-image/published" {
  return image.startsWith("ghcr.io/") ? "orchestrator-image/public" : "orchestrator-image/published";
}

// Every manifest a push can store: an image index or a single image, in OCI or Docker media types.
// GHCR answers an OCI image index with 404 unless the request accepts that type, so a missing type reads as no image.
// The publish workflow's own read sends the same list.
export const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

// One budget for the whole read, as the runner channel lookup bounds its own (resolveChannelCommit), since the poll waits on it before tracker work.
const ANONYMOUS_READ_TIMEOUT_MS = 10_000;

/**
 * Whether anyone can pull a GHCR image, read the way another Fly organization pulls it: an anonymous token, then the manifest.
 * GHCR answers a private package and a missing one alike, so false covers both. Any other failure throws with its status, for a retry to clear.
 */
export async function anonymousImageReadable(image: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const match = /^ghcr\.io\/([^:]+):([^:]+)$/.exec(image);
  if (!match) throw new Error(`not a GHCR image reference: ${image}`);
  const [, name, tag] = match;
  const refused = (status: number) => status === 401 || status === 403 || status === 404;
  const signal = AbortSignal.timeout(ANONYMOUS_READ_TIMEOUT_MS);
  const tokenResponse = await fetchImpl(`https://ghcr.io/token?scope=repository:${name}:pull`, { signal });
  if (refused(tokenResponse.status)) return false;
  if (!tokenResponse.ok) throw Object.assign(new Error(`GHCR token request failed HTTP ${tokenResponse.status}`), { status: tokenResponse.status });
  const { token } = (await tokenResponse.json()) as { token: string };
  const manifest = await fetchImpl(`https://ghcr.io/v2/${name}/manifests/${encodeURIComponent(tag)}`, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_TYPES },
    signal,
  });
  if (refused(manifest.status)) return false;
  if (!manifest.ok) throw Object.assign(new Error(`GHCR manifest read failed HTTP ${manifest.status}`), { status: manifest.status });
  return true;
}

/**
 * Whether a published commit's image can be deployed: its copy's publication status first, then an anonymous read of an image on GHCR.
 * An image on Fly's registry belongs to a control-plane image app, where no anonymous read applies.
 */
export async function publishedImageReadiness(
  image: string,
  reads: { published(context: string): Promise<boolean>; readable(image: string): Promise<boolean> },
): Promise<PublishedImageReadiness> {
  if (!(await reads.published(publicationContext(image)))) return "not-published";
  if (image.startsWith("ghcr.io/") && !(await reads.readable(image))) return "not-pullable";
  return "ready";
}

export type PublishedImageReadiness = "ready" | "not-published" | "not-pullable";
/** The poll's read of the head's image: its readiness, or "status-unreadable" when GitHub refuses the publication status read. */
export type HeadImageReadiness = PublishedImageReadiness | "status-unreadable";

// The last readiness read, for one head's image. Only "ready" is reused; anything else is read again.
let lastReadiness: { key: string; readiness: HeadImageReadiness } | null = null;

/** Identifies a readiness read: the watched repository, whose publication status answers it, the commit and the image it names. */
function readinessKey(target: SelfDeployTarget, commit: string, imageApp: string | undefined): string {
  return `${target.owner}/${target.repo} ${commit} ${publishedImage(target.owner, target.branch, commit, imageApp)}`;
}

/**
 * Whether the poll may act on the head an availability refresh found: always on the built path or when there is no new head;
 * on the published path, once the head's image can be deployed, the check SelfDeploy.start makes again before its hold.
 */
export async function availableHeadDeployable(input: {
  availability: DeploymentAvailability | null;
  target: SelfDeployTarget;
  kgSourceRepo: string | null | undefined;
  imageApp: string | undefined;
  reads: { published(commit: string, context: string): Promise<boolean>; readable(image: string): Promise<boolean> };
}): Promise<boolean> {
  const head = input.availability?.headCommit ?? null;
  if (input.kgSourceRepo || !head || input.availability?.available !== true) return true;
  const image = publishedImage(input.target.owner, input.target.branch, head, input.imageApp);
  const key = readinessKey(input.target, head, input.imageApp);
  if (lastReadiness?.key === key && lastReadiness.readiness === "ready") return true;
  let readiness: HeadImageReadiness;
  try {
    readiness = await publishedImageReadiness(image, { published: (context) => input.reads.published(head, context), readable: input.reads.readable });
  } catch (error) {
    // An installation without Commit statuses refuses every read, so it is recorded rather than thrown each poll. SelfDeploy.start refuses it too.
    if ((error as { status?: number }).status !== 403) throw error;
    readiness = "status-unreadable";
  }
  lastReadiness = { key, readiness };
  return readiness === "ready";
}

/** The readiness the poll last read for this target's head and its image, or null when it read none for them. */
export function getPublishedImageReadiness(target: SelfDeployTarget, commit: string | null, imageApp: string | undefined): HeadImageReadiness | null {
  return commit !== null && lastReadiness?.key === readinessKey(target, commit, imageApp) ? lastReadiness.readiness : null;
}

/** Whether the commit's latest status in `context` is success. GitHub returns statuses newest first, so the first in the context is authoritative. */
export async function githubImagePublished(appId: string, privateKey: string, target: { owner: string; repo: string }, commit: string, context: string): Promise<boolean> {
  const { token } = await mintSourceTokenOrJwt(appId, privateKey, target.owner, {
    permissions: { statuses: "read" }, repositories: [target.repo],
  });
  for (let page = 1; ; page++) {
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/commits/${encodeURIComponent(commit)}/statuses?per_page=100&page=${page}`, {
      headers: srcHeaders(token), signal: defaultFetchSignal(),
    });
    if (!response.ok) {
      if (response.status === 404) return false;
      throw Object.assign(new Error(`Image publication status read failed HTTP ${response.status}`), { status: response.status });
    }
    const statuses = await response.json() as { context: string; state: string }[];
    const publication = statuses.find(status => status.context === context);
    if (publication) return publication.state === "success";
    if (statuses.length < 100) return false;
  }
}

export function decideAvailability(
  runningCommit: DeploymentAvailability["runningCommit"],
  headCommit: DeploymentAvailability["headCommit"],
): DeploymentAvailability["available"] {
  if (!runningCommit || !headCommit) return null;
  return runningCommit !== headCommit;
}

let current: DeploymentAvailability | null = null;
// ETag from the last public-mode poll, paired with the SHA it was received with, and sent as If-None-Match on the next poll.
let etag: string | null = null;
let etagSha: string | null = null;
// The last comparison GitHub made, keyed by its two commits: their ancestry never changes, so a poll that finds the same pair reuses it.
let lastComparison: { key: string; behindBy: number } | null = null;

/** Whether the head is behind the running commit: false for the same commit, null when GitHub cannot compare them. */
async function headIsBehind(token: string | null, owner: string, repo: string, runningCommit: string, headCommit: string): Promise<boolean | null> {
  if (runningCommit === headCommit) return false;
  const key = `${runningCommit}...${headCommit}`;
  if (lastComparison?.key !== key) {
    const comparison = await compareCommits(token, owner, repo, runningCommit, headCommit);
    if (comparison === null) return null;
    lastComparison = { key, behindBy: comparison.behindBy };
  }
  return lastComparison.behindBy > 0;
}

/** Last computed availability, or null before the first poll of this process. */
export function getAvailability(): DeploymentAvailability | null {
  return current;
}

export async function refreshAvailability(input: AvailabilityInput): Promise<DeploymentAvailability> {
  const { appId, privateKey, owner, repo, branch, runningCommit } = input;
  // Scoped to the single repository whose branch this reads. When the App is not installed on the source repo's owner,
  // the public repository is read with a token from an account the App is installed on (mintSourceTokenOrJwt).
  // On the installation path the options match the deploy path's mint exactly, so the
  // two share one cache entry.
  const sourceAuth = await mintSourceTokenOrJwt(appId, privateKey, owner, {
    permissions: { contents: "read" },
    repositories: [repo],
  });

  let headCommit: string | null;
  if (sourceAuth.authMode === "public") {
    // GitHub does not count a 304 answering a request that carries a token, so the ETag makes each unchanged poll free.
    // Without a token (an App installed nowhere) a 304 still counts.
    const headers = srcHeaders(sourceAuth.token);
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

  const isDowngrade = runningCommit && headCommit ? await headIsBehind(sourceAuth.token, owner, repo, runningCommit, headCommit) : null;

  current = {
    available: decideAvailability(runningCommit, headCommit),
    runningCommit,
    headCommit,
    checkedAt: Date.now(),
    isDowngrade,
  };

  return current;
}
