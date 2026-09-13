import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PipelineContext, Step, StepModule, StepReporter, RunTelemetry } from "../types.js";
import { implementStep } from "./implement.js";
import type { ReferenceRepoResult } from "../../reference-repos.js";
import { reviewStep } from "./review.js";
import { READ_ONLY_ALLOWED_TOOLS } from "./read-only-tools.js";
import { capDiff } from "./review.js";
import { wrapWithPlanningGuard } from "../../planning-context-assembly.js";
import { classifyThrown, type FailureRecord } from "../failure-classification.js";
import { computeBackoffMs, normalizeRetryPolicy } from "../retry-backoff.js";

const DEFAULT_MAX_ITERATIONS = 3;
const DEFAULT_MODEL = "claude-sonnet-5";

const ACCEPTANCE_BAR_HEADER = "## ✅ AI Planning: Acceptance Bar";
const MAP_HEADER = "## 🗺 AI Planning: Implementation Map";

// All recognised planning-section headers. A section ends only when one of
// these appears, so internal subheadings (e.g. "## Files" inside the Map) do
// not split the section prematurely.
const PLANNING_HEADERS = [
  "## 🏗️ AI Planning: Architecture Analysis",
  "## 🧪 AI Planning: Test Plan",
  "## 🔗 AI Planning: Cross-Story Context",
  "## 🗺 AI Planning: Implementation Map",
  "## ✅ AI Planning: Acceptance Bar",
  "## ⚠️ AI Planning: Risks & Open Questions",
];

function extractSection(text: string, header: string): string | undefined {
  const startIdx = text.indexOf(header);
  if (startIdx === -1) return undefined;
  const afterStart = startIdx + header.length;
  let sectionEnd = text.length;
  for (const h of PLANNING_HEADERS) {
    if (h === header) continue;
    const idx = text.indexOf(h, afterStart);
    if (idx !== -1 && idx < sectionEnd) sectionEnd = idx;
  }
  // Strip planning_context wrapper tags that appear when this is the last section,
  // then strip the trailing "---" separator from the "\n\n---\n\n" join format.
  return text
    .slice(startIdx, sectionEnd)
    .replace(/<\s*\/?\s*planning_context\s*>/gi, "")
    .trim()
    .replace(/\n\n---\s*$/, "")
    .trim();
}

export function splitPlanningContext(planningContext: string): {
  acceptanceBar: string | undefined;
  mapSection: string | undefined;
} {
  return {
    acceptanceBar: extractSection(planningContext, ACCEPTANCE_BAR_HEADER),
    mapSection: extractSection(planningContext, MAP_HEADER),
  };
}

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
}

export type TerminationReason =
  | "approved"
  | "iterations_exhausted"
  | "review_error"
  | "max_turns"
  | "provider_unavailable";

export interface PassStat extends Record<string, unknown> {
  iteration: number;
  implementTurns: number | null;
  implementOutcome: string;   // RunTelemetry outcome or "unknown"
  costUsd: number | null;
  reviewCostUsd: number | null; // null when review never ran, or ran without telemetry, on this pass
  reviewApproved: boolean | null; // null when review never ran on this pass
  tokensIn?: number | null;
  tokensOut?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  /** Spawn attempts the implement call made for this pass (>1 only under a retried transient failure). */
  attempts?: number;
  /** Spawn attempts the review call made for this pass, when review ran (>1 only under a retried transient failure). */
  reviewAttempts?: number;
}

interface FeedbackLoopOutputs extends Record<string, unknown> {
  approved: boolean;
  iterations: number;
  finalFeedback: string;
  terminationReason: TerminationReason;
  passes: PassStat[];
  postMortem?: string;
  /** Set only for terminationReason "provider_unavailable" — the classified failure the
   *  runner callback reports through `postRunnerResult`/`formatFailureComment`. */
  failure?: FailureRecord;
  /** Sum of every superseded implement/review retry attempt's cost — never reflected in
   *  `passes`, which only carries the attempt that ultimately settled each stage. Mirrors
   *  report-card.ts's extraCostUsd `.retry` rows so the ticket-facing total (run-autonomous.ts)
   *  can agree with the report card (BAC-27201). */
  extraCostUsd: number | null;
}

function addExtraCost(a: number | null, b: number | null | undefined): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

