# Spotter status tools

Spotter reads `list_open_pulls` and `list_issue_statuses` to show pull requests and issue status for an orchestrator. The entry points are [src/open-pulls.ts](../src/open-pulls.ts) and [src/issue-statuses.ts](../src/issue-statuses.ts); [src/restate/tools.ts](../src/restate/tools.ts) declares both as read tools with role `user` and arguments `{}` (the tools API request is `{ "args": {} }`).

The successful result is a top-level JSON array, serialized in the tool response's `content[0].text`; it is not an object wrapping an array. All times are epoch milliseconds. `issue.identifier` joins these entries to `list_in_flight_jobs.issueIdentifier`.

## Open pull requests

[Recorded exchanges: docs/contracts/list_open_pulls/](contracts/list_open_pulls/) cover tracked active, tracked settled, untracked, empty and GitHub-unavailable results.

The tool lists every open PR in every distinct mapped repository, including PRs with no job history. GitHub is the source of membership: finished jobs cannot keep a closed PR in this list. Entries sort by `repo` ascending, then PR number descending.

| Field | Value |
|---|---|
| `teamKey` | Linked issue's mapping key; without a link, the sole mapping key for the repository, or `null` when ambiguous |
| `repo` | `owner/repo` |
| `pr` | `number`, `url`, `headRef`, `baseRef`, `openedAt`, and boolean `draft` |
| `pr.role` | Stored link role: `"implementation"` for an implementation link, `"roll-up"` for a roll-up link; key absent without a link (never `null`) |
| `issue` | `{ identifier, title, url }`, or `null` without a link or when the linked issue identifier is `null`; title and URL can be `null` |
| `lastJob` | `{ phase, status, conclusion, finishedAt }`, or `null`; phase and conclusion can be `null` |
| `tracked` | Whether a pull request link exists |
| `workflow` | Optional `{ state, reason }`; omitted when there is no verdict, never replaced by `null` |

Identity comes from `findLinkByPr(repo, pr.number)` in [src/pr-links.ts](../src/pr-links.ts), which joins `pull_request_link` to `tracked_issue`. A link keeps the PR tracked even when all its job rows have been pruned; dispatch rows and grouping branch names do not provide fallback identity. Workflow receives the linked issue's tracker ID and identifier, and treats the PR as a roll-up only when the link's stored `role` is `roll-up`. It uses the repository mapping matching the linked issue's mapping key; if that key is missing, the mapping is `null`. Only without a link does workflow use the repository's sole mapping, or `null` when ambiguous. `lastJob` independently selects the finished dispatch for the PR URL with the greatest log ID, not the greatest completion timestamp; it is `null` when no finished job exists, even for a tracked PR.

### Workflow rules

[src/open-pull-workflow.ts](../src/open-pull-workflow.ts) is read-only. The first matching row wins, so running or queued work takes precedence over parks and budgets. `active` means work remains; `settled` means the resolver sees no further work under that rule.

| Order | Condition | State | Reason |
|---|---|---|---|
| 1 | No issue identifier and not a roll-up | Omit | — |
| 2 | A `dispatched` or `running` job matches the PR URL, or the issue identifier and repository | `active` | `job-running` |
| 3a | Unfinished review-fix attempt for repository and PR number | `active` | `review-fix-running` |
| 3b | Unreleased dispatch admission for repository and PR number | `active` | `review-fix-running` |
| 4 | Pending review-fix queue row for repository and PR number | `active` | `review-fix-queued` |
| 5 | Pending or dispatched comment gap-fill row for owner, repository and PR number | `active` | `gap-fill-queued` |
| 6 | Late-review row for the PR URL created at or after now minus the 30-minute deadline | `active` | `awaiting-late-review` |
| 7 | Mapping enables auto-merge and is not paused; PR is not draft; base is a grouping branch different from the mapping's default branch; identifier exists; run-record merge verdict is `approved` | `active` | `auto-merge-pending` |
| 8 | Internal issue ID is parked in planning, gap-analysis or implementation | `settled` | `parked` |
| 9 | Mapping exists and PR's gap-analysis dispatch count in the inclusive last 24 hours reaches its resolved PR dispatch budget | `settled` | `budget-exhausted` |
| 10 | Roll-up | `settled` | `awaiting-review` |
| 11 | A finished dispatch exists for the PR URL (greatest log ID) | `settled` | Status mapping below |
| 12 | No earlier match | Omit | — |

