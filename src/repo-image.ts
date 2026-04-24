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
