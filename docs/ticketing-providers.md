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

## Jira setup

The setup checks read Jira's facts in one pass that never writes (`JiraProvider.fetchSetupFacts`). They prove the credentials first, then, for each Jira project, resolve its fields fresh, read the status and repo fields' options, and run its JQL as the poll runs it for one result. Each failed read is recorded with Jira's HTTP status, or none when Jira could not be reached, so one project's fault never hides another project's facts. Each check reports by id ([setup-checks.md § tracker](setup-checks.md#tracker)).

### Credentials

`JIRA_EMAIL` selects the mode.

| Mode | Variables | Requests go to | Header |
|---|---|---|---|
| Basic (API token) | `JIRA_EMAIL`, `JIRA_TOKEN`, `JIRA_SITE_URL` | `JIRA_SITE_URL` | `Basic` of `email:token` |
| OAuth | `JIRA_TOKEN` (access token), `JIRA_CLOUD_ID`, `JIRA_SITE_URL`; `JIRA_EMAIL` empty | `https://api.atlassian.com/ex/jira/<cloudId>` | `Bearer` |

**Basic mode is the supported path.** It acts as the person whose API token it holds, and Atlassian caps an API token's lifetime at a year, so Jira stops answering on the token's expiry date with no warning first. OAuth mode sends one access token as a bearer and never refreshes it, while Atlassian's OAuth access tokens last an hour, so `tracker.jira.credentials` fails OAuth mode even when Jira accepts the token. Neither mode reloads its credentials: `JiraClient` builds its Authorization header once and the registry reads the environment once at boot, so a new token takes a restart. `JIRA_SITE_URL` is required in both modes for issue links. A missing token or site URL, or neither email nor cloud ID, makes `createJiraProviderFromConfig` throw `MissingProviderConfigError`, and the registry skips Jira and polls the other trackers.

The check proves the credentials with `JiraClient.verifyCredentials`, a `GET /rest/api/3/resolution/search?maxResults=1`, which needs only "Permission to access Jira" and, for an OAuth token, the `read:jira-work` scope the poll needs. Most Jira reads answer a wrong or missing credential as an anonymous caller instead of refusing it (`/mypermissions` answered 200 to a wrong token on a Jira Cloud site), while this one answers 401.

The account lists fields, searches, reads issues and comments, sets the status field and adds comments. Reading a field's options takes more than the poll needs: the **Administer Jira** global permission (`manage:jira-configuration` for an OAuth token). Atlassian's API reference also lists the **Edit Workflows** project permission, but on a Jira Cloud site an account holding it without Administer Jira was refused both the field's contexts and its options with 403 ("Only Jira administrators can manage custom field options."), while listing fields and the credentials read still worked. Without Administer Jira, `tracker.jira.status-options` and `tracker.jira.repo-option` report *cannot verify* and name the permission. The setup checks send only GET requests and the poll's search POST.

### Custom fields

