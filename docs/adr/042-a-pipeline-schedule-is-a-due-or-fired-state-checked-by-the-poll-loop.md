# 042. A pipeline schedule is a due-or-fired state, checked by the poll loop

**Status:** Accepted
**Date:** 2026-10-16
**References:** ADR 037, ADR 039, [AII-1403](https://linear.app/eudoxus/issue/AII-1403/pipeline-schedules-run-a-pipeline-daily-at-a-set-time-on-restate-with), [AII-1431](https://linear.app/eudoxus/issue/AII-1431), [AII-1281](https://linear.app/eudoxus/issue/AII-1281/while-the-restate-registration-is-declined-tool-calls-do-not-start), `docs/restate.md` § "Pipeline schedules"

> The issue (AII-1431) names this file `041-…`, but ADR 041 is taken (`041-codex-uses-chatgpt-plan-tokens-from-one-refresher.md`). This ADR is 042; drafts in AII-1403 and its sibling issues that cite "ADR 041" for schedules mean this one.

## Context

The orchestrator has no way to run a pipeline at a time of day. Restate 1.7.10 with SDK 1.17.1 has no native cron (no cron in `node_modules/@restatedev/restate-sdk/dist/types`; cron is on Restate's roadmap only). A delayed self-send would stand in for a timer, but a timer brings back cancel-and-re-arm: every change to the time must find and cancel the pending invocation, and a lost one silently stops the schedule.

The orchestrator already has the right shape for "do this once per condition": the pickup label is a state, the `dispatched` row is the "fired" mark, and the poll loop is the tick.

## Decision

**1. A schedule is a state, not a timer.** `PipelineSchedule` is a Virtual Object keyed by pipeline name. Each day has one occurrence (the local `time` in `zone`). `lastFiredOccurrence` is the fired mark. An occurrence is *due* when the latest occurrence at or before now differs from `lastFiredOccurrence`. No timer and no pending invocation exist.

**2. The poll loop is the tick.** `checkPipelineSchedules(keys)` POSTs `PipelineSchedule/<key>/check` through the Restate ingress. It makes no call during a deploy hold (a new invocation must not start on the draining deployment, AII-1281) or unless the sidecar is `ready` and registration is `registered`. A failed call logs one line and never throws.

**3. `check` is the only handler that calls the pipeline, and it is exclusive.** It reads the clock once (`ctx.date.now()`), calls `busy`, and then `replace` or `fire`, and records the answer in the same handler. Overlapping polls cannot fire one occurrence twice, and a crash after `fire` returns replays from the journal instead of firing again.

**4. The pipeline answers three ways.** `busy` reads whether the worker is occupied and who holds it. `fire` answers `started` (fired; the run id is recorded), `busy` (the worker became busy between the read and the start: **not** fired, still due), or `refused` (any other refusal: **fired**, not retried until the next occurrence). A busy worker never loses the occurrence; a refusal never retries every minute.

**5. A run waiting for a person's decision may be replaced, once.** When the worker is busy, the holder is the run this schedule started (`lastStartedRunId`), and the holder awaits a decision, `check` calls the pipeline's optional `replace(runId)` and records `lastResult = replaced` for that run id. That record is the guard: a second `check` while still busy does not replace again. A manual run, or a pipeline without `replace`, is left alone and the occurrence stays due.

**6. `set` marks the past occurrence.** When `set` turns a schedule on, or changes `time` or `zone`, it sets `lastFiredOccurrence` to the latest occurrence at or before now. Without this, turning on a 03:00 schedule at 14:00 would fire at once.

**7. No `seed` handler.** No env var or row seeds a schedule, and empty state already means "off" (`get` answers `null`). `set` is `ingressPrivate` and validates strictly: a bad `time` (`^([01]\d|2[0-3]):[0-5]\d$`), a bad IANA `zone`, a key outside the registered pipelines, or an unknown field is a `TerminalError` 400 with state unchanged. No secret enters state, because Restate journals every handler input (ADR 039 rule 4).

**8. Time arithmetic is `Intl.DateTimeFormat` only; no date library.** `latestOccurrence` is pure. A local time inside a spring-forward gap maps to the first valid instant after the gap. A local time that occurs twice at fall-back maps to the first one. Several missed days give one occurrence, the latest: a schedule catches up once, not once per missed day.

**9. One contract suite.** `src/__tests__/restate/pipeline-schedule-contract.ts` holds 11 scenarios that every scheduled pipeline registers in `npm run test:restate`, on both server variants, with the clock moved through `deps.now` and no sleeping.

## Alternatives considered

- **A delayed self-send per occurrence.** Rejected: it needs cancel-and-re-arm on every change, and a lost message stops the schedule with nothing to notice it.
- **An external cron (Fly, GitHub Actions).** Rejected: it adds a credential and a failure surface outside the orchestrator (standing rule 2: prefer the design that needs no new GitHub or Actions right).
- **Fire on a busy worker anyway.** Rejected: the pipeline owns its own exclusion; the schedule waits and retries on the next tick.

## Consequences

A due occurrence is retried on every poll tick until the worker is free, so `busy` must be cheap and side-effect free. Nothing calls `PipelineSchedule` yet: AII-1403 step 2 connects KG refresh and the poll loop, and step 3 adds the writer tool. Until then the module has no consumer.
