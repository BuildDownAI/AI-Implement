# 012. Preview environments are machines in one standing Fly app

**Status:** Accepted
**Date:** 2026-09-01

## Context

Integration testing (AII-441) needs pre-merge environments: a PR branch of the
orchestrator deployed somewhere a test run can reach, concurrently for several
branches at once. Nothing in the codebase creates Fly *apps* programmatically —
`src/fly-machines.ts` only manages *machines* inside an existing app, and the
deploy credential contract (`FLY_DEPLOY_TOKEN`, ADR-relevant note in
`docs/deployment.md`) deliberately scopes every Fly token to a single app. A
per-branch *app* would require an org-scoped Fly token: a credential that can
create and destroy any app in the organization.

## Decision

We run one standing "previews" Fly app, created once by an operator. Each PR
branch under test becomes one **machine** inside that app, built from that
branch's image, with its own volume and its own SQLite file. Multiple branches
run concurrently as sibling machines. A test client reaches a specific branch
with the `fly-force-instance` request header. Teardown destroys the machine and
volume on PR close, with a TTL reaper for stragglers, mirroring the existing
session-machine reaper pattern.

## Alternatives considered

- **One Fly app per PR branch** — clean URLs and full isolation, but requires an
  org-scoped Fly token. A leak of that token exposes every app in the org, not
  one. Rejected for blast radius, not for capability.
- **ECS-per-PR (AII-140)** — already locked for the Cloudshare/AWS substrate. It
  targets client repos on AWS, not the orchestrator's own Fly deployment.
  Building it here would couple this feature to infrastructure AI-Implement
  itself does not run on. The two previews share a recipe/target contract, not
  an implementation.
- **No pre-merge environments** — the status quo. Real behavior stays observable
  only after merge, which is the gap AII-441 exists to close.

## Consequences

- Easier: no new credential class — the previews app gets its own app-scoped
  token, the `FLY_SESSIONS_TOKEN` pattern exactly. Machine CRUD, wait, and
  reaper code paths already exist and are reused.
- Harder: all previews share one hostname, so addressing is by header rather
  than by URL. Any client that cannot set headers cannot reach a specific
  preview. Accepted: the test runner is the only intended client.
- A concurrency cap on preview machines is required to bound cost; it is
  configuration, not architecture.
- Follow-on: the previews app must exist before the feature works; provisioning
  is a one-time operator step documented with the feature.
