import { parse as parseYaml } from "yaml";
import { defaultFetchSignal } from "./github.js";

const CACHE_TTL_MS = 300_000;
/** Read only declared dispatch inputs, matching the KG synchronous preflight. */
function declaredInputs(yamlText: string): Record<string, unknown> {
  const mapping = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : {};
  try {
    const doc = mapping(parseYaml(yamlText));
    return mapping(mapping(mapping(doc.on).workflow_dispatch).inputs);
  } catch {
    return {};
  }
}

/**
 * Static private-envelope marker (AII-982): a YAML comment, not a workflow_dispatch input.
 * Distinct from the stage-agent-config-v1 capability, which this must never imply.
 */
const PRIVATE_RUN_CONFIG_RE = /^#\s*ai-implement-capability:\s*private-run-config-v1\s*$/m;

/** Static marker for the ephemeral full-access execution policy projection (AII-1437). */
const EXECUTION_POLICY_RE = /^#\s*ai-implement-capability:\s*github-hosted-execution-policy-v2\s*$/m;

/** Both markers are required on the exact dispatch ref, independently of private transport. */
const STAGE_AGENT_CONFIG_RE = /^#\s*ai-implement-capability:\s*stage-agent-config-v1\s*$/m;
const STAGE_AGENT_CONTEXT_RE = /^#\s*ai-implement-capability:\s*stage-agent-launch-context-v1\s*$/m;

export type WorkflowContract = "envelope" | "legacy";
export interface WorkflowCapabilities {
  contract: WorkflowContract;
  /** Diagnostic facts for setup checks; dispatch keeps using the combined capability. */
  missing?: boolean;
  hasStageAgentConfigMarker?: boolean;
  hasStageAgentLaunchContextMarker?: boolean;
  supportsRunPublicationToken: boolean;
  /** True when the workflow declares `run_attempt_token`, gating attempt-correlation / versioned-callback support. */
  supportsAttemptCorrelation: boolean;
  /** True when an envelope workflow carries the private-envelope marker. Absent (older fixtures) = false. */
  supportsPrivateRunConfig?: boolean;
  /** True when an envelope workflow carries the github-hosted-execution-policy-v2 marker. Absent = false. */
  supportsExecutionPolicy?: boolean;
  /** Configured stages and independent trusted launch context on this exact ref. Absent = false. */
  supportsStageAgentConfig?: boolean;
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
  /** @deprecated Ignored. Failed reads always throw WorkflowProbeTransientError. */
  failOnTransient?: boolean;
}

/** Thrown when the probe could not read the workflow. Failed reads are never cached. */
export class WorkflowProbeTransientError extends Error {}

interface ProbeResult {
  capabilities: WorkflowCapabilities;
  /** True when the read failed. The resolver throws instead of caching capabilities. */
  transient: boolean;
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

  const { capabilities, transient } = await probeCapabilities(owner, repo, workflowFile, ref, token, fetchImpl);
  if (transient) {
    throw new WorkflowProbeTransientError(`could not read ${owner}/${repo}/${workflowFile}@${ref}`);
  }
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
): Promise<ProbeResult> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/.github/workflows/${workflowFile}?ref=${encodeURIComponent(ref)}`;
  const legacy = (transient = false): ProbeResult => ({
    capabilities: {
      contract: "legacy",
      supportsRunPublicationToken: false,
      supportsAttemptCorrelation: false,
      supportsPrivateRunConfig: false,
      supportsExecutionPolicy: false,
      supportsStageAgentConfig: false,
    },
    transient,
  });
  let res: Response;
  try {
    res = await fetchImpl(url, {
      // Fetch keeps this deadline active while consuming the response body too.
      signal: defaultFetchSignal(),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "linear-dispatch-worker",
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    console.warn(`[workflow-probe] ${owner}/${repo}/${workflowFile}: fetch failed (${err instanceof Error ? err.message : String(err)}); workflow read failed`);
    return legacy(true);
  }

  if (res.status === 404) {
    return { ...legacy(), capabilities: { ...legacy().capabilities, missing: true } };
  }
  if (!res.ok) {
    console.warn(`[workflow-probe] ${owner}/${repo}/${workflowFile}: contents lookup returned HTTP ${res.status}; workflow read failed`);
    return legacy(true);
  }

  let body: { content?: string; encoding?: string; type?: string };
  try {
    body = (await res.json()) as typeof body;
  } catch (err) {
    console.warn(`[workflow-probe] ${owner}/${repo}/${workflowFile}: response was not JSON; workflow read failed`);
    return legacy(true);
  }

  if (!body || body.type !== "file" || body.encoding !== "base64" || typeof body.content !== "string" || !body.content) {
    console.warn(`[workflow-probe] ${owner}/${repo}/${workflowFile}: response was not a file blob; workflow read failed`);
    return legacy(true);
  }

  // Buffer.from silently discards invalid characters and accepts truncated input.
  // GitHub wraps base64 across lines, so validate after removing whitespace.
  const encoded = body.content.replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    console.warn(`[workflow-probe] ${owner}/${repo}/${workflowFile}: invalid base64 content; workflow read failed`);
    return legacy(true);
  }
  const yamlText = Buffer.from(encoded, "base64").toString("utf8");
  const inputs = declaredInputs(yamlText);
  const hasInput = (name: string) => Object.prototype.hasOwnProperty.call(inputs, name);
  const contract = hasInput("run_config") ? "envelope" : "legacy";
  return {
    capabilities: {
      contract,
      hasStageAgentConfigMarker: STAGE_AGENT_CONFIG_RE.test(yamlText),
      hasStageAgentLaunchContextMarker: STAGE_AGENT_CONTEXT_RE.test(yamlText),
      supportsRunPublicationToken: contract === "envelope" && hasInput("run_publication_token"),
      supportsAttemptCorrelation: contract === "envelope" && hasInput("run_attempt_token"),
      supportsPrivateRunConfig: contract === "envelope" && PRIVATE_RUN_CONFIG_RE.test(yamlText),
      supportsExecutionPolicy: contract === "envelope" && EXECUTION_POLICY_RE.test(yamlText),
      supportsStageAgentConfig: contract === "envelope" && STAGE_AGENT_CONFIG_RE.test(yamlText) && STAGE_AGENT_CONTEXT_RE.test(yamlText),
    },
    transient: false,
  };
}
