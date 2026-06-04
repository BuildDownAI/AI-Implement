import { spawnSync } from "node:child_process";
import type { PipelineContext, Step, StepModule, StepReporter } from "../types.js";
import { implementStep } from "./implement.js";
import { reviewStep } from "./review.js";

const DEFAULT_MAX_ITERATIONS = 3;
const DEFAULT_MODEL = "claude-sonnet-4-6";

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

interface FeedbackLoopOutputs extends Record<string, unknown> {
  approved: boolean;
  iterations: number;
  finalFeedback: string;
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

    while (iteration < effectiveMaxIterations && !approved) {
      iteration++;

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
          planningContext: inputs.planningContext,
        },
        outputs: {},
        logs_url: null,
      };
      await reporter.report(implementSubStep);

      try {
        const implementOutputs = await implementStep.run(
          context,
          {
            workspaceDir: String(inputs.workspaceDir),
            prompt: implementPrompt,
            model: resolvedImplementModel,
            maxTurns: effectiveMaxTurns,
            planningContext:
              inputs.planningContext !== undefined ? String(inputs.planningContext) : undefined,
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

      const diff = getDiff(String(inputs.workspaceDir));

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
          },
          reporter,
        );
        reviewSubStep.status = "passed";
        reviewSubStep.ended_at = new Date().toISOString();
        reviewSubStep.outputs = reviewOutputs;
        await reporter.report(reviewSubStep);

        approved = reviewOutputs.approved;
        feedback = reviewOutputs.feedback;
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
          `[feedback-loop] Review step failed on iteration ${iteration}; skipping review and proceeding to push: ${String(err)}`,
        );
        approved = false;
        feedback = `Review step failed and was skipped: ${String(err)}`;
        break;
      }
    }

    return { approved, iterations: iteration, finalFeedback: feedback };
  },
};
