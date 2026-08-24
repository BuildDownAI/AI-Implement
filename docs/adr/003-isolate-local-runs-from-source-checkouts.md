# 003. Isolate local runs from source checkouts

**Status:** Accepted
**Date:** 2026-08-18

## Context

AI-Implement already has a developer harness that bind-mounts a checkout into the runner. This design gives maintainers a fast loop for testing uncommitted hooks and workflow changes. It also lets the runner change the developer's files and Git index.

The evaluator-facing local release has a different safety contract. A user must be able to inspect the result without risking changes to the selected checkout. The launcher must also avoid silently mixing unfinished local work into a generated patch.

## Decision

We keep two explicit workspace adapters.

The developer harness keeps its live, bind-mounted workspace. A local run uses an isolated copy and leaves the source checkout unchanged.

A local run accepts a clean checkout by default. If the checkout has local changes, the launcher stops before Docker starts. It lists the changed files and shows the exact `--include-dirty` command. That option copies tracked changes and non-ignored untracked files into the isolated workspace.

## Alternatives considered

- **Replace the developer harness with isolated execution** — rejected because maintainers need immediate access to uncommitted hook and workflow changes.
- **Include local changes by default** — rejected because a run could silently include unfinished work or an untracked secret.
- **Run directly in the source checkout** — rejected because the runner could change files, branches, or the Git index.

## Consequences

Local execution needs a workspace adapter boundary instead of one universal mount strategy. Tests must prove that local runs preserve the source checkout and that the developer harness keeps its current behavior.

Users with local changes take one extra explicit action. In return, the default run is reproducible and safe to inspect.
