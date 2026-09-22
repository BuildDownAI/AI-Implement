# Production promotion notes — what to decide when `testing` goes to `main`

**Status:** open. `testing` is not merged to `main` on any schedule tied to this work. The
operator decides when. This file collects the decisions and one-time steps that moment will
need, so nothing lives only in chat history.

**Rule for contributors and agents:** do not propose or perform a `testing` → `main` merge in
this repo as part of feature work. Append the item that the merge will need to this file
instead.

## State at time of writing

| Item | Value |
|---|---|
| `origin/main` | `162d7fc`, 2026-09-08 |
| `origin/testing` | `50c05d4` (AII-654), 2026-09-14 |
| Commits on `testing` not on `main` | 356 |
| Deployed from `testing` | the testing orchestrator, `ai-implement-testing-orchestrator.fly.dev` |

## What the merge carries (KG refresh rail and sidecar health)

The knowledge-graph work since `main` diverged. Each item is live on the testing orchestrator.

| Area | PRs | Reference |
|---|---|---|
| Refresh rail: preflight rows, `get_kg_status`, learnings comment, scope reconcile, `--direct` materialize | #482, #503, #504, #506, #507, #508, #510, #511, #512, #514, #519 | `docs/kg-architecture.md` |
| Dry-run trigger, REST route and Deployments button | #527, #528 | `docs/kg-architecture.md` → *Dry run* |
| PR-triggered dry-run check on the KG repos: sticky comment, commit status, per-PR outcomes, `unlabeled` re-report | #529, #532, #535, #536, #537, #538, #540 | `docs/kg-architecture.md` → *PR check* |
| Accept-new-baseline | #533 | `docs/kg-architecture.md` → *Accept-new-baseline plumbing* |
| Sidecar proxy tolerates a session-demanding server; boot probe; health surfaced on every read | #558, #559, #561 | `docs/deployment.md` → *KG sidecar health* |

## Decisions to make at promotion time

1. **Which production orchestrator, and which KG repo does it bind?**
   The rail needs `KG_SOURCE_REPO` and `KG_BASE_REPO` set on the production app. The
   testing app binds `BuildDownAI/knowledge-graph-ai-implement`. Decide whether production
   serves the same graph or its own derivative.
2. **GitHub App permissions on the production App.**
   The PR check's commit status needs *Commit statuses: Read and write*. The rail needs
   *Contents: Read and write* on the KG repo. Each is an App-level change that the installation
   must accept. Confirm with `get_tenant_health`: every `kgRefreshPreflight` row `ok: true`.
   Procedure: `docs/kg-architecture.md` → *Manual step — granting the status*.
3. **Base template repo setting.**
   `KG_BASE_REPO` seeds the *Base template repo* field once, on first boot. An app that booted
   before the variable existed has an empty field. Set it by hand under Settings → KG Refresh.
4. **Materialize path.**
   `KG_MATERIALIZE_DIRECT` is off by default. Turning it on needs the bound KG repo to carry the
   base's `--direct` / `nt_parts` support. Host sizing differs (`docs/kg-architecture.md` →
   *Two materialize paths*).
5. **Required check on the KG repos.**
   The `kg-refresh/dry-run` status is informational until a repo admin adds it to branch
   protection. BuildDownAI declined GitHub-side dependencies for now. Re-decide for production.
6. **Runner image channel.**
   `:latest` is built from `main` (`docs/runner-images.md`). The first merge promotes a new
   `:latest`. Confirm the smoke-tested digest promotes before production picks it up.
7. **Sidecar probe deadline.**
   The boot probe caps at 30 s and records `deployed-not-serving` on failure. A slower
   production host may need the cap raised. The value is `BOOT_PROBE_TIMEOUT_MS` in
   `src/kg-provider.ts`.
8. **Allowlist roles.**
   `trigger_kg_refresh` and accept-new-baseline are admin-only. Confirm which production
   accounts hold `admin` before the first refresh.
9. **Client deploy workflow.**
   `.github/workflows/deploy-clients.yml` runs on pushes to `main` and deploys nothing, by
   design (`docs/deployment.md` → *The matrix workflow does not currently deploy clients*).
   Decide whether the merge should change that.

## Items to append

Add a dated line here whenever `testing` gains something the promotion will need.

- 2026-09-14 — initial list, written after the AII-630 programme landed on `testing`.
- 2026-09-22 — **Connector-first skills need the `testing` MCP door.** BuildDown skills 1.5.29 (skills
  PR #128, ADR 0002) bind through `get_project_binding()` and the claude.ai connector model. Checked
  against production (`https://ai-implement.fly.dev`, v1.1.0, `main` at #336, 451 commits behind
  `testing`) on 2026-09-22: `/mcp` serves seven read tools and no `get_project_binding`,
  `get_session_identity`, `kg_*` or Restate-backed tools (AII-687 tree, AII-715), and dynamic client
  registration with the claude.ai callback returns 400 because `MCP_ALLOWED_REDIRECT_ORIGINS` is not
  set there (the code path exists on `main`; the secret does not). Until production carries `testing`'s
  MCP surface, the current skills cannot point at it; only skills `v1.4.0` (the `main` channel, with
  `bd-project-setup` and a per-repo `.mcp.json`) pair with orchestrator v1.1.0. Add at promotion time:
  (a) set the redirect-origin secret on the production app, or land AII-732 first so it is an admin
  setting; (b) add the production `/mcp` as a claude.ai connector and sign in once from chat and once
  from Claude Code `/mcp`; (c) confirm the production mappings' Linear workspace and reconnect the
  Linear connector to it; (d) run `bd-kg-search` in a fresh chat and a fresh `claude -p` session and read
  the first six lines (BDS-80 capstone lists the expected text).
