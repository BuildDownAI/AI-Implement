# ADR 020: carry the review-findings contract in a fenced JSON block

**Status:** Accepted

**Date:** 2026-09-14

**References:** AII-276 (superseded), AII-421, AII-651, ADR 019, `src/pipeline/review-ledger.ts`, anthropics/claude-code-action at 9c5ddab

## Context

AII-276 defined a machine-readable verdict as an HTML comment:

```
<!-- claude-review-verdict {"blocking":[...],"minor":[...]} -->
```

`extractVerdictMarkerFindings` reads it, prefers it over every other source, and returns early
when it parses. The contract is sound. It has never once arrived.

The reason is structural, not a prompt failure. Every comment `claude-code-action` posts goes
through `redactSecrets(sanitizeContent(body))` in `src/mcp/github-comment-server.ts`, and
`sanitizeContent` begins with `stripHtmlComments()` — `content.replace(/<!--[\s\S]*?-->/g, "")`.
The marker is deleted before the comment is created. No prompt can survive this. Across PRs 543
to 557 no review comment has ever carried the marker, while the reviewer's own progress
checklist shows it ticking off "Post final review with verdict block." It complied; the action
erased the result.

Tested directly against the action's sanitizer at the pinned commit:

```
HTML comment marker  ->  "Some review prose.\n\n"   (annihilated)
fenced ```json block ->  round-trips intact, verdict = changes_requested
```

Only HTML comments are destroyed. A fenced code block survives every transform the sanitizer
applies.

The forge matters too. The product is moving toward GitLab and Bitbucket. A verdict carried in
a forge-specific primitive — a GitHub check run, a Bitbucket Code Insights report — moves the
coupling rather than removing it, and needs a new publisher per forge.

## Decision

**The review-findings contract is a fenced JSON code block appended to the review comment,
tagged `review-findings`.**

```json review-findings
{
  "schema": "review-findings/v1",
  "verdict": "approve" | "changes_requested" | "incomplete",
  "findings": [
    { "severity": "blocking" | "minor", "body": "...", "path": "src/x.ts", "line": 12 }
  ]
}
```

`verdict` is a first-class field and is read. On PR #557 the reviewer stated "Ready to merge"
in prose and no code looked at it.

Any reviewer that can post a comment can emit this. It needs no credential, no network path to
the orchestrator, and no wrapper action. It is plain Markdown, so it ports to GitLab and
Bitbucket unchanged — and the forge adapter already has to read comments there to ingest human
reviews.

## Alternatives considered

- **Keep the HTML comment.** Rejected: proven impossible for the reviewer we ship. It would
  also hide the verdict from the human reading the PR.
- **Publish to a GitHub check run.** Rejected: forge-specific, and needs a per-forge publisher.
  It also demands permissions a third-party reviewer may not hold.
- **Report findings to the orchestrator over an authenticated callback.** Rejected: it needs an
  inbound credential in every client repository and a publicly reachable orchestrator, to carry
  data the comment already carries. The external reviewer is not part of a dispatched run, so
  no run-scoped token exists to reuse.
- **Read the action's `structured_output`.** Kept, but as the emitter's internal mechanism, not
  as the contract. It is available only to a workflow that wraps the action, so it cannot be
  the surface a third-party reviewer implements.

## Consequences

- `extractVerdictMarkerFindings` keeps its precedence and early return; only its delimiter and
  schema change. This is a parser edit, not a new subsystem.
- The verdict is visible to humans reading the PR. An HTML comment was not. A reader can see
  what the gate will act on.
- A reviewer that writes ` --> ` in a finding body no longer corrupts the block. JSON string
  escaping replaces that hazard.
- The contract is public surface. A schema change after clients adopt it needs a version bump,
  which is why `schema` is a required field.
- AII-276 is superseded. Its check-name matching and non-blocking-findings work stand.
