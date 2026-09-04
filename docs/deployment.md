# Deploying the orchestrator

How an orchestrator instance gets deployed, how a new client instance is stood up, and how to point a target repo at AWS Bedrock.

Reference for `src/deploy.ts`, `scripts/provision-client.sh`, `clients/`, `.github/workflows/deploy-clients.yml`, and the Bedrock path in the synced workflows. `CLAUDE.md` carries the summary and points here.

## Deploy paths

Every path below ships the orchestrator **and** the knowledge graph as one image: a data refresh is a code deploy, and a code deploy re-materializes the graph from the KG repository's default branch. [kg-architecture.md](kg-architecture.md#the-monolith) covers what that couples.

Three ways an orchestrator gets deployed, in descending order of how often they are actually used.

### Self-deploy — the standard path

The orchestrator builds and releases its own next version. Trigger one from an authenticated admin session:

```bash
# A session token comes from POST /api/auth with the access code, or from the
# session cookie an SSO sign-in already set in the browser.
curl -X POST https://<app-name>.fly.dev/api/deploy -H "Authorization: Bearer <session-token>"
```

| Response | Meaning |
|---|---|
| `202 {"deploying":"<sha>"}` | Accepted. The deploy has started, not finished. |
| `409 deploy-in-progress` | A deploy is already running. |
| `503 head-unknown` | The watched branch's HEAD could not be read. |
| `501` | This orchestrator is not configured to deploy itself. |

It pauses dispatch, waits for in-flight work to drain, fetches the source at the branch HEAD, builds with the sidecar secret and the source stamps, then releases. **The release replaces the machine running the deploy**, so the process is killed partway through and the 202 is the last thing it can tell you. The *incoming* process reports the outcome instead: at boot it records whether the release completed, came up without a working knowledge graph, or never released at all, and `/admin#deployments` shows that record. A build failure is recorded by the process that survived it, since a build that fails never replaces anything.

Four things must be true, and they are not all reported the same way:

- **`FLY_DEPLOY_TOKEN`** is set, scoped to this app. `FLY_SESSIONS_TOKEN` is a different credential and cannot deploy the orchestrator.
- **The running image carries its source stamps.** `AI_IMPLEMENT_SOURCE_REPO` (as `owner/repo`) and `AI_IMPLEMENT_SOURCE_BRANCH` are both required; an image built without them cannot self-deploy at all. `AI_IMPLEMENT_SOURCE_COMMIT` is not required — without it a deploy still runs, but availability reports *unknown* rather than telling you a new version exists.
- **An admin auth method is configured** — SSO providers or `ADMIN_ACCESS_CODE`. Every `/api/` route answers 503 otherwise, this one included.
- **The GitHub App installation can read this repository.** Its token is minted at `contents: read`, scoped to the source repo. If `KG_SOURCE_REPO` is set, the installation must also cover that repository; an unset value builds sidecar-less without requiring that second grant — the orchestrator boots normally, but `/mcp` returns 503. The Docker build arg is baked into the image as a non-secret environment value so later self-deploys keep using the same graph repo unless a runtime env override changes it.

The **Watched source** fields in `/admin#deployments` — owner/repo and ref — can shadow the build stamps. When both are set, the configured repo and ref take precedence over `AI_IMPLEMENT_SOURCE_REPO` and `AI_IMPLEMENT_SOURCE_BRANCH` for availability checks and deploys; clearing either restores the stamped values. A ref selector populated from the repository's branches and tags appears on blur.

When the configured ref's HEAD is behind the running commit by any number of commits, the watched-source card shows: *⚠ This ref is behind the running commit — deploying it is a downgrade.* The comparison uses the GitHub compare API; when either commit is unknown, no warning appears rather than a speculative one.

The first two and the app name collapse into a single `501`, which says the orchestrator cannot deploy itself without saying which piece is missing. The third is a different 503, raised at the `/api/` gate before this route is reached. The fourth is **not checked up front** — a token that cannot read a repository surfaces as a failed build, after the hold has already been taken and released.

