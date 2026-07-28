---
title: "comment-trigger.yml latent breakage: ai-implement-meta PR-body block dependency"
module: comment-trigger
category: workflow-patterns
date: 2026-07-21
problem_type: latent_dependency
component: workflow_template
severity: high
root_cause: implicit_data_coupling
resolution_type: architecture_change
symptoms:
  - "`comment-trigger.yml` \"Extract PR metadata\" step fails with \"PR body has no ai-implement-meta block\" when the PR was created by a tool or flow that doesn't embed the hidden HTML comment block"
  - "Gap-fill runs triggered by `/ai-implement` comments produce a failed `check-trigger` job rather than dispatching the runner"
  - "The failure is silent from the commenter's perspective — no error is posted back to the PR; the 👍 reaction is added but no run starts"
tags:
  - comment-trigger
  - ai-implement-meta
  - gap-fill
  - webhook
  - envelope
  - dispatch-log
related_components:
  - comment-gapfill-queue
  - workflow-probe
  - run-config
  - webhook-handler
---

# comment-trigger.yml latent breakage: ai-implement-meta PR-body block dependency

## Problem

`comment-trigger.yml` had a hidden coupling to the PR body: its "Extract PR metadata" step parsed a hidden HTML comment block embedded by the orchestrator when it first created the PR:

```html
<!-- ai-implement-meta
issue_id: <id>
issue_identifier: AII-123
issue_title: My issue title
issue_description_b64: <base64>
-->
```

The step `core.setFailed`-ed the entire job if this block was absent:

```js
const m = pr.data.body?.match(/<!--\s*ai-implement-meta([\s\S]*?)-->/);
if (!m) {
  core.setFailed("PR body has no ai-implement-meta block");
  return;
}
```

This was the only source of issue metadata for the gap-fill run. The design assumed every AI-Implement PR would always carry this block.

## Why It Was a Latent Break

- **PR body edits.** A human reviewer who edited the PR description to improve readability, add context, or collapse sections could inadvertently delete the hidden block. Subsequent `/ai-implement` triggers would fail silently.
- **Manual PRs.** A developer who opened a manual PR against an AI-Implement branch (e.g. to apply a quick fix before the gap-fill) would have no meta block, so any `/ai-implement` comment on that PR would fail.
- **Merge tooling.** Auto-merge or PR-update tools that rewrite the body (Dependabot, Renovate, some squash-merge UIs) could strip the block without anyone noticing.
- **The failure was non-obvious.** The `check-trigger` job would fail with a GHA job-level error. The commenter saw a 👍 reaction (added before the failure) but no run ever started. The failure was visible in the Actions tab but not surfaced to the comment thread.

The coupling was invisible in normal operation because the orchestrator's PR creation always embedded the block. The only signal was the infrequent "PR body has no ai-implement-meta block" failure that showed up in the Actions log.

## How the Webhook Path Replaced It

The orchestrator webhook handler (`src/webhook.ts`, `handleIssueCommentWebhook`) eliminates the dependency on the PR body entirely:

1. **Issue metadata from the dispatch log.** When the orchestrator first dispatched the issue, it wrote a row to `dispatch_log` (SQLite, `src/log.ts`) containing the issue ID, identifier, and associated PR URL. When a `/ai-implement` comment arrives via webhook, the handler looks up the dispatch log entry by PR URL or branch name (`findMatchingDispatch`) — no PR body parsing needed.

2. **Capability-gated dispatch.** The handler first probes the target repo's workflow contract (`resolveWorkflowContract`, `src/workflow-probe.ts`). Only envelope-generation repos (those whose `claude-implement.yml` has a `run_config:` input) receive orchestrator-dispatched gap-fill runs. The lookup happens in the orchestrator, which already has the issue data, so the gap-fill dispatch is assembled the same way as an initial implementation dispatch — no out-of-band data channel to the GHA workflow needed.

3. **Atomic enqueue + ack.** The handler enqueues the gap-fill (`enqueueCommentGapfill`, `src/comment-gapfill-queue.ts`) and posts the 👀 reaction in the same request cycle. The poll loop drains the queue. If enqueueing fails, the reaction is not posted (no false acknowledgement).

4. **`comment-trigger.yml` removed by sync.** For repos that migrate to the envelope contract, `Sync workflows` removes `comment-trigger.yml` from the target repo. There is no longer a GHA workflow that could fail due to a missing PR body block — the entire trigger path moves into the orchestrator.

## Recovery for Stuck Gaps

If an operator encounters a gap-fill that failed due to the missing meta block (on a legacy-generation repo that still has `comment-trigger.yml`):

1. Check that the `<!-- ai-implement-meta ... -->` block is present in the PR body. If it was deleted, the orchestrator can re-create it by triggering a new initial dispatch (add/remove the `AI-Implement` label) or by manually re-adding the block with the correct field values from the dispatch log.
2. Re-comment `/ai-implement` once the block is restored.

For envelope-generation repos (after migration), the meta block is irrelevant — the orchestrator webhook never reads the PR body.

## Prevention

- **Migrate to the envelope contract.** Run Sync workflows on any remaining legacy repos. Once migrated, the PR-body coupling is gone.
- **Do not embed machine-readable data in PR bodies.** The meta block pattern is inherently fragile. Any data the runner needs should travel via a controlled channel (dispatch input, env var, callback, or the SQLite dispatch log).
- **Webhook + dispatch log as the canonical comment-trigger path.** The orchestrator already has all issue metadata when it dispatches; the dispatch log is the durable record. Trust the log, not the PR body.
