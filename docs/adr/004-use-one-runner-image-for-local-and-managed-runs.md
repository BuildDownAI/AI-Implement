# 004. Use one runner image for local and managed runs

**Status:** Accepted
**Date:** 2026-08-18

## Context

The published runner image already contains the implementation pipeline, Claude Code, review loop, telemetry, and project detection. The local release needs the same behavior without a tracker, GitHub App, remote clone, push, or callback.

A separate local image could provide a simpler entrypoint. It would also create a second release artifact that can drift from the managed execution path before the local product proves that it needs unique assets.

## Decision

We publish one runner image for local and managed runs when possible.

The image gains an explicit local command. That command accepts a task document and an isolated local workspace. It does not require or fabricate GitHub inputs. The managed commands keep their current contracts.

We add a separate image only when the local product needs enough unique assets to justify another release artifact.

## Alternatives considered

- **Publish a dedicated local image now** — rejected because two images can ship different pipeline, review, and telemetry behavior.
- **Keep the current entrypoint and inject placeholder GitHub values** — rejected because the local path would appear GitHub-free while retaining hidden GitHub assumptions.
- **Replace the managed image with a local-first image** — rejected because existing GitHub Actions and Fly execution must remain stable.

## Consequences

The runner entrypoint must select an explicit command before it validates mode-specific inputs. The local pipeline must structurally omit remote publication steps.

Image tests must cover both local and managed commands. A local release cannot pass by weakening the existing managed-run contract.
