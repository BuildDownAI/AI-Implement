# ADR 005: Run the full AI loop in local mode

**Status:** Accepted

**Date:** 2026-08-18

**Implementation status (verified 2026-08-24, branch `testing`):** **Integrated.** `src/local/full-loop.ts`, reached through `session/entrypoint.sh` (`RUNNER_ENTRY="run-local-full-loop.js"` under the `full` mode).

---

## Context

AI-Implement's value is not limited to generating a code change. The product maps the repository, states an acceptance bar and risks, implements the task, runs verification, reviews the result, and explains the outcome.

The existing developer harness starts at implementation. Reusing that behavior without a visible planning result would make the evaluator-facing local release faster, but it would hide a central part of the product.

## Decision

Every local run executes the full loop: plan, implement, test, review, and summarize.

The local runner saves the planning result with the run artifacts and continues automatically. The first release does not add a manual plan-approval gate. The terminal shows each phase and the final artifact path.

## Alternatives considered

- **Start at implementation** — rejected because the first trial would not demonstrate AI-Implement's planning value.
- **Require manual plan approval** — rejected because it adds interaction before the local execution path proves itself.
- **Run planning only for the demo** — rejected because the demo and user-repository paths would demonstrate different products.

## Consequences

A local run uses more time and model tokens than an implementation-only run. The demo must stay small enough to complete quickly.

Tests and clean-room runs must measure time to the first planning result and the first diff. A failed planning phase must stop before implementation and preserve useful diagnostics.
