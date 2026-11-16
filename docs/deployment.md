# Deploying the orchestrator

How an orchestrator instance is deployed, how a new client instance is stood up, and how to point a target repo at AWS Bedrock.

Reference for `src/deploy.ts`, `src/provision-client.ts`, `clients/`, `.github/workflows/deploy-clients.yml`, and the Bedrock path in the synced workflows. `CLAUDE.md` carries the summary and points here.

## GitHub App permissions (install prerequisite)

The orchestrator authenticates to GitHub as a GitHub App and mints short-lived installation
tokens scoped to exactly the permission a feature needs. The App must therefore **hold** every
permission below, and its installation must cover every repository the orchestrator serves
(the KG source repo, the base template repo, and each onboarded project). A missing grant does
not fail boot; it fails the feature that needs it, late and quietly (a 4xx inside a run, or a
`hint` on a `get_tenant_health` preflight row).

| Repository permission | Level | Needed by |
|---|---|---|
| Contents | Read and write | cloning repos and dependency tokens (read); pushing `kg-refresh/<stamp>` snapshot branches and the publication token (write) |
| Pull requests | Read and write | reading PRs for gap-fill matching and dependency tokens (read); opening the refresh PR, roll-up PRs and posting PR comments (write) |
| Workflows | Read and write | the publication token used to push workflow-carrying commits from a run |
| Commit statuses | Read and write | the `kg-refresh/dry-run` commit status set by the PR-triggered KG dry-run check (AII-633); without it the check is comment-only |
| Actions | Read and write | `workflow_dispatch` of the planning/implementation/kg-refresh workflows on the GitHub Actions runner path, and reading run status |
| Checks | Read-only | reading check runs on a PR head (`…/commits/{sha}/check-runs`) for the post-push review's external-review wait gate and the roll-up gate |
| Issues | Read and write | PR comments go through GitHub's issue-comment endpoints: `postPrComment` / `updatePrComment` / `postOrUpdateStickyComment` (gap analysis, refresh PR, review verdicts, KG dry-run comment) and `addCommentReaction` on the `/ai-implement` comment rail — for every provider, on every envelope repo |
| Metadata | Read-only | granted to every App automatically |

