# 010. Use a minimal portable task document

**Status:** Accepted
**Date:** 2026-08-18

## Context

The local release needs one task format for the command-line runner, examples, validation, and agent-assisted authoring. The existing developer harness format includes fields that describe its own execution environment. Those fields would couple task intent to one machine or publication workflow.

## Decision

A task document is Markdown with YAML front matter. `title` is the only required metadata field. Optional metadata can set a stable `id`, a base revision, named profiles, and run limits. The Markdown body describes the work and its acceptance criteria.

The document does not contain a repository path, credentials, publication settings, or queue dependencies.

The runner owns the schema and validator. The repository includes a portable task-authoring skill that calls the real validator. Installation of that skill is optional and manual. The local command does not install or change agent tools.

The developer harness keeps a compatibility adapter for its current task fields.

## Alternatives considered

- **Reuse every developer harness field** — rejected because fields such as `repo` and `branch` mix task intent with execution context.
- **Require a tracker-shaped document** — rejected because local evaluation should not require tracker concepts.
- **Install the authoring skill automatically** — rejected because a Docker run should not change host agent configuration.

## Consequences

Users can write a task by hand, copy an example, or use the optional skill. All paths use the same validator and error messages.

The compatibility adapter adds a small maintenance cost until the developer harness adopts the shared schema.