Row 11 maps every terminal fallback as follows:

| Finished job status | Reason |
|---|---|
| `completed` | `completed` |
| `review_failed` | `review-failed` |
| `failed` | `failed` |
| `timed_out` | `timed-out` |
| `dispatch-failed` | `dispatch-failed` |
| Any other status | `settled` |

Expired late-review rows are ignored without deleting them.

## Issue statuses

[Recorded exchanges: docs/contracts/list_issue_statuses/](contracts/list_issue_statuses/) cover every normalized state, empty and tracker-unavailable results. The every-state exchange uses a fake provider; it does not mean each tracker emits every state.

| Field | Value |
|---|---|
| `teamKey` | Mapping key |
| `tracker` | Mapping's ticketing kind (`linear`, `jira`, or `filesystem` for built-in providers) |
| `issue` | `{ identifier, title, url }`; title and URL can be `null`; internal tracker ID is not served |
| `state` | `ready`, `planning`, `awaiting-approval`, `plan-approved`, `implementing`, `pr-ready`, `merged`, `failed`, or `unknown` |
| `phase` | `planning`, `implementation`, or `null`; failure phase when known |
| `raw` | `{ labels: string[], workflowState: string \| null }` from the provider |
| `changedAt` | Tracker update time or newer job time, or `null` when neither exists |

Teams are processed alphabetically. Duplicate identifiers keep the alphabetically first team's entry and log a warning. Results sort by team key ascending, then `changedAt` descending with null times last.

### Linear

[src/providers/linear.ts](../src/providers/linear.ts) reads the team's pickup-labelled nonterminal issues plus pickup-labelled issues completed in the last seven days, deduplicated by internal ID. Canceled and duplicate issues are excluded. Completed issues override labels; otherwise the first matching label below wins. Every provider phase is `null`.

| Tracker condition, in precedence order | State |
|---|---|
| Workflow type `completed` | `merged` |
| Orchestrator park record | `failed` |
| Label `Ready for Review` | `pr-ready` |
| Label `AI-Working` | `implementing` |
| Label `Plan-Complete` | `plan-approved` |
| Label `AI-Planning` | `planning` |
| Configured pickup label (default `AI-Implement`) | `ready` |
| No deciding label | `ready` |

For noncompleted issues, the deciding label is first in `raw.labels`, followed by the remaining labels; the fallback uses the pickup label. Completed issues have empty labels. `raw.workflowState` is the workflow name and the update time comes from `updatedAt`. Both queries page 100 at a time, fail beyond 20 pages, and reject a missing or nonadvancing continuation cursor.

### Jira

[src/providers/jira.ts](../src/providers/jira.ts) combines the mapping's JQL with a nonempty AI-Implement status field. `Merged`, `Planning Failed`, and `Implementation Failed` require an update within seven days; other values have no age cutoff. Results must also match the configured repository field value. This is the custom AI-Implement field, rather than Jira's ordinary workflow status.

| AI-Implement status | State | Phase |
|---|---|---|
| `Ready` | `ready` | `null` |
| `Planning` | `planning` | `null` |
| `Awaiting Approval` | `awaiting-approval` | `null` |
| `Plan Approved` | `plan-approved` | `null` |
| `Implementing` | `implementing` | `null` |
| `PR Ready` | `pr-ready` | `null` |
| `Merged` | `merged` | `null` |
| `Planning Failed` | `failed` | `planning` |
| `Implementation Failed` | `failed` | `implementation` |
| Any other value | `unknown` | `null` |

Labels are empty; `raw.workflowState` is the custom field value and the update time comes from Jira's `updated`. Search fails if continuation remains after 20 pages.

### Filesystem

