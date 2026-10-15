# Runner image resolution

Which container image a run executes in, how a target repo overrides it, the publishing channels, and why a private image constrains the execution mode.

Reference for `src/repo-image.ts`, the `runner_image` handling in the synced workflows, and `.github/workflows/build-runner.yml`. `CLAUDE.md` carries the summary and points here.

## The resolution ladder

Both execution modes resolve the image the same way, highest priority first.

**1. `.ai-implement/image.yml` at the target repo's default branch** — the per-repo override:

```yaml
image: ghcr.io/your-org/your-runner:v1
```

In `fly-machines` mode the orchestrator reads it through the GitHub contents API (`src/repo-image.ts`). In `github-actions` mode `claude-implement.yml` reads it with `gh api` from the **default branch only** — never a PR head, so a pull request cannot select its own privileged image.

**2. `AI_IMPLEMENT_RUNNER_IMAGE`** — the operator or organization default. A GitHub repo/org **variable** in `github-actions` mode (org-level applies to every repo); an orchestrator **environment variable** in `fly-machines` mode. `SESSION_IMAGE` is the deprecated former name of the env var — still honored, with a deprecation warning logged at startup.

**3. Upstream fallback** — `ghcr.io/builddownai/ai-implement-runner:latest`. Every fallback site resolves to `:latest`: `src/repo-image.ts` for the orchestrator, and the `runner_image` resolution inside `claude-implement.yml` and `claude-plan.yml`. Sync removes `comment-trigger.yml`, so it resolves no image.

In `github-actions` mode a manual `runner_image` dispatch input overrides everything for that one run.

If `image.yml` is absent or malformed, resolution falls through to the next rung rather than failing. An `image.yml` that names an image outside the allowlist is refused, not skipped: the launch does not happen and the default image is not substituted (see Allowlisting).

## Forwarding, and why it is conditional

On the Fly Machines path the orchestrator boots the session machine on the resolved image directly.

On the GitHub Actions path it forwards the resolved image as the `runner_image` dispatch input — **but only when the choice is explicit**: a per-repo `image.yml` override, or an explicitly set orchestrator image variable. When neither is set the orchestrator sends nothing, leaving the workflow to run its own resolution order (the repo/org variable, then its built-in `:latest`). That is what stops the orchestrator from silently overriding a repo that pins its image through the variable.

Planning runs honor the identical rule, so a testing orchestrator pinned to `:next` steers planning to `:next` as well. One asymmetry: unlike `claude-implement.yml`, `claude-plan.yml`'s own validate step does **not** read `image.yml`, so orchestrator forwarding is the only path by which a GHA planning run picks up either source — and the target repo must have re-synced `claude-plan.yml` first, or GitHub rejects the dispatch with "unexpected inputs".

## Allowlisting

The orchestrator checks the resolved runner image before every GitHub Actions and Fly launch (`resolveSessionImage`, `src/repo-image.ts`). It trusts `ghcr.io/builddownai/`, the repo owner's own `ghcr.io/<owner lowercased>/` namespace, and the extra prefixes stored in the Settings row (see "Extra trusted image prefixes"). Each prefix is matched literally with `startsWith`; no prefix is compiled into a pattern. The check runs on every call, including a hit on the 60 s cache, so removing a prefix at `/admin#settings` takes effect at the next launch.

A refused image throws `RunnerImageNotAllowedError` and logs `[repo-image] runner image <image> for <owner>/<repo> is not allowed; ...`. A disallowed `image.yml` is never replaced by the default image, and the orchestrator's own default (`AI_IMPLEMENT_RUNNER_IMAGE`, `SESSION_IMAGE`, or the built-in) is checked the same way. The Restate review-fix launch and the kg-refresh senders turn the refusal into a `rejected` outcome; the other launch paths treat the throw as a non-launch and release their reservation, so an implementation issue retries at each poll until the image or the allowlist is fixed.

On GitHub Actions the workflows keep their own check (`validate-runner-image`), which trusts the same built-in prefixes plus the repository variable `AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES`. A GitHub Actions image must pass both. When the orchestrator sends no `runner_image`, the workflow resolves the image itself and only its own check applies. Local Docker is not checked: `LOCAL_RUNNER_IMAGE` is operator configuration and no repository input reaches it.

## Private images constrain the execution mode

Only some backends can pull a private GHCR image. GitHub Actions can pull it. Fly Machines cannot: they pull anonymously with no credential mechanism, so a private image fails at machine-create time with `failed to get manifest ... unauthorized`. Local Docker runs the image from the host cache, private or public. On a cache miss, `docker run` pulls the image with the host daemon's own credentials (`buildDockerRunArgs` passes no `--pull` flag, so the default pull policy `missing` applies). There is no workaround on Fly. To run a private image on a host that has no cached copy and no daemon credentials, use GHA mode.

