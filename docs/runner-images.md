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

**3. Upstream fallback** — `ghcr.io/builddownai/ai-implement-runner:latest`. Every fallback site resolves to `:latest`: `src/repo-image.ts` for the orchestrator, and the `runner_image` resolution inside `claude-implement.yml`, `claude-plan.yml`, and `comment-trigger.yml`.

In `github-actions` mode a manual `runner_image` dispatch input overrides everything for that one run.

If `image.yml` is absent, malformed, or names an unreachable reference, resolution falls through to the next rung rather than failing.

## Forwarding, and why it is conditional

On the Fly Machines path the orchestrator boots the session machine on the resolved image directly.

On the GitHub Actions path it forwards the resolved image as the `runner_image` dispatch input — **but only when the choice is explicit**: a per-repo `image.yml` override, or an explicitly set orchestrator image variable. When neither is set the orchestrator sends nothing, leaving the workflow to run its own resolution order (the repo/org variable, then its built-in `:latest`). That is what stops the orchestrator from silently overriding a repo that pins its image through the variable.

Planning runs honor the identical rule, so a testing orchestrator pinned to `:next` steers planning to `:next` as well. One asymmetry: unlike `claude-implement.yml`, `claude-plan.yml`'s own validate step does **not** read `image.yml`, so orchestrator forwarding is the only path by which a GHA planning run picks up either source — and the target repo must have re-synced `claude-plan.yml` first, or GitHub rejects the dispatch with "unexpected inputs".

## Allowlisting

The `github-actions` path auto-trusts `ghcr.io/builddownai/` and the repo owner's own `ghcr.io/<owner>/` namespace, so a fork publishing its own image needs no extra configuration. `AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES` exists only for third-party registries.

The `fly-machines` path validates the image-reference format but applies no allowlist.

## Private images constrain the execution mode

A private GHCR image is usable **only in GitHub Actions mode**. Fly Machines and local Docker pull anonymously with no credential mechanism, so a private image fails at machine-create time with `failed to get manifest ... unauthorized`. There is no workaround on those backends — choosing a private image is choosing GHA mode.

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

**Promotion order.** Commit SHA tags are pushed first, then the build digest is smoke-tested, and only then is any mutable channel tag promoted. Channel-scoped date tags follow `base-<channel>-vYYYYMMDD-<12-char-sha>` (e.g. `base-next-v20260526-abc123def456`) so `latest` and `next` never collide and same-day builds do not overwrite one another.

Use the immutable **digest** for the strongest rollback pin; the SHA tag is a convenient lookup for the same build.

Cancelled or failed runs can leave SHA-only images with no channel pointer. That is intentional fail-closed behaviour — clean them through GHCR retention rather than treating mutable channel tags as a retention mechanism.

## Building a custom image

The typical reason is a language runtime or tool the base image lacks (terraform, ruby, go). Build `FROM` the channel matching your orchestrator, add your tools, publish, and point `image.yml` at it. The customer owns building and publishing; the image should be publicly pullable for the broadest compatibility.
