# 022. The Linear pickup label is a settings row, seeded once from the environment

**Status:** Accepted
**Date:** 2026-09-16

## Context

The Linear provider selects dispatch candidates by one label, `AI-Implement`. The name was a
module constant in `src/providers/linear.ts`. A customer needed a second orchestrator instance on
the same Linear team with a different label during a version migration. Their patch read the name
from an environment variable with the old constant as the fallback expression inside the provider.

Every other orchestrator setting follows one pattern: a row in the `settings` table, edited on an
admin page, with an environment variable as the first-boot seed. The question was whether the
pickup label should follow the full pattern, or only the settings-row part.

## Decision

We store the Linear pickup label in the `settings` table under `linear_pickup_label`. The default
is `AI-Implement` when the row is absent. Operators change it on `/admin#settings`. The provider
reads the setting on every poll, so a change takes effect at the next poll with no restart.

`LINEAR_PICKUP_LABEL` seeds the row once, at first boot, when no row exists. After that the
environment variable is inert. The provider never reads the environment and carries no fallback
expression.

The lifecycle labels (`AI-Planning`, `AI-Working`, `Plan-Complete`, `Ready for Review`) stay
fixed. One label per orchestrator; the setting is not per mapping.

## Alternatives considered

- **Environment variable with a constant fallback in the provider (the customer patch).**
  Rejected. The value is process-global and needs a redeploy to change. It has no admin surface,
  which the repo's settings rule forbids. And the provider then holds two sources for one value.
- **Settings row with no seed.** Rejected, narrowly. The Linear poll runs only when a Linear
  mapping exists, so an operator can set the label before the first mapping and no seed is
  needed for correctness. The seed still earns its eight lines: a fresh orchestrator can be
  deployed with the label set declaratively, which is the shape a second migration instance has.
- **Per-mapping label.** Rejected. The pickup query is one workspace-wide GraphQL call. A
  per-team label turns it into one call per team and makes every child and ancestor check
  team-aware. The customer need is a second orchestrator, not a second team.
- **Configurable lifecycle labels.** Rejected. Five settings instead of one, plus changes to the
  label-creation helpers. The migration case does not need it.

## Consequences

- Editing `LINEAR_PICKUP_LABEL` after first boot does nothing. Change the value on
  `/admin#settings`, or reset it to default there. This matches `KG_BASE_REPO`.
- Two orchestrators on one team share the lifecycle labels. Each counts the other's `AI-Working`
  and `AI-Planning` issues against its own capacity cap. Each skips the other's `Ready for Review`
  issues. This is bounded and documented; it is not fixed here.
- A typo in the label stops all Linear pickup with no error. The poll log names the active label
  when a snapshot returns no candidates.
- The skills bind `{{IMPLEMENT_LABEL}}` in each project's `CLAUDE.md`. That binding is now a copy
  of an orchestrator setting. AII-687 tracks moving skills to read it from the orchestrator.
