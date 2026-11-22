# 033. A run signal uses a channel that every deployment already has

**Status:** Accepted
**Date:** 2026-10-01
**References:** ADR 018, ADR 023, ADR 032, AII-682, AII-974, AII-1018, AII-1022

## Context

A Restate workflow that owns a run must learn when the run ends. There are two cases. In the normal case the runner reports its result to the orchestrator through the runner callback, and that report ends the wait. In the failure case the run dies and sends no report, and the workflow must find that out by another way.

For kg-refresh, AII-974 handled the failure case with the GitHub `workflow_run` event. The workflow created an awakeable for each GitHub Actions run and stored `run id → awakeable id` in a `settings` row. The orchestrator webhook resolved the awakeable when GitHub delivered `workflow_run.completed`. A poll remained as a backstop, at a 10-minute interval.

GitHub delivers `workflow_run` only when the GitHub App of the deployment subscribes to that event. That is a manual step in the App settings, and each customer must do it for its own App. A deployment that does not do it gets only the backstop: a dead run is found in up to 10 minutes. Before AII-974 the poll found it in 60 seconds. So the design was slower than its predecessor for every deployment with no extra setup, and faster only for a deployment that did the extra step.

The same question came up for the planning workflow (AII-1022). The operator rejected the `workflow_run` design there on 2026-10-01: "We don't want to add friction in the system for Topia and all other customers in the future." "Optional, with a backstop" did not make it acceptable, because the benefit then depends on the step.

## Decision

A signal that a workflow needs must come through a channel that every deployment already has. A design must not need a new GitHub App permission, a new GitHub App event subscription, a repository setting, or another customer-side step to give its benefit.

The channels that every deployment has today are:

- the runner callbacks (`/runner/result`, `/runner/progress`), which each run already uses;
- the webhook events that the App already subscribes to (`issue_comment`, `pull_request`, and the review events);
- a read of the run's own status through the GitHub API, with the token the orchestrator already holds.

For kg-refresh this means:

- The runner `report` ends the wait in the normal case. This does not change.
- The workflow finds a run that ended with no report by a read of that run's status on one interval, `KG_REFRESH_WATCH_INTERVAL_MS` (60 seconds, the value before AII-974).
- The `workflow_run` webhook path is removed: the awakeable, the `kg-refresh-run-watch:<runId>` rows in `settings`, the `register-run-watch` and `forget-run-watch` steps, and the webhook handler.

For the planning workflow, AII-1022 applies the same rule with the planning callback as the signal.

## Alternatives considered

- **Keep the `workflow_run` path as an option beside the poll.** Rejected. It is two mechanisms for one job, and the faster one works only after a customer-side step. Each deployment would behave differently, and the documents would need a setup section that most operators skip.
- **Keep the awakeable and resolve it from the runner callback.** Rejected for kg-refresh. The runner `report` already ends the wait through a durable promise. An awakeable would add a registry for a signal the workflow already has.
- **Watch for runner heartbeats and treat silence as a dead run.** Rejected for now. It needs a new periodic signal from the runner and a silence threshold. The status read is simpler and uses data GitHub already has.
- **A longer poll interval to keep the journal small.** Rejected for now. 60 seconds is the detection time operators had before. The journal cost is about ten entries for each tick. A later change (AII-1013) creates the wait arms one time and lowers that cost without a change to the interval.

## Consequences

Easier: kg-refresh behaves the same on each deployment with no setup. A dead run is found in about 60 seconds. One mechanism is removed: no awakeable registry, no `settings` rows for it, two fewer journal steps, and no `workflow_run` handler. The setup documents lose a section.

Harder: the workflow writes one status read to its journal for each minute of a run. A long run (the limit is 4 hours) has a longer journal than with the event. The detection time has a floor of one interval; it is not instant.

Rule for later run kinds: before a design adds a signal, a permission, or a setting on the customer side, name the channel that is already required and use it. If a customer-side step remains, the plan must name it and must state what the design gives with zero setup.

## Amendment (2026-10-02): an awakeable is allowed when it needs no new right

**Context.** The awakeable of AII-974 failed this ADR because its resolver was the `workflow_run` webhook. GitHub delivers that event only when the GitHub App subscribes to it, and each orchestrator has its own App, so each customer must change its own App settings. The permission behind the event (Actions, read) was already held, because dispatch uses Actions; the event subscription was the only missing right. The awakeable itself needs no GitHub right. The `settings` registry existed only because the GitHub event carries the run id, not the awakeable id. The second alternative above ("keep the awakeable and resolve it from the runner callback") was rejected for that registry.

**Decision.** An awakeable is a permitted primitive when its resolver uses a channel from the list above (for a runner signal: the runner callback route, authenticated by the run token). The registry is not needed: the workflow creates the awakeable before the dispatch and sends its id in the `run_config` envelope (a level-2 change in `docs/standing-rules.md`, no template change). The id is not a credential, because the Restate ingress binds loopback (ADR 023) and the authenticated callback route is the only way to reach it.

Use a workflow promise when the sender knows the workflow key (the kg-refresh `report` today). Use an awakeable when the wait is not in a workflow, or when one run has many waits (for example one per pipeline step).

**Evidence.** An experiment against the pinned versions (`restate-server` 1.7.10, `restate-sdk` 1.17.1) on 2026-10-02: a workflow created three awakeables, wrote their ids to a stand-in dispatch envelope, and waited. An outside process resolved each id through `POST /restate/awakeables/{id}/resolve` on the ingress (HTTP 202 for each), and the workflow completed with the three values. No registry was written.

The rule of this ADR does not change: no design may need a new App permission, event subscription, or repository setting. See `docs/standing-rules.md` rule 2.