The app it deploys is never configured: Fly injects `FLY_APP_NAME` into every machine, so an orchestrator can only ever deploy itself.

### Automatic self-deploy

`/admin#deployments` can release every new commit on the watched branch without being asked. Two properties make that safe to leave on:

- **One attempt per commit**, remembered across restarts. A commit is deployed at most once whether the attempt succeeds or fails, so a failed automatic deploy waits for the next push or a manual trigger rather than being retried. Without that rule a persistently failing build would re-take the hold every poll cycle and dispatch would never resume.
- **The hold is taken by the poll that notices the commit**, before the build starts, so nothing is dispatched into a version that is about to be replaced.

Switching it on does not reach back for a commit that has already been announced; that one needs the manual trigger. The trigger itself applies no availability check, so it will rebuild and re-release a commit that is already running — which is how a degraded release gets repaired.

### Availability watch

Three layers detect that a new commit is available on the watched ref, in descending order of latency:

| Layer | Trigger | Requirements |
|---|---|---|
| Push webhook | GitHub delivers a `push` event to `/api/github/webhook` on each commit to the watched ref | App subscribed to `push` events; `GITHUB_WEBHOOK_SECRET` set; publicly reachable orchestrator |
| **Check now** | Button in the watched-source card on `/admin#deployments` | Admin session |
| Poll | Every poll cycle | Nothing — always active |

The push webhook matches only the stamped source repository (the one baked into the image at build time). If `watchedRepo` points at a repository where the App is not installed, no `push` events arrive from it and only the poll and **Check now** layers apply.

### Manual deploy — cold start and recovery

Needed whenever there is no working orchestrator to ask: a brand-new app, an image that will not boot, or a release that broke the deploy path itself. This is the path that has to keep working when everything else does not.

```bash
# Exported, not inlined — an inline `GH_TOKEN=... fly deploy ... "$GH_TOKEN"` prefix
# does not affect same-line expansion and passes an empty secret.
export GH_TOKEN="$(gh auth token)"

fly deploy --remote-only --no-cache \
    --build-secret kg_token="$GH_TOKEN" \
    --build-arg KG_SOURCE_REPO="${KG_SOURCE_REPO}" \
    --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" \
    --build-arg SOURCE_REPO=BuildDownAI/AI-Implement \
    --build-arg SOURCE_BRANCH="$(git rev-parse --abbrev-ref HEAD)" \
    --app <app-name>
```

Then confirm the release actually serves, because booting is not serving:

```bash
curl -s -w '\n%{http_code}\n' -X POST https://<app-name>.fly.dev/mcp -d '{}'
```

**401 is success** — alive and OAuth-gated. **503 means it is not serving**, from either a sidecar-less image or an unset `OAUTH_REDIRECT_BASE_URL`. The two are indistinguishable by status, which is why the body is worth printing: it names the one that fired.

Every flag above is load-bearing, and each was learned from a silently degraded deploy:

- **`--build-secret`** — the KG is cloned at build time through it. Without it the build fail-softs to a sidecar-less image and reports success.
- **`--build-arg KG_SOURCE_REPO`** — the GitHub `owner/repo` to clone for the sidecar. Omit it (or leave `$KG_SOURCE_REPO` unset) to build without a KG sidecar; the orchestrator boots normally but `/mcp` returns 503. Set it to a project-specific graph such as `Answer9-llc/knowledge-graph-answer9-app` when needed. URLs and malformed values are rejected.
- **`--no-cache`** — a build secret is not part of the layer cache key, so a repeat deploy otherwise reuses a stale, possibly sidecar-less clone layer even when the secret is present.
- **`--build-arg SOURCE_*`** — the stamps. Omit `SOURCE_REPO` or `SOURCE_BRANCH` and the image you just deployed cannot deploy itself, which is how a manual recovery quietly disables the automatic path.
- **`--app`** — always explicit. A default would let a fork deploy itself over the upstream app.

Substitute your own `SOURCE_REPO` when deploying a fork; it must be `owner/repo`, and a malformed value logs a warning and disables self-deploy on the resulting image.

