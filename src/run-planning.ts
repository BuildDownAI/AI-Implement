import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseWorkflowMd } from "./workflow-md.js";
import { postRunnerResult } from "./runner-result.js";
import { decodeRunConfig, validateResolvedAgentSnapshot, type ResolvedAgentSnapshotV1 } from "./run-config.js";
import type { ModelAuthClient } from "./model-auth-client.js";
import { AgentStageError, createStageExecutor } from "./pipeline/stage-executor.js";
import { ClaudeCliExecutor } from "./pipeline/executor.js";
import type { InvocationAttributionV1, InvokeParams, LLMExecutor, LLMResult } from "./pipeline/types.js";
import { DEFAULT_MODEL } from "./pipeline/default-model.js";
import { setupPlanningWritePolicy, type PlanningWritePolicy } from "./planning-write-policy.js";

export type PlanningExecutor = (
  prompt: string,
  args: string[],
  cwd: string,
) => { status: number | null; stdout: string; stderr: string };

/** Asynchronous stage executor for configured runs (AII-944). Separate from the synchronous
 *  `PlanningExecutor`, which is unchanged. */
export type PlanningStageExecutor = (params: InvokeParams) => Promise<LLMResult>;

const defaultExecutor: PlanningExecutor = (prompt, args, cwd) => {
  const r = spawnSync("claude", [...args, "-p", prompt], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 100 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout?.toString() ?? "",
    stderr: r.stderr?.toString() ?? "",
  };
};

function requireEnv(n: string): string {
  const v = process.env[n];
  if (!v) throw new Error(`Missing required env var: ${n}`);
  return v;
}

function buildDefaultPlanningPrompt(s: Record<string, string>): string {
  return `You are a senior software architect performing a read-only planning analysis. Do NOT create branches, commits, or pull requests, and do NOT modify source files.

**Issue:** ${s.ISSUE_IDENTIFIER} — ${s.ISSUE_TITLE}

**Description:**
${s.ISSUE_DESCRIPTION}

**Parent:** ${s.PARENT}
**Siblings:** ${s.SIBLINGS}
**Dependencies:** ${s.DEPENDENCIES}

Use Read, Glob, and Grep to explore the codebase, then use Write to create structured planning comments as separate Markdown files under ai-output/comments/, prefixed with a two-digit sequence number:
  ai-output/comments/01-implementation-map.md  → "## 🗺 AI Planning: Implementation Map"
  ai-output/comments/02-acceptance-bar.md       → "## ✅ AI Planning: Acceptance Bar"
  ai-output/comments/03-risks.md                → "## ⚠️ AI Planning: Risks & Open Questions"
Do NOT post to the ticketing system; the orchestrator posts the files you write.

For the Implementation Map (01-implementation-map.md), include a Files section with canonical verb bullets (Create, Modify, Test, or Delete), each with a backtick-quoted path:
  - Modify: \`src/existing.ts\`
  - Create: \`src/new-module.ts\`
  - Test: \`src/__tests__/existing.test.ts\`

Append this machine block as the very last lines of 01-implementation-map.md (fill in the files array and risk value):
<!-- ai-implement-planning
v: 1
files: ["src/a.ts", "src/b.ts"]
risk: low|medium|high
-->`;
}

export interface RunPlanningOptions {
  workspaceDir?: string;
  executor?: PlanningExecutor;
  fetchImpl?: typeof fetch;
  /** Selected-credential client for configured runs. Required when the envelope carries `agentConfig`. */
  auth?: Pick<ModelAuthClient, "invoke">;
  /** Test seam for configured runs; the snapshot is still validated and `auth` is still required. */
  stageExecutor?: PlanningStageExecutor;
  /** Construction seams for the production stage executor (tests only): the Claude child spawn and Codex executor. */
  spawnImpl?: typeof spawn;
  createCodex?: (profileId: string) => LLMExecutor;
}

