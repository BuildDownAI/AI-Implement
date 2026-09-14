import type { ReviewerDefinition, ReviewerPromptInput } from "./registry.js";
import { REVIEWER_VERDICT_SCHEMA } from "./schema.js";

const GAP_ANALYSIS_MAX_TURNS = 3;

function buildPrompt(input: ReviewerPromptInput): string {
  return `You are reviewing the diff for PR #${input.prNumber} against issue ${input.issueIdentifier}: ${input.issueTitle}.

This is a spec-coverage review only. Read the issue's acceptance criteria and the diff, then answer one question: is any requirement in the issue not implemented in the diff?

Report findings only for:
- A requirement from the issue acceptance criteria that has no implementation in the diff.
- A substantial change in the diff that no requirement in the issue asked for, when that unrequested scope is unambiguous.

Every finding must name the requirement it came from, or state that the change is unrequested scope. Do not report style problems, code defects, security issues, test gaps, performance concerns, maintainability concerns, or future work. Those belong to code-review or later issues, not gap-analysis.

On follow-up reviews, first verify every previous finding is fixed, then review the entire updated diff again for missing requirements or unrequested scope.

Issue description and acceptance criteria:
${input.issueDescription}

Previous gap-analysis findings:
${input.previousFindings}

Review this PR diff:
<pr_diff>
${input.diff}
</pr_diff>

Output ONLY valid JSON: {"approved": bool, "findings": [{"severity": "blocking|medium|minor", "body": "self-contained finding", "path": "optional file path", "line": optional_number}]}.`;
}

const gapAnalysisReviewer: ReviewerDefinition = {
  id: "gap-analysis",
  buildPrompt,
  outputSchema: REVIEWER_VERDICT_SCHEMA,
  maxTurns: GAP_ANALYSIS_MAX_TURNS,
};

export default gapAnalysisReviewer;
