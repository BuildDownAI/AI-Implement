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

## Looking up an issue by key

`findByKey(key, scopeKey?)` reads one issue outside the poll. A Linear key names its team, so Linear always returns the team as the scope key. A Jira key does not name the mapping:

- **With `scopeKey`**, Jira reads the fields that mapping's poll reads and builds the issue the same way: scope key, description as text, profiles, base branch and assignee. The Restate planning and implementation runs use this form, with the run's team key (the scope key the poll dispatched with). Without it, those runs saw only the issue title, with no profiles or base branch.
- **Without `scopeKey`** (an admin lookup, a review-fix description), Jira returns `scopeKey: ""` and does not read the custom fields. The description is still converted from ADF to text.

## Tracker state after each planning outcome

| Outcome | Jira | Linear |
|---|---|---|
| Plan succeeded, "Auto-approve plans" on | `Plan Approved` (implementation starts on the next poll) | `AI-Planning` removed, `Plan-Complete` added |
| Plan succeeded, "Auto-approve plans" off | `Awaiting Approval`; a person sets `Plan Approved` | Same as above: the option is ignored (approval is AII-131) |
| Callback reported a failure | `Planning Failed` plus a comment | Planning-failed handling, comment |
| No callback, or deadline | `Planning Failed` plus one comment; issue parked, not requeued | Label kept; issue parked, one comment; Unpark to retry |
| Plan recorded but status write failed | Row `failed` / `plan_status_write_failed`; issue parked; `Planning Failed` plus one comment carrying the tracker's own error (Jira: status and body) | Same, with the label kept; Unpark to retry |
| Operator cancel | Working state cleared | Working state cleared |

