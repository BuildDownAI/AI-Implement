import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PipelineContext, Step, StepModule, StepReporter, RunTelemetry } from "../types.js";
import { implementStep } from "./implement.js";
import type { ReferenceRepoResult } from "../../reference-repos.js";
import { reviewStep } from "./review.js";
import { READ_ONLY_TOOL_PARAMS } from "./read-only-tools.js";
import { capDiff } from "./review.js";
import { normalizeRetryPolicy } from "../retry-backoff.js";
import { writeCycleSummary } from "../cycle-summary.js";
import { runFeedbackLoop, splitPlanningContext, type FeedbackLoopOutputs, type PassStat, type TerminationReason } from "../feedback-loop-core.js";
import { DEFAULT_MODEL } from "../default-model.js";

const DEFAULT_MAX_ITERATIONS = 3;

export { splitPlanningContext };
export type { PassStat, TerminationReason };

interface FeedbackLoopInputs extends Record<string, unknown> {
  workspaceDir: string;
  issueTitle: string;
  issueDescription: string;
  /** Explicit model override applied to both implement and review unless overridden individually. */
  model?: string;
  /** Explicit model override for the implement sub-step. Takes precedence over `model`. */
  implementModel?: string;
  /** Explicit model override for the review sub-step. Takes precedence over `model`. */
  reviewModel?: string;
  /** Repo-level implement model from .ai-implement/config.yml, injected by the install step. */
  repoImplementModel?: string;
  /** Repo-level review model from .ai-implement/config.yml, injected by the install step. */
  repoReviewModel?: string;
  maxIterations?: number;
  maxTurns?: number;
  provider?: string;
  planningContext?: string;
  referenceRepoResults?: ReferenceRepoResult[];
  implementationPrompt?: string;
  parentStepId?: string;
  /** Optional reviewer rubric appended to review prompts (e.g. kg-refresh-specific approval criteria). */
  reviewRubric?: string;
  /** Injectable backoff sleep for tests; defaults to a real timer-based wait. */
  sleep?: (ms: number) => Promise<void>;
  /** True when the first install attempt failed (`install` step output). */
  installFailed?: boolean;
  /** The install command that failed (`install` step output). */
  installMethod?: string;
  /** Redacted tail of the failed install's output (`install` step output). */
  installError?: string;
}


/**
 * Pathspecs excluded from the review diff. Generated artifacts (relay
 * `__generated__`, codegen `generated/` dirs) and lockfiles can each be
 * hundreds of KB after a `db:sync` / codegen run, blowing the reviewer's
 * prompt past the model context window. They are committed by the push step
 * regardless — this only controls what the reviewer is shown.
 */
const REVIEW_DIFF_EXCLUDES = [
  ":(exclude,glob)**/__generated__/**",
  ":(exclude,glob)**/generated/**",
  ":(exclude,glob)**/pnpm-lock.yaml",
  ":(exclude,glob)**/package-lock.json",
  ":(exclude,glob)**/yarn.lock",
];

