const CACHE_TTL_MS = 300_000;
const RUN_CONFIG_RE = /^\s{2,}run_config:\s*$/m;

export type WorkflowContract = "envelope" | "legacy";

type CacheEntry = { expiresAt: number; contract: WorkflowContract };

const cache = new Map<string, CacheEntry>();

export function __clearWorkflowProbeCacheForTests(): void {
  cache.clear();
}

export interface ResolveWorkflowContractInput {
  owner: string;
  repo: string;
  workflowFile: string;
  token: string;
  /** Injected for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to `Date.now`. */
  nowMs?: () => number;
}

export async function resolveWorkflowContract(
  input: ResolveWorkflowContractInput,
): Promise<WorkflowContract> {
  const { owner, repo, workflowFile, token } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = (input.nowMs ?? Date.now)();

  const cacheKey = `${owner}/${repo}/${workflowFile}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.contract;
  }

  const contract = await probeContract(owner, repo, workflowFile, token, fetchImpl);
  cache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, contract });
  return contract;
}

async function probeContract(
  owner: string,
  repo: string,
  workflowFile: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<WorkflowContract> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/.github/workflows/${workflowFile}`;
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
    console.warn(`[workflow-probe] ${owner}/${repo}/${workflowFile}: fetch failed (${err instanceof Error ? err.message : String(err)}); assuming legacy contract`);
    return "legacy";
  }

  if (res.status === 404) {
    return "legacy";
  }
  if (!res.ok) {
    console.warn(`[workflow-probe] ${owner}/${repo}/${workflowFile}: contents lookup returned HTTP ${res.status}; assuming legacy contract`);
    return "legacy";
  }

  let body: { content?: string; encoding?: string; type?: string };
  try {
    body = (await res.json()) as typeof body;
  } catch (err) {
    console.warn(`[workflow-probe] ${owner}/${repo}/${workflowFile}: response was not JSON; assuming legacy contract`);
    return "legacy";
  }

  if (body.type !== "file" || body.encoding !== "base64" || !body.content) {
    console.warn(`[workflow-probe] ${owner}/${repo}/${workflowFile}: response was not a file blob; assuming legacy contract`);
    return "legacy";
  }

  const yamlText = Buffer.from(body.content, "base64").toString("utf8");
  return RUN_CONFIG_RE.test(yamlText) ? "envelope" : "legacy";
}