/**
 * Structural check on the raw envelope: is an `agentConfig` present at all? Independent of the decode error
 * text, so a malformed envelope that also carries a snapshot can never degrade to the legacy executor.
 */
function envelopeCarriesAgentConfig(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && (parsed as Record<string, unknown>).agentConfig !== undefined;
  } catch {
    return false;
  }
}

/** Only a bounded, credential-free category ever reaches a failure reason or diagnostic. */
const SAFE_CATEGORY_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function safeCategory(value: unknown): string | null {
  return typeof value === "string" && SAFE_CATEGORY_RE.test(value) ? value : null;
}

function describeConfiguredFailure(err: unknown): string {
  const e = err as { category?: unknown; code?: unknown } | null;
  const category = safeCategory(e?.category) ?? safeCategory(e?.code) ?? "executor_error";
  return `Configured planning failed (${category})`;
}

interface ConfiguredPlanningInput {
  workspaceDir: string;
  prompt: string;
  snapshot: ResolvedAgentSnapshotV1;
  auth?: Pick<ModelAuthClient, "invoke">;
  stageExecutor?: PlanningStageExecutor;
  spawnImpl?: typeof spawn;
  createCodex?: (profileId: string) => LLMExecutor;
}

type ConfiguredPlanningOutcome =
  | { ok: true; attribution?: InvocationAttributionV1 }
  | { ok: false; reason: string; attribution?: InvocationAttributionV1 };

/**
 * Configured (opted-in) planning: one invocation through the stage executor with the frozen planning
 * selection. Model and timeout come from the snapshot; legacy model sources are not consulted. Never
 * falls back to the legacy executor, and never retries on another account.
 */
async function invokeConfiguredPlanning(input: ConfiguredPlanningInput): Promise<ConfiguredPlanningOutcome> {
  const { workspaceDir, prompt } = input;
  let snapshot: ResolvedAgentSnapshotV1;
  try {
    snapshot = validateResolvedAgentSnapshot(input.snapshot);
  } catch {
    return { ok: false, reason: "Configured planning failed (invalid_snapshot)" };
  }
  if (!input.auth) return { ok: false, reason: "Configured planning failed (auth_unavailable)" };
  const selection = snapshot.stages.planning;

  // Claude keeps the trusted write guard: Read/Glob/Grep plus Write confined to ai-output/comments.
  // Codex uses its own native planning driver and receives no Claude flags.
  let policy: PlanningWritePolicy | undefined;
  if (selection.agent === "claude") {
    try {
      policy = setupPlanningWritePolicy(workspaceDir);
    } catch {
      return { ok: false, reason: "Planning write policy could not be set up; planning was not started" };
    }
  }
  const policyArgs = policy?.args ?? [];
  const guardedSpawn = ((cmd: string, args: readonly string[], options: never) => {
    const idx = args.lastIndexOf("-p");
    const guarded = idx < 0 ? [...args, ...policyArgs] : [...args.slice(0, idx), ...policyArgs, ...args.slice(idx)];
    return (input.spawnImpl ?? spawn)(cmd, guarded, options);
  }) as unknown as typeof spawn;

  try {
    let invoke: PlanningStageExecutor;
    try {
      invoke = input.stageExecutor
        ? input.stageExecutor
        : createStageExecutor({
            workspaceDir,
            snapshot,
            auth: input.auth,
            legacy: {
              invoke: async () => {
                throw new AgentStageError("Legacy execution is not permitted for a configured run");
              },
            },
            createClaude: () => new ClaudeCliExecutor(workspaceDir, "summary", false, guardedSpawn),
            ...(input.createCodex ? { createCodex: input.createCodex } : {}),
          }).invoke;
    } catch (err) {
      return { ok: false, reason: describeConfiguredFailure(err) };
    }
    let result: LLMResult;
    try {
      result = await invoke({
        prompt,
        model: selection.model,
        invocationTimeoutMs: selection.invocationTimeoutMs,
        agentStage: "planning",
        stage: "plan",
        ...(selection.agent === "claude" ? { maxTurns: 50 } : {}),
      });
    } catch (err) {
      const attribution = (err as { attribution?: InvocationAttributionV1 } | null)?.attribution;
      return { ok: false, reason: describeConfiguredFailure(err), ...(attribution ? { attribution } : {}) };
    }
    const attribution = result.attribution ?? result.telemetry?.attribution;
    if (result.exitCode !== 0 || result.failure) {
      const category = safeCategory((result.failure as { code?: unknown } | undefined)?.code) ?? `exit_${result.exitCode}`;
      return { ok: false, reason: `Configured planning failed (${category})`, ...(attribution ? { attribution } : {}) };
    }
    return { ok: true, ...(attribution ? { attribution } : {}) };
  } finally {
    policy?.cleanup();
  }
}

