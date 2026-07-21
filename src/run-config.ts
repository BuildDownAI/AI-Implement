/**
 * Versioned orchestrator→runner config envelope. Travels as ONE
 * workflow_dispatch input (`run_config`) on GHA and as the
 * AI_IMPLEMENT_RUN_CONFIG env var on Fly/local. Never carries secrets:
 * run_token / run_progress_token stay separate inputs so the workflow
 * can ::add-mask:: them.
 */
export interface RunConfigV1 {
  v: 1;
  issue: { id: string; identifier: string; title: string; description: string };
  prNumber?: string;
  baseBranch?: string;
  runnerPhase?: "implementation" | "gap-analysis" | "planning";
  branchPrefix?: string;
  skillsRepo?: string;
  runnerCallbackUrl?: string;
  maxTurns?: number;
  maxIterations?: number;
  commentInstruction?: string;
  sensitiveFiles?: { add?: string[]; allow?: string[] };
  profiles?: string[];
  planningContext?: { parent?: string; siblings?: string; dependencies?: string };
}

const MAX_DESCRIPTION_CHARS = 40_000;
const TRUNCATION_MARKER = "\n\n[truncated by ai-implement: description exceeded envelope cap]";

export function encodeRunConfig(config: RunConfigV1): string {
  const description = config.issue.description.length > MAX_DESCRIPTION_CHARS
    ? config.issue.description.slice(0, MAX_DESCRIPTION_CHARS) + TRUNCATION_MARKER
    : config.issue.description;
  const payload = { ...config, issue: { ...config.issue, description } };
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
}

export function decodeRunConfig(encoded: string): RunConfigV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
  } catch (err) {
    throw new Error(`run_config is not valid base64 JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const cfg = parsed as Partial<RunConfigV1> & { v?: unknown };
  if (cfg.v !== 1) throw new Error(`unsupported run_config version: ${String(cfg.v)}`);
  const issue = cfg.issue as RunConfigV1["issue"] | undefined;
  if (!issue || typeof issue.id !== "string" || typeof issue.identifier !== "string"
      || typeof issue.title !== "string" || typeof issue.description !== "string") {
    throw new Error("run_config missing required issue block");
  }
  return pickKnownKeys(cfg as RunConfigV1);
}

function pickKnownKeys(cfg: RunConfigV1): RunConfigV1 {
  const { v, issue, prNumber, baseBranch, runnerPhase, branchPrefix, skillsRepo,
    runnerCallbackUrl, maxTurns, maxIterations, commentInstruction, sensitiveFiles,
    profiles, planningContext } = cfg;
  const out: RunConfigV1 = { v, issue };
  if (prNumber !== undefined) out.prNumber = prNumber;
  if (baseBranch !== undefined) out.baseBranch = baseBranch;
  if (runnerPhase !== undefined) out.runnerPhase = runnerPhase;
  if (branchPrefix !== undefined) out.branchPrefix = branchPrefix;
  if (skillsRepo !== undefined) out.skillsRepo = skillsRepo;
  if (runnerCallbackUrl !== undefined) out.runnerCallbackUrl = runnerCallbackUrl;
  if (maxTurns !== undefined) out.maxTurns = maxTurns;
  if (maxIterations !== undefined) out.maxIterations = maxIterations;
  if (commentInstruction !== undefined) out.commentInstruction = commentInstruction;
  if (sensitiveFiles !== undefined) out.sensitiveFiles = sensitiveFiles;
  if (profiles !== undefined) out.profiles = profiles;
  if (planningContext !== undefined) out.planningContext = planningContext;
  return out;
}
