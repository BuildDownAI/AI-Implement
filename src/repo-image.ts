declare global {
  namespace NodeJS {
    interface ProcessEnv {
      AI_IMPLEMENT_RUNNER_IMAGE?: string;
      SESSION_IMAGE?: string;
    }
  }
}

const CACHE_TTL_MS = 60_000;
const IMAGE_KEY_RE = /^image:\s*(\S+)\s*$/m;
// Registry ref: host/name(/subpath)* followed by either ":tag" or "@digest".
// No whitespace allowed. Examples accepted:
//   ghcr.io/acme/runner:v3
//   ghcr.io/acme/runner@sha256:abc123
// Rejected: bare names, missing tag/digest, anything with spaces.
const VALID_IMAGE_RE = /^[^\s@]+(\/[^\s@:]+)+(:[^\s@]+|@[^\s]+)$/;

type CacheEntry = { expiresAt: number; image: string; source: "override" | "default" };

const cache = new Map<string, CacheEntry>();

export function __clearRepoImageCacheForTests(): void {
  cache.clear();
}

export interface ResolveSessionImageInput {
  owner: string;
  repo: string;
  token: string;
  defaultImage: string;
  /** Injected for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to `Date.now`. */
  nowMs?: () => number;
}

export interface ResolveSessionImageResult {
  image: string;
  source: "override" | "default";
}

export async function resolveSessionImage(
  input: ResolveSessionImageInput,
): Promise<ResolveSessionImageResult> {
  const { owner, repo, token, defaultImage } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = (input.nowMs ?? Date.now)();

  const cacheKey = `${owner}/${repo}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { image: cached.image, source: cached.source };
  }

  const result = await fetchImage(owner, repo, token, defaultImage, fetchImpl);
  cache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, ...result });
  return result;
}

async function fetchImage(
  owner: string,
  repo: string,
  token: string,
  defaultImage: string,
  fetchImpl: typeof fetch,
): Promise<ResolveSessionImageResult> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/.ai-implement/image.yml`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "linear-dispatch-worker",
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    console.warn(`[repo-image] ${owner}/${repo}: fetch failed (${err instanceof Error ? err.message : String(err)}); using default image`);
    return { image: defaultImage, source: "default" };
  }

  if (res.status === 404) {
    return { image: defaultImage, source: "default" };
  }
  if (!res.ok) {
    console.warn(`[repo-image] ${owner}/${repo}: image.yml lookup returned HTTP ${res.status}; using default image`);
    return { image: defaultImage, source: "default" };
  }

  let body: { content?: string; encoding?: string; type?: string };
  try {
    body = (await res.json()) as typeof body;
  } catch (err) {
    console.warn(`[repo-image] ${owner}/${repo}: image.yml response was not JSON; using default image`);
    return { image: defaultImage, source: "default" };
  }

  if (body.type !== "file" || body.encoding !== "base64" || !body.content) {
    console.warn(`[repo-image] ${owner}/${repo}: image.yml was not a file blob; using default image`);
    return { image: defaultImage, source: "default" };
  }

  const yamlText = Buffer.from(body.content, "base64").toString("utf8");
  const match = yamlText.match(IMAGE_KEY_RE);
  if (!match) {
    console.warn(`[repo-image] ${owner}/${repo}: image.yml has no "image:" key; using default image`);
    return { image: defaultImage, source: "default" };
  }

  const candidate = match[1];
  if (!VALID_IMAGE_RE.test(candidate)) {
    console.warn(`[repo-image] ${owner}/${repo}: image.yml "image: ${candidate}" failed validation (expected host/name:tag); using default image`);
    return { image: defaultImage, source: "default" };
  }

  return { image: candidate, source: "override" };
}

const DEFAULT_RUNNER_IMAGE = "ghcr.io/builddownai/ai-implement-runner:latest";

/**
 * State of the deprecated SESSION_IMAGE env var relative to its replacement:
 * - `unused`   — SESSION_IMAGE is not set; nothing to warn about.
 * - `active`   — SESSION_IMAGE is set and in use (AI_IMPLEMENT_RUNNER_IMAGE unset).
 * - `shadowed` — both are set, so SESSION_IMAGE is ignored in favour of the new var.
 */
