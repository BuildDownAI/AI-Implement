# Ticketing providers

The orchestrator talks to issue trackers through one interface, `TicketingProvider` (`src/providers/types.ts`). Everything outside `src/providers/` (the poll loop, dispatch, callbacks, the reaper, merge reconciliation) calls the interface and never a tracker API directly. The knowledge graph's tracker-data export goes through the same interface: `TicketingProvider.listIssuesPage`, called by the `TrackerExport` Restate service ([ADR 043](adr/043-a-tracker-read-is-one-restate-service-call.md)).

## Providers

| Id | Module | Credentials (`.env.example`) |
|---|---|---|
| `linear` | `linear.ts` | `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` (app actor); `LINEAR_WORKSPACE_URL` for links |
| `jira` | `jira.ts`, `jira-client.ts` | `JIRA_TOKEN` + `JIRA_SITE_URL`, plus `JIRA_EMAIL` (Basic) or `JIRA_CLOUD_ID` (OAuth) |
| `filesystem` | `filesystem.ts` | none; local runner mode only ([filesystem-tickets.md](filesystem-tickets.md)) |

`resolveProvider` (`src/providers/index.ts`) first looks for a `custom/providers/<id>` factory, then falls back to the built-in.

**Custom-provider rule.** A custom factory is called with `(config)` only, so unlike the Jira and filesystem built-ins it receives no `getMappings`. The provider it returns must have an `id` equal to `<id>`: selection compares `provider.id` with the mapping's `ticketingProvider`, and an issue from a provider whose `id` differs is dropped as belonging to another tracker.

## Choosing a provider per mapping

Every project mapping carries `ticketingProvider` and a matching `ticketingConfig` (`ticketing-config.ts`). Linear needs no config. Jira needs `jql` (scope) and `repoFieldValue` (the `AI-Implement Repo` option), plus optional `*FieldOverride` ids.

