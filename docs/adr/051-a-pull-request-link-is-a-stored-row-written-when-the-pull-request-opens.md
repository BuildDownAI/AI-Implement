# 051. A pull request link is a stored row, written when the pull request opens

**Status:** Accepted
**Date:** 2026-11-17

## Context

The orchestrator found the issue for a pull request through `dispatch_log` rows. Those rows are an operating log, and the prune removes them. After the prune, an open pull request showed as untracked, and a merge did not move its issue to Done. A run that the watchdog stopped could still open a pull request, and no row recorded it.

## Decision

We store the link between an issue and a pull request in two tables, `tracked_issue` and `pull_request_link`, in `src/pr-links.ts`. We write the link when the pull request opens: from the `push` step report, from the run result, and from a poll that matches open pull requests of the App bot by branch name. We never prune these rows by age or count. Each reader that asks "which issue is this pull request for" reads these tables.

## Alternatives considered

- **Derive the link from job rows** — rejected. The link is lost when the rows are pruned, and a longer retention only moves the date.
- **Three generic tables (`work_item`, `change`, and a link table)** — rejected. No code path needs one pull request for many issues; a roll-up pull request belongs to one parent issue. The link table adds a join to each reader.
- **Accept a step report with an expired run nonce** — rejected. It gives a write back to a run that the orchestrator revoked. The branch-name poll covers that case with no new authority.
- **An outbox with acknowledgement for runs and usage** — deferred to AII-1565. It changes the contract with the control plane.

## Consequences

Readers no longer depend on job retention. The branch-name match stays as a permanent second writer, so a branch name that the App bot wrote is trusted as an issue reference. The `source` column shows which writer made each link.