On the GHA path, `claude-implement.yml` and `claude-plan.yml` authenticate the pull with the job's `GITHUB_TOKEN`: each requests `packages: read` **and** passes the token through the container `credentials:` block. A bare `packages: read` is not sufficient on its own, because GitHub Actions does not auto-authenticate a job-container image pull — the `credentials:` block is what performs the authenticated pull.

`GITHUB_TOKEN` can only read private packages owned by the **same org or account as the target repo**. So a private runner image must live in the target repo's own org; the realistic case is a customer pinning their own image via `image.yml` and linking that GHCR package to the repo. A private image in a *different* org requires substituting a PAT with `read:packages` on that org for `GITHUB_TOKEN` in `credentials.password`.

This is why the default image stays public: a cross-org `GITHUB_TOKEN` cannot pull it, so making it private would break every customer repo. The default must also be public for Fly, which pulls anonymously. New GHCR packages default to Private, and the organization must permit public container packages first (Org Settings → Packages).

## Channels

`.github/workflows/build-runner.yml` publishes to `ghcr.io/<owner>/ai-implement-runner`, lowercasing the owner of the repo it runs in — so a fork's builds land in its own namespace automatically, one the GHA allowlist already trusts. The built-in fallback in code and in the synced workflows stays `ghcr.io/builddownai/ai-implement-runner` regardless; a fork wanting its own image used must pin it rather than edit the fallback.

| Channel | Published from | Intended for |
|---------|----------------|--------------|
| `:latest` | `main` | Production orchestrators and synced target-repo workflows |
| `:next` | `testing` | Staging and testing orchestrators |

Pair the runner channel with the orchestrator's channel — a testing orchestrator should set its image variable to `:next` so the two move together.

kg-refresh dispatches (both GitHub Actions and Fly Machines) resolve the runner image through the same `resolveRunnerImageForDispatch` path as every other run kind — per-repo `image.yml` override, then the orchestrator default, then the built-in channel tag.

The Restate review-fix launch (`GithubReviewFixWorker.launch`) resolves the image the same way, using the target repo, a token from the launch credential, `config.sessionImage`, and `config.runnerImageExplicit`, and sends it as the `runner_image` workflow input (never in the envelope). If resolution fails, the launch omits `runner_image` and logs one warning; the workflow then runs its full ladder: `image.yml`, then the `AI_IMPLEMENT_RUNNER_IMAGE` variable, then `:latest`.

## Baked agent CLIs

The shared session image installs both supported agent CLIs in one image:

| Tool | Package | Pin | Build-time smoke |
|------|---------|-----|------------------|
| Claude Code | `@anthropic-ai/claude-code` | `2.1.284` | `claude --version` as `coder` |
| Codex CLI | `@openai/codex` | `0.159.2` | `codex --version` and `codex exec --help` as `coder` |

