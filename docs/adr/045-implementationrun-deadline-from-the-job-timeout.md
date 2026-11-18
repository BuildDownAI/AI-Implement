# 045. ImplementationRun's deadline is the project's job timeout

**Status:** Accepted
**Date:** 2026-10-26
**References:** ADR 035, ADR 044, [AII-1553](https://linear.app/eudoxus/issue/AII-1553)

## Context

`PlanningRun` uses a fixed total deadline (`PLANNING_TTL_SECONDS`, 30 min). An implementation run lasts as long as the project's job timeout allows: `maxJobMinutes`, read through `normalizeGithubActionsJobTimeoutMinutes` (default 90 min), which is also the GitHub Actions `timeout-minutes` and the Fly monitor's limit. Post-push review runs inside the same job. A fixed 2-hour deadline (`IMPLEMENTATION_TTL_SECONDS`) would stop longer runs that the runner itself still allows.

## Decision

The total deadline is the normalized job timeout, read once at dispatch into the workflow input (`maxJobMinutes`; the workflow computes `maxJobMinutes * 60_000` and never calls the normalizer). When the deadline passes, the workflow stops the run and waits up to a 10-minute stop margin (`IMPLEMENTATION_RUN_STOP_MARGIN_MS`) for the backend to end, as `PlanningRun` does. The bootstrap deadline, the time a run may show no started evidence, is 10 minutes (`IMPLEMENTATION_RUN_BOOTSTRAP_MS`). The workflow never re-reads the setting.

## Consequences

- The orchestrator stops a run at the same limit the runner obeys, not earlier; the margin is the time allowed for the stop to take effect.
- A changed setting applies to the next attempt only, so replay is deterministic.
- The callback token must live at least as long as the job timeout; a sibling issue in AII-1550 fixes its fixed 2-hour lifetime.

## Alternatives considered

- **Fixed 2 hours.** Stops runs early for projects with a longer timeout.
- **Re-read the setting at each tick.** Not deterministic on replay.
