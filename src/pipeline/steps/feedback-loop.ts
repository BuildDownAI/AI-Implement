import { spawnSync } from "node:child_process";
import type { PipelineContext, Step, StepModule, StepReporter, RunTelemetry } from "../types.js";
import { implementStep } from "./implement.js";
import { reviewStep } from "./review.js";
import { READ_ONLY_ALLOWED_TOOLS } from "./read-only-tools.js";
import { capDiff } from "./review.js";

const DEFAULT_MAX_ITERATIONS = 3;
const DEFAULT_MODEL = "claude-sonnet-4-6";

const ACCEPTANCE_BAR_HEADER = "## ✅ AI Planning: Acceptance Bar";
const MAP_HEADER = "## 🗺 AI Planning: Implementation Map";

function extractSection(text: string, header: string): string | undefined {
  const startIdx = text.indexOf(header);
  if (startIdx === -1) return undefined;
  const afterStart = startIdx + header.length;
  const nextHeaderIdx = text.indexOf("\n## ", afterStart);
  const sectionEnd = nextHeaderIdx !== -1 ? nextHeaderIdx : text.length;
  return text.slice(startIdx, sectionEnd).trim();
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
  implementationPrompt?: string;
  parentStepId?: string;
}

export type TerminationReason = "approved" | "iterations_exhausted" | "review_error" | "max_turns";

export interface PassStat extends Record<string, unknown> {
  iteration: number;
  implementTurns: number | null;
  implementOutcome: string;   // RunTelemetry outcome or "unknown"
  costUsd: number | null;
  reviewApproved: boolean | null; // null when review never ran on this pass
}

interface FeedbackLoopOutputs extends Record<string, unknown> {
  approved: boolean;
  iterations: number;
  finalFeedback: string;
  terminationReason: TerminationReason;
  passes: PassStat[];
  postMortem?: string;
}

