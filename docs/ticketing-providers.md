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

`ProviderRegistry` (`registry.ts`) resolves a provider from a mapping. It caches **one instance per provider id**: a single Linear provider and a single Jira provider serve every mapping of that kind. The cache is dropped when an admin saves or deletes a mapping. `forAllMappings` returns one provider per distinct id in use, skipping any whose construction fails; the poll loop iterates that set.

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

## Mapping keys

Mapping keys share one namespace across providers. A Linear mapping's key must equal the Linear team key. A Jira mapping's key is an operator-chosen label.

Selection is tracker-scoped. `mappingForProvider` and `mergeProviderSnapshots` drop an issue whose `scopeKey` is held by a mapping of a *different* tracker, and the Blockers panel lists it as `no-mapping`. A `scopeKey` with no mapping at all is kept, as before.

**Do not reuse a Linear team key as a Jira mapping key.** While the Jira mapping holds the key, that Linear team cannot be mapped: its issues are dropped as foreign.

The admin UI warns about this on save, without blocking it: `POST /api/mappings` returns a `warnings` array when a Jira mapping is saved over a key a Linear mapping holds today. The check is advisory — no provider method lists Linear teams, so an unmapped Linear team key is not detected.

## Mixed deployments

One instance can run Linear and Jira mappings together. Limits:

- **One Jira site and one Linear workspace per instance.** Credentials are process-level env vars and each provider is a single cached instance.
- **Knowledge graph coverage includes both trackers.** `resolveKgScopeTeams` (`src/admin.ts`) puts every Linear and Jira mapping in the default export scope; a Jira mapping reads through `JiraProvider.listIssuesPage`.
- **Dedup reconcile is per tracker.** Each tracker is asked only about its own `dispatched` rows; see [dispatch-dedup.md](dispatch-dedup.md) § "Reconcile loop".
- **The kg-refresh failure report** (`kgRefreshReportIssue`) is looked up with `ProviderRegistry.findByKeyInAnyTracker`, which asks every tracker that has a mapping. One hit posts the comment. A key found in two trackers is `ambiguous` and the comment is skipped with a warning. No hit skips it too; providers that could not be checked (`failedProviderIds`) are named in the log.