[src/providers/filesystem.ts](../src/providers/filesystem.ts) scans the mapping's tasks. Active-location tasks have no age cutoff; tasks in completed or failed locations need a known update time within seven days. Cancelled tasks are excluded regardless of location. Missing sidecar state defaults to `ready` when planning is enabled, otherwise `plan-approved`, with a null update time.

| Sidecar status | State | Phase |
|---|---|---|
| `ready` | `ready` | `null` |
| `planning` | `planning` | `null` |
| `plan-approved` | `plan-approved` | `null` |
| `implementing` | `implementing` | `null` |
| `pr-ready` | `pr-ready` | `null` |
| `failed` | `failed` | Sidecar `failurePhase`, or `null` |
| `completed` | `merged` | `null` |
| `cancelled` | Excluded | — |
| Any other string | `unknown` | `null` |

Labels are empty and `raw.workflowState` is the sidecar status (or its default). Update time comes from sidecar `updatedAt`.

### Local overlays

[src/issue-statuses.ts](../src/issue-statuses.ts) applies these rules after tracker normalization, on every call:

| Order | Rule | Effect |
|---|---|---|
| 1 | Read breaker parks newest first by `parked_at` | Keep the newest parked phase per internal issue ID |
| 2 | Find newest job for the issue identifier, across repositories and phases | Order by dispatch time descending, then log ID descending; job time is completion time if present, otherwise dispatch time |
| 3 | Provider state is `merged` | Protect state and phase from failure overlays |
| 4 | Nonmerged issue has a park joined by internal ID | Set `failed`; phase is `planning` only for a planning park, otherwise `implementation` |
| 5 | Nonmerged issue is `failed`, phase is missing, and a job exists | Fill phase: `planning` only for a planning job, otherwise `implementation` |
| 6 | Compute `changedAt` for every entry, including merged | Maximum of tracker update and job time; use the available time if only one exists, otherwise `null` |

Overlays preserve the provider's raw labels and workflow state. Park time itself does not contribute to `changedAt`.

## Caching and failures

Open PR source lists are cached in memory per `owner/repo` for 60 seconds; issue source records are cached per team key for 60 seconds. Age at least 60 seconds triggers a refresh. Successful fetch completion starts the cache age. Local job enrichment, workflow verdicts and breaker overlays are recomputed on every call, including cache hits.

For both tools, a failed source refresh serves the last good copy for that repository or team only if its age at failure is less than 5 minutes (300,000 ms). Serving it does not reset its age, and each fallback logs the repository or team and copy age. A stale open PR list omits linked pull requests whose outcome is no longer `open`, including merged and closed-unmerged pull requests. With no copy, or a copy at least 5 minutes old, the refresh error fails the whole call: no partial array is returned. Provider resolution errors and providers without the optional `listIssueStatuses` method still fail the whole call. GitHub reads all pages (100 per page), throwing on HTTP errors, invalid creation times or continuation beyond 50 pages. Tracker pagination limits likewise throw rather than silently truncate.

An error tool response has `isError: true` and explanatory text; the recorded failures have HTTP status 200, so callers must inspect the tool response. `[]` is a successful statement that there are no entries in scope (including no configured mappings). It is never an error answer: converting an unreadable source into `[]` would incorrectly erase known status.

## Known limits and Spotter handoff

- Spotter does not decode `pr.role` yet.
- The `ReviewFixPR` `wake` timer lives in Restate object state and is not readable by the workflow resolver. A PR can show `settled` for one poll after review feedback arrives, before visible queued or admitted work appears.
- `auto-merge-pending` uses the stored run-record verdict and does not read check runs. It can remain active while checks hold the merge; it does not assert that checks passed.
- Linear and filesystem never report `awaiting-approval`; Jira has a distinct value for it.

After merge, copy both contract directories' fixtures to `Tests/SpotterCoreTests/Fixtures/` in the Spotter repository for its `OpenPull` and `IssueStatus` decoders in `Sources/SpotterCore/Models.swift`. Handoff note: `pr.draft` is a new boolean field beyond the original contract; Spotter ignores unknown fields and can adopt it when needed. Fixture copying is work in that repository.
