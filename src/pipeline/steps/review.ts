import type { PipelineContext, StepModule, StepReporter } from "../types.js";

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
 * Scans `text` for balanced `{ ... }` blocks and returns the first one that
 * parses as valid JSON with at least one key. Avoids the greedy-regex pitfall
 * where a preamble containing `{}` causes the regex to match from the first
 * `{` to the last `}`. Empty objects `{}` are skipped as likely preamble noise.
 */
function extractFirstJsonObject(text: string): object | null {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = text.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate) as object;
          // Skip empty objects — they are likely preamble artifacts, not the review JSON.
          if (Object.keys(parsed).length > 0) {
            return parsed;
          }
        } catch {
          // Not valid JSON — keep scanning for the next balanced block.
        }
        start = -1;
      }
    }
  }
  return null;
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
  if (diff) prompt += `\n\n## Implementation Diff\n\`\`\`diff\n${diff}\n\`\`\``;

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
      model: model ?? "claude-sonnet-4-6",
    });

    if (result.exitCode !== 0) {
      throw new Error(`Review LLM invocation failed with exit code ${result.exitCode}${llmResultDetail(result)}`);
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

function llmResultDetail(result: { stdout?: string; stderr?: string }): string {
  const detail = (result.stderr || result.stdout || "").trim();
  return detail ? `: ${detail}` : "";
}