| Field | Required | What the code reads | Override (the project's setting on `/admin#projects`) |
|---|---|---|---|
| `AI-Implement Status` | yes | single-select option value | `statusFieldOverride` (**Status Field**) |
| `AI-Implement Repo` | yes | single-select or text matching `repoFieldValue` | `repoFieldOverride` (**Repo Field**) |
| `AI-Implement Profiles` | no | multi-select option values | `profilesFieldOverride` (**Profiles Field**) |
| `AI-Implement Base Branch` | no | non-blank text | `baseBranchFieldOverride` (**Base Branch Field**) |
| `Epic Link` | no | classic-project epic key | none |

`resolveCustomFieldIds` matches exact, case-sensitive names. A required field that matches no field or several throws `JiraFieldResolutionError`, which fails the whole Jira snapshot, every Jira project included ("When one tracker's snapshot fails", below), and `tracker.jira.fields` fails the project, naming the setting that picks the field instead. An optional field that is absent or matches several stays off, and `tracker.jira.fields` warns of a duplicated one, naming the feature it leaves off. Epic Link takes the first match. Overrides are IDs of letters, digits and underscores, used as given and never checked against Jira. With all four overrides set, the field list is never read and Epic Link is not resolved. A repo mismatch drops the issue with one warning per issue.

### Field cache

Resolved IDs are cached by site (the site URL in Basic mode, the cloud ID in OAuth mode) and all four overrides, for the life of the process. A mapping save does not clear the cache, and a failed resolution is not cached. `tracker.jira.field-cache` compares the IDs it resolves fresh with the cached ones without filling the cache (`peekCachedFieldIds`), and warns when they differ: the poll is still using fields from before a change in Jira, and a restart makes it read the current ones.

### The `AI-Implement Status` options

The poll's bucket is `(<project jql>) AND <status field> in (Ready, "Plan Approved")`. Nine values are read or written (`STATUS_VALUES`):

| Option | Set by | When missing |
|---|---|---|
| `Ready` | a person; `clearWorkingState` after a planning run | no issue can be queued, and a stopped planning run cannot return its issue to the queue |
| `Planning` | `markPlanningStarted` | write fails; run continues and issue stays Ready |
| `Awaiting Approval` | `markPlanComplete`, auto-approval off | plan-complete write fails and parks the run |
| `Plan Approved` | `markPlanComplete`, auto-approval on; `clearWorkingState` after an implementation run; a person | plan-complete write and implementation resets fail |
| `Implementing` | `markImplementing` | write fails after launch |
| `PR Ready` | `markPrReady` | write fails; review comment is lost |
| `Merged` | `markMerged` | merge completion never updates the issue |
| `Planning Failed` | `markPlanningFailed`; `parkForHuman` after a planning run | write fails; failure comment is lost, and a planning run the stuck watchdog gives up on is not parked |
| `Implementation Failed` | `markImplementationFailed`; `parkForHuman` after an implementation run | write fails; failure comment is lost, and an implementation run the stuck watchdog gives up on is not parked |

`Awaiting Approval` is required only with auto-approval off, and `tracker.jira.status-options` asks for it only then. Which run outcome writes which option is in "Tracker state after a failed, stuck or given-up run", above.

Comment-carrying setters write status first, so a rejected write loses the comment. Merged is terminal: `setStatus` refuses to move an issue off Merged, but proceeds if its pre-read fails. A refused regression makes `markPlanningFailed` and `markPrReady` post nothing; `markImplementationFailed` posts a late-report comment instead. `markMerged` changes only the custom field; native Done or field Merged counts as finished.

Without a Merged option, merge reconciliation retries once per poll and dead-letters after five failures. The issue keeps PR Ready and, until its native status becomes Done, holds grouping-parent dispatch and roll-up and issues it Blocks.

### Repo option

`tracker.jira.repo-option` requires the repo field to have an option spelled exactly as the project's **Repo Field Value** (`repoFieldValue`). The poll drops every issue whose repo field holds another value, so without that option it finds none of the project's issues. A text repo field has no options, so the check does not apply to it; the poll compares its text instead (`readRepoFieldValue`). Reading the options needs the permission in "Credentials", above.

### JQL

`tracker.jira.jql` runs the project's JQL as the poll runs it, `(<project jql>) AND <status field> in (Ready, "Plan Approved")` from `buildBucketQuery`, with a `customfield_N` status field written as `cf[N]`, asking for one result. A query Jira refuses fails the check with Jira's status and error. It also fails the whole Jira snapshot, as a missing field does, so the fix is the project's **JQL** on `/admin#projects`, leaving the status filter to the poll. The check runs the search, not `validateJql`'s parse endpoint, so it judges the query Jira will actually run.

## Filesystem setup

The provider needs no tracker credentials and requires `RUNNER_MODE=local`. A project's **Ticket Directory** must be absolute (a mapping save refuses any other), exist as a directory, and let the orchestrator create entries in it, which needs search permission as well as write. `tracker.filesystem.directory` resolves symlinks through `existingRealDirectory`, as the poll does, and asks for both with `access(W_OK | X_OK)`, writing nothing. The poll skips a missing directory silently, so the check is the only report of one. The provider writes `.state/<mapping key>/<identifier>.json` and `completed/` and `failed/` archives; archiving is skipped with a warning when mappings share a directory. See [filesystem-tickets.md](filesystem-tickets.md) for the format.

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

## Creating pickup-ready children

`createChildIssue(parentId, scopeKey, { title, body })` returns
`Promise<{ id: string; identifier: string }>`. The orchestrator calls it with
its own tracker credentials. The child uses the parent's native team/project
and parent association; tracker failures propagate to the caller.

Linear reads the effective pickup label from settings on each call and requires
an exact-name team or workspace label. Jira resolves the mapping's custom field
IDs, sets AI-Implement Status to `Ready`, and inherits the parent's AI-Implement
Repo value (text or select). It requires that Repo to match the mapping and
chooses a project-supported native child issue type; unsupported hierarchies or
required-field restrictions fail explicitly. A label does not replace Jira's
pickup fields.

Filesystem children are new task documents with a collision-resistant identity
and exclusive file creation. Parent metadata is stored in provider-owned state
and survives restart; pickup follows the mapping's planning setting. The fake
provider records the parent association and puts children in planning pickup.
