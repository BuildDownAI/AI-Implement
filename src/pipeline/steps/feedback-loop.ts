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

function getDiff(workspaceDir: string): string {
  const result = spawnSync("git", ["diff", "HEAD"], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return "";
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
    const maxIterations =
      typeof inputs.maxIterations === "number" ? inputs.maxIterations : DEFAULT_MAX_ITERATIONS;

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

    while (iteration < maxIterations && !approved) {
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
        reviewSubStep.status = "failed";
        reviewSubStep.ended_at = new Date().toISOString();
        reviewSubStep.outputs = { error: String(err) };
        await reporter.report(reviewSubStep);
        throw err;
      }
    }

    return { approved, iterations: iteration, finalFeedback: feedback };
  },
};