`KG_SOURCE_REPO` is not a secret. Manual deploys bake the build arg into the image as `ENV KG_SOURCE_REPO`,
and `loadConfig()` reads that value at runtime for the next self-deploy. A Fly secret or environment
variable with the same name still wins at runtime, which is useful for changing the graph repo before
the next deploy; the next image will then bake that resolved value. A malformed runtime override logs a
warning and disables self-deploy instead of crashing the orchestrator or silently selecting a different graph.

### Fly's native GitHub integration

A Fly app can watch a branch and deploy on push, with no workflow involved. Fly documents little of this, so the behaviour worth knowing:

- **The attached app wins over `fly.toml`'s `app` key.** Deploys reach the attached app despite a different name in the root toml, and no stray app is created — so one repo can serve several apps without per-app toml edits.
- **Auto-deploy is off by default, and the toggle only appears *after* attaching the repo.** Every new connection must enable it explicitly, or pushes deploy nothing.
- **Attaching does not itself deploy.** The first deploy happens on the next push to the watched branch.
- **The release `USER` field shows the connecting account even for integration deploys**, so it cannot distinguish an automated deploy from a manual one. Correlate by timestamp instead.

**This path cannot carry the sidecar, and that is why self-deploy exists.** An integration deploy has no hook for a BuildKit build secret — no pre-deploy command, nowhere to pass `--build-secret`, no `fly.toml` key for one — so every push-triggered release ships a sidecar-less image whose `/mcp` answers 503, silently overwriting a good manual deploy. Leaving auto-deploy enabled on an app that serves `/mcp` will undo a working deploy on the next merge.

### Using a public source repository

When `watchedRepo` in `/admin#deployments` points at a repository the GitHub App is not installed on, availability checks and deploy fetches fall back to an App JWT. GitHub accepts App JWTs for reading public repositories without an installation scope, so a public upstream fork can be watched and deployed without installing the App on the upstream organisation.

Two caveats apply:

- **Deploys whatever upstream pushes.** The source tarball is fetched from the configured upstream ref, not from your fork, so the resulting image is built entirely from upstream code. Any `custom/` steps in your fork are absent from the image.
- **No push webhook.** The App is not installed on the upstream repository, so GitHub delivers no `push` events from it. Only the poll loop and **Check now** detect new commits on the upstream ref.

A private upstream repository that the App cannot read fails at tarball fetch time with a message naming the missing installation rather than silently building a stale image.

## Client instances

Each client is a separate Fly app described by a file in `clients/<slug>.toml`. Copy `clients/example-client.toml` to start, or use the guided helper:

```bash
./scripts/provision-client.sh <client-slug>
```

Manual equivalent:

```bash
cp clients/example-client.toml clients/<slug>.toml
# edit the file, then:
fly apps create <app_name> --org <org>
fly volumes create dedup_data --size 1 --region iad --app <app_name>
fly secrets set GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY=... --app <app_name>
```

The Fly volume `dedup_data` mounts at `/data` and holds the SQLite database. Only the GitHub App pair is required for the orchestrator to boot; ticketing credentials are needed for it to poll anything. See `.env.example` for the full set.

### The matrix workflow does not currently deploy clients

`.github/workflows/deploy-clients.yml` exists and triggers on pushes to `main`, building a deploy matrix by globbing `clients/*.toml`. **In practice it always deploys nothing**, because `.gitignore` excludes `clients/*.toml` and un-ignores only the example — which the workflow explicitly skips. Every run finds zero clients, emits an empty matrix, and skips the deploy job via its own guard, reporting success.

So a client toml is local-only unless force-added, and client instances are deployed through the wrapper script or the Fly integration rather than by this workflow. Treat the workflow as inert until that is deliberately resolved one way or the other.

### Per-instance Fly commands

```bash
fly secrets set KEY=value --app <app_name>   # set secrets
fly logs --app <app_name>                    # tail logs
fly ssh console --app <app_name>             # shell into the machine
```

### Per-project secrets (Fly)

