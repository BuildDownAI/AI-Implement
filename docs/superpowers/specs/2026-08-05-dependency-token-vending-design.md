# Dependency Read-Token Vending (per-project GitHub token scope)

**Date:** 2026-08-05
**Status:** Approved direction — orchestrator-vended, two-token model, uniform across execution modes

## Problem

The implementer's GitHub App token is scoped to the dispatching repo only (GHA mode:
`actions/create-github-app-token` with no `owner`/`repositories` inputs). Clients whose
builds fetch private sibling repos — e.g. composer packages for okta integrations or core
services split across repos — cannot install dependencies inside the run, even though the
App installation covers those repos.

Meanwhile the Fly/local vending path (`/api/token`) mints a **full-installation token**
(all repos, all App permissions) — broader than intended and inconsistent with GHA.

## Goals

- A per-project admin setting that grants runs read access to dependency repos.
- `claude-implement.yml` never changes for this feature — not even one re-sync.
- The primary write token stays scoped to the target repo in every execution mode.
- GHA, Fly Machines, and local Docker behave identically.

## Non-goals (v2 candidates)

- Explicit dependency repo lists (v1 is off / all-installation-repos; the storage and
  minting API are shaped so a list slots in without migration pain).
- `packages: read` (GitHub Packages npm registries); v1 is `contents: read` only.
- Per-run scope overrides via `/ai-implement` comments.

## Design

### Two-token model

| Token | Scope | Permissions | Source |
|---|---|---|---|
| Primary (existing) | Target repo only | App's full grants (contents write, PRs, …) | GHA `create-github-app-token` step / Fly-local `/api/token` |
| Dependency (new) | All installation repos (v1) | `contents: read` (+ implicit `metadata: read`) | New orchestrator vending endpoint, fetched by the runner mid-run |

The implementer executes arbitrary code driven by ticket text. Read-only-everything is an
acceptable v1 grant; write-everything is not, which is why the primary token is never
broadened.

### Mapping setting

New nullable column `dependency_token_scope TEXT` on `mappings`
(migration via the existing `ALTER TABLE` ladder in `src/config.ts`):

- `NULL` (default) — feature off; runs behave exactly as today.
- `'installation'` — dependency token covers every repo the App installation can see.
- Future: a JSON array of repo names occupies the same column (`'["core-services","okta-api"]'`),
  distinguished by leading `[`.

`TeamMapping.dependencyTokenScope: "installation" | null`. Editable in the `/admin`
Projects edit dialog and the add-project wizard as a select — "Off (default)" /
"All repos the App can access (read-only)" — with helper text naming the security
trade-off. Admin API validates the enum.

### Envelope

`RunConfigV1` gains an optional field:

```ts
dependencyTokenScope?: "installation";
```

Set by the orchestrator from the mapping at dispatch time (all phases, including
webhook-triggered gap-fill and review-feedback re-dispatches, which share the unified
dispatch path). Added to `pickKnownKeys` in `src/run-config.ts`. The envelope is opaque
to the workflow, so this is orchestrator + runner-image only. The field's presence is the
runner's signal to fetch a token; absence means the runner never calls the endpoint.

### Vending endpoint

`POST /api/runner/dependency-token` (registered next to `/api/token` in `src/index.ts`).

- **Auth:** `Authorization: Bearer <RUN_PROGRESS_TOKEN>` — verified with
  `verifyRunToken(token, secret, "progress", { consume: false })`. The progress audience
  is multi-use and time-boxed per run (implementation TTL 2h), and verification resolves
  `mappingTeamKey` from the `runner_tokens` table.
