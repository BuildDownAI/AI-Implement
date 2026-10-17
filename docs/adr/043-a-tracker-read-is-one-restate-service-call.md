# 043. A tracker read is one Restate service call

**Status:** Accepted
**Date:** 2026-10-17
**References:** ADR 025, ADR 039, [AII-605](https://linear.app/eudoxus/issue/AII-605/kg-ingests-jira-issues-hold-refreshes-with-no-tracker-data-one-restate), [AII-1462](https://linear.app/eudoxus/issue/AII-1462), `docs/restate.md` § "The TrackerExport service"

> The AII-605 draft of this ADR was not readable when AII-1462 landed. This text is written from the landed code; reconcile it with the draft when AII-605 closes.

## Context

The knowledge-graph tracker export reads Linear directly (`fetchTrackerIssuesPage`, `src/runner-callback.ts`), so a Jira mapping contributes nothing, and a missing credential surfaces as a 502 or 503 on an HTTP route. Reading a page of issues is an external call with a credential, a retry question, and a failure the caller must tell apart from "the tracker is not configured".

## Decision

**1. One service, one handler.** `TrackerExport` (`src/restate/tracker-export.ts`) has one handler, `page({ team, cursor })`. It returns `{ issues, pageInfo }` for one page of the mapping's issues.

**2. The provider owns the query.** `TicketingProvider.listIssuesPage?(mapping, cursor)` is optional so a fork's custom provider factory still compiles. The handler calls it inside `ctx.run("page", …)`.

**3. The handler stamps `sourceSystem` and `team`.** `sourceSystem` is the provider's `id`, `team` the mapping key. One place for these two fields keeps every provider identical, and a new provider cannot forget them. A provider never sets them.

**4. Two terminal codes, carried as the `TerminalError` message prefix** (`TerminalError.code` is the HTTP status):
- `tracker-unavailable` (503): unknown mapping, a provider that cannot be built, a provider without `listIssuesPage`, or `TrackerUnavailableError` (a missing credential). Never retried, because retrying a missing credential only delays the hold. The provider failing to build is a judgement call beyond the issue's wording: `ProviderRegistry.forMapping` throws on an unknown or unconfigured provider, and outside `ctx.run` a plain throw would be retried forever.
- `tracker-failed` (502): the page read failed on every attempt. The `ctx.run` policy is 5 attempts, 1 s to 10 s apart; exhaustion surfaces as a `TerminalError`, which the handler re-codes.

A zero-issue page is a normal answer.

**5. Not an MCP tool.** The service is not registered on `orchestratorTools` and no `/mcp` tool wraps it.

**6. The input is `{ team, cursor }` only (strict).** Restate journals inputs (ADR 039 rule 4); a credential is read by the provider at call time and never enters the journal.

**7. The provider needs the team key; `RepoMapping` does not carry it.** `getMappings()` returns fresh objects, so the provider cannot find the key by identity. The handler passes `{ ...mapping, teamKey: team }` and `RepoMapping.teamKey?` is documented as set only there. The provider still receives only the mapping and the cursor.

**8. The ingress client never throws.** `createTrackerExportIngressClient().page()` answers `{ ok: true, page }` or `{ ok: false, code }` with `code` one of `tracker-unavailable`, `tracker-failed`, `unavailable` (connection error, timeout, anything else). Its default timeout is 120 s, above the retry window.

## Consequences

- Journal size: one page is up to 50 issues with up to 100 comments each, journaled whole by `ctx.run`. The page size is fixed at 50; this ADR does not record a measured size.
- Nothing calls the service yet and it is not registered at boot; the wiring issue does both with its first caller. `fetchTrackerIssuesPage` stays until then.

## Alternatives considered

- **The provider's HTTP call outside Restate, as today.** Rejected: each route re-implements retry and the credential-missing answer.
- **A `teamKey` argument on `listIssuesPage`.** Rejected here: it departs from the specified signature; the stamped mapping field keeps it.