function collectLocalPlanningContext(workspaceDir: string): string {
  const dir = join(workspaceDir, "ai-output", "comments");
  if (!existsSync(dir)) return "";
  try {
    const files = readdirSync(dir)
      .filter((n) => n.endsWith(".md"))
      .sort();
    return files.map((n) => readFileSync(join(dir, n), "utf-8")).join("\n\n");
  } catch {
    return "";
  }
}

export interface RunPlanningLocalOptions {
  workspaceDir: string;
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string;
  parent?: string;
  siblings?: string;
  dependencies?: string;
  model?: string;
  executor?: PlanningExecutor;
  /** Resolved stage snapshot (AII-944). Present = configured run; absent = legacy behavior. */
  agentConfig?: ResolvedAgentSnapshotV1;
  /** Selected-credential client; required when `agentConfig` is present. */
  auth?: Pick<ModelAuthClient, "invoke">;
  /** Asynchronous stage executor for configured runs. Test seam; snapshot and `auth` are still required. */
  stageExecutor?: PlanningStageExecutor;
  spawnImpl?: typeof spawn;
  createCodex?: (profileId: string) => LLMExecutor;
}

export interface RunPlanningLocalResult {
  exitCode: number;
  /** Optional diagnostic attribution (AII-946); emission is AII-971. */
  attribution?: InvocationAttributionV1;
  planningContext: string;
  /** True when at least one readable Markdown plan file was produced. */
  planFound: boolean;
  /** Human-readable diagnostics for plan_failed outcomes. */
  diagnostics: string;
}