`ProviderRegistry` (`registry.ts`) resolves a provider from a mapping. It caches **one instance per provider id**: a single Linear provider and a single Jira provider serve every mapping of that kind. The cache is dropped when an admin saves or deletes a mapping. `forAllMappings` returns one provider per distinct id in use, skipping any whose construction fails; the poll loop iterates that set. The setup check `tracker.provider` names a provider that cannot be built, and one that has no setup checks of its own ([setup-checks.md § tracker](setup-checks.md#tracker)).

## How each provider finds work

- **Linear** fetches every issue in the workspace that carries the pickup label and is not completed or cancelled. Each issue's `scopeKey` is its **Linear team key**.
- **Jira** runs each Jira mapping's `jql` wrapped with the `AI-Implement Status` filter. Each issue's `scopeKey` is the **mapping key** it was found under.

## Knowledge-graph export (`listIssuesPage`)

`listIssuesPage(mapping, cursor)` returns one page of a mapping's issues as `TrackerIssueRecord`s; the `TrackerExport` handler stamps `sourceSystem` and `team`, never the provider. A missing credential or mapping config throws `TrackerUnavailableError`; any other error propagates so Restate retries it.

- **Linear** pages `issues(filter: team)` 50 at a time; the cursor is the GraphQL `endCursor`.
- **Jira** runs `(<mapping jql>)` through `JiraClient.searchJqlPage`, one page of up to 100 issues; the cursor is Jira's `nextPageToken` (`null` is the first page). Issues whose repo field is not the mapping's `repoFieldValue` are dropped after the search, so a page can hold fewer issues, or none, while `hasNextPage` is true. `searchJql` (the poll's all-pages call) is unchanged.

Jira field mapping: `identifier` is the issue key; `state` is `{ status.name, statusCategory.key }`; `description` and comment bodies go through `adfToPlainText`; `parent` is the native `parent`, else the Epic Link field; `branchName` is absent. Links from `issuelinks`: an outward `Blocks` link is `blocks`, an outward `Duplicate` is `duplicate`, every other outward link is `related`. An **inward** link is always `related`, because `blocks` and `duplicate` are directed from the record's own issue and the other issue's record carries that edge.

Comments: the search response embeds a capped comment list with its `total`. Only an issue whose embedded list is shorter than `total` costs an extra `listComments` call (newest first, at most 300 fetched), and at most 100 comments are kept per issue, so the per-page call count is bounded by the issues with long threads.

Selection (`src/poll-selection.ts`) then matches each issue to a mapping by `scopeKey`.

## Tracker state after each planning outcome

| Outcome | Jira | Linear |
|---|---|---|
| Plan succeeded, "Auto-approve plans" on | `Plan Approved` (implementation starts on the next poll) | `AI-Planning` removed, `Plan-Complete` added |
| Plan succeeded, "Auto-approve plans" off | `Awaiting Approval`; a person sets `Plan Approved` | Same as above: the option is ignored (approval is AII-131) |
| Callback reported a failure | `Planning Failed` plus a comment | Planning-failed handling, comment |
| No callback, or deadline | `Planning Failed` plus one comment; issue parked, not requeued | Label kept; issue parked, one comment; Unpark to retry |
| Plan recorded but status write failed | Row `failed` / `plan_status_write_failed`; issue parked; `Planning Failed` plus one comment carrying the tracker's own error (Jira: status and body) | Same, with the label kept; Unpark to retry |
| Operator cancel | Working state cleared | Working state cleared |

A Jira `AI-Implement Status` field needs these options: `Ready`, `Planning`, `Plan Approved`, `Planning Failed`, and `Awaiting Approval` when "Auto-approve plans" is off. A missing option makes the plan-complete write fail, which fails and parks the run.

The filesystem provider ignores `awaitApproval` as well. A parked issue needs **Unpark** at `/admin#runners` before it dispatches again.

## Tracker state after a failed, stuck or given-up run

Two provider verbs move a ticket after a run that did not finish. Both take the phase of the run (`planning` or `implementation`) and both refuse an issue that is already terminal (return `false`).

| Verb | Used by | Jira | Linear | Filesystem |
|---|---|---|---|---|
| `clearWorkingState(id, scope, phase)`: put the issue back in pickup | Retries within `STUCK_JOB_MAX_ATTEMPTS`, the reaper, operator cancel, admin job destroy | planning: `Ready`; implementation: `Plan Approved` | `AI-Working` and `AI-Planning` removed | `ready` or `plan-approved`, from the task's own state |
| `parkForHuman(id, scope, phase)`: take the issue out of pickup, no comment | The stuck watchdog's give-up (`src/stuck-watchdog.ts`) | planning: `Planning Failed`; implementation: `Implementation Failed` | `AI-Needs-Human` added first, then `AI-Working` and `AI-Planning` removed; the pickup label stays | Task `failed`, then archived by the failure reconciler |

A planning reset goes to `Ready`, not `Plan Approved`: a planning run that failed left no approved plan, and `Plan Approved` would dispatch implementation. A fix run (job phase `gap-analysis`) is never reset or parked; its ticket already has a PR.

On give-up, the watchdog parks first and only then clears the dedup row and the stuck-attempt counter, so a restarted ticket gets a full retry budget. When the park throws or is refused, the row and the counter stay. The give-up comment ends with the restart step: on Linear, remove the `AI-Needs-Human` label; on Jira and the filesystem provider, reset the AI-Implement status or label.

## Mapping keys

Mapping keys share one namespace across providers. A Linear mapping's key must equal the Linear team key. A Jira mapping's key is an operator-chosen label.

Selection is tracker-scoped. `mappingForProvider` and `mergeProviderSnapshots` drop an issue whose `scopeKey` is held by a mapping of a *different* tracker, and the Blockers panel lists it as `no-mapping`. A `scopeKey` with no mapping at all is kept, as before.

**Do not reuse a Linear team key as a Jira mapping key.** While the Jira mapping holds the key, that Linear team cannot be mapped: its issues are dropped as foreign.

The admin UI warns about this on save, without blocking it: `POST /api/mappings` returns a `warnings` array when a Jira mapping is saved over a key a Linear mapping holds today. The check is advisory — no provider method lists Linear teams, so an unmapped Linear team key is not detected.

## Linear setup

The Linear provider relies on the app's credentials and on four things in the workspace. The setup checks get the app's token, then read the rest in one GraphQL request (`LinearProvider.fetchSetupFacts`), which never writes, and report each by id ([setup-checks.md § tracker](setup-checks.md#tracker)).

### The app's credentials

The orchestrator acts in Linear as an OAuth app, never as a person. Boot reads `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` (`configureLinearAuthFromEnv`, `src/linear-app-auth.ts`), and the first request mints an app-actor token through the client-credentials grant, so the app needs client credentials tokens enabled. The token is cached and minted again an hour before it expires; a request answered 401 mints a fresh token and retries once. A refused grant is a `LinearApiError` carrying Linear's HTTP status, and without a token every Linear read and write fails.

### Team access

A Linear mapping's key is its team's key ("Mapping keys", above). The poll is one workspace-wide search ("How each provider finds work"), so a team the app cannot access looks exactly like a team with no labeled issues: its issues never appear. A mapping key that names no team looks the same, and Linear answers both cases the same way, with no team for that key.

### The pickup label

The poll matches the pickup label by its exact name (`labels: { name: { eq } }`), as a workspace label or one of the team's own. The orchestrator never creates it, and reads its name from the `linear_pickup_label` setting at the start of each poll ([ADR 022](adr/022-pickup-label-is-a-settings-row-seeded-once-from-the-environment.md)). A label that differs only in case is never matched.

### Lifecycle labels

The lifecycle verbs apply `AI-Planning`, `Plan-Complete`, `AI-Working`, once a PR opens `Ready for Review`, and, when the stuck watchdog gives up, `AI-Needs-Human`. The poll skips an issue carrying `AI-Needs-Human` before it counts capacity, so a park that added the marker but failed to remove `AI-Working` does not hold a slot. Each label's name and color are defined once (`LINEAR_LABELS`, `src/providers/linear.ts`), and each label is created at first use. Before creating one, `ensureTeamLabel` searches the workspace for the name ignoring case and reuses the team's own match, else a workspace match (`reusableLabel`); another team's label is never reused, since this team's issues cannot carry it. With neither, it creates the label in the issue's team, which needs no workspace admin rights. The poll's label tests, `removeLabelByName` and `markMerged` compare exact names, so a reused label in a different case, such as `ai-working`, is applied but never recognized by the poll, and never removed.

### Workflow states

`markPlanningStarted` and `markImplementing` move an issue still in triage, the backlog or an unstarted state to the team's `started`-type state (`In Progress` when the team has one). `markMerged` moves a merged issue to its `completed`-type state (`Done` when it has one). A team with no state of that type fails the transition with `No "started" workflow state found for team …`, or the `completed` equivalent.

## Mixed deployments

One instance can run Linear and Jira mappings together. Limits:

- **One Jira site and one Linear workspace per instance.** Credentials are process-level env vars and each provider is a single cached instance.
- **Knowledge graph coverage includes both trackers.** `resolveKgScopeTeams` (`src/admin.ts`) puts every Linear and Jira mapping in the default export scope; a Jira mapping reads through `JiraProvider.listIssuesPage`.
- **Dedup reconcile is per tracker.** Each tracker is asked only about its own `dispatched` rows; see [dispatch-dedup.md](dispatch-dedup.md) § "Reconcile loop".
- **The kg-refresh failure report** (`kgRefreshReportIssue`) is looked up with `ProviderRegistry.findByKeyInAnyTracker`, which asks every tracker that has a mapping. One hit posts the comment. A key found in two trackers is `ambiguous` and the comment is skipped with a warning. No hit skips it too; providers that could not be checked (`failedProviderIds`) are named in the log.
