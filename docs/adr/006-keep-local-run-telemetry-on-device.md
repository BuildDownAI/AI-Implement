# ADR 006: Keep local run telemetry on device

**Status:** Accepted

**Date:** 2026-08-18

**Implementation status (verified 2026-08-24, branch `testing`):** **Not yet integrated.** `writeRunArtifacts` in `src/local/artifacts.ts` carries the on-device telemetry fields this ADR specifies, but has no callers outside its own test.

---

## Context

The local release can measure phase timing, completion, model usage, and failure codes. Sending these events to a remote service would help measure the onboarding funnel.

The same release asks a new user to mount source code and provide a model credential. Remote telemetry before the product proves value creates another trust decision and another network failure mode.

## Decision

The first local release sends no product telemetry to a remote service.

It writes phase timing, outcome, token and cost summaries, and failure codes into the local run artifacts. It does not record credentials or repository content in telemetry fields.

## Alternatives considered

- **Send anonymous funnel events by default** — rejected because the user has not yet established trust in the product.
- **Send events only for the bundled demo** — rejected because the demo must not carry a hidden network behavior that normal local runs do not have.
- **Remove telemetry entirely** — rejected because local diagnostics and clean-room evaluation need structured evidence.

## Consequences

The team cannot measure real-world local onboarding centrally in the first release. Evaluators must choose to share artifacts or study results.

A later release can add explicit, informed telemetry consent without changing the local artifact contract.