export async function runPlanningLocally(
  opts: RunPlanningLocalOptions,
): Promise<RunPlanningLocalResult> {
  const subs: Record<string, string> = {
    ISSUE_ID: "",
    ISSUE_IDENTIFIER: opts.issueIdentifier,
    ISSUE_TITLE: opts.issueTitle,
    ISSUE_DESCRIPTION: opts.issueDescription,
    PARENT: opts.parent ?? "None",
    SIBLINGS: opts.siblings ?? "None",
    DEPENDENCIES: opts.dependencies ?? "None",
  };
  let model = opts.model ?? DEFAULT_MODEL;
  let prompt = buildDefaultPlanningPrompt(subs);
  const planningMdPath = join(opts.workspaceDir, "PLANNING.md");
  if (existsSync(planningMdPath)) {
    const parsed = parseWorkflowMd(readFileSync(planningMdPath, "utf-8"), subs);
    if (parsed.frontMatter.model) model = opts.model ?? parsed.frontMatter.model;
    if (parsed.body.trim()) prompt = parsed.body;
  }
  if (opts.agentConfig) {
    const outcome = await invokeConfiguredPlanning({
      workspaceDir: opts.workspaceDir,
      prompt,
      snapshot: opts.agentConfig,
      auth: opts.auth,
      stageExecutor: opts.stageExecutor,
      spawnImpl: opts.spawnImpl,
      createCodex: opts.createCodex,
    });
    const attribution = outcome.attribution ? { attribution: outcome.attribution } : {};
    if (!outcome.ok) {
      return { exitCode: 1, planningContext: "", planFound: false, diagnostics: outcome.reason, ...attribution };
    }
    const configuredContext = collectLocalPlanningContext(opts.workspaceDir);
    if (!configuredContext.trim()) {
      return {
        exitCode: 1,
        planningContext: "",
        planFound: false,
        diagnostics: "Planning process exited successfully but produced no readable Markdown plan in ai-output/comments/",
        ...attribution,
      };
    }
    return { exitCode: 0, planningContext: configuredContext, planFound: true, diagnostics: "", ...attribution };
  }
  let policy: PlanningWritePolicy;
  try {
    policy = setupPlanningWritePolicy(opts.workspaceDir);
  } catch {
    return {
      exitCode: 1,
      planningContext: "",
      planFound: false,
      diagnostics: "Planning write policy could not be set up; planning was not started",
    };
  }
  const args = [
    "--dangerously-skip-permissions",
    "--model",
    model,
    "--max-turns",
    "50",
    ...policy.args,
  ];
  const executor = opts.executor ?? defaultExecutor;
  let result: ReturnType<PlanningExecutor>;
  try {
    result = executor(prompt, args, opts.workspaceDir);
  } finally {
    policy.cleanup();
  }
  if (result.status !== 0) {
    return {
      exitCode: 1,
      planningContext: "",
      planFound: false,
      diagnostics: (result.stderr || result.stdout || "planning executor exited with non-zero status").slice(0, 2000),
    };
  }
  const planningContext = collectLocalPlanningContext(opts.workspaceDir);
  if (!planningContext.trim()) {
    return {
      exitCode: 1,
      planningContext: "",
      planFound: false,
      diagnostics: "Planning process exited successfully but produced no readable Markdown plan in ai-output/comments/",
    };
  }
  return { exitCode: 0, planningContext, planFound: true, diagnostics: "" };
}

