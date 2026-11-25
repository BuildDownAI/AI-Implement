# 046. Self-deploy is a Restate object that never keeps an invocation open across its own restart

**Status:** Accepted
**Date:** 2026-10-29
**References:** ADR 023, [AII-1607](https://linear.app/eudoxus/issue/AII-1607), [CON-81](https://linear.app/eudoxus/issue/CON-81/update-an-orchestrator-to-the-newest-testing-or-main-build-from-the)

## Context

Self-deploy replaces the machine that runs the orchestrator's own Restate server. Two checks count every invocation that is not `completed` and not `scheduled`: the deploy drain (`queryNonCompletedInvocations`, `src/restate/endpoint.ts`) and the boot registration, which forces only when that count is 0. The old self-deploy was a plain async function: a crash during the drain lost the deploy, and boot guessed the outcome.

## Decision

Self-deploy is the Virtual Object `SelfDeploy` (`src/restate/self-deploy.ts`), keyed by the Fly app name. Each step is a short handler: `start`, then `checkDrain`, then `apply`, then `verify`. A step moves to the next one with a delayed send, never with `ctx.sleep`, so between steps only a `scheduled` call exists, and both checks ignore it (the same rule as the KG hold, AII-1402). `apply` schedules `verify` before it changes the image, and it returns before Fly stops the machine. `verify` runs on the new code and records the outcome. The deploy hold is set by `start` and cleared by `finish()` when the deploy ends, whether it succeeded, failed (`drain-timeout`, `apply-failed`, `verify-timeout`) or was cancelled. `cancel` works only while the deploy is draining and answers `too-late` after that.

Every orchestrator changes its code the same way: the machine's image only, with the Machines API. The image comes from one rule. An orchestrator with no knowledge graph (`kgSourceRepo` unset) uses the published image `<branch>-<sha7>` and refuses with `image-not-published` when there is none; an orchestrator with a knowledge graph builds its own image. `start` also refuses with `not-configured` or `head-unknown`.

The `SelfDeploy` option `applyFlyToml` (default off, set through the `setOptions` handler) runs `flyctl deploy --image <ref> --detach` with the repo `fly.toml` instead. `setOptions` refuses it with `apply-fly-toml-refused` when `FLY_IMAGE_APP` is set (the control plane created that machine and owns its config), and `apply` falls back to the image-only path if the option is set later.

Only a human orchestrator admin, the control plane's deploy-scoped token, and internal calls may start a deploy.

## Alternatives considered

- **One workflow with `ctx.sleep`**: the drain waits for the deploy itself, and the boot registration declines while the deploy invocation is open. A per-service exclusion in both checks would fix it, but `docs/restate.md` rejects exclusions by service ("the rule is about the status").
- **`flyctl deploy` with `fly.toml` on every orchestrator**: runs 20 minutes and is stopped part way, so the step never completes; on a created orchestrator it applies the BD orchestrator's VM and mount.
- **Build from source when no published image exists**: builds an image that CI did not test.
- **Map the deploy scope to the admin role**: the control plane would reach every admin write tool.

## Consequences

- A crash during the drain resumes after boot; the hold stays set until the deploy ends (`verify`, `cancel`, or a failure).
- The `SelfDeploy` journal must stay compatible across versions, because a retried `apply` runs on the new code. A journal snapshot test (`src/__tests__/restate/self-deploy-journal.restate.test.ts`) guards it.
- A change to the VM size or the mount needs `applyFlyToml`, or a manual `fly deploy`.
- Follow-on: load the knowledge graph at runtime, so that one image serves every orchestrator.

## Amendment (2026-11-24): the published image is on GHCR, and `start` checks that anyone can pull it

**The published image is the watched repository owner's GHCR image** ([AII-1837](https://linear.app/eudoxus/issue/AII-1837)). An orchestrator with no knowledge graph applies `ghcr.io/<owner, lowercased>/ai-implement-orchestrator:<branch>-<sha7>`, where the owner is the watched repository's, so the publication status `start` reads and the image it applies always name the same repository. A machine with `FLY_IMAGE_APP` keeps `registry.fly.io/<FLY_IMAGE_APP>:<branch>-<sha7>`: the control plane created it in the Fly organization that owns that image app. The rule's first form named only Fly's registry, which only the owning organization can pull from, so every self-hosted orchestrator without a knowledge graph failed at `apply`, after its drain.

**`start` refuses an image nobody can pull, before the hold.** Inside the existing "find target" step, after the publication status, `start` reads a GHCR image the way another Fly organization pulls it: a pull token requested with no credentials, then the manifest. A refusal there is the existing `image-not-published`, with a log line naming the image. The step's name, its result and the refusal codes are unchanged, so the journal stays compatible (Consequences above). This is not the registry check AII-1645 replaced with the publication status: that one needed access to BuildDown's Fly registry, which tenants do not have, while an anonymous read needs no credential.

**What the publication status means.** `orchestrator-image/published` now says the image can be pulled anonymously from GHCR, and, on BuildDown's own repository, that the Fly image app holds it too. The publish job builds the image once on its runner, refuses one that could hold a private knowledge graph, pushes it to GHCR, reads that copy anonymously, pushes it to Fly's registry, and sets the status last. A new GHCR package is private, so its owner makes it public once ([deployment.md](../deployment.md) § Self-deploy, "Publishing shared images").

**The rejected alternatives, re-checked** (standing rule 3). "Build from source when no published image exists" still holds: the published path applies only an image CI built. The other two are unaffected.