Secrets set through the admin UI Secrets panel are stored as classic Fly app secrets on the **shared sessions app**, prefixed with the team key — for example, a secret named `QA_PROBE` on the `SAN` mapping is stored as `SAN_QA_PROBE`.

Classic Fly app secrets are **app-wide**: Fly injects every classic secret into every machine on the sessions app under its stored name, regardless of which team that machine belongs to. The Fly Machines API `processes[].secrets` field with `env_var` remap only applies to the non-GA named-secrets feature and has no effect on classic secrets.

The runner entrypoint (`session/entrypoint.sh`, via `remap_team_secrets` in `session/lib.sh`) is the isolation boundary. When `AI_IMPLEMENT_TEAM_SECRET_PREFIX` is set, the entrypoint runs before the `su -p coder` handoff and:

1. Remaps each own-team secret (`<TEAM>_<NAME>`) to its unprefixed form (`<NAME>`), making it available to setup hooks and the agent.
2. Unsets foreign-team secrets — names from other team mappings that are listed in `AI_IMPLEMENT_FOREIGN_SECRET_NAMES` — so machines dispatched for one team cannot read another team's secrets even though Fly injected them.
3. Leaves global machine secrets (secrets with no team prefix, set on the sessions app for shared use) untouched — they pass through unchanged and are visible to every machine.
4. Sets `AI_IMPLEMENT_FORWARDED_SECRETS` to a comma-joined list of the bare names exposed (e.g., `QA_PROBE,DB_URL`).

`buildSessionMachineConfig` (in `src/fly-machines.ts`) passes two env vars so the entrypoint knows which names to process:
- `AI_IMPLEMENT_TEAM_SECRET_PREFIX=<TEAM>_`: the own-team prefix; the entrypoint scans the environment for vars with this prefix and remaps them.
- `AI_IMPLEMENT_FOREIGN_SECRET_NAMES=<comma-joined list>`: names that start with another team's prefix; the entrypoint unsets these. Global secrets are absent from this list and pass through unchanged.

If a team secret's bare name (the part after the team prefix) matches a reserved orchestrator variable — `GITHUB_*`, `ISSUE_*`, `AI_IMPLEMENT_*`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `SESSION_TOKEN`, `MACHINE_NONCE`, `RUN_TOKEN`, `ORCHESTRATOR_URL`, `RUNNER_CALLBACK_URL`, `WORKSPACE_DIR`, `PATH`, or `HOME` — the entrypoint logs a warning and skips the export rather than overwriting the orchestrator-issued value. The same names are rejected at the admin UI level by `handleSetSecret` in `src/admin.ts`, so well-formed deployments never reach that guard.

### Process-level secrets (AII-491 spike)

The process-level secrets setting is controlled via the **Runners page** in the admin UI (`/admin#runners`), under the runner-mode controls. The setting is persisted in the `settings` table and takes effect on the next dispatch without a restart. `FLY_PROCESS_LEVEL_SECRETS` remains as an environment variable override: when set to a truthy value (`true`, `1`, or `yes`, case-insensitive), it wins over the UI setting at runtime and the Runners page shows the toggle disabled with an override warning. Anything else, including empty, means the env var is not set and the UI setting applies.

Setting this to enabled switches `buildSessionMachineConfig` to a stricter isolation mode. Instead of setting `AI_IMPLEMENT_TEAM_SECRET_PREFIX` / `AI_IMPLEMENT_FOREIGN_SECRET_NAMES` and relying on the entrypoint filter, the machine config sets `processes[0].ignore_app_secrets: true` and enumerates only the secrets the machine should receive in `processes[0].secrets`:

- Own-team secrets (`<TEAM>_<NAME>`) → `{ env_var: "<NAME>", name: "<TEAM>_<NAME>" }` (remapped to bare form)
- Foreign-team secrets → excluded entirely
- Global secrets (no team prefix) → `{ env_var: "<NAME>" }` (passed through unchanged)

The entrypoint remap/filter logic remains active in both modes but is a no-op when the flag is on, since the machine already receives bare names with foreign names absent. The orchestrator also sets `AI_IMPLEMENT_FORWARDED_SECRETS` to the comma-joined bare names of the own-team secrets in `processes[0].secrets`, so `modelProcessEnv()` strips them from the agent's environment before Claude Code starts.