export function getDiff(workspaceDir: string): string {
  // Resolve the real index via git rev-parse --git-path index, which handles
  // worktrees correctly (each worktree has its own index, not the one in the
  // shared .git dir).
  const gitPathResult = spawnSync("git", ["rev-parse", "--git-path", "index"], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (gitPathResult.status !== 0) {
    console.warn(
      `[getDiff] git rev-parse --git-path index failed (exit ${gitPathResult.status ?? "null"})`,
    );
    return "";
  }

  const rawIndexPath = gitPathResult.stdout.toString().trim();
  if (!rawIndexPath) {
    console.warn("[getDiff] git rev-parse --git-path index returned an empty path");
    return "";
  }
  const realIndexPath = resolve(workspaceDir, rawIndexPath);

  // mkdtempSync guarantees exclusive creation — no collision with existing paths
  // or symlink-following attacks. The disposable index lives inside this dir.
  const tmpDir = mkdtempSync(join(tmpdir(), "ai-implement-review-index-"));
  const tmpIndexPath = join(tmpDir, "index");

  try {
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndexPath };

    if (existsSync(realIndexPath)) {
      // Seed the disposable index from the real one so existing staged changes
      // remain visible in the diff. The real index is only read here — never written.
      copyFileSync(realIndexPath, tmpIndexPath);
    } else {
      // No real index (nothing staged yet): initialize the disposable index
      // from HEAD so that git diff HEAD sees the full working-tree delta.
      const readTreeResult = spawnSync("git", ["read-tree", "HEAD"], {
        cwd: workspaceDir,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      if (readTreeResult.status !== 0) {
        console.warn(
          `[getDiff] git read-tree HEAD failed (exit ${readTreeResult.status ?? "null"}): ${readTreeResult.stderr?.toString().trim() ?? ""}`,
        );
        return "";
      }
    }

    // Apply intent-to-add to the disposable index only — the real index is
    // never mutated. Pre-existing entries in the real index are byte-for-byte
    // unchanged after this function returns.
    const addResult = spawnSync("git", ["add", "-N", "."], {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    if (addResult.status !== 0) {
      console.warn(
        `[getDiff] git add -N failed (exit ${addResult.status ?? "null"}): ${addResult.stderr?.toString().trim() ?? ""}`,
      );
      return "";
    }

    const result = spawnSync(
      "git",
      ["diff", "HEAD", "--", ".", ...REVIEW_DIFF_EXCLUDES],
      {
        cwd: workspaceDir,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      },
    );

    if (result.status !== 0) {
      console.warn(
        `[getDiff] git diff failed (exit ${result.status ?? "null"}): ${result.stderr?.toString().trim() ?? ""}`,
      );
      return "";
    }
    return result.stdout.toString();
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures
    }
  }
}

/**
 * `git status --porcelain` snapshot, used by `isRunDirty` to detect uncommitted
 * changes (BAC-27134). Returns "" on a spawn failure — the same fail-safe
 * getDiff uses — since misreading a dirty tree as clean (the exhausted-and-throw
 * path) is the safer misclassification than fabricating a dirty tree that isn't there.
 */
function gitStatusSnapshot(workspaceDir: string): string {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.toString() : "";
}

/** `git rev-parse HEAD`, used by `isRunDirty` to detect a hook/template commit
 *  (BAC-27134). Returns "" on a spawn failure, the same fail-safe as gitStatusSnapshot. */
function resolveHeadSha(workspaceDir: string): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.toString().trim() : "";
}

/**
 * True when the working tree has uncommitted changes, OR HEAD has moved since
 * `runStartHead` was captured at the start of the run (BAC-27134): a hook or
 * template that commits on its own leaves a clean tree with real work behind it.
 * Evaluated against the WHOLE run rather than a per-pass snapshot — comparing
 * against a per-pass snapshot let iteration 2's provider failure (before any
 * edit of its own) match a snapshot that already listed iteration 1's files,
 * silently losing iteration 1's work. Lockfile-only churn counting as dirty is
 * acceptable.
 */
function isRunDirty(workspaceDir: string, runStartHead: string): boolean {
  if (gitStatusSnapshot(workspaceDir).trim().length > 0) return true;
  return resolveHeadSha(workspaceDir) !== runStartHead;
}


const POST_MORTEM_MAX_TURNS = 15;

function buildPostMortemPrompt(params: {
  issueTitle: string;
  issueDescription: string;
  diff: string;
  telemetry: RunTelemetry;
  maxTurns: number;
}): string {
  const { issueTitle, issueDescription, diff, telemetry, maxTurns } = params;
  const trace = (telemetry.toolTrace ?? []).join("\n") || "(no tool trace captured)";
  return `An AI implementation session hit its turn cap (${telemetry.numTurns ?? "?"}/${maxTurns} turns) before completing. Write a concise post-mortem in markdown. You have read-only access to the workspace.

Answer, with headers:
1. **Where the turns went** — summarize the phases of work from the tool trace.
2. **What is complete** — based on the diff.
3. **What remains** — concrete missing pieces vs. the issue requirements.
4. **Why it likely didn't converge** — over-broad scope, missing prerequisites, thin context, or environment friction. Be specific.

Issue: ${issueTitle}

Description:
${issueDescription}

## Working-tree diff
\`\`\`diff
${capDiff(diff)}
\`\`\`

## Tool trace (chronological)
${trace}`;
}

/** Read-only post-mortem invocation. Non-fatal: returns null on any failure. */
async function runPostMortem(
  context: PipelineContext,
  params: { issueTitle: string; issueDescription: string; diff: string; telemetry: RunTelemetry; maxTurns: number; model: string; iteration: number; parentStepId: string },
  reporter: StepReporter,
): Promise<string | null> {
  const subStep: Step = {
    id: `post-mortem.${params.iteration}`,
    type: "custom",
    status: "running",
    started_at: new Date().toISOString(),
    ended_at: null,
    parent_step_id: params.parentStepId,
    inputs: { iteration: params.iteration, maxTurns: params.maxTurns },
    outputs: {},
    logs_url: null,
  };
  await reporter.report(subStep);
  let result: Awaited<ReturnType<typeof context.llmExecutor.invoke>> | undefined;
  try {
    result = await context.llmExecutor.invoke({
      prompt: buildPostMortemPrompt(params),
      model: params.model,
      maxTurns: POST_MORTEM_MAX_TURNS,
      ...READ_ONLY_TOOL_PARAMS,
      stage: `feedback-loop/post-mortem-${params.iteration}`,
      expectsStructuredOutput: false,
      cycle: params.iteration,
    });
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      throw new Error(`post-mortem invocation exited ${result.exitCode}`);
    }
    subStep.status = "passed";
    subStep.ended_at = new Date().toISOString();
    // telemetry (BAC-27201): this is real spend against a turn cap — report-card.ts's
    // extraCostUsd must be able to price it the same way it prices a retry attempt or a
    // post-push-review sub-step.
    subStep.outputs = { length: result.stdout.length, telemetry: result.telemetry };
    await reporter.report(subStep);
    return result.stdout.trim();
  } catch (err) {
    subStep.status = "failed";
    subStep.ended_at = new Date().toISOString();
    // A spawn-level rejection never reaches the `result =` assignment above, so telemetry may
    // genuinely be unavailable here — but when invoke() DID settle (e.g. the exitCode/empty-
    // stdout throw just above), its cost must not be lost from the failed report.
    subStep.outputs = { error: String(err), ...(result?.telemetry ? { telemetry: result.telemetry } : {}) };
    await reporter.report(subStep);
    console.warn(`[feedback-loop] post-mortem failed (non-fatal): ${String(err)}`);
    return null;
  }
}

/**
 * Orchestrates the implement→review loop. Each iteration is reported as a sub-step
 * with parent_step_id pointing to the enclosing feedback-loop step id.
 * The loop terminates when the reviewer approves or maxIterations is reached.
 */
export const feedbackLoopStep: StepModule<FeedbackLoopInputs, FeedbackLoopOutputs> = {
  async run(
    context: PipelineContext,
    inputs: FeedbackLoopInputs,
    reporter: StepReporter,
  ): Promise<FeedbackLoopOutputs> {
    const parentStepId =
      typeof inputs.parentStepId === "string" ? inputs.parentStepId : "feedback-loop";
    const effectiveMaxIterations =
      inputs.maxIterations ?? (inputs.provider === "bedrock" ? 2 : DEFAULT_MAX_ITERATIONS);
    const effectiveMaxTurns = inputs.maxTurns ?? 50;

    // Fallback hierarchy: explicit per-step > unified `model` input > repo config > tenant default > hard default
    const tenantModel = context.data.model;
    const resolvedImplementModel =
      (inputs.implementModel !== undefined ? String(inputs.implementModel) : undefined) ??
      (inputs.model !== undefined ? String(inputs.model) : undefined) ??
      (inputs.repoImplementModel !== undefined ? String(inputs.repoImplementModel) : undefined) ??
      tenantModel ??
      DEFAULT_MODEL;
    const resolvedReviewModel =
      (inputs.reviewModel !== undefined ? String(inputs.reviewModel) : undefined) ??
      (inputs.model !== undefined ? String(inputs.model) : undefined) ??
      (inputs.repoReviewModel !== undefined ? String(inputs.repoReviewModel) : undefined) ??
      tenantModel ??
      DEFAULT_MODEL;

    const rawPlanningContext =
      inputs.planningContext !== undefined ? String(inputs.planningContext) : undefined;
    const workspaceDir = String(inputs.workspaceDir);
    const sleep =
      inputs.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    // Captured once for the whole run (BAC-27134), not per-pass — see isRunDirty.
    const runStartHead = resolveHeadSha(workspaceDir);

    const result = await runFeedbackLoop(
      {
        workspaceDir,
        issueTitle: String(inputs.issueTitle),
        issueDescription: String(inputs.issueDescription),
        issueIdentifier: context.data.issueIdentifier,
        implementationPrompt:
          inputs.implementationPrompt !== undefined ? String(inputs.implementationPrompt) : undefined,
        planningContext: rawPlanningContext,
        referenceRepoResults: inputs.referenceRepoResults,
        reviewRubric: inputs.reviewRubric !== undefined ? String(inputs.reviewRubric) : undefined,
        installFailed: inputs.installFailed === true,
        installMethod: inputs.installMethod !== undefined ? String(inputs.installMethod) : undefined,
        installError: inputs.installError !== undefined ? String(inputs.installError) : undefined,
        maxIterations: effectiveMaxIterations,
        maxTurns: effectiveMaxTurns,
        implementModel: resolvedImplementModel,
        reviewModel: resolvedReviewModel,
        retryPolicy: normalizeRetryPolicy(context.data.retryPolicy),
        runStartHead,
        parentStepId,
      },
      {
        implement: (args) =>
          implementStep.run(
            context,
            {
              workspaceDir,
              prompt: args.prompt,
              model: resolvedImplementModel,
              maxTurns: effectiveMaxTurns,
              planningContext: args.planningContext,
              referenceRepoResults: inputs.referenceRepoResults,
              iteration: args.iteration,
            },
            reporter,
          ),
        review: (args) =>
          reviewStep.run(
            context,
            {
              model: resolvedReviewModel,
              diff: args.diff,
              iteration: args.iteration,
              issueTitle: inputs.issueTitle !== undefined ? String(inputs.issueTitle) : undefined,
              issueDescription:
                inputs.issueDescription !== undefined ? String(inputs.issueDescription) : undefined,
              acceptanceBar: args.acceptanceBar,
              reviewRubric: args.reviewRubric,
              installFailed: inputs.installFailed === true,
            },
            reporter,
          ),
        postMortem: (args) =>
          runPostMortem(
            context,
            {
              issueTitle: String(inputs.issueTitle),
              issueDescription: String(inputs.issueDescription),
              diff: args.diff,
              telemetry: args.telemetry,
              maxTurns: effectiveMaxTurns,
              model: resolvedReviewModel,
              iteration: args.iteration,
              parentStepId,
            },
            reporter,
          ),
        getDiff: () => getDiff(workspaceDir),
        isRunDirty: () => isRunDirty(workspaceDir, runStartHead),
        writeCycleSummary: (input) => {
          writeCycleSummary(workspaceDir, input);
        },
        report: (step) => reporter.report(step),
        sleep,
        now: () => new Date().toISOString(),
        warn: (message) => console.warn(message),
      },
    );
    const feedback = result.finalFeedback;

    if (feedback) {
      try {
        const feedbackDir = join(String(inputs.workspaceDir), "ai-output", "comments");
        mkdirSync(feedbackDir, { recursive: true });
        writeFileSync(join(feedbackDir, "80-reviewer-feedback.md"), feedback, "utf-8");
      } catch (err) {
        console.warn(`[feedback-loop] could not write reviewer feedback file (non-fatal): ${String(err)}`);
      }
    }

    return result;
  },
};