Plus whatever the runner's own GitHub Actions workflows need on each project repo (those are
declared in the workflow files, not here). The list above is the set of `permissions: {…}`
scopes requested in `src/` plus the grants the per-run installation token relies on (it carries the
App's full permission set scoped to one repository); a change that mints a token for a new permission must add a row
here and grant it on the App before the feature is switched on (tracked for automation in
AII-645: one declared table, probed on `get_tenant_health`, shown on the admin page, and an
App manifest for new installs).

**Granting or widening a permission is two steps by an org owner, not a per-repository
setting.** GitHub App permissions live on the App; each installation then has to accept the
change:

1. App settings → *Permissions & events* (for an org-owned App:
   `https://github.com/organizations/<org>/settings/apps/<app-slug>/permissions`) → set the
   repository permission → **Save changes**.
2. The installation (`https://github.com/organizations/<org>/settings/installations/<id>`; ids
   from `gh api orgs/<org>/installations`) shows a review banner → **Review request** →
   **Accept new permissions**.
3. Verify: `gh api orgs/<org>/installations --jq '.installations[] | select(.app_slug=="<app-slug>") | .permissions'`
   lists the new level, and `get_tenant_health` shows the matching preflight row with
   `status: 200` and no `hint`.

The App is created once per orchestrator (`GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` secrets);
its webhook must point at the orchestrator's `/api/github/webhook` with the
`GITHUB_WEBHOOK_SECRET`.

## Deploy paths

Deployments with `KG_SOURCE_REPO` ship the orchestrator **and** the knowledge graph as one image: a data refresh is a code deploy, and a code deploy re-materializes the graph from the KG repository's default branch. Shared published images omit the knowledge graph. [kg-architecture.md](kg-architecture.md#the-monolith) covers what that couples.

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
| `202 {"deployId","commit","image","alreadyActive"}` | Accepted. The deploy has started, not finished. A call while one is active returns the active deploy's id with `alreadyActive: true`. |
| `409 image-not-published` | The commit has no successful image publication status (see "The image rule"). |
| `503 head-unknown` | The watched branch's HEAD could not be read. |
| `400 unsupported-branch` | The watched ref is not `testing` or `main`, the two with published image channels. |
| `501` | This orchestrator is not configured to deploy itself. |

`POST /api/deploy-cancel` (admin only) cancels a deploy still in `draining`; later phases answer `{ "cancelled": false, "reason": "too-late" }`.

**The `SelfDeploy` object.** The admin Deploy button, the auto-deploy loop, and the `start_deploy` tool (used by the BuildDown control plane) call `SelfDeploy.start` (a Restate virtual object keyed by `FLY_APP_NAME`, `src/restate/self-deploy.ts`). It is durable, so the deploy survives the process being replaced, and its state is the one source of truth. Inside the existing target lookup, it resolves `watchedRepo` / `watchedRef` policy overrides and records the chosen `owner/repo` in `target.repo` (also exposed as `selfDeploy.target.repo` by `get_deploy_posture`). The requested branch takes precedence over `watchedRef`. Builds and source checkout use that recorded repository even if policy changes during draining. Its phases:

| Phase | What happens |
|---|---|
| `draining` | The deploy hold is set, so dispatch stops. A delayed `checkDrain` re-checks in-flight work and the old Restate endpoint until quiet; after 75 minutes it ends `failed` with reason `drain-timeout`. This is the only phase `cancel` works in. |
| `applying` | Built images are built, pushed and released by one `flyctl deploy --remote-only --no-cache` command. Published images update each machine, or use `flyctl deploy --image` when the fly.toml option is on. A rejected apply ends `failed` / `apply-failed`. |
| `verifying` | The new process reports its `AI_IMPLEMENT_SOURCE_COMMIT`; five polls without a match end `failed` / `verify-timeout`. |
| `succeeded`, `failed`, `cancelled` | Terminal. The hold is released and the outcome is recorded. |

**The image rule.** Without `KG_SOURCE_REPO` the deploy applies the published image `registry.fly.io/<FLY_IMAGE_APP or builddown-orchestrator-image>:<branch>-<sha7>`, and refuses with `image-not-published` unless the latest GitHub commit status with context `orchestrator-image/published` is `success`. Whoever publishes the image — the [AII-1602](https://linear.app/eudoxus/issue/AII-1602/publish-an-orchestrator-image-for-each-push-to-testing-and-main-and) workflow or the manual `bd-image-push` script — must set this status on the commit after pushing the image. The check uses a repository-scoped GitHub App installation token with `statuses: read`; tenants need no access to the shared registry. A 401/403 refuses deployment and logs `[self-deploy] image check unauthorized HTTP <status>`. With `KG_SOURCE_REPO` set it builds `registry.fly.io/<app>:deploy-<sha7>` from the source tarball with the KG build secret, and releases it in the same `flyctl deploy --remote-only --no-cache --image-label deploy-<sha7>` call. Fly waits until it can use the image; no separate registry probe or Machines API update follows.

**Publishing shared images.** `.github/workflows/publish-orchestrator-image.yml` builds and pushes on every push to `testing` and `main`, including docs-only changes. Manual `workflow_dispatch` selects one of those branches and publishes its current head, independently of the workflow ref. The tag is `<branch>-<sha7>` (for example, `registry.fly.io/builddown-orchestrator-image:testing-abcdef0`). Checkout, tag, full `SOURCE_COMMIT`, `SOURCE_REPO` and `SOURCE_BRANCH` stamps, and publication status all describe the same commit. No `KG_SOURCE_REPO` is passed: this shared image has no knowledge graph. The job summary shows the image reference. The existing `orchestrator-image.yml` remains the PR build/boot gate.

Configure this repository Actions secret:

- `FLY_IMAGE_PUSH_TOKEN` (required): a Fly deploy token scoped only to `builddown-orchestrator-image`. Missing credentials fail with an explicit error. The installed token `gha-publish-orchestrator-image` expires 2027-11-02; rotate it before expiry.

After a successful push, the workflow uses `GITHUB_TOKEN` with `statuses: write` to set `orchestrator-image/published` to `success` on the published commit, with the image reference as its description. Build/push failure sets no status. Newer runs cancel superseded Docker validation builds per branch. After validation, a separate publication job rebuilds remotely with Fly and serializes publication per branch without cancelling an active publisher. Its job-level `always()` condition protects the entire remote build/push and status update, including the interval before flyctl reports push success. Dispatch publishes the exact commit resolved by validation.

Orchestrators update themselves through their own auto-deploy; the control plane does not trigger updates.

To verify a published image operationally, run `fly machine update <machine> -a <scratch-app> --image <image reference>` and verify the full pushed commit through `GET /`: `curl -fsS https://<scratch-app>.fly.dev/ | jq -e --arg commit "<full pushed sha>" '.status == "ok" and .sourceCommit == $commit'`. The `sourceCommit` field exposes `AI_IMPLEMENT_SOURCE_COMMIT` (or `null` for unstamped builds).

**Outcome.** The object's terminal record is written to `deploy_last_outcome` and announced on the notice webhook (failures and cancellations; a success is announced by the new process's boot notice). `succeeded` is `deployed-ok`, `failed` is `deploy-failed` and `cancelled` is `deploy-cancelled`, the latter two with the reason code in `detail`. `/admin#deployments`, `get_deploy_posture` (`lastOutcome`) and `GET /api/deployment-status` (`lastDeployOutcome`, plus `selfDeploy` and `applyFlyTomlAllowed`) read it. Log lines read `[self-deploy] <deployId> <phase> <reason>`; the `draining` line includes the target repository after the phase. Boot no longer guesses an outcome, so the old `deployed-not-serving` signal (sidecar missing or failing its probe) is no longer written; sidecar health is reported by `GET /` and `get_kg_status`.

**Apply failures and retries.** The bounded `apply image` effect makes at most three attempts, with 100 ms then 200 ms backoff. Built deploys have a 20-minute flyctl deadline per call. Published Machines API 409 (conflict/lease) and 429 (rate limit) retry; other 4xx responses fail immediately. Transient server/transport errors and published-image flyctl errors also retry. A built flyctl failure rereads machines once to reconcile an accepted release; if they do not all run the target image, it ends with `apply-failed` without another flyctl attempt. Each attempt rereads machine configuration and returns success when all machines already run the target image, including after an interrupted release replaces its own process. The `deploy-<sha7>` label keeps the released image equal to the recorded target, preventing a second deploy on replay. The journal still runs `apply policy` then `apply image`, with no added journal operations. Every caught error logs `[self-deploy] <deployId> apply error <operation> HTTP <status> <message>` (`unknown` when no status is available). Messages are single-line, limited to 200 characters, and stripped of credentials (including quoted response-body values), command arguments and URLs, including relative URL query strings. The final sanitized diagnostic is journaled with the effect result and passed separately to the outcome callback; the failure notice includes it after `apply-failed`. The durable deploy record and tool contract shapes stay unchanged.

**Apply fly.toml on deploy.** A published-image deploy only changes each machine's image by default. Built deploys always apply fly.toml through their build-and-release command. For published images, a VM size or mount change needs the "Apply fly.toml on deploy" option, or a manual `fly deploy`. The option is `options.applyFlyToml` in the `SelfDeploy` object's state (default off, no env seed, no SQLite key), set with `POST /api/deploy-policy {"applyFlyToml": true}`. It is refused with `409 apply-fly-toml-refused` when `FLY_IMAGE_APP` is set, because the control plane owns that machine's config and `fly.toml` would change its VM size and mount.

**The hold and recovery.** Boot keeps the deploy hold until the first successful Restate registration, then uses the loopback `SelfDeployRecovery` service to call this app's private, exclusive `SelfDeploy.releaseUnownedHold` handler. It reads the record and clears an unowned hold under the same object lock as `start`, so a new deploy cannot race recovery. A deploy in `draining`, `applying` or `verifying` owns the hold, so boot preserves it. If there is no deploy, or the record is terminal, boot clears the unowned hold and dispatch resumes. A failed recovery call keeps the hold set and logs why. This also recovers a crash between setting the hold and the object's first journaled write. `cancel` works only in `draining`. A deploy in `applying` or `verifying` ends on its own: the apply fails, or `verify-timeout` follows five polls without the new commit, and either releases the hold.

**First release.** The first release containing this change is still deployed by the old in-memory deploy. The new process releases that legacy hold after successful Restate registration finds no active `SelfDeploy` record; the next deploy is the first to go through `SelfDeploy`.

Four things must be true, and they are not all reported the same way:

- **`FLY_DEPLOY_TOKEN`** is set, scoped to this app. `FLY_SESSIONS_TOKEN` is a different credential and cannot deploy the orchestrator.
- **The running image carries its source stamps.** `AI_IMPLEMENT_SOURCE_REPO` (as `owner/repo`) and `AI_IMPLEMENT_SOURCE_BRANCH` are both required; an image built without them cannot self-deploy at all. `AI_IMPLEMENT_SOURCE_COMMIT` is not required — without it a deploy still runs, but availability reports *unknown* rather than telling you a new version exists.
- **An admin auth method is configured** — SSO providers or `ADMIN_ACCESS_CODE`. Every `/api/` route answers 503 otherwise, this one included.
- **The GitHub App installation can read this repository.** Its token is minted at `contents: read`, scoped to the source repo. If `KG_SOURCE_REPO` is set, the installation must also cover that repository; an unset value builds sidecar-less without requiring that second grant — the orchestrator boots normally, and `/mcp` serves without the `kg_*` tools. The Docker build arg is baked into the image as a non-secret environment value so later self-deploys keep using the same graph repo unless a runtime env override changes it.

The **Watched source** fields in `/admin#deployments` — owner/repo and ref — can shadow the build stamps. When both are set, the configured repo and ref take precedence over `AI_IMPLEMENT_SOURCE_REPO` and `AI_IMPLEMENT_SOURCE_BRANCH` for availability checks and deploys; clearing either restores the stamped values. A ref selector populated from the repository's branches and tags appears on blur.

When the configured ref's HEAD is behind the running commit by any number of commits, the watched-source card shows: *⚠ This ref is behind the running commit — deploying it is a downgrade.* The comparison uses the GitHub compare API; when either commit is unknown, no warning appears rather than a speculative one.

The first two and the app name collapse into a single `501`, which says the orchestrator cannot deploy itself without saying which piece is missing. The third is a different 503, raised at the `/api/` gate before this route is reached. The fourth is **not checked up front** — a token that cannot read a repository surfaces as a failed build, after the hold has already been taken and released.

The app it deploys is never configured: Fly injects `FLY_APP_NAME` into every machine, so an orchestrator can only ever deploy itself.

**CI boots the image before merge.** `.github/workflows/orchestrator-image.yml` builds the root `Dockerfile` on every PR (without the knowledge graph, base image pulled from Docker Hub at the pinned digest) and runs it with its real entrypoint, a throwaway GitHub App key and `DEDUP_DB_PATH` under `/tmp`. The `orchestrator-image` check passes only when `GET /` answers 200 with `status: "ok"`, the Restate sidecar `ready` and registration `registered`, the container still running, and the sidecar reported as unreachable and never probed (`kgUnavailable` is deliberately not asserted `true`: it means "a probe failed", so it stays `false` when no sidecar is ever probed). That proves the image builds, the entrypoint boots, and Restate comes up, which `fly.toml` (no health check) would not catch before a self-deploy. It does not prove a real KG query, ticketing or GitHub App calls, or anything that needs a secret.

### Automatic self-deploy

`/admin#deployments` can release every new commit on the watched branch without being asked. Two properties make that safe to leave on:

- **One attempt per commit**, remembered across restarts. A commit is deployed at most once whether the attempt succeeds or fails, so a failed automatic deploy waits for the next push or a manual trigger rather than being retried. Without that rule a persistently failing build would re-take the hold every poll cycle and dispatch would never resume.
- **The hold is taken by the poll that notices the commit**, before the build starts, so nothing is dispatched into a version that is about to be replaced.
- **A drain that waits on a reservation.** Each held `dispatch_admissions` row counts as in-flight work (`getInFlightWork`), even when its run has ended, so a reservation that was never released keeps the deploy in "Draining". `/admin#deployments` lists every held reservation under the status tile (also the `list_dispatch_reservations` tool). Click **Release** on the stuck row: it releases when the backend run is confirmed ended (a terminal job row alone is refused, because the planning callback closes the row while the run may still execute), and otherwise shows why it refused and offers a forced release behind a confirm. Force only when the run is dead — a Restate-owned or job-less row is never confirmed and needs it. `release_dispatch_reservation` is the same action for MCP/`POST /api/tools/release_dispatch_reservation`. Do not edit `/data/dedup.sqlite` over `fly ssh`.
- **What callers see during a hold.** Every MCP `tools/call` and `POST /api/tools/<name>` answers `409 { "error": "deploy-in-progress", "deployStartedAt": <ms> }` without contacting Restate (admission stays closed so the drain can finish), where a real outage still answers `503 restate-unavailable`. The kg-refresh endpoints answer the same 409, except `GET /api/kg/status` and the decision. Four tools are let through the hold: `get_kg_status` and `get_deploy_posture` (reads), `start_deploy` (a retry during a drain answers `alreadyActive: true`, and the control plane polls the deploy through `get_deploy_posture`), and `decide_kg_refresh` (resolves the durable promise a KG refresh held at the decision gate waits on). All four finish in milliseconds, and deciding is what lets the held run end and the drain finish; without it the operator could not decide and the deploy waited out its drain limit (AII-1401). The Restate-not-ready check still applies to them, and `trigger_kg_refresh` stays refused. The unauthenticated `GET /` health body carries `deploy: { held, startedAt }` (`false` / `null` when no hold is set), so a deploy is distinguishable from an outage.

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

**401 is success** — alive and OAuth-gated. **503 means it is not serving**: `OAUTH_REDIRECT_BASE_URL` is unset, and the body says so. A sidecar-less image still answers 401 here, because `/mcp` serves without the `kg_*` tools; check the sidecar on the health check instead — `curl -s https://<app-name>.fly.dev/`, where `sidecar.checkedAt: null` means no sidecar was probed and `sidecar.toolsListed: true` means it serves.

Every flag above is load-bearing, and each was learned from a silently degraded deploy:

- **`--build-secret`** — the KG is cloned at build time through it. Without it the build fail-softs to a sidecar-less image and reports success.
- **`--build-arg KG_SOURCE_REPO`** — the GitHub `owner/repo` to clone for the sidecar. Omit it (or leave `$KG_SOURCE_REPO` unset) to build without a KG sidecar; the orchestrator boots normally and `/mcp` serves without the `kg_*` tools. Set it to a project-specific graph such as `Answer9-llc/knowledge-graph-answer9-app` when needed. URLs and malformed values are rejected.
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

**This path cannot carry the sidecar, and that is why self-deploy exists.** An integration deploy has no hook for a BuildKit build secret — no pre-deploy command, nowhere to pass `--build-secret`, no `fly.toml` key for one — so every push-triggered release ships a sidecar-less image, whose `/mcp` serves without the `kg_*` tools, silently overwriting a good manual deploy. Leaving auto-deploy enabled on an app that serves `/mcp` will undo a working deploy on the next merge.

### Using a public source repository

When `watchedRepo` in `/admin#deployments` points at a repository the GitHub App is not installed on, availability checks and deploy fetches fall back to an App JWT. GitHub accepts App JWTs for reading public repositories without an installation scope, so a public upstream fork can be watched and deployed without installing the App on the upstream organisation.

Two caveats apply:

- **Deploys whatever upstream pushes.** The source tarball is fetched from the configured upstream ref, not from your fork, so the resulting image is built entirely from upstream code. Any `custom/` steps in your fork are absent from the image.
- **No push webhook.** The App is not installed on the upstream repository, so GitHub delivers no `push` events from it. Only the poll loop and **Check now** detect new commits on the upstream ref.

A private upstream repository that the App cannot read fails at tarball fetch time with a message naming the missing installation rather than silently building a stale image.

A fork that carries `custom/` overrides should not use this path. It updates by merging upstream into its own deploy branch instead — `custom/README.md` § "Updating a fork from upstream". The same section lists the upstream-only files (`CONTRIBUTING.md`, `legal/`, `SECURITY.md`, `.github/workflows/cla.yml`) a fork can drop, and the merge line that keeps them dropped.

## Client instances

Each client is a separate Fly app described by a file in `clients/<slug>.toml`. Copy `clients/example-client.toml` to start, or let the provisioning command (`src/provision-client.ts`) write it:

```bash
npm run provision-client -- <client-slug>
```

The command sets up a self-hosted orchestrator in the operator's own Fly organization, the counterpart of the control plane's set-up, and is run again to change its secrets or add target repositories. The slug takes lowercase letters, digits and hyphens; anything else exits 2.

It opens by saying what it will do and linking the docs site's step-by-step guide, and each question says what its value is for and where to find it, with an example when the value has a known shape. Anything typed while the command is busy is dropped before the next question, so it cannot answer one unseen.

**Before any question** it lists the Fly apps, and the orchestrator app's secret names when that app exists. Fly lists secret names, never values. If `flyctl` is missing or signed out, it stops with exit 1 and nothing changed. For a new client it asks the orchestrator app's name, organization and region, then the sessions app's, whose organization and region default to the orchestrator's.

**The client file** is written for a new client and never replaced after. The command adds an `[answers]` table, which it keeps last, remembering the GitHub App ID, the `.pem` path, both base URLs and `KG_SOURCE_REPO`, none of them secret, so a rerun's knowledge-graph build and closing commands need no question. Everything above that table, an operator's comments included, is kept as written.

**The questions**, in order:

- **Sign-in:** the admin addresses (`OAUTH_ALLOWED_EMAILS`), `RUNNER_CALLBACK_BASE_URL` and `OAUTH_REDIRECT_BASE_URL` (both default to `https://<app>.fly.dev`), then Google or Microsoft. Once the provider is chosen it prints the two redirect addresses to register in the sign-in application, before asking that provider's client credentials, and for Microsoft a single-tenant ID.
- **The ticketing system:** Linear or Jira, and only its own variables. Jira takes basic authentication or OAuth. Switching an instance to OAuth clears `JIRA_EMAIL` after a confirmation, since basic authentication wins while it is set.
- **The GitHub App:** its ID, and the path to its `.pem` file, where a leading `~` is the home directory.
- **Models:** whether projects run on a Claude subscription, which asks `CLAUDE_CODE_OAUTH_TOKEN` for the legacy path. A model API key is never asked; it belongs in an account profile on Models & providers.
- **Optional:** `NOTIFY_TYPE` and `NOTIFY_WEBHOOK_URL`.
- **`KG_SOURCE_REPO`:** asked on every run, since the build bakes it into the image rather than Fly holding it. On a new client Enter builds without a knowledge graph; once the client file remembers one, Enter keeps it, so a rerun cannot drop the graph.
- **A break-glass `ADMIN_ACCESS_CODE`**, if wanted, and then the target repositories, one at a time. Their jobs run in GitHub Actions by default and read the GitHub App pair, and on a subscription the Claude token, as repository secrets, so the command prints the `gh secret set` commands for each one at the end. Entering none skips them.

`RUNNER_TOKEN_SECRET` and `GITHUB_WEBHOOK_SECRET` are generated, and `FLY_DEPLOY_TOKEN` (scoped to the orchestrator app, expiring after one year) and `FLY_SESSIONS_TOKEN` (scoped to the sessions app) are minted as deploy tokens; each of the four is kept when it is already set. Secrets are read with hidden prompts and everything else in the open, and an answer that is refused is asked again, up to three times.

**Every answer is judged before anything is written,** by the setup checks that read only the environment: the `env.*` and `admin.*` checks and `callback.config`. The sign-in and GitHub App checks run as soon as their group is answered, and a group that fails is asked again, with Enter keeping each earlier answer; a last pass runs over every answer. A value already on Fly cannot be read, so a check that rests on one is confirmed only by the setup checks on the orchestrator after the deploy, which also see an admin allowlist saved there.

**Then it writes,** in this order, naming each step as it starts: the client file, the apps that are missing, the deploy tokens, one `flyctl secrets import` over stdin carrying every value (the PEM on one line with literal `\n` escapes), and a `dedup_data` volume in the client's region when there is none. It prints the break-glass code once.

**The deploy, the health wait and the setup checks each ask first.** The deploy is § Manual deploy's remote build of this checkout, stamped with its commit, its branch and its GitHub `origin` repository so a fork deploys itself, with `--primary-region` set to the client's region (`fly.toml` pins `iad`) and `--ha=false` for one machine. A knowledge-graph build gets an App installation token with `contents: read` on that one repository, minted as self-deploy mints it. It is the one secret passed as an argument, since flyctl takes a build secret only that way, and it expires within the hour. When the App cannot read the repository, the command says so and offers a deploy without a knowledge graph. flyctl's output is shown as it runs, line by line, with every secret this run holds redacted, the build token included, since a failed build can echo it. The health wait polls `GET /` for up to 15 minutes and says each minute how long it has waited, and the setup checks run `node /app/dist/check-setup.js` over `flyctl ssh console`, with every secret this run set redacted from their output. Whatever is declined or fails is printed under "Still to run"; a knowledge-graph deploy is re-run through the command, since its token has no hand-run form.

Last, it prints the `gh secret set` commands for each target repository, the GitHub App webhook's address and events, the command that reads the webhook secret, a reminder of the two redirect addresses, the access-recovery command, and a link to the docs site's guide to adding a project and choosing its model access. Anything to copy sits on a line of its own. A rerun that keeps every value in a group shows no heading for it. It exits with the setup checks' own code when they fail, and 1 when the preflight, the health wait or another step failed.

**On a re-run** it offers to keep every value already set and ask only what is missing. Changing `RUNNER_TOKEN_SECRET` makes every stored model credential unreadable, so each one has to be entered again. The orchestrator takes its sessions app from `FLY_SESSIONS_APP` once, at its first boot (seed-once), so the command treats the seed as taken once the orchestrator app has a release, and sets it again on a rerun before any deploy. Once it is taken, the saved runner settings own the sessions app: the command leaves both sessions seed variables alone and creates no sessions app, and the sessions app is changed on `/admin#settings`. If `FLY_SESSIONS_TOKEN` is missing then, it asks the active sessions app's name from `/admin#settings`, so the token is minted for the right app.

The Fly volume `dedup_data` mounts at `/data` and holds the SQLite database. Only the GitHub App pair is required for the orchestrator to boot; ticketing credentials are needed for it to poll anything. See `.env.example` for the full set.

To run the setup checks on a deployed instance again later: `fly ssh console --app <app_name> -C "node /app/dist/check-setup.js"`. It exits 0, or names each fault with its fix ([setup-checks.md](setup-checks.md)).

At boot the orchestrator sets the snapshot retention of every volume in its own Fly app to the `volume_snapshot_retention_days` setting (default 14 days; Fly's own default is 5, its range 1–60), using `FLY_DEPLOY_TOKEN` and the injected `FLY_APP_NAME` through the Machines API (`src/fly-volumes.ts`). Only volumes whose retention differs are updated, and every volume in the app is covered, not just `dedup_data`. The volume also holds the Restate store under `/data/restate`, so a longer window keeps Restate history recoverable. A Fly error or a missing token or app name is logged as `[fly-volumes] snapshot retention not applied: <reason>` and never blocks boot; local runs have neither and always log it. The value is changed on `/admin#deployments` (Retention card, `GET`/`POST /api/retention`): a new volume value is applied to the Fly volumes at once, while a new `restate_retention_days` value applies at the next deploy or restart.

### The matrix workflow does not currently deploy clients

`.github/workflows/deploy-clients.yml` exists and triggers on pushes to `main`, building a deploy matrix by globbing `clients/*.toml`. **In practice it always deploys nothing**, because `.gitignore` excludes `clients/*.toml` and un-ignores only the example — which the workflow explicitly skips. Every run finds zero clients, emits an empty matrix, and skips the deploy job via its own guard, reporting success.

So a client toml is local-only unless force-added, and client instances are deployed through `npm run provision-client -- <slug>` and the manual deploy command rather than by this workflow. Treat the workflow as inert until that is deliberately resolved one way or the other.

### Per-instance Fly commands

```bash
fly secrets set KEY=value --app <app_name>   # set secrets
fly logs --app <app_name>                    # tail logs
fly ssh console --app <app_name>             # shell into the machine
```

### Per-project secrets (Fly)

Secrets set through the admin UI Secrets panel are stored as classic Fly app secrets on the **shared sessions app**, prefixed with the team key — for example, a secret named `QA_PROBE` on the `SAN` mapping is stored as `SAN_QA_PROBE`.

Names are read from the Fly Machines API (`GET /v1/apps/{app}/secrets`), the same store Fly uses when starting a machine. The reply is an object that holds the list (`{ "secrets": [{ name, digest, created_at, updated_at }] }`), not a bare list; `listAppSecrets` reads `.secrets` and rejects any other shape. Admin set and delete operations use that API too. Admin writes deliberately ignore secrets versions and leave version pinning off; protected-run bootstrap still manages its own version.

Before merging this change, compare `fly secrets list -a <sessions app>` with the historical GraphQL list on **each sessions app**. REST-only global names become visible to launch and pass to every machine in process-level mode. On `ai-implement-testing-sessions` on 2026-11-13, the only REST-only name was the protection key, which ordinary launch skips. The global admin list hides that key and rejects attempts to overwrite or delete it.

If Fly removes a machine before it starts, inspect `fly machine status <id> -a <sessions app>`. A missing requested secret produces a `launch` event followed by `destroy` from source `flyd`, with no `start` event. Check the requested names against `fly secrets list -a <sessions app>`. Remove a stale name with `fly secrets unset <name> -a <sessions app>` (or the corresponding admin delete route), then retry the run. Deleting an absent name succeeds; an unknown app can still return HTTP 404. Secret values stay on the admin API and never pass through a Restate journal.

Classic Fly app secrets are **app-wide** by default: with the process-level flag off, Fly injects every classic secret into every machine on the sessions app under its stored name, regardless of which team that machine belongs to. With the flag on (the default, see [Process-level secrets](#process-level-secrets)), `processes[0].ignore_app_secrets` plus an explicit `processes[0].secrets` list keeps other teams' secrets out at the Fly boundary. An earlier note here that the `processes[].secrets` remap has no effect on classic secrets was superseded by the AII-491 spike and the AII-1388 live probe (2026-10-15), which confirmed the key is present and a foreign-team secret absent on a protected probe machine.

The runner entrypoint (`session/entrypoint.sh`, via `remap_team_secrets` in `session/lib.sh`) is the isolation boundary. When `AI_IMPLEMENT_TEAM_SECRET_PREFIX` is set, the entrypoint runs before the `su -p coder` handoff and:

1. Remaps each own-team secret (`<TEAM>_<NAME>`) to its unprefixed form (`<NAME>`), making it available to setup hooks and the agent.
2. Unsets foreign-team secrets — names from other team mappings that are listed in `AI_IMPLEMENT_FOREIGN_SECRET_NAMES` — so machines dispatched for one team cannot read another team's secrets even though Fly injected them.
3. Leaves global machine secrets (secrets with no team prefix, set on the sessions app for shared use) untouched — they pass through unchanged and are visible to every machine.
4. Sets `AI_IMPLEMENT_FORWARDED_SECRETS` to a comma-joined list of the bare names exposed (e.g., `QA_PROBE,DB_URL`).

`buildSessionMachineConfig` (in `src/fly-machines.ts`) passes two env vars so the entrypoint knows which names to process:
- `AI_IMPLEMENT_TEAM_SECRET_PREFIX=<TEAM>_`: the own-team prefix; the entrypoint scans the environment for vars with this prefix and remaps them.
- `AI_IMPLEMENT_FOREIGN_SECRET_NAMES=<comma-joined list>`: names that start with another team's prefix; the entrypoint unsets these. Global secrets are absent from this list and pass through unchanged.

If a team secret's bare name (the part after the team prefix) matches a reserved orchestrator variable — `GITHUB_*`, `ISSUE_*`, `AI_IMPLEMENT_*`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `SESSION_TOKEN`, `MACHINE_NONCE`, `RUN_TOKEN`, `ORCHESTRATOR_URL`, `RUNNER_CALLBACK_URL`, `WORKSPACE_DIR`, `PATH`, or `HOME` — the entrypoint logs a warning and skips the export rather than overwriting the orchestrator-issued value. The same names are rejected at the admin UI level by `handleSetSecret` in `src/admin.ts`, so well-formed deployments never reach that guard.

### Process-level secrets

**Process-level mode is on by default** (AII-515). The setting is controlled via the **Runners page** in the admin UI (`/admin#runners`), persisted in the `settings` table, and takes effect on the next dispatch without a restart.

`FLY_PROCESS_LEVEL_SECRETS` overrides the UI toggle at runtime: a truthy value (`true`, `1`, or `yes`, case-insensitive) forces it on; an explicit falsy value (`false`, `0`, or `no`) forces it off. Either way the Runners page shows the toggle disabled with an override warning. Unset or empty means the UI toggle applies (which itself defaults to on).

Process-level mode switches `buildSessionMachineConfig` to a stricter isolation mode. Instead of setting `AI_IMPLEMENT_TEAM_SECRET_PREFIX` / `AI_IMPLEMENT_FOREIGN_SECRET_NAMES` and relying on the entrypoint filter, the machine config sets `processes[0].ignore_app_secrets: true` and enumerates only the secrets the machine should receive in `processes[0].secrets`:

- Own-team secrets (`<TEAM>_<NAME>`) → `{ env_var: "<NAME>", name: "<TEAM>_<NAME>" }` (remapped to bare form)
- Foreign-team secrets → excluded entirely
- Global secrets (no team prefix) → `{ env_var: "<NAME>" }` (passed through unchanged)
- `AI_IMPLEMENT_MODEL_AUTH_PROTECTION_KEY` → omitted from global passthrough for ordinary runs; for a **protected** run (ADR 009) it is always listed as `{ env_var: "AI_IMPLEMENT_MODEL_AUTH_PROTECTION_KEY" }`, even when the secrets listing failed and the list is otherwise empty, so the fail-closed empty list does not withhold it. With the flag off, a non-protected config appends the key to `AI_IMPLEMENT_FOREIGN_SECRET_NAMES` when it appears in the listing.

**Protection key delivery.** `ensureProtectionKeySecret` (`src/fly-protection-key.ts`) derives the key from `RUNNER_TOKEN_SECRET`, writes it to the sessions app once with `FLY_SESSIONS_TOKEN` through the REST `POST /v1/apps/{app}/secrets` endpoint (`putAppSecretsVersioned`), and stores `{fingerprint, version}` in the `settings` table. The returned secrets version becomes the machine's `min_secrets_version`. Rotating `RUNNER_TOKEN_SECRET` writes a new key and version on the next protected dispatch. A team key whose prefix captures the key name (team `AI`, prefix `AI_`) makes the builder throw `protected_team_prefix_collision`. Rollback has two steps: (1) `fly secrets unset AI_IMPLEMENT_MODEL_AUTH_PROTECTION_KEY -a <sessions app>`, and (2) delete the `fly_protection_key_secret` row from the `settings` table (`DELETE FROM settings WHERE key = 'fly_protection_key_secret'`). Skipping step 2 leaves a stored fingerprint that still matches, so the next protected dispatch pins a secrets version whose key is gone and Fly destroys the machine before it starts. No code deletes the row.

The entrypoint remap/filter logic remains active in both modes but is a no-op when process-level mode is on, since the machine already receives bare names with foreign names absent. The orchestrator also sets `AI_IMPLEMENT_FORWARDED_SECRETS` to the comma-joined bare names of the own-team secrets in `processes[0].secrets`, so `modelProcessEnv()` strips them from the agent's environment before Claude Code starts.

**Fail-closed on secret-list errors.** If the orchestrator cannot list the sessions app's secrets at dispatch time (network failure or auth error), process-level mode sends an empty `processes[0].secrets` list with `ignore_app_secrets: true`. The machine receives no per-project secrets, and any hook that needs one fails loudly rather than silently proceeding with the wrong secret set.

**Runner-image requirement.** The runner image must be built after AII-462 and AII-513 landed on `testing`. An older image still receives the `processes[0].secrets` remapping from Fly but does not strip forwarded secrets from the agent's environment. Per-project secrets reach hooks correctly under both images; only the agent-environment strip depends on the newer entrypoint.

**Entrypoint fallback (when off).** Disabling process-level mode reverts to the entrypoint-filter path: Fly injects all secrets and the runner entrypoint removes foreign ones based on `AI_IMPLEMENT_FOREIGN_SECRET_NAMES`. This is the rollback path — untick the toggle on the Runners page, or set `FLY_PROCESS_LEVEL_SECRETS=false`.

The dispatch log line lists the requested secret *names* (never values) so the outcome can be confirmed from the orchestrator log.

## Using AWS Bedrock

To run a target repo against Bedrock instead of the Anthropic API, use the **GitHub Actions execution mode**. Bedrock is not supported on Fly Machines or local Docker: those backends have no equivalent of GitHub's OIDC role assumption, and the runner entrypoint rejects `provider=bedrock` outside GHA mode outright.

1. **In the admin UI (`/admin`)**, edit the repo's mapping: set **Provider** to `bedrock` and **AWS Region** to the region hosting your inference profile (e.g. `us-west-2`).
2. **In the target repo**, add a repository secret `AWS_BEDROCK_ROLE_ARN` — an IAM role trusting the GitHub OIDC provider for that repo, with `bedrock:InvokeModel` on the profiles you need.
3. **In the target repo's `WORKFLOW.md`** (and `PLANNING.md` if planning is enabled), change `model:` to a Bedrock model ID or inference-profile ARN.

**Step 3 is not optional and nothing enforces it.** The workflows validate that `aws_region` and `AWS_BEDROCK_ROLE_ARN` are present, and fail clearly when they are not — but **nothing validates the model against the provider**. An Anthropic-style ID left in front matter is passed to Bedrock verbatim and fails at Claude invocation time with a provider error rather than a configuration error.

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

## The health body (`GET /`)

`GET /` needs no authentication and answers HTTP 200 with `status: "ok"` only when
Restate is `ready` and `registered`; otherwise it answers HTTP 503 with
`status: "unavailable"` (`src/index.ts`). Both responses retain every diagnostic
body field. Monitors should read the diagnostic body even on 503; it carries no secret.

| Field | Meaning |
|---|---|
| `status` | `"ok"` when Restate is `ready` and `registered`; otherwise `"unavailable"` |
| `sourceCommit` | Full `AI_IMPLEMENT_SOURCE_COMMIT` build stamp, or `null` when unset |
| `polls` | Poll cycles since boot |
| `lastPollStartedAt`, `lastPollFinishedAt` | ISO times, or `null` before the first poll |
| `kgDegraded` | Embeddings missing; search is lexical only |
| `kgUnavailable` | The last KG sidecar probe failed (`false` when never probed) |
| `sidecar` | `{ reachable, toolsListed, lastError, checkedAt }` for the KG sidecar (`checkedAt` is epoch milliseconds, `null` before the first probe) |
| `restate.sidecar.state` | `starting`, `ready`, `timeout`, `exited` (with `code`, `signal`), or `missing-binary` |
| `restate.registration.state` | `registered`, `declined-conflict`, `unreachable`, or `not-attempted` |
| `setupChecks` | `{ checkedAt, failingCore, failingOnAdminPath? }`: last known run time (epoch milliseconds) and failing core count, both `null` before a run is known; optional bootstrap ids as described below |
| `deploy` | `{ held, startedAt }`: a self-deploy hold, so a deploy is not mistaken for an outage (`startedAt` is epoch milliseconds, or `null` when nothing is held) |

`setupChecks.failingOnAdminPath` appears only while no admin path is configured:
it lists failing check ids on the path to an admin, with no titles, details, fixes or
projects. An access code, complete SSO path with an admin address, or BuildDown
with its redirect URL ends bootstrap mode; an unreadable allowlist also keeps it
off. The count comes from the last known run, restored after Restate registration;
bootstrap ids are checked locally on each request. `GET /` never calls Restate or
any other network service, so it continues returning diagnostics during their
outages, with HTTP 503 while Restate cannot serve.

A healthy orchestrator shows `restate.sidecar.state: "ready"`,
`restate.registration.state: "registered"`, and a recent `lastPollFinishedAt`.

## KG sidecar health

`kgDegraded` only says whether embeddings are present. A sidecar can also be up and still reject every call — on 2026-09-13 it answered `400 Missing session ID` to each proxied request while every health read stayed green (AII-648, KGB-28). The orchestrator now probes the sidecar after it reports ready (`tools/list` must list the six `kg_*` tools, then one `kg_neighbors` on the spine) and surfaces the result beside `kgDegraded` on every health read (AII-650):

- **`GET /`**, **`GET /api/kg/status`** / `get_kg_status`, and `get_tenant_health` carry `kgUnavailable: boolean` and `sidecar: { reachable, toolsListed, lastError, checkedAt }`. `reachable` means a well-formed HTTP answer came back; `toolsListed` means the six tools were present; `checkedAt` is `null` until the first probe has run.
- The **Knowledge Graph Pipelines page** KG card shows _⚠️ KG sidecar not serving — <lastError>_ when `kgUnavailable` is true, and a one-line "KG sidecar: reachable" once a probe has succeeded. The Deployments page keeps the deploy record.
- The **`deployed` / `restarted` deploy notification** adds _⚠️ KG sidecar not serving — <lastError>_ next to the embeddings warning, and the deploy record reads `deployed-not-serving` instead of `deployed-ok` when the boot probe fails.

The sidecar is probed at boot and on a failed proxied call (throttled). While it is marked unavailable, the poll also sends `KgSidecarHealth.check` each cycle (60 s) until a probe succeeds, so the fields recover on their own once the sidecar does, even when no further call fails (AII-1527; [docs/restate.md](restate.md) § "The KgSidecarHealth object"). The boot probe has one overall deadline (30 s); a timeout is recorded as a failed probe. A failed boot probe also makes the asynchronous deploy notice wait for warm-up: it retries every 5 s within the refresh canary’s 120 s budget, then posts one notice using the final probe result. This does not delay the HTTP server. If a successfully delivered notice warned that the sidecar was not serving, a later passing `KgSidecarHealth.check` posts `✅ KG sidecar serving again` in its journaled `notify-recovery` step. Silent boots and failed warning deliveries do not arm recovery notices. Warning/recovery pairing is process-local, like sidecar health; the journal prevents a completed recovery step from being sent again on replay.

## Restate sidecar

`restate-server` runs as a second child-process sidecar of the orchestrator, spawned and stopped alongside the KG sidecar. Restate is an implemented boot and runtime hard dependency: boot waits for readiness, successful registration, and completion of the registered hook before dispatch begins. Startup, registration, or hook failure exits 1, as does expiry of the five-minute boot deadline unless registration is `declined-conflict`; that state keeps waiting and retrying every 60 seconds without a deadline. An unexpected sidecar exit after boot shuts down the orchestrator with exit 1; intentional stop/restart teardown does not trigger fatal shutdown ([ADR 023 implementation note](adr/023-run-the-restate-server-as-an-orchestrator-sidecar.md#current-implementation-status-2026-11-08-stage-1); full reference: [docs/restate.md](restate.md#boot-sequence)). The machine restarts on a non-zero exit, at most 10 times in a row under the restart policy (`fly.toml` `[[restart]]`), but proxy auto-start remains enabled and can start a stopped machine on incoming traffic, so the retry cap does not guarantee it stays stopped. It adds no deployment surface of its own — no separate Fly app or new health endpoint — because every listener it and its SDK endpoint expose binds to `127.0.0.1` only, and the orchestrator process is the only thing on the machine that talks to any of them.

`RESTATE_DATA_DIR` is the one operator-facing knob (`.env.example`): unset, the embedded store lives under the dedup DB's directory (`/data/restate` on Fly), so a Fly volume that already covers `DEDUP_DB_PATH` covers it without a config change. The sidecar automatically selects TCP listeners on macOS, or on other platforms when the resolved absolute `<dataDir>/<hostname>/ingress.sock` path exceeds 100 UTF-8 bytes, so long checkout paths need no `RESTATE_DATA_DIR` workaround (full detail: [docs/restate.md](restate.md#boot-sequence) § "Boot sequence").

**Required checks (operator step).** Mark `unit-tests`, the six `restate-tests-binary (<pass>, <shard>)` checks (passes 1 to 3, shards 1 and 2), and `orchestrator-image` as required checks on `testing` (Settings → Branches). The branch has no required status checks by default, so until this is done a red job does not block a merge.

### Local image boot check

Before shipping a change that touches the sidecar's bind addresses, confirm loopback-only binding inside the actual built image rather than trusting the source. Run with a memory cap and a `/data` volume so the run also measures the sidecar's resident footprint (docs/restate.md § "Memory") — populate the named volume once as root first, since Docker only re-seeds an empty named volume from the image's own root-owned `/data` on its *first* mount, not on every run:

```bash
docker volume create ai-implement-boot-check-data
docker run --rm --entrypoint sh -v ai-implement-boot-check-data:/data <image> \
  -c "chown -R node:node /data && touch /data/.keep"
docker run --rm -d --name ai-implement-boot-check --memory 1g -v ai-implement-boot-check-data:/data <image>
sleep 5
docker exec ai-implement-boot-check sh -c "ss -ltnp 2>/dev/null || netstat -ltnp"
docker port ai-implement-boot-check
docker stats --no-stream ai-implement-boot-check
docker stop ai-implement-boot-check
```

`ss`/`netstat` inside the container should show the ingress (8081), admin API (9070), the fabric port (5122), and SDK endpoint (9080) listening on `127.0.0.1`, never `0.0.0.0`; `docker port` should publish none of them to the host. Either symptom is the regression this check exists to catch — a wrong config key silently falling back to `restate-server`'s own default bind (`0.0.0.0`) would otherwise only surface as an unexplained port collision or an externally reachable admin API. `docker stats`' container total is the number recorded in docs/restate.md § "Memory".