**This flag is off by default.** Ship it behind the flag, run one probe, then decide:

| Probe result | Action |
|---|---|
| `QA_PROBE` present; `SAN_QA_PROBE` + `AII_PROBE_FOREIGN` absent | Fly honours the list ✅ — leave flag on; file follow-up to make it default |
| `SAN_QA_PROBE` + `AII_PROBE_FOREIGN` still present | `processes` not applied — add `entrypoint: ["/opt/ai-implement/entrypoint.sh"]` to `processes[0]` and retry |
| No `QA_`, `SAN_`, `AII_` vars present | `ignore_app_secrets` applied but the list did not resolve — turn flag off; entrypoint filter remains the boundary |

The dispatch log line (written only when the flag is on) lists the requested secret *names* (never values) so the outcome can be read from the orchestrator log as well as the probe hook report.

## Using AWS Bedrock

To run a target repo against Bedrock instead of the Anthropic API, use the **GitHub Actions execution mode**. Bedrock is not supported on Fly Machines or local Docker: those backends have no equivalent of GitHub's OIDC role assumption, and the runner entrypoint rejects `provider=bedrock` outside GHA mode outright.

1. **In the admin UI (`/admin`)**, edit the repo's mapping: set **Provider** to `bedrock` and **AWS Region** to the region hosting your inference profile (e.g. `us-west-2`).
2. **In the target repo**, add a repository secret `AWS_BEDROCK_ROLE_ARN` — an IAM role trusting the GitHub OIDC provider for that repo, with `bedrock:InvokeModel` on the profiles you need.
3. **In the target repo**, add two repository *variables* so `/ai-implement` comment-triggered runs route to the same provider:
   - `AI_IMPLEMENT_PROVIDER` = `bedrock`
   - `AI_IMPLEMENT_AWS_REGION` = the same region
4. **In the target repo's `WORKFLOW.md`** (and `PLANNING.md` if planning is enabled), change `model:` to a Bedrock model ID or inference-profile ARN.

**Step 4 is not optional and nothing enforces it.** The workflows validate that `aws_region` and `AWS_BEDROCK_ROLE_ARN` are present, and fail clearly when they are not — but **nothing validates the model against the provider**. An Anthropic-style ID left in front matter is passed to Bedrock verbatim and fails at Claude invocation time with a provider error rather than a configuration error.

IAM trust policy shape, scoped to one repo:

```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
    "StringLike":   { "token.actions.githubusercontent.com:sub": "repo:<owner>/<repo>:*" }
  }
}
```

Credentials are configured once before the containerized runner step with a **4-hour session duration**, covering the implementation and gap-analysis runs in a single job. Only GitHub OIDC is supported — there is no static-key path.

## KG embeddings health

Two steps in the image build bake the embedding model and graph embeddings — both can fail without failing the build (fail-soft, so lexical search still works). The risk is a silent regression: a build that skips embeddings is indistinguishable from a healthy build in the deploy log.

**Receipt rule:** every fail-soft build step that skips meaningful work must write `/app/kg/.embeddings-failed` into the image. `|| echo` alone is not sufficient — the failure is visible in build logs but invisible to monitoring across deploys. The marker is the machine-readable contract between the build and the boot-time entrypoint.

When the sidecar starts and the marker is present (or `out/embeddings.npz` is absent), `docker-entrypoint.sh` logs a warning and sets `KG_EMBEDDINGS_DEGRADED=1` in the Node process. The flag surfaces in two places:

- **`GET /`** returns `kgDegraded: true` so uptime monitors can alert on it.
- The **`deployed` / `restarted` deploy notification** includes a warning line: _⚠️ KG embeddings missing — /mcp is lexical-only_.

To repair a degraded image, re-deploy with `--no-cache` and a working `--build-secret kg_token`. A cached layer from a previous degraded build will reuse the bad output even when the underlying problem is fixed — `--no-cache` is not optional for this recovery.
