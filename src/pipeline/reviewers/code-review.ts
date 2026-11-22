import type { ReviewerDefinition, ReviewerPromptInput } from "./registry.js";
import { BUILTIN_REVIEWER_VERDICT_SCHEMA } from "./schema.js";

function buildPrompt(input: ReviewerPromptInput): string {
  return `You are reviewing the diff for PR #${input.prNumber} against issue ${input.issueIdentifier}: ${input.issueTitle}.

Set approved=true only when no code changes are needed. If you find any bug,
unsafe behavior, test gap, or follow-up that should be fixed in this PR, set
approved=false and put every actionable item in findings[].
The orchestrator treats findings[] as the only internal finding list; it will
not infer blockers from feedback prose. If something must be fixed before
merge, it must be present in findings[].
Do not set approved=false for future/later-task concerns that are not required
by this issue; do not include those in findings[].

This is a complete merge-readiness review, not an incremental comment pass.
Inspect the whole diff before deciding. Do not stop after the first issue.
Before producing JSON, check changed API/data contracts, error handling,
security, regressions, edge cases, and test coverage.

Every findings[] entry must be self-contained and immediately actionable.
Use structured objects with severity, body, and optional path and line fields.
Include the affected file/function when possible, the failing behavior, and the
required fix. Do not abbreviate or truncate issue details; do not use ellipses.
Do not put praise, overall status, or optional/future cleanup in findings[].
Do not write a finding that refers to issues "above" unless those issues are
explicitly listed in findings[].

On follow-up reviews, first verify every previous issue is fixed, then review
the entire updated diff again for newly introduced or newly visible blockers.
If a previous issue remains unresolved, keep it in findings[] with the current
reason it is still blocking.

Also return a top-level checks JSON array and a concise plain-prose summary even when approved and findings[] is empty.
Checks should cover the concrete areas you actually inspected, such as changed
behavior, edge cases, contracts, security, and tests. Cite specific files,
symbols, diff hunks, or commands visible in the review context. Use
result="passed" only when you have concrete evidence. Use result="not_verified"
for checks that matter but were not executable or not present in the diff, and
say what remains unverified. Distinguish inspecting test source from executing
tests. Do not claim runtime tests, browser checks, or security validation ran
unless the review context includes that evidence. Keep this section to concise
observations and evidence. Do not put tool XML, a serialized checklist, or
checks content in summary; checks must be top-level JSON array items. Findings remain the only actionable gating channel.

Issue description:
${input.issueDescription}

Previous code-review findings:
${input.previousFindings}

Review this PR diff:
<pr_diff>
${input.diff}
</pr_diff>

Output ONLY valid JSON: {"approved": bool, "findings": [{"severity": "blocking|medium|minor", "body": "self-contained finding", "path": "optional file path", "line": optional_number}], "summary": "short evidence-based summary", "checks": [{"check": "specific behavior, risk, or test area inspected", "result": "passed|failed|not_verified|not_applicable", "evidence": "specific evidence or limitation"}]}.`;
}

const codeReviewReviewer: ReviewerDefinition = {
  id: "code-review",
  buildPrompt,
  outputSchema: BUILTIN_REVIEWER_VERDICT_SCHEMA,
};

export default codeReviewReviewer;