function buildImplementPrompt(
  issueTitle: string,
  issueDescription: string,
  reviewFeedback: string | undefined,
  issueIdentifier: string,
  implementationPrompt?: string,
): string {
  const basePrompt =
    implementationPrompt && implementationPrompt.trim()
      ? implementationPrompt
      : `Implement the following issue.\n\nTitle: ${issueTitle}\n\nDescription:\n${issueDescription}`;

  if (reviewFeedback) {
    return `${basePrompt}\n\n## Reviewer Feedback\n\nYou previously attempted to implement ${issueIdentifier}: ${issueTitle}.\n\nReviewer feedback:\n${reviewFeedback}\n\nPlease address the feedback and improve the implementation.`;
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
  // Mark all untracked files as "intent to add" so git diff HEAD includes them
  // as new-file additions. Without this, untracked files (e.g. newly created
  // .mcp.json, .claude/settings.json) are invisible to the diff and the reviewer
  // falsely rejects the implementation as "uncommitted". The push step runs
  // git add -A unconditionally, so leaving intent-to-add markers is harmless.
  spawnSync("git", ["add", "-N", "."], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const result = spawnSync(
    "git",
    ["diff", "HEAD", "--", ".", ...REVIEW_DIFF_EXCLUDES],
    {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    // A non-zero exit means the reviewer sees an empty diff and may spuriously
    // approve. Behaviour is unchanged (still return ""), but surface it so the
    // failure is observable in the runner logs rather than silent.
    console.warn(
      `[getDiff] git diff failed (exit ${result.status ?? "null"}): ${result.stderr?.toString().trim() ?? ""}`,
    );
    return "";
  }
  return result.stdout.toString();
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
  try {
    const result = await context.llmExecutor.invoke({
      prompt: buildPostMortemPrompt(params),
      model: params.model,
      maxTurns: POST_MORTEM_MAX_TURNS,
      tools: READ_ONLY_ALLOWED_TOOLS,
    });
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      throw new Error(`post-mortem invocation exited ${result.exitCode}`);
    }
    subStep.status = "passed";
    subStep.ended_at = new Date().toISOString();
    subStep.outputs = { length: result.stdout.length };
    await reporter.report(subStep);
    return result.stdout.trim();
  } catch (err) {
    subStep.status = "failed";
    subStep.ended_at = new Date().toISOString();
    subStep.outputs = { error: String(err) };
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
    let terminationReason: TerminationReason = "iterations_exhausted";
    const passes: PassStat[] = [];
    let postMortem: string | undefined;

    const rawPlanningContext =
      inputs.planningContext !== undefined ? String(inputs.planningContext) : undefined;
    const { acceptanceBar, mapSection } = splitPlanningContext(rawPlanningContext ?? "");
    const isNewFormatContext = acceptanceBar !== undefined || mapSection !== undefined;

    while (iteration < effectiveMaxIterations && !approved) {
      iteration++;

      const implementPlanningContext =
        isNewFormatContext && iteration > 1 ? mapSection : rawPlanningContext;

      const implementPrompt = buildImplementPrompt(
        String(inputs.issueTitle),
        String(inputs.issueDescription),
        feedback || undefined,
        context.data.issueIdentifier,
        inputs.implementationPrompt !== undefined ? String(inputs.implementationPrompt) : undefined,
      );

      // --- implement sub-step ---
      const implementSubStep: Step = {
        id: `implement.${iteration}`,
        type: "implement",
        status: "running",
        started_at: new Date().toISOString(),
        ended_at: null,
        parent_step_id: parentStepId,
        inputs: {
          workspaceDir: inputs.workspaceDir,
          prompt: implementPrompt,
          model: resolvedImplementModel,
          maxTurns: effectiveMaxTurns,
          planningContext: implementPlanningContext,
        },
        outputs: {},
        logs_url: null,
      };
      await reporter.report(implementSubStep);

      let implementOutputs: Awaited<ReturnType<typeof implementStep.run>>;
      try {
        implementOutputs = await implementStep.run(
          context,
          {
            workspaceDir: String(inputs.workspaceDir),
            prompt: implementPrompt,
            model: resolvedImplementModel,
            maxTurns: effectiveMaxTurns,
            planningContext: implementPlanningContext,
          },
          reporter,
        );
        implementSubStep.status = "passed";
        implementSubStep.ended_at = new Date().toISOString();
        implementSubStep.outputs = implementOutputs;
        await reporter.report(implementSubStep);
      } catch (err) {
        implementSubStep.status = "failed";
        implementSubStep.ended_at = new Date().toISOString();
        implementSubStep.outputs = { error: String(err) };
        await reporter.report(implementSubStep);
        throw err;
      }

      const implementTelemetry = implementOutputs.telemetry as RunTelemetry | undefined;
      const pass: PassStat = {
        iteration,
        implementTurns: implementTelemetry?.numTurns ?? null,
        implementOutcome: implementTelemetry?.outcome ?? "unknown",
        costUsd: implementTelemetry?.costUsd ?? null,
        reviewApproved: null,
      };
      passes.push(pass);

      const diff = getDiff(String(inputs.workspaceDir));

      // Hard max_turns: the pass ran out of budget mid-work. Reviewing or
      // re-implementing an over-scoped task just burns more passes — stop,
      // post-mortem where the turns went, and let the pipeline open a draft PR.
      if (implementTelemetry?.outcome === "max_turns") {
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

      // --- review sub-step ---
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
          },
          reporter,
        );
        reviewSubStep.status = "passed";
        reviewSubStep.ended_at = new Date().toISOString();
        reviewSubStep.outputs = reviewOutputs;
        await reporter.report(reviewSubStep);

        approved = reviewOutputs.approved;
        feedback = reviewOutputs.feedback;
        pass.reviewApproved = reviewOutputs.approved;
        if (approved) terminationReason = "approved";
      } catch (err) {
        // A review failure (e.g. "Prompt is too long", a transient API error)
        // is NOT actionable feedback and must not discard a successful
        // implementation. Record the failure, stop the loop, and let the
        // pipeline push the working tree — retrying implementation would only
        // burn another pass producing the same un-reviewable diff.
        reviewSubStep.status = "failed";
        reviewSubStep.ended_at = new Date().toISOString();
        reviewSubStep.outputs = { error: String(err) };
        await reporter.report(reviewSubStep);
        console.warn(
          `[feedback-loop] Review step failed on iteration ${iteration}; stopping the loop — the pipeline will push the working tree as a draft PR: ${String(err)}`,
        );
        approved = false;
        feedback = `Review step failed and was skipped: ${String(err)}`;
        terminationReason = "review_error";
        break;
      }
    }

    if (!approved) {
      console.warn(
        `[feedback-loop] exited without approval (${terminationReason}) after ${iteration}/${effectiveMaxIterations} iteration(s). Final feedback: ${feedback || "(none)"}`,
      );
    }
    return { approved, iterations: iteration, finalFeedback: feedback, terminationReason, passes, ...(postMortem ? { postMortem } : {}) };
  },
};
