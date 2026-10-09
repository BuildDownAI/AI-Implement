import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseWorkflowMd } from "./workflow-md.js";
import { postRunnerResult } from "./runner-result.js";
import { decodeRunConfig, type ResolvedAgentSnapshotV1 } from "./run-config.js";
import { ConfiguredRunError, hasConfiguredIntent, prepareConfiguredRun, validateBorrowedConfiguredRun, type ConfiguredRun, type ConfiguredRunOptions } from "./run-autonomous.js";
import { ClaudeCliExecutor } from "./pipeline/executor.js";
import type { InvocationAttributionV1, InvokeParams, LLMResult } from "./pipeline/types.js";
import { DEFAULT_MODEL } from "./pipeline/default-model.js";
import { installSkills, skillAgentsForSnapshot } from "./pipeline/steps/install-skills.js";
import { setupPlanningWritePolicy, type PlanningWritePolicy } from "./planning-write-policy.js";

export type PlanningExecutor = (
  prompt: string,
  args: string[],
  cwd: string,
) => { status: number | null; stdout: string; stderr: string };

/** Asynchronous stage executor type for configured runs (AII-944); still referenced by the local full-loop options. */
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
  /** Construction seam for the Claude child spawn of a configured run (tests only). */
  spawnImpl?: typeof spawn;
  /**
   * Configured-run seams, passed to the shared `prepareConfiguredRun` (injected client/transport, Codex executor, trust).
   * They never bypass snapshot, bootstrap or trust validation. Production passes none: the grant comes from the envelope.
   */
  configured?: ConfiguredRunOptions;
}

/** Only a bounded, credential-free category ever reaches a failure reason or diagnostic. */
const SAFE_CATEGORY_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function safeCategory(value: unknown): string | null {
  return typeof value === "string" && SAFE_CATEGORY_RE.test(value) ? value : null;
}

function describeConfiguredFailure(err: unknown): string {
  const e = err as { category?: unknown; code?: unknown; reason?: unknown } | null;
  const category =
    (err instanceof ConfiguredRunError ? safeCategory(e?.reason) : null) ?? safeCategory(e?.category) ?? safeCategory(e?.code) ?? "executor_error";
  return `Configured planning failed (${category})`;
}

/**
 * Installs the selected project skills before any planning executor starts. The runner's `GITHUB_TOKEN` reaches only
 * the clone child (through `gitProcessEnv`), never a model process. Bounded and non-fatal: failures only warn.
 */
function installPlanningSkills(skillsRepo: string | undefined, snapshot: ResolvedAgentSnapshotV1 | undefined): void {
  if (!skillsRepo) return;
  try {
    installSkills({
      skillsRepoUrl: skillsRepo,
      githubToken: process.env.GITHUB_TOKEN?.trim() ?? "",
      agents: skillAgentsForSnapshot(snapshot),
    });
  } catch {
    // installSkills does not throw; planning must proceed regardless.
  }
}

const INVALID_SNAPSHOT_REASON = "Configured planning failed (invalid_snapshot)";

interface ConfiguredPlanningInput {
  workspaceDir: string;
  prompt: string;
  configured: ConfiguredRun;
  spawnImpl?: typeof spawn;
  /** True when this call owns the auth lifecycle and must finish it; a caller-owned client is left to the caller. */
  ownsLifecycle: boolean;
}

type ConfiguredPlanningOutcome =
  | { ok: true; planningContext: string; attribution?: InvocationAttributionV1 }
  | { ok: false; reason: string; attribution?: InvocationAttributionV1 };

/**
 * Configured (opted-in) planning: one invocation through the shared selected stage executor with the frozen planning
 * selection. Model and timeout come from the snapshot; legacy model sources are not consulted. Never falls back to
 * the legacy executor, and never retries on another account. Success requires a readable Markdown plan.
 */