function buildImplementPrompt(
  issueTitle: string,
  issueDescription: string,
  reviewFeedback: string | undefined,
  reviewIssues: string[],
  issueIdentifier: string,
  implementationPrompt?: string,
): string {
  const basePrompt =
    implementationPrompt && implementationPrompt.trim()
      ? implementationPrompt
      : `Implement the following issue.\n\nTitle: ${issueTitle}\n\nDescription:\n${issueDescription}`;

  if (reviewFeedback || reviewIssues.length > 0) {
    const issueBlock =
      reviewIssues.length > 0
        ? `\n\nReviewer issues:\n${reviewIssues.map((issue, index) => `${index + 1}. ${issue}`).join("\n")}`
        : "";
    return `${basePrompt}\n\n## Reviewer Feedback\n\nYou previously attempted to implement ${issueIdentifier}: ${issueTitle}.${issueBlock}\n\nReviewer feedback:\n${reviewFeedback ?? "(none)"}\n\nPlease address every listed issue and use the feedback for context.`;
  }
  return basePrompt;
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

const IMPLEMENT_CONTINUATION_NOTE =
  "A previous attempt was interrupted by a provider error. The working tree contains its partial changes. Continue from the current state; do not revert it.";

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
      tools: READ_ONLY_ALLOWED_TOOLS,
      stage: `feedback-loop/post-mortem-${params.iteration}`,
      expectsStructuredOutput: false,
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

    let iteration = 0;
    let approved = false;
    let feedback = "";
    let reviewIssues: string[] = [];
    let terminationReason: TerminationReason = "iterations_exhausted";
    const passes: PassStat[] = [];
    let postMortem: string | undefined;
    let failureForOutputs: FailureRecord | undefined;
    // Sum of every superseded implement/review retry attempt's cost — real spend that a
    // pass's own costUsd/reviewCostUsd never carries, since those reflect only the attempt
    // that ultimately settled the stage. Mirrors report-card.ts's extraCostUsd `.retry` rows
    // so the ticket-facing total can agree with the report card (BAC-27201).
    let extraCostUsd: number | null = null;
    const retryPolicy = normalizeRetryPolicy(context.data.retryPolicy);
    const sleep =
      inputs.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    // Captured once for the whole run (BAC-27134), not per-pass — see isRunDirty.
    const runStartHead = resolveHeadSha(String(inputs.workspaceDir));

    const rawPlanningContext =
      inputs.planningContext !== undefined ? String(inputs.planningContext) : undefined;
    const { acceptanceBar, mapSection } = splitPlanningContext(rawPlanningContext ?? "");
    const isNewFormatContext = acceptanceBar !== undefined || mapSection !== undefined;

    while (iteration < effectiveMaxIterations && !approved) {
      iteration++;

      // On retries with new-format context, send only the map section — but
      // re-wrap it with the untrusted-data guard so the security preamble is
      // never dropped. Fall back to the full rawPlanningContext when mapSection
      // is absent (partial planning output) rather than sending undefined.
      const implementPlanningContext =
        isNewFormatContext && iteration > 1
          ? mapSection !== undefined
            ? wrapWithPlanningGuard(mapSection)
            : rawPlanningContext
          : rawPlanningContext;

      const implementPrompt = buildImplementPrompt(
        String(inputs.issueTitle),
        String(inputs.issueDescription),
        feedback || undefined,
        reviewIssues,
        context.data.issueIdentifier,
        inputs.implementationPrompt !== undefined ? String(inputs.implementationPrompt) : undefined,
      );

      // --- implement sub-step (stage-level retry on a transient failure, BAC-27134) ---
      let currentImplementPrompt = implementPrompt;
      let implementStageAttempt = 0;
      let implementAttemptsTotal = 0;
      let implementOutputs: Awaited<ReturnType<typeof implementStep.run>> | undefined;
      let implementProviderUnavailable: FailureRecord | undefined;
      let implementProviderUnavailableTelemetry: RunTelemetry | undefined;

      for (;;) {
        implementStageAttempt++;
        const implementSubStep: Step = {
          id: `implement.${iteration}`,
          type: "implement",
          status: "running",
          started_at: new Date().toISOString(),
          ended_at: null,
          parent_step_id: parentStepId,
          inputs: {
            workspaceDir: inputs.workspaceDir,
            prompt: currentImplementPrompt,
            model: resolvedImplementModel,
            maxTurns: effectiveMaxTurns,
            planningContext: implementPlanningContext,
            referenceRepoResults: inputs.referenceRepoResults,
          },
          outputs: {},
          logs_url: null,
        };
        await reporter.report(implementSubStep);

        try {
          const outputs = await implementStep.run(
            context,
            {
              workspaceDir: String(inputs.workspaceDir),
              prompt: currentImplementPrompt,
              model: resolvedImplementModel,
              maxTurns: effectiveMaxTurns,
              planningContext: implementPlanningContext,
              referenceRepoResults: inputs.referenceRepoResults,
            },
            reporter,
          );
          implementSubStep.status = "passed";
          implementSubStep.ended_at = new Date().toISOString();
          implementSubStep.outputs = outputs;
          await reporter.report(implementSubStep);
          implementAttemptsTotal += outputs.attempts ?? 1;
          implementOutputs = outputs;
          break;
        } catch (err) {
          implementSubStep.status = "failed";
          implementSubStep.ended_at = new Date().toISOString();
          const implementStage = `feedback-loop/implement-${iteration}`;
          // Re-stamp `stage`: classifyThrown() passes an already-attached record
          // (from the executor's classifyLlmResult, surfaced onto the thrown error by
          // implementStep) through unchanged, which would otherwise leave the
          // iteration-qualified stage never applied.
          const implementFailure = { ...classifyThrown(err, { stage: implementStage, attempt: 1 }), stage: implementStage };
          // implement.ts (and the executor, for a spawn-level rejection) stamps
          // `err.telemetry` when every attempt fails — surface it on the failed
          // sub-step report too, or the tokens/cost that attempt burned are lost
          // from the run's evidence entirely rather than merely absent from PassStat.
          const implementErrTelemetry =
            typeof err === "object" && err !== null ? (err as { telemetry?: RunTelemetry }).telemetry : undefined;
          const isTransient = implementFailure.category === "transient";
          const willRetryImplement = isTransient && implementStageAttempt <= retryPolicy.stageRetries;
          // A retried attempt's failure must not overwrite the canonical `implement.{iteration}`
          // row — that id is reserved for the final attempt (BAC-27134's "keep every attempt's
          // evidence"), so a retried attempt's failure record and telemetry are preserved under
          // their own id instead of being clobbered by the next attempt's "running" report.
          if (willRetryImplement) {
            implementSubStep.id = `implement.${iteration}.retry${implementStageAttempt}`;
            extraCostUsd = addExtraCost(extraCostUsd, implementErrTelemetry?.costUsd);
          }
          implementSubStep.outputs = {
            error: String(err),
            failure: implementFailure,
            ...(implementErrTelemetry ? { telemetry: implementErrTelemetry } : {}),
          };
          await reporter.report(implementSubStep);
          if (typeof err === "object" && err !== null) {
            try {
              (err as Record<string, unknown>).failure = implementFailure;
            } catch {
              // err may be frozen/non-extensible — losing the attached record here
              // must not turn this catch path itself into a thrown TypeError.
            }
          }
          implementAttemptsTotal += implementFailure.attempt;

          if (willRetryImplement) {
            const dirtyForRetry = isRunDirty(String(inputs.workspaceDir), runStartHead);
            await sleep(computeBackoffMs(implementStageAttempt, retryPolicy));
            currentImplementPrompt = dirtyForRetry
              ? `${implementPrompt}\n\n${IMPLEMENT_CONTINUATION_NOTE}`
              : implementPrompt;
            continue;
          }

          if (isTransient) {
            const providerUnavailableFailure: FailureRecord = {
              ...implementFailure,
              stage: "implement",
              code: "PROVIDER_UNAVAILABLE",
              // Exhausted the stage-retry budget: this record is terminal, matching the
              // convention push.ts's GIT_PUSH_RETRIES_EXHAUSTED states — an orchestrator
              // rail keying off `retryable` must not re-dispatch a run that already spent
              // its whole stage-retry budget.
              retryable: false,
            };
            const dirtyFinal = isRunDirty(String(inputs.workspaceDir), runStartHead);
            if (dirtyFinal) {
              // Partial work survives: stop the loop and let the pipeline push it as a
              // draft PR rather than throwing it away.
              implementProviderUnavailable = providerUnavailableFailure;
              implementProviderUnavailableTelemetry = implementErrTelemetry;
              break;
            }
            // Clean tree: nothing to preserve — fail the run with PROVIDER_UNAVAILABLE.
            if (typeof err === "object" && err !== null) {
              try {
                (err as Record<string, unknown>).failure = providerUnavailableFailure;
              } catch {
                // err may be frozen/non-extensible
              }
            }
            throw err;
          }

          throw err;
        }
      }

      if (implementProviderUnavailable) {
        terminationReason = "provider_unavailable";
        feedback = `Model provider was unavailable during implementation after ${implementStageAttempt} attempt(s); partial changes were preserved. ${implementProviderUnavailable.message}`;
        failureForOutputs = implementProviderUnavailable;
        passes.push({
          iteration,
          implementTurns: implementProviderUnavailableTelemetry?.numTurns ?? null,
          implementOutcome: "error",
          costUsd: implementProviderUnavailableTelemetry?.costUsd ?? null,
          reviewCostUsd: null,
          reviewApproved: null,
          tokensIn: implementProviderUnavailableTelemetry?.tokensIn ?? null,
          tokensOut: implementProviderUnavailableTelemetry?.tokensOut ?? null,
          cacheReadTokens: implementProviderUnavailableTelemetry?.cacheReadTokens ?? null,
          cacheCreationTokens: implementProviderUnavailableTelemetry?.cacheCreationTokens ?? null,
          attempts: implementAttemptsTotal,
        });
        break;
      }

      if (!implementOutputs) {
        throw new Error("[feedback-loop] implement stage ended without outputs or a provider-unavailable failure");
      }

      const implementTelemetry = implementOutputs.telemetry as RunTelemetry | undefined;
      const pass: PassStat = {
        iteration,
        implementTurns: implementTelemetry?.numTurns ?? null,
        implementOutcome: implementTelemetry?.outcome ?? "unknown",
        costUsd: implementTelemetry?.costUsd ?? null,
        reviewCostUsd: null,
        reviewApproved: null,
        tokensIn: implementTelemetry?.tokensIn ?? null,
        tokensOut: implementTelemetry?.tokensOut ?? null,
        cacheReadTokens: implementTelemetry?.cacheReadTokens ?? null,
        cacheCreationTokens: implementTelemetry?.cacheCreationTokens ?? null,
        attempts: implementAttemptsTotal,
      };
      passes.push(pass);

      const diff = getDiff(String(inputs.workspaceDir));

      // Hard max_turns: the pass ran out of budget mid-work. Reviewing or
      // re-implementing an over-scoped task just burns more passes — stop,
      // post-mortem where the turns went, and let the pipeline open a draft PR.
      //
      // The CLI's error_max_turns subtype (outcome === "max_turns") is the ONLY
      // authoritative signal. Do NOT also compare telemetry.numTurns against the
      // configured cap: result.num_turns counts conversation MESSAGES, not the
      // agent turns --max-turns bounds — this repo's own telemetry fixture pins a
      // real production run reporting subtype "success" at num_turns 104 under
      // the default 50-turn cap (7b74bf6). A numTurns comparison falsely fails
      // successful passes: review skipped, draft PR, MAX_TURNS_EXHAUSTED.
      if (implementTelemetry && implementTelemetry.outcome === "max_turns") {
        terminationReason = "max_turns";
        feedback = `Implementation hit the ${effectiveMaxTurns}-turn cap before completing (${implementTelemetry.numTurns ?? "?"} turns used).`;
        postMortem =
          (await runPostMortem(
            context,
            {
              issueTitle: String(inputs.issueTitle),
              issueDescription: String(inputs.issueDescription),
              diff,
              telemetry: implementTelemetry,
              maxTurns: effectiveMaxTurns,
              model: resolvedReviewModel,
              iteration,
              parentStepId,
            },
            reporter,
          )) ?? undefined;
        break;
      }

      // --- review sub-step (stage-level retry on a transient failure, BAC-27134) ---
      const reviewRubric = inputs.reviewRubric !== undefined ? String(inputs.reviewRubric) : undefined;
      let reviewStageAttempt = 0;
      let reviewAttemptsTotal = 0;
      let reviewStageFailed = false;

      for (;;) {
        reviewStageAttempt++;
        const reviewSubStep: Step = {
          id: `review.${iteration}`,
          type: "review",
          status: "running",
          started_at: new Date().toISOString(),
          ended_at: null,
          parent_step_id: parentStepId,
          inputs: {
            model: resolvedReviewModel,
            diff,
            iteration,
            issueTitle: inputs.issueTitle,
            issueDescription: inputs.issueDescription,
            acceptanceBar,
            ...(reviewRubric ? { reviewRubric } : {}),
          },
          outputs: {},
          logs_url: null,
        };
        await reporter.report(reviewSubStep);

        try {
          const reviewOutputs = await reviewStep.run(
            context,
            {
              model: resolvedReviewModel,
              diff,
              iteration,
              issueTitle: inputs.issueTitle !== undefined ? String(inputs.issueTitle) : undefined,
              issueDescription:
                inputs.issueDescription !== undefined ? String(inputs.issueDescription) : undefined,
              acceptanceBar,
              reviewRubric,
            },
            reporter,
          );
          reviewSubStep.status = "passed";
          reviewSubStep.ended_at = new Date().toISOString();
          reviewSubStep.outputs = reviewOutputs;
          await reporter.report(reviewSubStep);

          reviewAttemptsTotal += reviewOutputs.attempts ?? 1;
          approved = reviewOutputs.approved;
          feedback = reviewOutputs.feedback;
          reviewIssues = [...reviewOutputs.issues];
          pass.reviewApproved = reviewOutputs.approved;
          pass.reviewAttempts = reviewAttemptsTotal;
          pass.reviewCostUsd = reviewOutputs.telemetry?.costUsd ?? null;
          if (approved) terminationReason = "approved";
          break;
        } catch (err) {
          // A review failure (e.g. "Prompt is too long", a transient API error)
          // is NOT actionable feedback and must not discard a successful
          // implementation. Record the failure, stop the loop, and let the
          // pipeline push the working tree — retrying implementation would only
          // burn another pass producing the same un-reviewable diff.
          reviewSubStep.status = "failed";
          reviewSubStep.ended_at = new Date().toISOString();
          const reviewStage = `feedback-loop/review-${iteration}`;
          // Re-stamp `stage`: classifyThrown() passes an already-attached record
          // (from the executor's classifyLlmResult, surfaced onto the thrown error by
          // reviewStep) through unchanged, which would otherwise leave the
          // iteration-qualified stage never applied.
          const reviewFailure = { ...classifyThrown(err, { stage: reviewStage, attempt: 1 }), stage: reviewStage };
          const reviewErrTelemetry =
            typeof err === "object" && err !== null ? (err as { telemetry?: RunTelemetry }).telemetry : undefined;
          const isTransient = reviewFailure.category === "transient";
          const willRetryReview = isTransient && reviewStageAttempt <= retryPolicy.stageRetries;
          // A retried attempt's failure must not overwrite the canonical `review.{iteration}`
          // row — see the matching implement-stage comment above (BAC-27134).
          if (willRetryReview) {
            reviewSubStep.id = `review.${iteration}.retry${reviewStageAttempt}`;
            extraCostUsd = addExtraCost(extraCostUsd, reviewErrTelemetry?.costUsd);
          }
          reviewSubStep.outputs = {
            error: String(err),
            failure: reviewFailure,
            ...(reviewErrTelemetry ? { telemetry: reviewErrTelemetry } : {}),
          };
          await reporter.report(reviewSubStep);
          reviewAttemptsTotal += reviewFailure.attempt;

          if (willRetryReview) {
            await sleep(computeBackoffMs(reviewStageAttempt, retryPolicy));
            continue;
          }

          approved = false;
          pass.reviewCostUsd = reviewErrTelemetry?.costUsd ?? null;
          pass.reviewAttempts = reviewAttemptsTotal;
          reviewStageFailed = true;

          if (isTransient) {
            console.warn(
              `[feedback-loop] Review step remained transiently unavailable after ${reviewStageAttempt} attempt(s) on iteration ${iteration}; stopping the loop — the pipeline will push the working tree as a draft PR: ${String(err)}`,
            );
            terminationReason = "provider_unavailable";
            // Terminal: the stage-retry budget is spent (matches push.ts's
            // GIT_PUSH_RETRIES_EXHAUSTED convention) — never retryable.
            failureForOutputs = { ...reviewFailure, stage: "review", code: "PROVIDER_UNAVAILABLE", retryable: false };
            feedback = `Model provider was unavailable during review after ${reviewStageAttempt} attempt(s). ${reviewFailure.message}`;
          } else {
            console.warn(
              `[feedback-loop] Review step failed on iteration ${iteration}; stopping the loop — the pipeline will push the working tree as a draft PR: ${String(err)}`,
            );
            feedback = `Review step failed and was skipped: ${String(err)}`;
            terminationReason = "review_error";
          }
          break;
        }
      }

      if (reviewStageFailed) break;
    }

    if (!approved) {
      console.warn(
        `[feedback-loop] exited without approval (${terminationReason}) after ${iteration}/${effectiveMaxIterations} iteration(s). Final feedback: ${feedback || "(none)"}`,
      );
    }

    if (feedback) {
      try {
        const feedbackDir = join(String(inputs.workspaceDir), "ai-output", "comments");
        mkdirSync(feedbackDir, { recursive: true });
        writeFileSync(join(feedbackDir, "80-reviewer-feedback.md"), feedback, "utf-8");
      } catch (err) {
        console.warn(`[feedback-loop] could not write reviewer feedback file (non-fatal): ${String(err)}`);
      }
    }

    return {
      approved,
      iterations: iteration,
      finalFeedback: feedback,
      terminationReason,
      passes,
      extraCostUsd,
      ...(postMortem ? { postMortem } : {}),
      ...(failureForOutputs ? { failure: failureForOutputs } : {}),
    };
  },
};
