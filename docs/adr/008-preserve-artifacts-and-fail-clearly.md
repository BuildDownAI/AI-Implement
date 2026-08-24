# ADR 008: Preserve artifacts and fail clearly

**Status:** Accepted

**Date:** 2026-08-18

**Implementation status (verified 2026-08-24, branch `testing`):** **Not yet integrated.** The exit-code and artifact-retention behaviour lives in `src/local/artifacts.ts`, which has no callers outside its own test.

---

## Context

A local run can fail during planning, implementation, testing, or review. It can also reach a turn or iteration limit without approval. A zero exit code would hide these outcomes from scripts and evaluators. Automatic cleanup would remove the evidence needed to understand them.

## Decision

A failed, unapproved, or capped local run returns a nonzero exit code. It preserves all available artifacts and prints the outcome, the next repair action, and the absolute artifact path.

Version one keeps every run until the user explicitly removes it by run ID. It performs no automatic pruning.

## Alternatives considered

- **Return zero when the container ran successfully** — rejected because container completion is not pipeline success.
- **Delete failed-run artifacts** — rejected because failures need more evidence than successful runs.
- **Prune old runs automatically** — rejected because an implicit retention policy can destroy evidence that the user still needs.

## Consequences

Shell scripts and clean-machine tests can trust the command exit code. Users can inspect partial work after any failure.

The artifact directory can grow until the user runs the explicit cleanup command.
