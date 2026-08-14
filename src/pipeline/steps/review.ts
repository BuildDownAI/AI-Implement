import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { formatLlmResultDetail } from "../step-utils.js";
import { extractFirstJsonObject } from "../json-extract.js";

interface ReviewInputs extends Record<string, unknown> {
  model?: string;
  diff?: string;
  iteration?: number;
  issueTitle?: string;
  issueDescription?: string;
}

interface ReviewOutputs extends Record<string, unknown> {
  approved: boolean;
  issues: string[];
  score: number;
  progressDelta: number;
  feedback: string;
  tokensUsed: number;
}

interface ReviewJson {
  approved?: boolean;
  issues?: string[];
  score?: number;
  progress_delta?: number;
  feedback?: string;
}

/**
 * Hard cap on diff characters embedded in the review prompt. A regenerated
 * codegen diff can be hundreds of KB; without a cap the prompt exceeds the
 * model's input limit and the whole invocation fails ("Prompt is too long").
 * ~200k chars ≈ 50k tokens, leaving ample headroom in a 200k-token window.
 */
const MAX_REVIEW_DIFF_CHARS = 200_000;

export function capDiff(diff: string): string {
  if (diff.length <= MAX_REVIEW_DIFF_CHARS) return diff;
  const cut = diff.lastIndexOf("\n", MAX_REVIEW_DIFF_CHARS);
  // `> 0` (not `!== -1`) on purpose: fall back to the hard cap both when no
  // newline precedes the boundary (-1) and in the degenerate case where the
  // only one is at index 0, which would otherwise slice to an empty diff.
  const boundary = cut > 0 ? cut : MAX_REVIEW_DIFF_CHARS;
  return `${diff.slice(0, boundary)}\n\n... [diff truncated: showing first ${boundary} of ${diff.length} characters] ...`;
}

const REVIEW_PROMPT = (
  issueTitle: string | undefined,
  issueDescription: string | undefined,
  diff: string | undefined,
  iteration: number,
) => {
  let prompt = `Review the implementation against the issue requirements. This is review iteration ${iteration}.`;

  if (issueTitle) prompt += `\n\nIssue: ${issueTitle}`;
  if (issueDescription) prompt += `\n\nDescription:\n${issueDescription}`;
  if (diff) prompt += `\n\n## Implementation Diff\n\`\`\`diff\n${capDiff(diff)}\n\`\`\``;

  prompt += `\n\nRespond with a JSON object only:
{
  "approved": true | false,
  "issues": ["<issue 1>", "<issue 2>"],
  "score": <0-100 quality score>,
  "progress_delta": <0-100 percentage of issue addressed>,
  "feedback": "<concise reviewer notes>"
}`;

  return prompt;
};

export const reviewStep: StepModule<ReviewInputs, ReviewOutputs> = {
  async run(
    context: PipelineContext,
    inputs: ReviewInputs,
    _reporter: StepReporter,
  ): Promise<ReviewOutputs> {
    const { model, diff, issueTitle, issueDescription } = inputs;
    const iteration = typeof inputs.iteration === "number" ? inputs.iteration : 1;

    const prompt = REVIEW_PROMPT(issueTitle, issueDescription, diff, iteration);

    const result = await context.llmExecutor.invoke({
      prompt,
      model: model ?? "claude-sonnet-5",
    });

    if (result.exitCode !== 0) {
      throw new Error(`Review LLM invocation failed with exit code ${result.exitCode}${formatLlmResultDetail(result)}`);
    }

    let approved = false;
    let issues: string[] = [];
    let score = 0;
    let progressDelta = 0;
    let feedback = "";

    try {
      const parsed = extractFirstJsonObject(result.stdout);
      if (parsed) {
        const json = parsed as ReviewJson;
        approved = json.approved ?? false;
        issues = Array.isArray(json.issues) ? json.issues : [];
        score = typeof json.score === "number" ? json.score : 0;
        progressDelta = typeof json.progress_delta === "number" ? json.progress_delta : 0;
        feedback = json.feedback ?? "";
      } else {
        feedback = result.stdout.trim();
      }
    } catch {
      feedback = result.stdout.trim();
    }

    return { approved, issues, score, progressDelta, feedback, tokensUsed: result.tokensUsed };
  },
};
