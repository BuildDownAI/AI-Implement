# Private npm registry

How the built-in `install` step authenticates to a private npm registry, why the credential arrives through the forwarded-secrets rail rather than a dedicated secret, and where the token does and does not exist during a run.

## The problem

A target repo whose `package.json` depends on packages from a private registry (Artifactory, GitHub Packages, Verdaccio, …) fails inside the runner at `npm ci` / `yarn install --frozen-lockfile` / `pnpm install --frozen-lockfile` with a 403, because the runner container has no registry credentials and the clone carries none.

The obvious fix — export the token from a `setup:` hook — does not work. The pipeline order is `clone → reference-repos → install-skills → dependency-auth → install → setup → feedback-loop` (see `pipelines/autonomous.yml`), so `install` has already failed by the time any hook runs. That is why this lives in the install step itself (`configureNpmAuth()` in `src/pipeline/steps/install.ts`).

## Configuration

Three values, all on the target repo (or its org). The token is a forwarded secret; the other two are plain Actions variables.

| Name | Where | Purpose |
|---|---|---|
| `NPM_TOKEN` | a `NPM_TOKEN=<token>` line inside the `AI_IMPLEMENT_FORWARDED_ENV` Actions **secret** | Registry auth token |
| `AI_IMPLEMENT_NPM_REGISTRY` | Actions **variable** | Registry URL, e.g. `https://your.registry.example/artifactory/api/npm/npm/` |
| `AI_IMPLEMENT_NPM_SCOPE` | Actions **variable**, optional | Comma-separated npm scope(s) to route to that registry, e.g. `@acme` or `acme, other` |

Both `claude-implement.yml` and `claude-plan.yml` pass the two variables through to the runner, and the templates' "Forward repository secrets" step delivers the token, so **no `.npmrc` needs to be committed to the target repo**. The passthrough takes effect only after the target repo re-syncs the workflows.

`AI_IMPLEMENT_NPM_SCOPE` is required in practice for a scoped registry. Without it only the `_authToken` line is written, npm keeps routing scoped packages to `registry.npmjs.org`, and the token is never sent. Omit it only when the registry is already the configured default for the repo by some other means.

**Why the token is not `AI_IMPLEMENT_NPM_TOKEN`.** Both forwarding rails — the GHA "Forward repository secrets" step and the Fly `remap_team_secrets` entrypoint pass — reserve the `AI_IMPLEMENT_` prefix (and `RUN_`) so a forwarded value cannot overwrite an orchestrator-managed variable. A token under that name would be rejected by the rail. `NPM_TOKEN` is the conventional name npm tooling already uses, and it passes validation.

On Fly the same name works as a per-project team secret (`<TEAM>_NPM_TOKEN`, remapped to `NPM_TOKEN` by the entrypoint). The two variables cannot ride the team-secret rail (same reserved prefix); set them as global sessions-app secrets, which pass through unchanged.

## What the install step does

When **both** `NPM_TOKEN` and `AI_IMPLEMENT_NPM_REGISTRY` are present and there is a `package.json` to install:

1. Builds the npm config lines: `//<registry host and path>/:_authToken=<token>`, plus one `@<scope>:registry=<registry>` line per scope. The registry URL is normalised to a trailing slash; the scheme is stripped from the auth line as npm requires.
2. If `~/.npmrc` exists, copies its contents first, so the per-run file augments rather than shadows whatever the runner image ships.
3. Writes the result to a fresh temp directory (`mkdtemp`, file mode `0600`) and spawns the install command with `NPM_CONFIG_USERCONFIG` pointing at it. npm, yarn classic and pnpm all honour that variable (yarn and pnpm read `npm_config_*` case-insensitively).
4. Removes the temp directory in a `finally`, whether or not the install succeeded.

When either value is missing the step behaves exactly as before. In mounted-workspace mode (`npm run dev:run`) the install step no-ops, so nothing is written.

## Where the token exists — and where it does not

The point of the design is that the token is a **build-time input to one step**, not a run-wide credential.

- **Install process env** — yes. `install` spawns with `repoProcessEnv()`, which keeps forwarded secrets.
- **Setup / verify / teardown hooks** — yes, as `NPM_TOKEN` in the env (the forwarded rail's normal contract). The temp `.npmrc` is already gone, so a hook that runs its own install must write its own config.
- **The model process** — no. `modelProcessEnv()` strips every name listed in `AI_IMPLEMENT_FORWARDED_SECRETS`, and additionally strips `NPM_TOKEN` by name so a token injected outside the rail (an app-wide Fly secret, a local Docker `-e`) is still hidden.
- **On disk after install** — no. Nothing is ever appended to `~/.npmrc`; the temp user config is unlinked before the feedback loop starts, so the model cannot read the token back from the filesystem.

The residual exposure is `node_modules` itself: packages fetched from the private registry are in the workspace, as they must be for the implementation to build. The credential is not.

## Consequences worth knowing

- The model cannot install a **new** private-registry dependency during the feedback loop — its `npm install @acme/new-pkg` will 403 because neither the token nor the config survives past the install step. Repos where the implementer is expected to add private packages should pin them in `package.json` on the issue's branch first, or accept that such changes fail the implementation pass.
- The token is masked in GHA logs by the forwarding step (`::add-mask::`), so an install failure that echoes the registry URL never prints the credential.
- Three of the four validations in the forwarding step apply here: the line must be `KEY=VALUE`, the value must be non-empty, and the name must not use a reserved prefix. A malformed `AI_IMPLEMENT_FORWARDED_ENV` fails the job before the runner starts — that is the forwarding rail's behaviour, not this feature's.