- **Authorization:** load the mapping for `mappingTeamKey`; if `dependencyTokenScope` is
  null → `403` (defense in depth — a runner shouldn't call without the envelope flag).
- **Minting:** new `getScopedInstallationToken(appId, privateKey, owner, options)` in
  `src/github-app-auth.ts` — same install-resolution as `getInstallation` but POSTs
  `access_tokens` with a body: `{ "permissions": { "contents": "read" } }` and (v1) no
  `repositories` field, which yields all installation repos with narrowed permissions.
  Cached per `owner + scope-signature` for 50 minutes, mirroring `getInstallationToken`.
- **Response:** `{ "token": "...", "expires_at": "ISO-8601" }`.
- Tokens are never logged. Verification failures return 401/403 with reason codes
  matching the runner-callback endpoints' conventions.

Requires `RUNNER_TOKEN_SECRET` + `RUNNER_CALLBACK_BASE_URL` and a publicly reachable
orchestrator — a core assumption of this deployment model (already required for planning
auto-advance and the feature-branch cascade). Runs dispatched without run tokens simply
never fetch a dependency token.

### Runner behaviour

A new early pipeline stage (`dependency-auth`, running after clone, before install /
implement) activates only when `ctx` has `dependencyTokenScope`, `runnerCallbackUrl`,
and `RUN_PROGRESS_TOKEN`:

1. **Fetch** an initial token from the vending endpoint.
2. **Git credential helper:** install a small executable (shipped in the runner image)
   registered as `git config --global credential."https://github.com".helper`. On `get`
   it returns `x-access-token` + a cached token, re-fetching from the endpoint when the
   cached token is within 5 minutes of expiry — so long runs never hit a stale token for
   git operations. The target repo's clone/push remotes embed their own credentials in
   the URL and bypass credential helpers, so the primary write path is untouched.
3. **Composer:** export `COMPOSER_AUTH={"github-oauth":{"github.com":"<token>"}}` into
   the environment Claude's invocations inherit (via the runner's `$GITHUB_ENV`
   management). This covers composer's API-based dist downloads; its git-based source
   installs go through the credential helper. Caveat: `COMPOSER_AUTH` is a snapshot —
   documented 1-hour freshness; installs nearly always happen early in a run.
4. **Failure is non-fatal:** endpoint unreachable / 403 → log a warning and continue;
   the run degrades to today's behaviour.

The helper masks the token in GHA logs (`::add-mask::`) when running under Actions.

### Fly/local parity and primary-token narrowing

- The existing `/api/token` handler (`src/token-vending.ts`) switches from
  `getInstallationToken` (full install) to a repo-scoped mint:
  `repositories: [<job repo name>]`, full App permissions. This makes the Fly/local
  primary token match GHA's. **Behaviour change** for existing Fly users whose runs
  relied on incidental org-wide access — called out in release notes; the remedy is
  enabling the new setting.
- The dependency endpoint is identical for all modes: Fly (`fly-machines.ts`) and local
  Docker (`local-docker.ts`) already pass `RUN_TOKEN`/`RUN_PROGRESS_TOKEN` and the
  envelope into the runner env.

## Security notes

- Enabling `installation` scope lets the implementer (and therefore anything that can
  steer it, including injected ticket text) **read every repo the App installation
  covers**. This is the documented trade-off of v1's coarse scope; the v2 repo list is
  the narrowing path. The admin UI helper text states this.
- The dependency token cannot write anywhere: `contents: read` is enforced at mint time
  by GitHub, not by runner-side convention.
- The progress token was already exposed to the runner; this adds a new capability to it
  (minting read tokens). Mitigations: audience check, per-run TTL, DB-backed revocation
  surface (`runner_tokens` row), read-only mint, scope gated per-mapping server-side.

## Testing

- `token-vending` / new endpoint: auth failures (bad signature, expired, wrong audience,
  consumed-result token), scope-off 403, correct `access_tokens` body (mocked fetch),
  response shape.
- `config.ts`: migration + round-trip of `dependencyTokenScope`, invalid values rejected
  by the admin API.
- `run-config.ts`: encode/decode round-trip with the new field; unknown-key stripping
  still intact.
- Credential helper: expiry-driven refetch against a mock endpoint; non-fatal failure path.
- Fly narrowing: `/api/token` mints with `repositories: [repo]`.

## Documentation

- CLAUDE.md: new "Dependency repo access (admin UI)" subsection; note the Fly narrowing.
- `docs/workflow-envelope.md`: `dependencyTokenScope` field.
- Release notes: Fly primary-token narrowing as a behaviour change.

## As-built deviations (2026-08-11)

The AII-287 tree implemented this spec with three deltas, recorded here so the doc
stays truthful as a decision artifact:

- **Credential-helper refresh threshold is 10 minutes**, not 5
  (`session/git-credential-helper.sh`).
- **Scoped-token cache TTL is derived from GitHub's `expires_at` minus a 5-minute
  safety margin**, not a fixed 50 minutes (`getScopedInstallationToken` in
  `src/github-app-auth.ts`).
- **`/api/token` mints with `forceRefresh`**: the roll-up merge reconciled this spec's
  repo-narrowing with testing's fresh-mint requirement (AII-207 lineage) by adding a
  `forceRefresh` option to `getScopedInstallationToken` — the endpoint's advertised
  55-minute expiry is only honest on a freshly minted token, never a cache hit.

The release-note requirement in **Documentation** was satisfied by the
"Fly/local primary-token narrowing (behaviour change)" subsection in CLAUDE.md —
the repo has no separate changelog convention.