async function invokeConfiguredPlanning(input: ConfiguredPlanningInput): Promise<ConfiguredPlanningOutcome> {
  const { workspaceDir, prompt, configured } = input;
  const selection = configured.snapshot.stages.planning;
  let completed = false;

  // Claude keeps the trusted write guard: Read/Glob/Grep plus Write confined to ai-output/comments.
  // Codex uses its own native planning driver and receives no Claude flags.
  let policy: PlanningWritePolicy | undefined;
  try {
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

    let result: LLMResult;
    try {
      const executor = configured.createExecutor({
        workspaceDir,
        legacy: new ClaudeCliExecutor(workspaceDir, "summary", false, guardedSpawn),
        logLevel: "summary",
      });
      result = await executor.invoke({
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
    const attr = attribution ? { attribution } : {};
    if (result.exitCode !== 0 || result.failure) {
      const category = safeCategory((result.failure as { code?: unknown } | undefined)?.code) ?? `exit_${result.exitCode}`;
      return { ok: false, reason: `Configured planning failed (${category})`, ...attr };
    }
    const planningContext = collectLocalPlanningContext(workspaceDir);
    if (!planningContext.trim()) {
      return {
        ok: false,
        reason: "Planning process exited successfully but produced no readable Markdown plan in ai-output/comments/",
        ...attr,
      };
    }
    completed = true;
    return { ok: true, planningContext, ...attr };
  } finally {
    policy?.cleanup();
    // The executor has returned or thrown, so no child is running here; a possibly-live child holds inside finish().
    if (input.ownsLifecycle) await configured.finish(completed ? "completed" : "failed");
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
  /** Project skills repository (envelope `skillsRepo`); absent = no install. */
  skillsRepo?: string;
  /**
   * Local configured-run sources (protected credential port, injected client, trust, Codex seam), validated by the
   * shared `prepareConfiguredRun`. A snapshot without a source fails closed. An injected `modelAuthClient` stays
   * owned by the caller, which finishes it; a client built here from a port is finished here.
   */
  configured?: ConfiguredRunOptions;
  /** Trusted env source for hosted configured grants. */
  configuredEnv?: NodeJS.ProcessEnv;
  /** @internal Borrowed configured run owned by the local full-loop wrapper. */
  prebuiltConfiguredRun?: ConfiguredRun;
  /** Construction seam for the Claude child spawn of a configured run (tests only). */
  spawnImpl?: typeof spawn;
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
  // An opted-in run is validated before any prompt, policy or model work; it never degrades to the legacy executor.
  let configured: ConfiguredRun | undefined;
  try {
    configured = validateBorrowedConfiguredRun(opts.prebuiltConfiguredRun, opts.agentConfig)
      ?? await prepareConfiguredRun({ env: opts.configuredEnv ?? {}, snapshot: opts.agentConfig, workspaceDir: opts.workspaceDir, options: opts.configured });
  } catch (err) {
    return { exitCode: 1, planningContext: "", planFound: false, diagnostics: describeConfiguredFailure(err) };
  }
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
  installPlanningSkills(opts.skillsRepo, opts.agentConfig);
  if (configured) {
    const outcome = await invokeConfiguredPlanning({
      workspaceDir: opts.workspaceDir,
      prompt,
      configured,
      spawnImpl: opts.spawnImpl,
      ownsLifecycle: !opts.prebuiltConfiguredRun && !opts.configured?.modelAuthClient,
    });
    const attribution = outcome.attribution ? { attribution: outcome.attribution } : {};
    if (!outcome.ok) {
      return { exitCode: 1, planningContext: "", planFound: false, diagnostics: outcome.reason, ...attribution };
    }
    return { exitCode: 0, planningContext: outcome.planningContext, planFound: true, diagnostics: "", ...attribution };
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

const MAX_RECOVERED_CALLBACK_URL = 2048;

/**
 * For a rejected configured envelope only: recover the public `runnerCallbackUrl` so the failure can still be
 * reported. Nothing else is read from the unvalidated payload; a missing, oversized, non-HTTP(S) or
 * credential-bearing URL yields undefined and the rejection stays silent rather than echoing input.
 */
function recoverCallbackUrl(encoded: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
    const raw = (parsed as { runnerCallbackUrl?: unknown } | null)?.runnerCallbackUrl;
    if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RECOVERED_CALLBACK_URL) return undefined;
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    return raw;
  } catch {
    return undefined;
  }
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
  let skillsRepo: string | undefined;
  let malformedConfiguredIntent = false;
  const rawConfig = process.env.AI_IMPLEMENT_RUN_CONFIG;
  if (rawConfig) {
    try {
      const cfg = decodeRunConfig(rawConfig);
      envelopeIssue = cfg.issue;
      if (cfg.planningContext) envelopePlanningContext = cfg.planningContext;
      envelopeCallbackUrl = cfg.runnerCallbackUrl;
      agentConfig = cfg.agentConfig;
      skillsRepo = cfg.skillsRepo;
    } catch {
      // Malformed envelope: fall back to env vars without failing — unless it shows configured intent (an
      // `agentConfig` or a protected grant), which is authoritative and must never degrade to legacy execution.
      malformedConfiguredIntent = hasConfiguredIntent(rawConfig);
      if (malformedConfiguredIntent) envelopeCallbackUrl = recoverCallbackUrl(rawConfig);
    }
  }
  const callbackUrl = envelopeCallbackUrl ?? process.env.RUNNER_CALLBACK_URL?.trim() ?? null;
  const failConfigured = async (failureReason: string): Promise<{ exitCode: number }> => {
    await postRunnerResult({
      phase: "planning",
      workspaceDir,
      outcome: "failure",
      failureReason,
      callbackUrl,
      fetchImpl: opts.fetchImpl,
    });
    return { exitCode: 1 };
  };

  // Configured intent is judged before any legacy issue env lookup, prompt, policy or model work, so a malformed
  // or incomplete configured envelope reports a bounded failure instead of throwing on missing env.
  if (malformedConfiguredIntent) return failConfigured(INVALID_SNAPSHOT_REASON);
  let configured: ConfiguredRun | undefined;
  try {
    const owner = process.env.GITHUB_OWNER?.trim();
    const repo = process.env.GITHUB_REPO?.trim();
    configured = await prepareConfiguredRun({
      env: process.env,
      snapshot: agentConfig,
      workspaceDir,
      repositories: owner && repo ? [`${owner}/${repo}`] : [],
      options: opts.configured,
    });
  } catch (err) {
    return failConfigured(describeConfiguredFailure(err));
  }

  const subs: Record<string, string> = {
    ISSUE_ID: envelopeIssue?.id ?? requireEnv("ISSUE_ID"),
    ISSUE_IDENTIFIER: envelopeIssue?.identifier ?? requireEnv("ISSUE_IDENTIFIER"),
    ISSUE_TITLE: envelopeIssue?.title ?? requireEnv("ISSUE_TITLE"),
    ISSUE_DESCRIPTION: envelopeIssue?.description ?? requireEnv("ISSUE_DESCRIPTION"),
    PARENT: envelopePlanningContext?.parent ?? process.env.PARENT?.trim() ?? "None",
    SIBLINGS: envelopePlanningContext?.siblings ?? process.env.SIBLINGS?.trim() ?? "None",
    DEPENDENCIES: envelopePlanningContext?.dependencies ?? process.env.DEPENDENCIES?.trim() ?? "None",
  };
  let model = process.env.CLAUDE_MODEL || DEFAULT_MODEL;
  let prompt = buildDefaultPlanningPrompt(subs);
  const planningMdPath = join(workspaceDir, "PLANNING.md");
  if (existsSync(planningMdPath)) {
    const parsed = parseWorkflowMd(readFileSync(planningMdPath, "utf-8"), subs);
    if (parsed.frontMatter.model) model = process.env.CLAUDE_MODEL || parsed.frontMatter.model;
    if (parsed.body.trim()) prompt = parsed.body;
  }
  installPlanningSkills(skillsRepo, agentConfig);
  if (configured) {
    const outcome = await invokeConfiguredPlanning({ workspaceDir, prompt, configured, spawnImpl: opts.spawnImpl, ownsLifecycle: true });
    if (!outcome.ok) return failConfigured(outcome.reason);
    await postRunnerResult({
      phase: "planning",
      workspaceDir,
      outcome: "success",
      callbackUrl,
      fetchImpl: opts.fetchImpl,
    });
    return { exitCode: 0 };
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

// The entrypoint passes no options: a configured envelope carries its own protected grant, which the shared
// `prepareConfiguredRun` validates and turns into the one runner-owned selected-credential client.
if (import.meta.url === `file://${process.argv[1]}`) {
  runPlanning()
    .then((r) => process.exit(r.exitCode))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
