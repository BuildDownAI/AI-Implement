<!--
  MAINTAINER NOTE — why this file is short, and how to keep it that way.

  CLAUDE.md is loaded into EVERY Claude invocation: implement and review on each
  feedback-loop iteration, plus every post-push-review fix pass. Length is a
  correctness lever, not tidiness — Claude Code's own guidance is to target under
  200 lines, because a longer file reduces adherence to what it says.

  So the rule for what belongs here: keep what an agent CANNOT derive by reading
  the repo — pitfalls, rationale, why-nots, and conventions that differ from tool
  defaults. Anything derivable (directory trees, exhaustive field tables,
  architecture narration) belongs in docs/ behind a "Full reference:" link, or
  nowhere.

  These HTML comments are stripped before the file reaches the model, verified
  empirically — so maintainer notes here are free to the agent, and visible to
  whoever reads the file to edit it. Use them rather than prose for guidance
  aimed at humans.

  Before adding a section, ask whether `ls` or one file-read would answer it. If
  so, don't.
-->

# AI-Implement — Codebase Guide

A Node.js service that polls Linear or Jira for issues labeled `AI-Implement` and dispatches containerized runs of Claude Code to implement them. It also serves an admin UI and manages the workflow templates synced to target repos.

## Issue tracker bindings

Bindings for the BuildDown skills (bd-build-up, bd-build-down, bd-summit-push, etc.). These are read by name — keep the keys intact when editing.

- tracker.kind: linear
- MCP server: `linear-eudoxus` (declared in the project `.mcp.json`, which is **gitignored** — copy `.mcp.json.example` to `.mcp.json` on a fresh clone and add any machine-local servers there. Also **not** pre-approved: `.claude/` is gitignored and absent here, so each machine approves the server on first use)
- Workspace: `eudoxus` (bound at OAuth time)
- Team: `AII`  ← issues filed/listed/searched against this team
- Team URL: https://linear.app/eudoxus/team/AII/overview
- GitHub repo (PRs land here): `BuildDownAI/AI-Implement`
- Implement label: `AI-Implement` (orchestrator pickup trigger)
- Agent mention (PR comment re-trigger): `/ai-implement`


## Knowledge graph

Bindings for the KG skills (bd-kg-search, kg recon — format: skills `plugin/skills/bd-shared/kg-binding.md`):

