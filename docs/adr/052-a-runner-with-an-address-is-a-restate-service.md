# 052. A runner with an address is a Restate service

**Status:** Accepted
**Date:** 2026-11-21
**References:** ADR 017, ADR 018, ADR 023, ADR 037, [AII-2033](https://linear.app/eudoxus/issue/AII-2033/plan-runners-with-an-address-become-restate-services-local-docker), [AII-1032](https://linear.app/eudoxus/issue/AII-1032/explore-the-runner-as-a-restate-service-advantages-platform-stability), [AII-2034](https://linear.app/eudoxus/issue/AII-2034/let-the-runner-start-as-the-restate-service-runner-runid-on-local), [AII-2042](https://linear.app/eudoxus/issue/AII-2042/make-local-docker-runners-restate-services), [AII-2048](https://linear.app/eudoxus/issue/AII-2048/add-the-launch-plumbing-for-serve-mode-on-local-docker-off-by-default)

## Context

A local Docker runner starts `run-autonomous.js`, runs the pipeline, and reports through `/runner/result`. The orchestrator learns about the run only from callbacks and from container polling. Retries, timeouts, cancellation, and crash accounting are all homegrown, or missing.

Restate already owns durable execution for the orchestrator's workflows (ADR 017), and ADR 018 adopts it one run kind at a time. The pinned pair — restate-server 1.7.10 and SDK 1.17.1 — can run the pipeline behind one call instead. Experiments on those versions (AII-2033, e1–e7) proved the pieces below.

## Decision

**1. Option A: the runner serves one Restate service per run.** The runner image gets a serve mode that starts an SDK endpoint and registers the service `Runner_<runId>`; the orchestrator's Restate server calls it. The mode adds a service module, its process entry, and these tests. No workflow calls it yet, so production behavior does not change.

**2. The name is per run.** A shared name lets one runner take another runner's call (AII-1032 T1). The run id is the dispatch id (a UUID) from `AI_IMPLEMENT_RUNNER_ID`. `Runner_<uuid>` with its hyphens registers on the pinned server (checked 2026-11-19). The one handler, `run`, takes `{ workflowKey }` and no secret.

**3. The handler wraps the pipeline unchanged.** `run` calls `runAutonomous()`, which reads the same RunConfig environment `run-autonomous.js` uses today. Standing rule 4: the proven mechanism is wrapped as it is. The pipeline is started once per invocation id; serve mode never calls `process.exit`, and the container stays up until the workflow removes it.

**4. One journaled event loop is the only channel to Restate.** The flight pushes events into an in-process queue; the handler takes each event inside `ctx.run("ev-i")` and returns a result or throws a terminal error:

```ts
const flight = startFlight(ctx.request().id);
for (let i = 0; ; i++) {
  const ev = await ctx.run(`ev-${i}`, () => flight.next(i));
  if (ev.kind === "result") return ev.result;
  if (ev.kind === "failed") throw new restate.TerminalError(ev.message);
  // later children add other kinds here (invocation, step)
}
```

The flight pushes exactly one terminal event when `runAutonomous` settles: `result` when it resolves, `failed` (a message, no secret) when it rejects. Without it a pipeline that throws would leave the loop waiting until the deadline. A retry after a Restate restart replays `ev-0 … ev-k` from the journal, then waits on the live queue, so every Restate command stays in a fixed order. The pipeline never sends to Restate: after a retry it would hold a stale context.

**5. Only a cancellation aborts the flight.** A kill and a retry both reach the handler as an attempt abort, so the handler cannot tell them apart. The service sets `explicitCancellation` and races each `ev-i` against the context's cancellation signal (`(ctx as restate.internal.ContextInternal).cancellation()`); only that arm aborts the flight. After a kill the workflow's cleanup removes the container, and that ends the pipeline.

**6. Service options fix proven failures.**

- `retryPolicy: { maxAttempts: 3, onMaxAttempts: "kill" }` — without it Restate retries a dead runner forever and the workflow never ends (AII-2033 T2).
- `inactivityTimeout` (7 h) and `abortTimeout` (8 h) sit above the longest job timeout (360 min) plus ImplementationRun's 10-minute stop margin. Without them an `ev-i` step that waits minutes for the next event is suspended and restarted forever (T4).

**7. Calls are signed, and the service fails closed.** The endpoint gets `identityKeys: [RESTATE_IDENTITY_KEY]`, the public `publickeyv1_…` half, inline — not via `resolveIdentityKeys`, because that module imports the orchestrator's tools and operator services. Unlike the orchestrator endpoint, the runner refuses to start when the key is absent: its port is reachable from the host, and an unsigned runner would accept a call from any local process.

**8. The process entry listens on `:::9080`.** When `runner-service.js` is the entry it starts the endpoint itself and stays up until the container is removed. It cannot use the orchestrator's default `127.0.0.1`: a loopback listener inside a container cannot be reached through `-p`. `::` also covers the Fly private network (IPv6). It exits with an error when `AI_IMPLEMENT_RUNNER_ID` or `RESTATE_IDENTITY_KEY` is missing.

**9. No secret enters the journal.** The `run` input and every event hold no key or token. Model keys keep `/runner/model-auth/*`; GitHub tokens keep nonce vending. A failure event is a message scrubbed of configured secret values and token-shaped strings, never a raw error or stack.

**10. A dead runner ends the run as today.** The three-attempt, kill-on-exhaustion policy means a runner that dies mid-run fails the invocation terminally after three attempts, so the workflow ends instead of waiting forever. The pipeline's callbacks and result path are unchanged.

**11. Launch wiring is not here.** The serve entry in `session/lib.sh`, the published port, and the environment come from AII-2048. This ADR covers only the service module and its tests.

## Alternatives considered

- **One shared service name** — rejected: one runner can take another runner's call (AII-1032 T1).
- **Have the pipeline send events to Restate directly** — rejected: after a retry the pipeline holds a stale context, its sends fail, and the replay check sees commands out of order.
- **Abort the flight on any attempt abort** — rejected: a retry also aborts the attempt, so the pipeline would stop on every Restate restart.
- **Retry a dead runner forever** — rejected: the workflow would never end (AII-2033 T2).
- **Default invoker timeouts** — rejected: a `ctx.run` step waiting for the next event is suspended and restarted forever (T4).
- **Import `resolveIdentityKeys` from the orchestrator endpoint** — rejected: it loads the orchestrator's whole tool and operator service graph into the runner.
- **Run unsigned and rely on the port binding** — rejected: the port is reachable from the host, so the runner fails closed without a key.
- **Bind `127.0.0.1` like the orchestrator endpoint** — rejected: a Docker published port cannot reach a container's loopback listener.

## Consequences

The runner can be addressed by the orchestrator's Restate server, which supplies retries, timeouts, cancel, and journaling in place of the homegrown parts. Everything the pipeline does — model calls, git, callbacks, result reporting — is unchanged. Nothing calls the serve mode yet; the launch plumbing (AII-2048) and the workflow caller follow, and reverting this change is a plain revert because no caller depends on it.
