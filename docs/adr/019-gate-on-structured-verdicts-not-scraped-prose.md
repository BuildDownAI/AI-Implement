# ADR 019: gate merges on structured verdicts, not on scraped prose

**Status:** Accepted

**Date:** 2026-09-14

**References:** AII-421 (superseded in part), AII-437, AII-485, AII-499, AII-651, PR #302, PR #371, PR #557, `src/pipeline/review-ledger.ts`, `src/pipeline/steps/post-push-review.ts`

## Context

The post-push gate reads external review findings out of PR comment prose. A reviewer writes
Markdown for a human; `extractGithubActionsClaudeReviewFindings` guesses which sentences are
defects. That guess has now been wrong three times in production, each time blocking a correct
PR:

| Issue | Date | Fix shipped | What it missed |
|---|---|---|---|
| AII-437 | 2026-09-04 | Decoupled the verdict from CI evidence | The extractor itself |
| AII-485 | 2026-09-03 | `isNonFindingBullet`, a start-anchored denylist | Section-level misclassification |
| PR #557 | 2026-09-13 | — | `**Previous blocking issue is fixed correctly.**` opened a blocking section |

On PR #557 the extractor produced eight blocking findings from seven compliments and one
cosmetic nit. One of them was "No security or shell-escaping concerns." The external reviewer's
own closing line said "Ready to merge — no blocking issues found," and nothing read it. The run
burned two fix passes, hit the review cap, and reported `REVIEW_UNAPPROVED` to the tracker
while every check was green.

The denylist has been patched twice and failed a third time. Prose is not a contract, and each
patch only narrows the next misparse.

AII-421 pulled the other way for good reason. On PR #302 the gate approved while a real
`### Blocking` section sat in the review. Its third acceptance criterion — "Approval requires
zero current external findings, regardless of severity label" — is the `!hasExternalFindings`
clause in `post-push-review.ts`. It stops a false approval, and it is exactly what converts a
misparsed compliment into a blocked merge. Both failures are real. They cannot both be fixed by
tuning one parser.

## Decision

**Structured findings gate by default. Prose parsed out of a comment is advisory unless
project reviewer settings explicitly opt that source into gating.**

Three structured sources gate by default:

1. A `review-findings/v1` block emitted by the reviewer (ADR 020).
2. A formal review state of `CHANGES_REQUESTED`. This comes from the forge's own review API,
   not from prose, so no parser can corrupt it.
3. An internal reviewer, whose output is schema-validated in-process.

Prose scraped from a comment body is collected, shown on the PR, and recorded in the step log —
but by default it cannot hold a merge. A repository may opt its scraped findings back into gating through
its project settings, for a reviewer it trusts and cannot change.

This supersedes AII-421's third acceptance criterion. Its other criteria stand, including
"ambiguous or malformed review output fails closed."

## Alternatives considered

- **Fix the parser again.** A fourth patch to the denylist. Rejected: three attempts, three
  recurrences, and each fix is a guess about prose a model will write differently next week.
  The failure mode is silent and costs a full run each time.
- **Keep every finding gating and make the reviewer write better prose.** Rejected: the prose
  is already correct. PR #557's reviewer said "Ready to merge." The defect is on the reading
  side, and we do not control what a client's Codex reviewer writes.
- **Drop prose scraping entirely and require the contract.** Rejected: a client running an
  existing reviewer emits no contract, and their review would vanish silently. Advisory keeps
  it visible while it migrates.
- **Gate on prose only when the reviewer is on an allowlist.** Rejected: authorship says
  nothing about whether the parse was right. PR #557's misparse came from an allowlisted
  author.

## Consequences

- The PR #302 false approval becomes reachable again for a reviewer that posts comment prose
  and no formal review. This is the accepted cost. It is bounded by the default internal reviewer selection,
  explicit project gating settings (ADR 021), and CI checks, which are unaffected.
- The current `claude-code-action` posts issue comments, not formal reviews, so it contributes
  nothing gating until it emits the contract. The reference emitter closes this gap.
- AII-499 is resolved as a special case: a reviewer reporting that it could not run tests is
  prose, so it can no longer burn a fix pass.
- `dedupeIssuesAgainstExternalFindings` and the `!hasExternalFindings` clause collapse into one
  predicate over one findings list, keyed by source and severity.
- A misparse now degrades to noise in a comment. The blast radius of the next parser defect is
  a confusing comment, not a failed run.