Each Jira status in this table is an option of the `AI-Implement Status` field, and a write of an option the field does not have is refused. For the plan-complete write, the refusal fails and parks the run. The field needs nine options in all; [Jira setup](#jira-setup) lists them, with what each missing one breaks.

The filesystem provider ignores `awaitApproval` as well. A parked issue needs **Unpark** at `/admin#runners` before it dispatches again.

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

The lifecycle verbs apply `AI-Planning`, `Plan-Complete`, `AI-Working` and, once a PR opens, `Ready for Review`. Each label's name and color are defined once (`LINEAR_LABELS`, `src/providers/linear.ts`), and each label is created at first use. Before creating one, `ensureTeamLabel` searches the workspace for the name ignoring case and reuses the team's own match, else a workspace match (`reusableLabel`); another team's label is never reused, since this team's issues cannot carry it. With neither, it creates the label in the issue's team, which needs no workspace admin rights. The poll's label tests, `removeLabelByName` and `markMerged` compare exact names, so a reused label in a different case, such as `ai-working`, is applied but never recognized by the poll, and never removed.

### Workflow states

`markPlanningStarted` and `markImplementing` move an issue still in triage, the backlog or an unstarted state to the team's `started`-type state (`In Progress` when the team has one). `markMerged` moves a merged issue to its `completed`-type state (`Done` when it has one). A team with no state of that type fails the transition with `No "started" workflow state found for team …`, or the `completed` equivalent.

## Jira setup

The setup checks read Jira's facts in one pass that never writes (`JiraProvider.fetchSetupFacts`): the account, each mapping's fields resolved fresh, the status and repo fields' options, and one result of each mapping's bucket query.

### Credentials

`JIRA_EMAIL` selects the mode.

| Mode | Variables | Requests go to | Header |
|---|---|---|---|
| Basic (API token) | `JIRA_EMAIL`, `JIRA_TOKEN`, `JIRA_SITE_URL` | `JIRA_SITE_URL` | `Basic` of `email:token` |
| OAuth | `JIRA_TOKEN` (access token), `JIRA_CLOUD_ID`, `JIRA_SITE_URL`; `JIRA_EMAIL` empty | `https://api.atlassian.com/ex/jira/<cloudId>` | `Bearer` |

Neither mode refreshes. `JiraClient` builds its Authorization header once and the registry reads environment variables once at boot; changing an expired token requires replacing it and restarting the orchestrator. `JIRA_SITE_URL` is required in both modes for issue links. Missing token or site URL, or neither email nor cloud ID, makes `createJiraProviderFromConfig` throw `MissingProviderConfigError`; the registry skips Jira and polls other trackers. Basic auth with an API token is recommended for a long-lived setup.

The account lists fields, searches, reads issues and comments, sets the status field and adds comments. Setup checks only use GET requests and the poll's search POST.

### Field cache

`tracker.jira.field-cache` compares fresh IDs with the poll cache without filling it. Restart the orchestrator if they differ.

### Bucket query

`tracker.jira.query` runs the exact poll bucket query for one result. Correct the mapping JQL if Jira refuses it; it does not use the parse endpoint.

### Repo option

`tracker.jira.repo-option` requires a select option equal to the mapping’s `repoFieldValue`; add the exact option or correct the mapping. Text fields need no option.

### Custom fields

| Field | Required | What the code reads | Override |
|---|---|---|---|
| `AI-Implement Status` | yes | single-select option value | `statusFieldOverride` |
| `AI-Implement Repo` | yes | single-select or text matching `repoFieldValue` | `repoFieldOverride` |
| `AI-Implement Profiles` | no | multi-select option values | `profilesFieldOverride` |
| `AI-Implement Base Branch` | no | non-blank text | `baseBranchFieldOverride` |
| `Epic Link` | no | classic-project epic key | none |

`resolveCustomFieldIds` matches exact, case-sensitive names. Missing or duplicate required fields throw; absent or ambiguous optional fields warn and stay off. Epic Link takes the first match. Overrides are letters-digits-underscores IDs used as given, without validation against Jira. With all four overrides set, the field list is never read and Epic Link is not resolved. A repo mismatch drops the issue with one warning per issue.

Resolved IDs are cached by site (site URL for Basic, cloud ID for OAuth) and all four overrides for the life of the process. A mapping save does not clear this cache. Failed resolutions are not cached. Setup resolves fresh and warns on drift; restart the orchestrator to use the current fields.

### The `AI-Implement Status` options

The poll's bucket is `(<mapping jql>) AND <status field> in (Ready, "Plan Approved")`. Nine values are read or written (`STATUS_VALUES`):

| Option | Set by | When missing |
|---|---|---|
| `Ready` | a person | no issue can be queued |
| `Planning` | `markPlanningStarted` | write fails; run continues and issue stays Ready |
| `Awaiting Approval` | `markPlanComplete`, auto-approval off | plan-complete write fails and parks the run |
| `Plan Approved` | `markPlanComplete`, auto-approval on; `clearWorkingState`; a person | plan-complete write and resets fail |
| `Implementing` | `markImplementing` | write fails after launch |
| `PR Ready` | `markPrReady` | write fails; review comment is lost |
| `Merged` | `markMerged` | merge completion never updates the issue |
| `Planning Failed` | `markPlanningFailed` | write fails; failure comment is lost |
| `Implementation Failed` | `markImplementationFailed` | write fails; failure comment is lost |

`Awaiting Approval` is required only with auto-approval off. `clearWorkingState` writes Plan Approved for operator cancels, admin machine stops, watchdog and monitor resets.

Comment-carrying setters write status first, so a rejected write loses the comment. Merged is terminal: `setStatus` refuses to move an issue off Merged, but proceeds if its pre-read fails. A refused regression makes `markPlanningFailed` and `markPrReady` post nothing; `markImplementationFailed` posts a late-report comment instead. `markMerged` changes only the custom field; native Done or field Merged counts as finished.

Without a Merged option, merge reconciliation retries once per poll and dead-letters after five failures. The issue keeps PR Ready and, until its native status becomes Done, holds grouping-parent dispatch and roll-up and issues it Blocks.

## Filesystem setup

The provider needs no tracker credentials and requires `RUNNER_MODE=local`. Mapping directories must be absolute, exist as directories and be writable. The check resolves symlinks through `existingRealDirectory`, just like the poll, and tests access without writing. Missing directories are silently skipped by the poll. The provider writes `.state/<mapping key>/<identifier>.json` and `completed/` and `failed/` archives; archiving is skipped with a warning when mappings share a directory. See [filesystem-tickets.md](filesystem-tickets.md) for the format.

## When a tracker write fails

A missing label, state, team or option shows up as one of these writes failing. The handling belongs to the caller, so it is the same for every tracker.

| Write | Called | On failure |
|---|---|---|
| planning started (`markPlanningStarted`) | after a planning run launches | caught and logged, warning that the next poll may re-dispatch planning; the run continues |
| plan complete (`markPlanComplete`) | on the planning success callback | the run fails as `plan_status_write_failed` and the issue is parked; see the planning-outcome table |
| implementing (`markImplementing`) | after an implementation run launches (`postDispatch`) | throws out of dispatch, and the poll logs `[poll] Error processing <key>`; the run continues. On Fly Machines and local Docker, `dispatchSession` also deletes the issue's dedup row and records a dispatch failure |
| PR ready (`markPrReady`) | on the implementation success callback, and from the monitor | logged; the callback also returns it in `warnings` |
| failed (`markPlanningFailed`, `markImplementationFailed`) | on the failure callback (`handleRunnerResult`), among other callers | in the callback, logged and returned in `warnings` |
| merged (`markMerged`) | from merge reconciliation and grouping-parent finalize paths | reconciliation makes one attempt per poll and marks the row `failed` after the fifth failure; finalize paths log |

## When one tracker's snapshot fails

`fetchProviderSnapshots` settles providers separately. A rejected snapshot logs `[poll] <provider> snapshot failed, its issues sit out this cycle`; other trackers still dispatch, and skip-reason memory retains failed-provider issues. Jira rejects on missing or duplicate required fields, failed field listing or search, affecting every Jira mapping. Linear rejects on token mint or API/GraphQL errors. Construction failures are skipped by the registry, which retains them until a mapping save.

## Mixed deployments

One instance can run Linear and Jira mappings together. Limits:

- **One Jira site and one Linear workspace per instance.** Credentials are process-level env vars and each provider is a single cached instance.
- **Knowledge graph coverage includes both trackers.** `resolveKgScopeTeams` (`src/admin.ts`) puts every Linear and Jira mapping in the default export scope; a Jira mapping reads through `JiraProvider.listIssuesPage`.
- **Dedup reconcile is per tracker.** Each tracker is asked only about its own `dispatched` rows; see [dispatch-dedup.md](dispatch-dedup.md) § "Reconcile loop".
- **The kg-refresh failure report** (`kgRefreshReportIssue`) is looked up with `ProviderRegistry.findByKeyInAnyTracker`, which asks every tracker that has a mapping. One hit posts the comment. A key found in two trackers is `ambiguous` and the comment is skipped with a warning. No hit skips it too; providers that could not be checked (`failedProviderIds`) are named in the log.