export async function runPlanning(opts: RunPlanningOptions = {}): Promise<{ exitCode: number }> {
  const workspaceDir = opts.workspaceDir ?? process.env.WORKSPACE_DIR ?? "/workspace";

  // Resolve issue fields + planning context + callback URL: prefer the envelope,
  // fall back to legacy env vars. The callback URL matters most here — GHA never
  // sets RUNNER_CALLBACK_URL as a plain env var, so without this the orchestrator
  // never learns the run finished and the issue gets stuck mid-planning.
  let envelopeIssue: { id: string; identifier: string; title: string; description: string } | undefined;
  let envelopePlanningContext: { parent?: string; siblings?: string; dependencies?: string } | undefined;
  let envelopeCallbackUrl: string | undefined;
  let agentConfig: ResolvedAgentSnapshotV1 | undefined;
  let malformedAgentConfig = false;
  const rawConfig = process.env.AI_IMPLEMENT_RUN_CONFIG;
  if (rawConfig) {
    try {
      const cfg = decodeRunConfig(rawConfig);
      envelopeIssue = cfg.issue;
      if (cfg.planningContext) envelopePlanningContext = cfg.planningContext;
      envelopeCallbackUrl = cfg.runnerCallbackUrl;
      agentConfig = cfg.agentConfig;
    } catch {
      // Malformed envelope: fall back to env vars without failing — unless it carries an `agentConfig`,
      // which is authoritative and must never degrade to legacy execution (detected structurally).
      malformedAgentConfig = envelopeCarriesAgentConfig(rawConfig);
    }
  }
  const callbackUrl = envelopeCallbackUrl ?? process.env.RUNNER_CALLBACK_URL?.trim() ?? null;

  const subs: Record<string, string> = {
    ISSUE_ID: envelopeIssue?.id ?? requireEnv("ISSUE_ID"),
    ISSUE_IDENTIFIER: envelopeIssue?.identifier ?? requireEnv("ISSUE_IDENTIFIER"),
    ISSUE_TITLE: envelopeIssue?.title ?? requireEnv("ISSUE_TITLE"),
    ISSUE_DESCRIPTION: envelopeIssue?.description ?? requireEnv("ISSUE_DESCRIPTION"),
    PARENT: envelopePlanningContext?.parent ?? process.env.PARENT?.trim() ?? "None",
    SIBLINGS: envelopePlanningContext?.siblings ?? process.env.SIBLINGS?.trim() ?? "None",
    DEPENDENCIES: envelopePlanningContext?.dependencies ?? process.env.DEPENDENCIES?.trim() ?? "None",
  };
  if (malformedAgentConfig) {
    await postRunnerResult({
      phase: "planning",
      workspaceDir,
      outcome: "failure",
      failureReason: "Configured planning failed (invalid_snapshot)",
      callbackUrl,
      fetchImpl: opts.fetchImpl,
    });
    return { exitCode: 1 };
  }
  let model = process.env.CLAUDE_MODEL || DEFAULT_MODEL;
  let prompt = buildDefaultPlanningPrompt(subs);
  const planningMdPath = join(workspaceDir, "PLANNING.md");
  if (existsSync(planningMdPath)) {
    const parsed = parseWorkflowMd(readFileSync(planningMdPath, "utf-8"), subs);
    if (parsed.frontMatter.model) model = process.env.CLAUDE_MODEL || parsed.frontMatter.model;
    if (parsed.body.trim()) prompt = parsed.body;
  }
  if (agentConfig) {
    const outcome = await invokeConfiguredPlanning({
      workspaceDir,
      prompt,
      snapshot: agentConfig,
      auth: opts.auth,
      stageExecutor: opts.stageExecutor,
      spawnImpl: opts.spawnImpl,
      createCodex: opts.createCodex,
    });
    const failureReason = outcome.ok
      ? collectLocalPlanningContext(workspaceDir).trim()
        ? null
        : "Planning process exited successfully but produced no readable Markdown plan in ai-output/comments/"
      : outcome.reason;
    await postRunnerResult({
      phase: "planning",
      workspaceDir,
      outcome: failureReason === null ? "success" : "failure",
      ...(failureReason === null ? {} : { failureReason }),
      callbackUrl,
      fetchImpl: opts.fetchImpl,
    });
    return { exitCode: failureReason === null ? 0 : 1 };
  }
  let policy: PlanningWritePolicy;
  try {
    policy = setupPlanningWritePolicy(workspaceDir);
  } catch {
    await postRunnerResult({
      phase: "planning",
      workspaceDir,
      outcome: "failure",
      failureReason: "Planning write policy could not be set up; planning was not started",
      callbackUrl,
      fetchImpl: opts.fetchImpl,
    });
    return { exitCode: 1 };
  }
  const args = [
    "--dangerously-skip-permissions",
    "--model",
    model,
    "--max-turns",
    "50",
    ...policy.args,
  ];
  const executor = opts.executor ?? defaultExecutor;
  let result: ReturnType<PlanningExecutor>;
  try {
    result = executor(prompt, args, workspaceDir);
  } finally {
    policy.cleanup();
  }
  if (result.status !== 0) {
    await postRunnerResult({
      phase: "planning",
      workspaceDir,
      outcome: "failure",
      failureReason: (result.stderr || "planning run failed").slice(-4000),
      callbackUrl,
      fetchImpl: opts.fetchImpl,
    });
    return { exitCode: 1 };
  }
  await postRunnerResult({
    phase: "planning",
    workspaceDir,
    outcome: "success",
    callbackUrl,
    fetchImpl: opts.fetchImpl,
  });
  return { exitCode: 0 };
}

// The entrypoint passes no `auth`: the selected-credential client is built from the model-auth bootstrap by the
// runner bootstrap work (AII-951/AII-955/AII-960), and this slice adds no second resolver. Until that lands, an
// envelope carrying `agentConfig` fails closed here with `auth_unavailable` rather than running on legacy
// credentials. Covered by the "entrypoint without auth" test.
if (import.meta.url === `file://${process.argv[1]}`) {
  runPlanning()
    .then((r) => process.exit(r.exitCode))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