The Codex pin was checked against the [official npm package](https://www.npmjs.com/package/@openai/codex) on September 30, 2026. Upgrade it by changing `CODEX_CLI_VERSION` in `Dockerfile.session`, rebuilding the image, and re-running the non-root version/help smoke checks before promoting a channel tag.

**Expected warning: `Codex could not find bubblewrap on PATH`.** `codex app-server` (the planning stage) logs this at ERROR level once per run; the `codex exec` stages (implementation, review) don't print it but resolve `bwrap` the same way. Without a `bwrap` on `PATH`, Codex uses the copy bundled in its npm package (`@openai/codex-linux-*/vendor/*/codex-resources/bwrap`, which reports itself as "bubblewrap built for Codex"). The message is noise; the sandbox works with the bundled copy. **Do not silence it by installing the distribution `bubblewrap` package.** With Debian bookworm's `bubblewrap` 0.8.0 on `PATH`, Codex prefers it, and in the pipeline the implementation stage's file edits then fail (`Failed to delete file /workspace/…`, `Failed to write file …`), so implementation changes nothing. The bundled-only image passes the same live smoke. A plain `codex exec` edit in a bare container works with either copy, so only the live `npm run local:feedback -- --live` smoke ([local-feedback.md](local-feedback.md)) catches this. Run it for any image change that touches the Codex sandbox.

The runner does not add an OpenAI application SDK dependency for Codex execution. The CLI is installed for stage executors that need `codex`; stage selection and runtime credential delivery are implemented in later issues; installing the CLI does not enable them. No authentication state is baked into the image.

The supported local automation surface is `codex exec`. Per the [official OpenAI non-interactive documentation](https://developers.openai.com/codex/noninteractive), `codex exec --json` writes a JSONL stream of structured events to stdout, including `item.started` and `item.completed` events for command executions. The installed CLI help exposes `codex exec --output-schema <FILE>` for constraining the final response to a JSON Schema when a later stage needs a stable machine-checked result.

Codex sends that schema to OpenAI structured outputs in strict mode, which rejects the whole request (HTTP 400 `invalid_json_schema`) unless every object sets `additionalProperties: false` and lists every property in `required`. An optional field is therefore declared required and nullable (`type: ["string", "null"]`), and the parser treats `null` as absent. `src/__tests__/codex-output-schemas.test.ts` holds every built-in output schema to that rule.

**Promotion order.** Commit SHA tags are pushed first, then the build digest is smoke-tested, and only then is any mutable channel tag promoted. Channel-scoped date tags follow `base-<channel>-vYYYYMMDD-<12-char-sha>` (e.g. `base-next-v20260526-abc123def456`) so `latest` and `next` never collide and same-day builds do not overwrite one another.

**Promotion rule.** A channel is promoted for the newest branch head whose image content equals a tested build. If the branch advances between when a build starts and when its smoke tests pass (for example, a docs-only push lands after the triggering code push), the promotion step runs `scripts/image-equiv-check.sh` to diff the tested SHA against the current head. When the diff is empty for the paths that affect the runner image (`Dockerfile.session`, `session/**`, `src/**`, `pipelines/**`, `custom/**`, and the workflow file itself), the build's tested digest is promoted for the current head: the channel tag is updated, the usual date tag for the tested SHA is pushed, and an additional date tag for the head SHA is pushed (`base-<channel>-vYYYYMMDD-<head12>`). The deploy-posture check does not read tags. The extra tag is a manual check only (see [When a change reaches a run](#when-a-change-reaches-a-run)). When the diff is non-empty — the head includes image-relevant changes — promotion is skipped and the build that covers those changes will promote the channel when it completes.

Use the immutable **digest** for the strongest rollback pin; the SHA tag is a convenient lookup for the same build.

Cancelled or failed runs can leave SHA-only images with no channel pointer. That is intentional fail-closed behaviour — clean them through GHCR retention rather than treating mutable channel tags as a retention mechanism.

## When a change reaches a run

This section describes today's behavior. It uses the code on `testing` as its source.

### Which code runs where

The orchestrator image and the runner image both compile all of `src/`. Only the entry differs.

- The orchestrator starts `src/index.ts`.
- The runner starts `node /app/dist/$RUNNER_ENTRY` (`session/entrypoint.sh`). `select_runner_entry` in `session/lib.sh` picks the entry: `run-autonomous.js`, `run-planning.js`, or `pipeline/kg-refresh-run.js` (and two local-only entries).

Some modules are in both images, for example `src/run-config.ts` and `src/runner-token.ts`. The callback wire format is not shared. `src/runner-result.ts` is runner-only. `src/runner-callback.ts` is orchestrator-only.

### The path after a merge to `testing`

1. Self-deploy has no paths filter (`src/deploy-policy.ts`). Every merge makes a new orchestrator head, and `src/deploy.ts` deploys it.
2. `build-runner.yml` runs only when the push changes `Dockerfile.session`, `session/**`, `src/**`, `pipelines/**`, `custom/**`, or the workflow file. A docs-only merge builds no runner image.
3. The build pushes `:<sha>`, smoke-tests the digest, then tags the digest `:next` (from `testing`) or `:latest` (from `main`). It also adds the `base-<channel>-vYYYYMMDD-<sha12>` tag.

There is no order between the orchestrator deploy and the channel move. Either can finish first.

### Which channel a run uses

`resolveDefaultRunnerImage` reads `AI_IMPLEMENT_RUNNER_IMAGE`, then `SESSION_IMAGE`, then `:latest`. A repo's `.ai-implement/image.yml` (default branch) overrides it. The orchestrator caches the `image.yml` read for 60 seconds. Every path uses a moving tag. Nothing pins a digest.

### When each backend fixes the image

| Backend | Image is fixed when | Anchor |
|---------|---------------------|--------|
| GitHub Actions | The implement job starts. The Actions runner pulls `container.image`, so the tag can move while the job waits in the queue. | `workflows/claude-implement.yml` (`container.image`) |
| Fly one-shot | The machine is created. | `src/fly-machines.ts` (`machineConfig.image`) |
| Kept Fly machine ([ADR 037](adr/037-a-durable-runner-is-a-profile-object-that-owns-one-kept-machine.md)) | Every claim. The orchestrator sends a Fly update with a fresh config and the re-resolved image, then starts the machine. | `src/restate/kg-refresh-production.ts` (`updateMachine`, then `startMachine`) |
| Local Docker | `docker run`. The image comes from the host cache. On a cache miss, `docker run` pulls it, so a moving tag that is already cached is not refreshed. `image.yml` is ignored. | `buildDockerRunArgs` in `src/local-docker.ts` |

A run that is in flight keeps its image. A new channel image affects only the runs that start after it.

### How to confirm that a change reached a run

- **The date tag (works today).** Find the `base-<channel>-vYYYYMMDD-<sha12>` tag on the channel digest in GHCR. If the `<sha12>` is your commit (or a later commit with the same runner paths), the channel has your change.
- **`dispatch_log.session_image` (`src/log.ts`).** It holds the tag string that the run was given. It is null on GitHub Actions when the repo ladder chooses the image. It names a moving tag, not a build.
- **`get_deploy_posture`.** Read-only snapshot of deploy and channel state. Its fields are below.

#### `get_deploy_posture` fields

The tool takes no input. It returns:

```json
{
  "autoDeploy": true,
  "watchedRepo": "BuildDownAI/AI-Implement",
  "watchedRef": "testing",
  "runningCommit": "<sha>",
  "headCommit": "<sha>",
  "upToDate": false,
  "deploy": {
    "held": false,
    "inFlight": false,
    "lastOutcome": "deployed-ok"
  },
  "runnerChannel": {
    "image": "ghcr.io/builddownai/ai-implement-runner",
    "channelTag": "next",
    "channelCommit": null,
    "matchesHead": null
  },
  "mergeCost": "deploy+image"
}
```

- `autoDeploy`, `held`, `runningCommit`, `headCommit`, `lastOutcome`, `watchedRepo`, `watchedRef` — from the same source as `GET /api/deployment-status`.
- `upToDate` — `true` when `runningCommit === headCommit`, `null` when either is unknown.
- `deploy.inFlight` — `true` when runner jobs are executing. It does not show whether a deploy is in progress.
- `deploy.lastOutcome` — `"deployed-ok"`, `"deployed-not-serving"`, `"build-failed"`, or `null` when no deploy has completed.
- `runnerChannel.channelTag` — `"next"` for `testing`, `"latest"` for `main`, `null` for other branches. It comes from the watched ref, not from the configured image.
- `runnerChannel.channelCommit` — read from the OCI labels of the channel image (`org.opencontainers.image.revision` or `AI_IMPLEMENT_SOURCE_COMMIT`) in `src/repo-image.ts`. `Dockerfile.session` has no `LABEL`, so this value is always null today.
- `runnerChannel.matchesHead` — `true` when `channelCommit === headCommit`, `null` when `channelCommit` is null. It is always null today.
- `mergeCost` — depends only on `autoDeploy` and the watched ref: `"deploy+image"` when `autoDeploy` is on, `"image"` when it is off and the ref is `main` or `testing`, `"none"` otherwise. It over-reports for a merge that builds no runner image, such as a docs-only merge.

The posture never reads the date tags.

### Planned

AII-1308 plans a runner commit report (D12) and a `RunnerChannel` object. They do not exist yet. The image check in AII-1323 will change the behavior that this section describes.

### Open questions

- Does a Fly update with an unchanged tag pull the image again? The source tree does not answer this.
- Does the promoted channel digest equal the build digest? The promotion logic is in `build-runner.yml` and `scripts/image-equiv-check.sh`. It is not confirmed.

## Building a custom image

The typical reason is a language runtime or tool the base image lacks (terraform, ruby, go). Build `FROM` the channel matching your orchestrator, add your tools, publish, and point `image.yml` at it. The customer owns building and publishing; the image should be publicly pullable for the broadest compatibility.

## Extra trusted image prefixes (AII-1321)

The orchestrator stores extra trusted runner-image prefixes in the `runner_image_allowed_prefixes` settings row (comma-separated, each ending in `/`). It seeds the row once from `RUNNER_IMAGE_ALLOWED_PREFIXES` and serves it on `GET`/`POST /api/settings` as `runnerImageAllowedPrefixes` (`value`, `effective`, `builtIn`). Only an admin can write it. `getRunnerImageAllowedPrefixes()` returns `[]` when the row is missing or unreadable, so a database fault never widens the allowlist. The built-in prefixes always apply. The orchestrator's launch check reads it (see Allowlisting); the repository Actions variable `AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES` is a separate store.
