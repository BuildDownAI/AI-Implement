# 037. A durable runner is a profile object that owns one kept machine

**Status:** Accepted
**Date:** 2026-10-07
**References:** ADR 032, ADR 036, [AII-1106](https://linear.app/eudoxus/issue/AII-1106/kg-refresh-on-a-durable-fly-runner-watched-one-shot-runs-per-pipeline), [AII-1123](https://linear.app/eudoxus/issue/AII-1123/temporary-admin-mcp-tool-probe-fly-machine-reuse-start-update-of-a), [AII-1126](https://linear.app/eudoxus/issue/AII-1126/add-the-flymachineprofile-restate-object-get-set-seed-with-a-kg), [AII-1131](https://linear.app/eudoxus/issue/AII-1131), [AII-1032](https://linear.app/eudoxus/issue/AII-1032/explore-the-runner-as-a-restate-service-advantages-platform-stability)

## Context

Every Fly run creates a machine, and the reaper destroys it after it stops. The next run pulls the image again (21 to 39 s on 2026-10-06). The experiment of 2026-10-07 (AII-1123) showed that `update` then `start` on a stopped machine gives a clean disk, the new env, the new size, and the current image in about 2.5 s. Fly facts the design relies on: `update` takes the whole config; `update` on a stopped machine applies it and does not start it; `update` on a running machine reboots it; `update` resets the machine's event history.

## Decision

**1. One object owns the kept machine.** The `FlyMachineProfile` object (one per pipeline phase, ADR 032, AII-1126) holds the pipeline's profile and, beside it, `machine: { machineId?, lastUsedAt, heldBy: { dispatchId, attempt } | null }`. At most one machine is kept per pipeline, and at most one dispatch holds it.

**2. The run's env never enters the object.** Restate journals every handler input, for an ingress call and for an SDK-to-SDK call alike (`docs/restate.md`). A `claim` that carried `GITHUB_TOKEN`, the run token, or the model key would write them to the journal. So `claim` hands out only the machine id. The workflow's `dispatch` step, which already mints the tokens inside one `ctx.run` and never journals them, does the Fly calls that need them: `update` + `start` on the claimed machine, or `create` when the claim answered `null`. It stamps the metadata `purpose: durable-runner`, `pipeline: <phase>`, `dispatch_id: <dispatchId>` (constants exported from `src/restate/fly-machine-profile.ts`), then calls `attach` with the machine id.

**3. The object decides; its handlers are these.** All are `ingressPrivate`; all are exclusive except `status`.

| Handler | Behaviour |
| -- | -- |
| `claim { dispatchId, attempt? }` | Same dispatch and attempt: answer the same `{ machineId }`, no change. Same dispatch, higher attempt: set the hold's attempt and answer the recorded id (it may be a dead machine; the dispatch step reconciles it and `attach`es a replacement). Same dispatch, lower attempt: 409. Another dispatch while held: 409 `machine held by <id> attempt <n>`. No hold: take it and answer the id, or `null` when no machine exists (the hold is recorded with the id unset). No Fly call. |
| `attach { dispatchId, machineId, attempt?, replaces? }` | Only the holder. The same id is idempotent at any attempt. A first attach after a `null` claim records it. A different id replaces the recorded one when `attempt > heldBy.attempt`, or `attempt === heldBy.attempt` and `attempt > 1`; the object logs both ids and does not destroy the old machine (the reaper's `durable_until` rule does). When `replaces` names the recorded machine (the dispatch step found it `destroyed` or 404 and created this one), the replacement is recorded at any attempt; a `replaces` that does not match, or no `replaces` at attempt 1, is still 409. Otherwise, or from a non-holder: 409. |
| `release { dispatchId }` | Keyed by dispatch id at any attempt; it runs once, at the end of the run. A non-holder is a logged no-op. In one `ctx.run("scrub", …, 3 attempts)`: `clearMachineEnv`, then stamp `durable_until` (epoch seconds, now + idle timeout + 1 day). Then clear the hold, set `lastUsedAt = now`, and send itself `expire { releasedAt: now }` after the profile's `idleTimeoutMs`. If the scrub exhausts its retries, the machine is destroyed in a second `ctx.run` and `machine` is cleared: a kept machine with stale env is worse than none. The hold is released and `expire` is scheduled on both paths. |
| `release { dispatchId }` after a `claim` that never `attach`ed (hold, no machine) | No Fly call and no `expire` (there is nothing to scrub or time out). The hold is cleared and `machine` is cleared with it, so `status` shows no machine. |
| `expire { releasedAt }` | Destroys the machine (3 attempts, a 404 counts as destroyed) and clears `machine` only when `lastUsedAt === releasedAt` and no hold exists; otherwise a no-op. A `claim` and `release` since moves `lastUsedAt`, so the older timer does nothing. |
| `status` (shared) | `{ profile, machine }`. |

The decisions are the pure functions `decideClaim`, `decideAttach`, and `decideExpire`, unit-tested without Restate; the handlers apply them.

**4. The hold names the attempt.** After a `dispatch_lost` the workflow may make one resume attempt of the same dispatch (AII-1032). That attempt must take the hold again, and a dead machine must be replaceable without a `release` in between, so the hold is `{ dispatchId, attempt }` (default 1). Only attempt 1 is sent in this tree; the resume path is AII-1032's.

**5. `durable_until` is a backstop.** If the object is lost, the reaper destroys a `durable-runner` machine past its `durable_until` (step 3c). The idle timeout is read from the profile at `release`, so a changed profile applies to the next release.

## Consequences

The object touches Fly only inside `ctx.run` closures, through `FlyMachineProfileDeps.fly`, bound to `FLY_SESSIONS_TOKEN` + `FLY_SESSIONS_APP` by the composer; if either is unset the object still registers and a handler that needs Fly fails when it runs. Nothing calls `claim`, `attach`, `release`, or `expire` yet; the workflow wiring is step 3b and the reaper rule is step 3c.
