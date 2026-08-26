const CACHE_TTL_MS = 300_000;
const RUN_CONFIG_RE = /^\s{2,}run_config:\s*$/m;
const RUN_PUBLICATION_TOKEN_RE = /^\s{2,}run_publication_token:\s*$/m;

export type WorkflowContract = "envelope" | "legacy";
export interface WorkflowCapabilities {
  contract: WorkflowContract;
  supportsRunPublicationToken: boolean;
}

type CacheEntry = { expiresAt: number; capabilities: WorkflowCapabilities };

const cache = new Map<string, CacheEntry>();

export function __clearWorkflowProbeCacheForTests(): void {
  cache.clear();
}

export interface ResolveWorkflowContractInput {
  owner: string;
  repo: string;
  workflowFile: string;
  token: string;
  /** Branch the actual workflow_dispatch will target (mapping.defaultBranch). Probes this ref so the contract check agrees with the dispatch. */
  ref: string;
  /** Injected for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to `Date.now`. */
  nowMs?: () => number;
}

export async function resolveWorkflowContract(
  input: ResolveWorkflowContractInput,
): Promise<WorkflowContract> {
  const capabilities = await resolveWorkflowCapabilities(input);
  return capabilities.contract;
}

export async function resolveWorkflowCapabilities(
  input: ResolveWorkflowContractInput,
): Promise<WorkflowCapabilities> {
  const { owner, repo, workflowFile, token, ref } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = (input.nowMs ?? Date.now)();

  const cacheKey = `${owner}/${repo}/${workflowFile}/${ref}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.capabilities;
  }

  const capabilities = await probeCapabilities(owner, repo, workflowFile, ref, token, fetchImpl);
  cache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, capabilities });
  return capabilities;
}

async function probeCapabilities(
  owner: string,
  repo: string,
  workflowFile: string,
  ref: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<WorkflowCapabilities> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/.github/workflows/${workflowFile}?ref=${encodeURIComponent(ref)}`;
  const legacy = (): WorkflowCapabilities => ({
    contract: "legacy",
    supportsRunPublicationToken: false,
  });
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
    return legacy();
  }

  if (res.status === 404) {
    return legacy();
  }
  if (!res.ok) {
    console.warn(`[workflow-probe] ${owner}/${repo}/${workflowFile}: contents lookup returned HTTP ${res.status}; assuming legacy contract`);
    return legacy();
  }

  let body: { content?: string; encoding?: string; type?: string };
  try {
    body = (await res.json()) as typeof body;
  } catch (err) {
    console.warn(`[workflow-probe] ${owner}/${repo}/${workflowFile}: response was not JSON; assuming legacy contract`);
    return legacy();
  }

  if (body.type !== "file" || body.encoding !== "base64" || !body.content) {
    console.warn(`[workflow-probe] ${owner}/${repo}/${workflowFile}: response was not a file blob; assuming legacy contract`);
    return legacy();
  }

  const yamlText = Buffer.from(body.content, "base64").toString("utf8");
  const contract = RUN_CONFIG_RE.test(yamlText) ? "envelope" : "legacy";
  return {
    contract,
    supportsRunPublicationToken: contract === "envelope" && RUN_PUBLICATION_TOKEN_RE.test(yamlText),
  };
}
