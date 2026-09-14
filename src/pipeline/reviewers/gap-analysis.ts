import type { ReviewerDefinition, ReviewerPromptInput } from "./registry.js";
import { BUILTIN_REVIEWER_VERDICT_SCHEMA } from "./schema.js";

const GAP_ANALYSIS_MAX_TURNS = 3;

function buildPrompt(input: ReviewerPromptInput): string {
  return `You are reviewing the diff for PR #${input.prNumber} against issue ${input.issueIdentifier}: ${input.issueTitle}.

This is a spec-coverage review only. Read the issue's acceptance criteria and the diff, then answer one question: is any requirement in the issue not implemented in the diff?

Report findings only for:
- A requirement from the issue acceptance criteria that has no implementation in the diff.
- A substantial change in the diff that no requirement in the issue asked for, when that unrequested scope is unambiguous.

Every finding must name the requirement it came from, or state that the change is unrequested scope. Do not report style problems, code defects, security issues, test gaps, performance concerns, maintainability concerns, or future work. Those belong to code-review or later issues, not gap-analysis.

On follow-up reviews, first verify every previous finding is fixed, then review the entire updated diff again for missing requirements or unrequested scope.

Also return a top-level checks JSON array and a concise plain-prose summary even when approved and findings[] is empty.
Each acceptance criterion should have a checks[] item, and include one scope check for clearly
unrequested changes. Each checks[] item must name a concrete acceptance criterion, requested behavior, or scope boundary,
then cite evidence from changed files, symbols, diff hunks, or the issue text. Use result="passed"
only when the diff contains concrete implementation evidence. Use result="not_verified" when the
available diff is insufficient, and explain what was not verified. Distinguish inspecting test
source from executing tests. Do not claim tests were executed or runtime behavior was checked
unless the review context includes that exact evidence. Do not put tool XML, a
serialized checklist, or checks content in summary; checks must be top-level
JSON array items.

Issue description and acceptance criteria:
${input.issueDescription}

Previous gap-analysis findings:
${input.previousFindings}

Review this PR diff:
<pr_diff>
${input.diff}
</pr_diff>

Output ONLY valid JSON: {"approved": bool, "findings": [{"severity": "blocking|medium|minor", "body": "self-contained finding", "path": "optional file path", "line": optional_number}], "summary": "short evidence-based summary", "checks": [{"check": "specific requirement or scope boundary inspected", "result": "passed|failed|not_verified|not_applicable", "evidence": "specific evidence or limitation"}]}.`;
}

const gapAnalysisReviewer: ReviewerDefinition = {
  id: "gap-analysis",
  buildPrompt,
  outputSchema: BUILTIN_REVIEWER_VERDICT_SCHEMA,
  maxTurns: GAP_ANALYSIS_MAX_TURNS,
};

export default gapAnalysisReviewer;
