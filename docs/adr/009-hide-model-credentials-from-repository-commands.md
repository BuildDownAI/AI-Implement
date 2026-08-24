# 009. Limit model credential exposure in trusted repositories

**Status:** Accepted
**Date:** 2026-08-18

## Context

The current runner passes its process environment to repository setup and verification hooks. That environment can contain `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. A repository command could read or transmit the model credential.

Claude Code also receives the credential and can start shell commands. Anthropic does not document a supported way to guarantee that these child commands cannot access the credential. The first local release cannot honestly claim isolation from hostile repository code without a different credential-broker and command-sandbox design.

Local runs need network access for the model provider and, when required, package registries. Removing all network access would prevent common setup and test workflows.

## Decision

The first local release supports trusted repositories and trusted task documents only. The quickstart states this boundary before the first run.

AI-Implement removes the model credential from repository setup, test, verification, and teardown processes that it starts directly. Claude Code receives the credential. Commands started by Claude Code may inherit it.

Repository commands keep normal container network access in version one. The container receives no host Docker socket and no GitHub credential. The selected repository mount is read-only, and all modifications happen in the isolated working copy.

## Alternatives considered

- **Pass the full runner environment to every AI-Implement child process** — rejected because setup and test code do not need the model credential.
- **Disable container networking** — rejected because the model call and common dependency installation need network access.
- **Give the container a GitHub token for future publication** — rejected because publication is outside the local release.
- **Claim isolation from hostile repository code** — rejected because the current Claude Code process model cannot support that guarantee.
- **Build a credential broker and command sandbox now** — deferred because it materially expands the local release and needs a separate security design.

## Consequences

The runner needs separate environment builders for the model process and AI-Implement-owned repository commands. Tests must prove that setup, test, verification, and teardown processes started by AI-Implement cannot read either supported model credential.

Users must treat repository code and task documents as trusted, network-capable inputs. The quickstart and security notes must state this boundary.