export type SessionImageStatus = "unused" | "active" | "shadowed";

export interface DefaultRunnerImageResult {
  image: string;
  /**
   * True when an explicit orchestrator-wide default was set via either env var
   * (AI_IMPLEMENT_RUNNER_IMAGE or the legacy SESSION_IMAGE), vs the built-in
   * fallback. Drives whether the resolved image is forwarded to GitHub Actions
   * dispatches (see {@link selectRunnerImageInput}).
   */
  explicit: boolean;
  sessionImageStatus: SessionImageStatus;
}

/**
 * Resolves the orchestrator-wide default runner image, preferring the
 * mode-agnostic AI_IMPLEMENT_RUNNER_IMAGE and falling back to the legacy
 * (deprecated) SESSION_IMAGE, then the upstream BuildDownAI image. The
 * returned status lets the caller emit a deprecation warning whose wording
 * distinguishes "rename it" (active) from "it's ignored" (shadowed).
 */
export function resolveDefaultRunnerImage(
  env: Pick<NodeJS.ProcessEnv, "AI_IMPLEMENT_RUNNER_IMAGE" | "SESSION_IMAGE">,
): DefaultRunnerImageResult {
  const hasNew = Boolean(env.AI_IMPLEMENT_RUNNER_IMAGE);
  const hasLegacy = Boolean(env.SESSION_IMAGE);
  const sessionImageStatus: SessionImageStatus = !hasLegacy
    ? "unused"
    : hasNew
      ? "shadowed"
      : "active";
  return {
    image: env.AI_IMPLEMENT_RUNNER_IMAGE || env.SESSION_IMAGE || DEFAULT_RUNNER_IMAGE,
    explicit: hasNew || hasLegacy,
    sessionImageStatus,
  };
}

/**
 * Decides whether a resolved image should be forwarded to a target workflow as
 * the `runner_image` workflow_dispatch input.
 *
 * We only forward when the image represents an *explicit* choice:
 *   - a per-repo `.ai-implement/image.yml` override (source === "override"), or
 *   - an explicit orchestrator-wide default (AI_IMPLEMENT_RUNNER_IMAGE or the
 *     legacy SESSION_IMAGE), surfaced as `runnerImageExplicit`.
 *
 * When neither is true the resolved image is just the built-in fallback, so we
 * return `undefined` and let the target workflow keep its own resolution
 * (its own `.ai-implement/image.yml`, the `AI_IMPLEMENT_RUNNER_IMAGE` repo/org
 * variable, then its built-in default). This keeps repos that pin via that
 * variable from being silently overridden by the orchestrator's default.
 */
export function selectRunnerImageInput(opts: {
  resolved: ResolveSessionImageResult;
  runnerImageExplicit: boolean;
}): string | undefined {
  if (opts.resolved.source === "override" || opts.runnerImageExplicit) {
    return opts.resolved.image;
  }
  return undefined;
}

/**
 * Resolves the runner image to forward on an orchestrator-initiated workflow
 * dispatch: resolve the per-repo `.ai-implement/image.yml` override (falling
 * back to the orchestrator default), then decide whether it should be forwarded
 * as the `runner_image` workflow_dispatch input (only on an explicit override or
 * an explicitly-set orchestrator default — see {@link selectRunnerImageInput}).
 *
 * Returns the image string to forward, or `undefined` to leave the target
 * workflow's own image resolution in place. Both the implementation and planning
 * GitHub Actions dispatch paths share this so a testing orchestrator pinned to
 * `:next` steers both phases, and a per-repo image pin is honored for both.
 */
export async function resolveRunnerImageForDispatch(opts: {
  owner: string;
  repo: string;
  token: string;
  defaultImage: string;
  runnerImageExplicit: boolean;
  /** Injected for tests. Defaults to the global `fetch` via resolveSessionImage. */
  fetchImpl?: typeof fetch;
}): Promise<string | undefined> {
  const resolved = await resolveSessionImage({
    owner: opts.owner,
    repo: opts.repo,
    token: opts.token,
    defaultImage: opts.defaultImage,
    fetchImpl: opts.fetchImpl,
  });
  return selectRunnerImageInput({ resolved, runnerImageExplicit: opts.runnerImageExplicit });
}