> **Path note (skills PR #49):** the skills repo moved its shared docs from `docs/` into
> `plugin/skills/bd-shared/`. Stubs remain at the old `docs/` paths, so old citations still
> resolve. Use the `bd-shared/` path in new references.

- kg.present:      true
- kg.orchestrator: https://ai-implement-testing-orchestrator.fly.dev
- kg.mcp_server:   orch-ai-implement-testing
- kg.search_tool:  mcp__orch-ai-implement-testing__kg_hybrid_search
- kg.source_repo:  BuildDownAI/knowledge-graph-ai-implement
- kg.local_mcp_server:  ai-implement-kg
- kg.local_search_tool: mcp__ai-implement-kg__kg_hybrid_search
- kg.prefer:       orchestrator

Project-specific orchestrator instances can override the bundled graph with `KG_SOURCE_REPO=owner/repo`.
The value is a GitHub repo identifier, not a URL; see `docs/kg-sidecar.md`.

## Architecture

```
Linear / Jira  ──poll every 60s──▶  orchestrator (src/index.ts)
                                          │
                                          ▼  dispatch
                     GitHub Actions │ Fly Machines │ local Docker
                                          │
                                          ▼  all three enter session/entrypoint.sh
                                    runner container
                                          │
                              pipeline (src/pipeline/) runs the steps
                                          │
                                          ▼
                        PR opened → review → callbacks → tracker updated
```

The runner never holds a ticketing credential. It reports through authenticated callbacks and the orchestrator performs every tracker write with its own.

## Subsystem index

Entry points for areas that are easy to miss. Each names the module to start from; the ones with references have depth behind them.

| Subsystem | Start at | Reference |
|---|---|---|
| Pipeline, steps, custom overrides | `src/pipeline/` | [docs/pipeline-architecture.md](docs/pipeline-architecture.md) |
| Review findings → fix dispatches | `src/review-fix-queue.ts` | [docs/review-fix-rail.md](docs/review-fix-rail.md) |
| Parent/child grouping and roll-up | `src/feature-branch.ts`, `src/merge-up.ts` | [docs/feature-branch-grouping.md](docs/feature-branch-grouping.md) |
| Dispatch envelope (`RunConfigV1`) | `src/run-config.ts` | [docs/workflow-envelope.md](docs/workflow-envelope.md) |
| Runner image selection | `src/repo-image.ts` | [docs/runner-images.md](docs/runner-images.md) |
| Knowledge graph end-to-end (ingest → snapshot → image → serve) | `Dockerfile` KG stages, `docker-entrypoint.sh` | [docs/kg-architecture.md](docs/kg-architecture.md) |
| KG sidecar and `/mcp` | `src/mcp.ts`, `src/mcp-oauth.ts` | [docs/kg-sidecar.md](docs/kg-sidecar.md) |
| Deploying, clients, Bedrock | `src/deploy.ts` and its `deploy-*` siblings | [docs/deployment.md](docs/deployment.md) |
| Ticketing provider abstraction | `src/providers/` — `linear.ts`, `jira.ts`, `registry.ts` | |
| Execution backends | `src/fly-machines.ts`, `src/local-docker.ts`, `src/github.ts` | |
| Runner callbacks and tokens | `src/runner-callback.ts`, `src/runner-token.ts`, `src/token-vending.ts` | |
| Merge reconciliation | `src/reconciliation.ts`, `src/reconcile-merged.ts`, `src/poll-merged-prs.ts` | |
| Workflow sync to target repos | `src/workflow-sync.ts`, `src/workflow-sync-queue.ts` | |
| `/ai-implement` comment rail | `src/webhook.ts`, `src/comment-gapfill-drain.ts` | |
| Stuck-run recovery | `src/reaper.ts`, `src/stuck-watchdog.ts` | |
| Per-team dispatch capacity | `src/poll-selection.ts` | |
| Run classification and autopsy | `src/completion-classification.ts`, `src/run-autopsy.ts` | |
| Admin SSO / OIDC, roles, page grants | `src/oauth/`, `src/admin-session.ts`, `src/access-entries.ts`, `src/access-page-grants.ts` | [docs/access-model.md](docs/access-model.md) |
| Admin SPA | `src/admin-ui/` | |

**Diagram convention:** flow diagrams in `docs/`, issue bodies, and PR descriptions are mermaid (validated with `mermaid-cli` before commit); tabular data is a table; ASCII only in this file. Full rule: [docs/README.md](docs/README.md).

## Running locally

```bash
cp .env.example .env   # GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY are the only required pair
npm install
npm run dev            # checks the Node major, loads .env when present, runs src/index.ts via tsx
npm run dev:local      # rebuilds the local runner image, then runs dispatches in local Docker
```

Only the GitHub App pair is hard-required — `loadConfig` throws without it. Ticketing credentials are not: an absent Linear or Jira configuration logs a warning and skips that provider's mappings, so the orchestrator still boots and serves.

Health check `curl http://localhost:8080/` · Admin UI `http://localhost:8080/admin` (needs an OAuth provider **or** `ADMIN_ACCESS_CODE`).

Node is pinned to 24 (`engines`, `.tool-versions`). On a Node-major switch, `npm test` fails wholesale inside `getDb()` with a `NODE_MODULE_VERSION` mismatch — check which Node you are on before reaching for `npm rebuild better-sqlite3`, since the native modules are usually right and the shell is wrong.

## Local dev harness

`npm run dev:run` launches a single runner container against a local target-repo checkout — no orchestrator, no poll loop, no tracker. It is the only local path that can iterate on `WORKFLOW.md` and hook scripts, because it bind-mounts your working tree instead of cloning.

```bash
npm run dev:run -- --workspace ../target-repo --task task.md
npm run dev:run -- --workspace ../target-repo --task task.md --until setup --shell
```

The task file is Markdown with front matter: `title` required; `identifier`, `maxTurns`, `maxIterations`, `repo`, `branch` optional.

- `--until <step>` stops after that pipeline step, **including when the step is skipped**; an unknown step name fails before execution rather than falling through to a full run. Since `setup` precedes `feedback-loop`, `--until setup` is a token-free hook loop.
- `--shell` holds the container open at that boundary and attaches a shell in `/workspace`, with setup-hook `$GITHUB_ENV` exports loaded. Exiting collects artifacts, then removes the container.
- **Mounted mode never pushes** — the mount is your live checkout, dirty by design, so a push would sweep in-progress work into the commit. The mutated tree is left for `git diff`.
- The clone and install steps both detect mounted mode and no-op, so uncommitted edits take effect immediately and your `node_modules` is left alone.

Per-run artifacts land in `.dev-runs/<timestamp>/` (gitignored): `run.log`, `changes.diff`, `diffstat.txt`, `telemetry.json`.

## Running tests

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

**`typecheck` excludes `src/__tests__`, and vitest strips types without checking them** — so type errors in a test file are caught by nothing. Type-check a new test file explicitly with a throwaway tsconfig. `src/admin-ui/__tests__/` *is* covered and can break the build.

## Data layer

One SQLite file at `DEDUP_DB_PATH` (default `/data/dedup.sqlite`; `./dedup.sqlite` locally) holding 22 tables. `dedup.ts` owns the singleton — every other module imports `getDb` from it rather than opening its own handle.

**Dedup has no TTL.** The `dispatched` table is a bare existence check with no retention logic: an entry clears only when something explicitly removes it — a failed or timed-out run, the reconcile loop reaching a terminal issue, or a manual delete. There is no time-based auto-retry. This is a recurring source of documentation errors claiming a 24-hour window; the only genuine 24-hour figure belongs to the reaper's summary statistic.

## Environment variables

**`.env.example` is canonical** — it carries every orchestrator variable with grouped comments, and is kept in lockstep with the code. Consult it rather than a second list here.

Only the non-obvious ones are worth restating:

- `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` — the only pair that throws at boot when absent. Everything else warns and degrades a feature.
- `RUNNER_CALLBACK_BASE_URL` + `RUNNER_TOKEN_SECRET` — **not Fly-specific.** All three execution modes report through them; the GHA path receives the URL as a workflow input rather than an env var. Without them a planning run never reports completion and the issue stalls.
- `OAUTH_ALLOWED_DOMAINS` / `OAUTH_ALLOWED_EMAILS` — fail-closed, and a **seed rather than the list**: they apply until the first save at `/admin#access`, then go inert while the stored list has entries. Empty and nothing stored means deny everyone.
- `KG_SIDECAR_URL` — unset degrades `/mcp`, but an unauthenticated probe still gets **401** and cannot detect it. Only an unset `OAUTH_REDIRECT_BASE_URL` 503s every caller.
- `AI_IMPLEMENT_LOG_LEVEL`, `AI_IMPLEMENT_RUNNER_LABEL`, `AI_IMPLEMENT_PROVIDER` — repo/org **Actions variables**, not orchestrator env, and effective only after the target repo re-syncs `claude-implement.yml`. `LOG_LEVEL` is `summary` (one result line per invocation — outcome, turns, duration, cost, tokens) or `stream` (additionally tees each tool call, not its output); telemetry is captured at both. `RUNNER_LABEL` overrides `runs-on`, default `ubuntu-latest` — pointing it at a larger runner roughly halves the CPU-bound implement job, but **write access to that variable lets the holder retarget the job to an arbitrary self-hosted runner that would then see the job's secrets.**
- `AI_IMPLEMENT_SOURCE_COMMIT` / `_REPO` / `_BRANCH` — **stamped by the image build, not set by an operator** (`Dockerfile` build args). Self-deploy compares the stamp against the branch head, so an image built without all three goes inert and reports availability as *unknown*, never as up to date — a hand-run `fly deploy` that omits them silently disables the feature. No webhook or inbound reachability is needed; those only cut detection latency from one poll cycle to seconds.
- `FLY_DEPLOY_TOKEN` — the orchestrator's own deploy credential, distinct from `FLY_SESSIONS_TOKEN`, which is scoped to the sessions app and cannot deploy the orchestrator. Scope it to the single app it deploys. The app name needs no variable: Fly injects `FLY_APP_NAME` into every machine, so an orchestrator can only ever deploy itself.

Adding or renaming a variable means updating `.env.example` in the same change; it is the operator's only discovery surface.

A change that adds or alters an architectural feature must update the matching `docs/` reference in the same change; a new pattern with no existing home in `docs/` gets one.

## Adding a new target repo

1. Add the mapping at `/admin` via the **New project** stepper. On the Source step, **Check installation** probes whether the App is installed and can see the repo, linking straight to the fix — install the App, or add the repo to an existing install. The check is advisory; you can save regardless.
2. **Save.** The mapping persists immediately and sync runs in the background, polling to a terminal state. The mapping is saved however the sync resolves.
3. Merge the sync PR in the target repo.

The GitHub App needs **Workflows** permission alongside **Contents** — GitHub rejects writes under `.github/workflows/` without it, and the sync fails with "permission denied" before opening its PR. If the orchestrator restarts mid-sync, the poll loop reclaims the orphaned job after a stale window.

The target repo's "Allow GitHub Actions to create and approve pull requests" toggle is **not** a prerequisite, despite older instructions saying so. Every synced workflow opens PRs with a **GitHub App token**, while that toggle governs the default `github-actions[bot]` actor — a different identity. Leaving it on is harmless; the real prerequisite is the App installed with contents, pull-requests, and workflows permissions.

`.github/workflows/sync-workflow.yml` remains a manual bulk fallback, but normal distribution happens from the orchestrator.

## Workflow templates

`workflows/claude-implement.yml` and `claude-plan.yml` are synced to target repos; `WORKFLOW.md` and `PLANNING.md` are **seeded once and never overwritten**, so every repo keeps whatever template it was created with. Sync also *removes* `comment-trigger.yml`, since the orchestrator webhook now handles `/ai-implement` for envelope repos.

That seed-once rule has a consequence worth internalising: **a template correction never reaches an existing repo.** Fixing a bug in `workflows/WORKFLOW.md` fixes it for repos onboarded afterward and for nobody else.

Non-obvious behaviour:

- **Model IDs pass through verbatim**, and nothing validates them against the provider. A Bedrock mapping with an Anthropic-style `model:` fails at Claude invocation time rather than at dispatch. Per-phase model selection lives in `.ai-implement/config.yml`, not front matter.
- **Prompt assembly** — the runner uses `WORKFLOW.md`'s body with front matter and HTML comments stripped and `${UPPER_SNAKE}` substituted, then appends its own blocks. Any *unrecognised* `${TOKEN}` becomes an empty string, so a shell example containing one is silently blanked. Never put `${PLANNING_CONTEXT}` in the body: it is substituted *and* appended, emitting the block twice.
- **The pipeline owns repository writes on every autonomous run.** Initial runs create the branch, commit, push, and PR. Gap-fill runs leave the existing PR branch checked out, then the pipeline commits and pushes reviewed changes to it. Templates must tell the agent to leave changes uncommitted in both modes.
- **Unapproved runs still ship** as a draft PR carrying the reviewer's final feedback and per-pass stats, reported as a coded failure (`REVIEW_UNAPPROVED` / `MAX_TURNS_EXHAUSTED`) so the ticket updates and notifications fire, while the GHA job stays green with a `::warning::`. If the repo plan rejects draft PRs (422), it opens normally prefixed `[NEEDS REVIEW — unapproved]`.
- **Hooks work in every execution mode.** `setup` / `verify` / `teardown` front-matter paths run around the implement loop — setup failure aborts early, teardown always runs. All three modes enter through `session/entrypoint.sh`, which populates the workspace before the runner starts.
- **Planning writes files, it does not post.** A planning run writes `ai-output/comments/NN-*.md`; the orchestrator posts them to the ticket. Runner-written files are collected in lexicographic order — avoid the `90-` prefix, which the run autopsy uses.

`/ai-implement` comment handling requires the App subscribed to `issue_comment`, `GITHUB_WEBHOOK_SECRET` set on both sides, a publicly reachable orchestrator, and an envelope-generation target repo. Legacy repos are silently ignored.

## Per-project settings (admin UI)

Editable per mapping; blank means the default.

| Field | Default | Notes |
|---|---|---|
| Max Turns | `50` | Claude turns per implement pass |
| Max Iterations | bedrock `2`, anthropic `3` | implement/review cycles |
| Job Timeout (min) | `90` | GHA only |
| Branch Prefix | none | Path segment prepended to the implementation branch |
| Sensitive Add / Allow Globs | none | Extends or un-blocks the push step's blocklist; **allow always wins** |
| Dependency Token Scope | off | `installation` lets the run read private sibling repos during dependency install |

Caps apply to re-dispatches, not just initial runs. Branch prefix affects only the initial run — gap-fill commits to the existing PR branch. Sensitive-file globs travel **exclusively** in the envelope, so a repo must be on envelope generation before setting them.

On **legacy** repos only — those still carrying `comment-trigger.yml` — the repo variables `AI_IMPLEMENT_MAX_TURNS`, `AI_IMPLEMENT_MAX_ITERATIONS`, `AI_IMPLEMENT_MAX_JOB_MINUTES`, and `AI_IMPLEMENT_SKILLS_REPO` still cap comment-triggered gap-fill runs. They are deprecated and unnecessary once a repo is on envelope generation, where the mapping's own values ride the envelope instead.

**Jira profiles** ride `run_config.profiles`, read from a multi-select custom field that must be named exactly `AI-Implement Profiles` unless `profilesFieldOverride` pins its ID. Option names must not contain commas — the contract is a comma-joined list. **No built-in step consumes profiles**; they exist as the contract surface for image-baked `custom/` steps.

**Dependency Token Scope** runs on a deliberate two-token split. The **primary** token carries the App's full grants but is scoped to the target repository alone; the **dependency** token is installation-wide but strictly `contents: read`. The `dependency-auth` step fetches the second from `POST /api/runner/dependency-token`, installs it as a git credential helper for `github.com` and as `COMPOSER_AUTH`, and the helper re-mints it when under ten minutes remain. So the implementer can read sibling repos it needs and can never push to them.

Two things to know before enabling it. The scope is **all-or-nothing** — the token reads every repository the App installation covers, not a chosen subset (a per-project list is a planned v2; the field is stored as text so a JSON array slots in without a migration). And it needs a **publicly reachable orchestrator**, since the token is fetched over the runner callback; runs dispatched without a progress token skip the fetch and proceed without private-dependency access rather than failing.

> **Behaviour change for existing Fly deployments.** The Fly-mode `/api/token` endpoint used to mint a full-installation token. It now narrows the primary token to the target repository, matching the GHA path. A deployment that incidentally relied on org-wide primary-token access to read private sibling repos must set this field to restore it.

## Per-repo configuration (`.ai-implement/config.yml`)

Optional, in the target repo. Parsed with a real YAML parser; a missing file, malformed YAML, or an unexpected shape all resolve silently to "no config", so a typo disables a key rather than failing the run.

| Key | Effect |
|---|---|
| `packageManager` | Overrides the install step's lockfile detection |
| `models.implement` / `models.review` | Per-phase models |
| `reviewProviders` | External review sources; `github-claude-code-review` is the only recognised value |
| `reviewCheckNames` | Check-run names that identify the external review gate. Defaults to `review`, `code-review-plugin`, `claude-review`, `claude code review`, `claude-code-review`, plus any name containing both `claude` and `review`. A target repo with an unrelated CI job named `review` should set this to avoid that job becoming the review gate |

**This is where per-phase model selection lives.** Both keys take precedence over `WORKFLOW.md`'s `model:` — the chain is `config.yml` → front matter → built-in default. Pairing a strong implement model with a cheap review model is the supported way to hold down review cost.

`reviewProviders` is **enabled when absent**. Two shapes disable collection quietly: an explicit empty list, and a list whose entries are all unrecognised (unknown names are filtered out, leaving empty).

The two `.ai-implement/` files read from different refs: `image.yml` from the **default branch**, so a PR cannot pick its own runner image; `config.yml` from the **checked-out workspace**, which on a gap-fill run is the PR head.

## Custom extensions

A file at `custom/<path>` overrides the corresponding built-in. Resolution searches the workspace root, then `AI_IMPLEMENT_CUSTOM_ROOT`, then the package root — see [docs/pipeline-architecture.md](docs/pipeline-architecture.md) for the mechanics and the step contract.

Built-in step keys, in pipeline order: `clone`, `install-skills`, `dependency-auth`, `install`, `setup`, `feedback-loop`, `preflight`, `push`, `verify`, `post-push-review`.

- `custom/` belongs to an AI-Implement **fork**, not a target repo; sync never creates it there.
- **Place client-specific behaviour in `custom/`** rather than editing built-in modules — that is what keeps a fork rebasing cleanly.
- A `custom/` file with no `default` export warns and falls back to the built-in rather than misbehaving silently.
- `protect-custom.yml` flags upstream PRs touching `custom/`, but is **advisory only** — it emits a `::warning::`, never fails, and only runs on PRs targeting `main`, so PRs into `testing` never trigger it.

## Feature-branch grouping

A parent issue labelled `AI-Implement` with labelled children becomes a **feature node**: it owns `ai-implement/feature/<key>`, its children PR into that branch rather than the repo base, and the tree cascades recursively. Internal roll-ups merge directly; only the top-of-tree `feature → base` is a human-reviewed PR. A parent labelled before its children is left alone until a child is labelled.

Labels: `AI-Implement` → `AI-Planning` → `Plan-Complete` → `AI-Working` → `Ready for Review`, then Done on merge.

The cascade **self-advances** and self-heals: a child PR landing dirty is re-queued through the comment-gapfill rail (capped at 2 attempts), a parent with an open roll-up PR is held from dispatch, and siblings whose declared `Files:` overlap an in-flight sibling are deferred (failing open). Requires a publicly reachable runner callback, and the runner image channel paired to the orchestrator's.

**Full reference: [docs/feature-branch-grouping.md](docs/feature-branch-grouping.md).**

## Issue completion on PR merge

Two paths feed one `reconciliation_queue` → `markMerged` worker: a **poll detector** that needs no configuration and catches everything within a tick, and a **webhook** that merely reduces latency. Completion runs even for paused projects. Jira target repos need a `Merged` option on their AI-Implement status field.

## Admin UI and auth

SSO via OIDC (Google, Microsoft) with a deprecated `ADMIN_ACCESS_CODE` fallback; the UI 503s when neither is configured. The fail-closed allowlist is **database-backed and edited at `/admin#access`** — `OAUTH_ALLOWED_*` seed it and apply until the first save, which hands authority to the stored list permanently. Every entry carries a role: `admin` reaches everything, `user` reaches `/mcp` plus whichever pages have been granted — none, until someone grants some.

Four things here are easy to state backwards. **A domain admits as `user`; only a listed address can be `admin`** — so a domain-only seed admits everyone and lets nobody administer, a misconfiguration the boot log and the sign-in page both flag. An entry is *declared* by address but **matched by provider + `sub` once bound** at first sign-in, so a rename keeps its role and a reassigned address inherits nothing — and re-pointing a bound entry takes two saves, not one. **Page grants restrict the admin UI, not what a user can read**: `/mcp` is role-blind, so a user granted nothing still reaches every MCP tool. And an unreadable list answers **503, never 401** — the SPA logs out on 401, so a database fault must not eject everyone.

Every authenticated request re-checks against an in-memory list, so a removal ends a session on the next request rather than at token expiry. **Full reference: [docs/access-model.md](docs/access-model.md)** — precedence, the audit trail, and the host command that recovers from lockout.

The SPA at `/admin` is composed from string-exporting modules under `src/admin-ui/` with **no client-side build step** — all client JS is concatenated into one inline `<script>` at module load. Each `pages/<name>.ts` exports `<name>Html` and `<name>Script`; the script is an IIFE ending in `window.registerPage('<route>', …)`, and page scripts call `window.api()` and the HTML-escaping helpers (below) rather than bare globals. Adding a page means the module, both strings in `index.ts`, and a route in `sidebar.ts` — and it is ungrantable until listed in `PAGE_ROUTES` (`access-page-grants.ts`), which is deliberate: grantability is declared by naming what a page may read, so a new page and a new endpoint both fail closed.

**HTML escaping — three-way rule** (full rationale: [docs/adr/002-admin-ui-html-escaping.md](docs/adr/002-admin-ui-html-escaping.md)):

| Context | Helper | Why |
|---|---|---|
| Text interpolated into markup (`innerHTML`) | `window.esc()` | Escapes `&`, `<`, `>` via DOM round-trip. A value assigned to `textContent` needs **no** helper — it is never parsed as HTML |
| Quoted attribute value (`title=`, `data-*`, path in `href=`) | `window.escAttr()` | Also escapes `"` and `'` |
| Full URL in `href=`/`src=` (scheme from data) | `window.safeUrl()` | Validates scheme; `javascript:` returns `'#'` |

`window.html` is a tagged template that calls `escAttr()` on every interpolation by default; when the preceding static chunk ends with `href=` or `src=` (with an optional opening quote), it also runs `safeUrl()` on the value first, and `window.raw(markup)` opts out for pre-built HTML. **No page module uses it** — every call site concatenates strings with explicit `esc()`/`escAttr()`, because nesting a template literal inside the page's own script template means escaping every backtick and `${`. Follow the call sites. Do **not** use `esc()` inside a quoted attribute — that is the bug this rule prevents. And when a URL is assembled in a variable before being interpolated, no helper can detect the URL context — call `safeUrl()` explicitly there.

Six routes (`channels`, `policies`, `secrets`, `mcp`, `webhooks`, `updates`) are still "Coming soon" stubs in `pages/stubs.ts`.

## Backend outage playbook

The global **runner mode** is the failover lever: `/admin#runners` or `POST /api/runner-mode` with `fly` forces Fly Machines, `gha` forces GitHub Actions, `default` restores per-project modes. In-flight runs keep their monitors; only new dispatches reroute.

Ineligible mappings are **skipped at dispatch** — `provider=bedrock` is GHA-only, and Fly needs a sessions app — staying queued with dedup untouched and appearing in the Runners banner and `GET /api/runner-mode`. Flip back to `default` afterward; skipped issues dispatch on the next poll.

## Notifications

`src/notify.ts` exports one function per notification shape — `notify`, `notifyCompletion`, `notifyDeploy`, `notifyStuckGiveUp`, `notifyReaperBurst` — each taking `(type, webhookUrl, payload)` and switching on `NOTIFY_TYPE` to a private per-provider implementation; any unrecognised value falls through to Slack. A sixth export, `notifyText`, deliberately skips the switch for cases with no issue context. Adding a provider means a private function per shape plus a case in each switch.

The orchestrator also announces its own deploys, comparing `FLY_IMAGE_REF` against a value in `settings` to distinguish "redeployed" from "restarted". Both notices gate on `FLY_IMAGE_REF`, which exists only inside a Fly Machine, so local runs never post. **A failure classification always reaches the tracker comment** regardless of whether a webhook is configured — the ticket is the highest-visibility surface, and the webhook send is gated separately and best-effort.
