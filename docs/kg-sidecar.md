# KG sidecar and the `/mcp` endpoint

The orchestrator bundles a Python knowledge-graph sidecar that serves `kg_*` tools, and exposes them to MCP clients through an OAuth-authenticated proxy at `/mcp`. This covers the deploy shape, how the image is built, the OAuth flow, and the ways a deploy can ship without a working sidecar.

Reference for `docker-entrypoint.sh`, the KG stages of `Dockerfile`, `src/mcp.ts`, `src/mcp-oauth.ts`, and `src/deploy.ts`. `CLAUDE.md` carries the summary and points here.

## Deploy shape

The sidecar runs **inside the orchestrator container on loopback** — no separate service, no public port, no second Fly app. `docker-entrypoint.sh` starts it on `127.0.0.1:8765`, waits for it, exports `KG_SIDECAR_URL`, and only then executes Node.

Startup has two entry points, tried in order: `kg/start.sh` (preferred — the vendor script knows its own arguments, and is generated at build time) or a bare `kg/server.py` with a pre-built `.venv`. Neither present means no sidecar.

Readiness is polled for up to 30 seconds. **Any HTTP response counts as ready**, including 4xx and 5xx — the check is whether the server accepts connections, not whether it answers correctly. The poll also bails early if the sidecar process has already exited, rather than waiting out the full timeout.

**Sidecar failure is non-fatal at every stage.** A missing entry point, a crash, or a readiness timeout all leave `KG_SIDECAR_URL` unset and let the orchestrator boot normally; `/mcp` returns 503 and every other route is unaffected.

For local development, start the sidecar yourself and set `KG_SIDECAR_URL` in `.env`, or leave it blank to run without `/mcp`.

## What `/mcp` tells you, and what it hides

The endpoint needs **both** `KG_SIDECAR_URL` and `OAUTH_REDIRECT_BASE_URL`, but the two are not equally visible from outside, because the auth gate sits between their checks.

- **`OAUTH_REDIRECT_BASE_URL` unset** — `/mcp` answers **503** to every caller.
- **`KG_SIDECAR_URL` unset** — `/mcp` answers **401** to an unauthenticated caller. Only an authenticated request that actually needs the sidecar reaches the 503; an authenticated `tools/list` still answers **200**, listing the built-in diagnostic tools alone. The sidecar check sits below both the auth gate and that routing deliberately, so those diagnostics stay reachable on a sidecar-less image.

**So an unauthenticated probe of `/mcp` cannot distinguish a sidecar-less release from a healthy one — both answer 401.** The public endpoint that can is `/.well-known/oauth-protected-resource`, which 503s when either variable is missing.

Inside the container the question is settled without a request at all: `docker-entrypoint.sh` exports `KG_SIDECAR_URL` only after the sidecar answers its readiness check, so an absent value is the sidecar-less signal. That is what the orchestrator itself reads at boot.

## Building the image

### Base image

`node:24-slim` (Debian bookworm), not Alpine. fastembed and onnxruntime ship pre-built glibc wheels, and Alpine's musl libc makes those fail to install without a full from-source build. Slim costs roughly 30 MB and makes the sidecar viable without cross-compilation.

### Acquiring the KG source

The knowledge-graph repository is private. A **BuildKit build secret** mounts a GitHub token for exactly one `RUN` layer to clone it; the token is never written to `ARG`, `ENV`, or image history.

**Where that token comes from is an operational prerequisite, not a detail.** A self-deploy mints it from the GitHub App installation, scoped to the knowledge-graph repository alone with `contents: read` — which only works if that repository is part of the installation. The installation grants selected repositories rather than the whole organisation, so it has to be added deliberately. Without it the mint fails with a 422 naming an inaccessible repository, before any build starts; the deploy reports a failure rather than shipping a sidecar-less image, which is the one good thing about failing this early. A manual deploy sidesteps the question entirely by passing an operator's own token.

That requirement is a consequence of automating the deploy, and it is worth understanding rather than working around. The operator script that preceded self-deploy cloned the repository with `gh auth token` — a *human's* credential, which reached the repository because that human could. An orchestrator has no human behind it; its only GitHub identity is the App installation, so access that used to be ambient has to be granted explicitly. The gap was always there, and borrowing a person's credentials merely hid it.

**Changing this is a deliberate decision, not a configuration tweak.** Two alternatives exist, and both cost something the current shape does not:

- **A read-only deploy key** on the knowledge-graph repository. The narrowest option — nothing else gains access — but it adds a secret to store and rotate, needs one per fork, and the clone would have to move from HTTPS to SSH.
- **A personal access token.** Works immediately and widens nothing at the installation, but reintroduces a person-shaped credential that leaves when they do, which is the property automating the script was meant to remove.

The App installation was chosen because it adds no new secret and keeps the per-deploy token scoped to a single repository. Its cost is that installation-*wide* tokens — the dependency-token vending path mints one — now reach the knowledge-graph repository too. That is bounded: the setting defaults to off per project, and a per-project repository list is already planned to replace the all-or-nothing scope. Revisit this if that plan changes.

The mount is declared `required=false`, so a build with no secret still succeeds — it logs `[kg] sidecar-less build` and produces a working orchestrator without `/mcp`. That fail-soft behaviour is deliberate, and it is also the trap described below.

### The four build stages

1. **Clone** — copies `kg_query`, `kg_ingest`, and `snapshot` plus the top-level files, then generates `start.sh` with the runtime environment baked in.
2. **Dependency install** — creates `/app/kg/.venv` from `requirements.txt`. Absent requirements means no venv, and everything downstream skips.
3. **Model bake** — warms the fastembed model `BAAI/bge-small-en-v1.5` into `FASTEMBED_CACHE_PATH=/app/kg/.fastembed-cache` so the running sidecar never fetches it at query time. **Soft failure** — logs `[kg] WARNING: EMBEDDINGS BUILD FAILED`, writes `kg/.embeddings-failed`, and continues lexical-only.
4. **Materialize and embed** — `kg_ingest.materialize --no-embed` produces `out/graph.trig`, then a second full pass adds semantic vectors. The graph pass is a **hard failure**: it is the one step not wrapped in a fallback, so a broken graph fails the build. The embed pass is **soft**: it writes `kg/.embeddings-failed` and falls back to lexical-only search.

When `docker-entrypoint.sh` detects `kg/.embeddings-failed` at boot it exports `KG_EMBEDDINGS_DEGRADED=1`, logs a warning, and the orchestrator surfaces this in two places: `GET /` returns `{"kgDegraded": true}` in the health payload, and deploy notifications include a warning line so the degraded state is visible immediately after a deploy.

`start.sh` exports the same `FASTEMBED_CACHE_PATH`, so the running sidecar reads the baked cache rather than downloading on first query. `kg_hybrid_search` therefore returns results immediately on boot with no separate data-load step.

### The graph is built from committed data, at build time

The clone brings three directories — `kg_query` (the server), `kg_ingest` (the transformer), and `snapshot` (the source data) — plus `requirements.txt` and `sources.yml`. The KG repository owns both the mechanism and the data.

**There is no runtime ingestion.** Nothing crawls, refreshes, or re-materializes while the orchestrator runs. The graph's freshness is a product of two separate things: when the snapshot was last committed to the KG repository, and when this image was last built. A perfectly healthy sidecar can serve a months-old view of the world, and nothing in its responses indicates the age of what it is serving. The clone is `--depth 1`, so the image does not carry the history that would let you check.

Updating the graph therefore means updating the snapshot upstream **and** rebuilding the orchestrator image. A redeploy alone changes nothing about graph content.

The container runs as the unprivileged `node` user.

## Deploying

**A plain `fly deploy` silently produces a sidecar-less image.** Deploy through the orchestrator itself, or with the manual command in [deployment.md](deployment.md#deploy-paths) when there is no orchestrator to ask.

Three separate mistakes each produce a silently degraded deploy, and each has happened repeatedly:

- **The build secret is required for the clone.** Without it the build fail-softs to a sidecar-less image rather than failing.
- **`--no-cache` is required.** A build secret is not part of the layer cache key, so a repeat deploy otherwise reuses a stale — possibly sidecar-less — clone layer even when the secret is present.
- **The token must be exported, not inlined.** An inline `GH_TOKEN=... fly deploy ... "$GH_TOKEN"` prefix does not affect same-line expansion and passes an empty secret.

Self-deploy carries all three by construction: they are assembled in one place and a test asserts each is present, so they cannot be dropped the way a hand-typed command can. The exported-token trap disappears entirely there, because the secret is passed as an argument rather than through a shell.

A release that boots is not necessarily a release that serves, and the difference is invisible from the Fly dashboard. **After a self-deploy** the orchestrator checks itself: the process that comes up in place of the one that started the deploy records whether its own image carries a sidecar, and `/admin#deployments` shows the result. A release made any other way records nothing, because no deploy hold was taken for it — those still need the manual check below.

To check by hand, poll **`/.well-known/oauth-protected-resource`** — 200 means both variables are set, 503 means one is missing. Polling `/mcp` for a 401 proves only that the route is configured.

### Verifying more than "it answers"

A 401 proves the endpoint is alive and OAuth-gated. It does not prove the graph is queryable.

The clone copies the KG's `sources.yml`, which pins the IRI namespace. Without it the server falls back to a placeholder namespace and every type-filtered `kg_*` tool returns empty — the graph loads, queries match nothing, and nothing errors. Verify a deploy with a real query (`kg_search` returning non-empty, or `degraded:false` in a `kg_hybrid_search` response), not just the 401.

### Building without the sidecar

```bash
docker build .                 # local, no secret
fly deploy --remote-only       # degraded: /mcp returns 503, all other routes healthy
```

## MCP OAuth

`/mcp` returns 401 with a `WWW-Authenticate` header pointing at `/.well-known/oauth-protected-resource`. A compliant client discovers the authorization server from there and completes an RFC 6749 authorization-code flow with PKCE.

| Endpoint | Purpose |
|----------|---------|
| `POST /mcp/register` | RFC 7591 dynamic client registration — returns `client_id` |
| `GET /mcp/authorize` | Starts the PKCE flow; delegates to the configured OIDC provider |
| `GET /mcp/callback/{provider}` | OIDC callback; applies the allowlist, mints a 5-minute auth code |
| `POST /mcp/token` | `authorization_code` exchanges code + PKCE verifier for an access token and a refresh token; `refresh_token` rotates both |
| `GET /.well-known/oauth-protected-resource` | Resource metadata pointing at the authorization server |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 authorization-server metadata |

Authorization is **fail-closed**: a verified identity must pass the same `OAUTH_ALLOWED_DOMAINS` / `OAUTH_ALLOWED_EMAILS` allowlist as the admin UI.

### Token lifetimes and rotation

Access tokens default to one hour and are configurable through `MCP_ACCESS_TOKEN_TTL` (seconds). Refresh tokens live **30 days**, so a client re-authenticates in a browser roughly monthly rather than hourly.

Refresh is **rotating with reuse detection**. Each refresh mints a replacement in the same rotation chain, tracked by a `family_id` on the `mcp_refresh_tokens` table. Presenting an already-rotated token is treated as a replay: the entire family is deleted and a warning is logged, so a stolen token cannot be used alongside the legitimate client — both are forced back through a full sign-in.

Registration is bounded in the same spirit: a dynamically registered client that never completes its first authorization is pruned after 24 hours, and expired refresh tokens are swept on the same pass.

`MCP_ALLOWED_REDIRECT_ORIGINS` controls which callback origins dynamic clients may use. Loopback IP-literal HTTP callbacks are allowed by default; any other HTTPS origin must be listed explicitly, and arbitrary HTTPS callbacks are denied.

The orchestrator proxies auth-verified requests to the sidecar verbatim and **strips the `Authorization` header before forwarding**, so the sidecar never sees the caller's token. It should be reachable only from loopback.

Register two additional redirect URIs in the provider consoles, alongside the admin-UI ones:

- `${OAUTH_REDIRECT_BASE_URL}/mcp/callback/google`
- `${OAUTH_REDIRECT_BASE_URL}/mcp/callback/microsoft`

## Memory sizing

Fastembed models load into process memory at startup. A small model such as `BAAI/bge-small-en-v1.5` is ~130 MB on disk but expands to roughly 300–400 MB resident. With the orchestrator's own Node footprint of 100–150 MB, **256 MB Fly machines are too small** and will OOM-kill one process or the other.

Minimum with the sidecar is **512 MB**; **1 GB** gives comfortable headroom for larger models or concurrent requests.

```toml
[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

`fly.toml` ships 512 MB as the base default. Adjust per client in `clients/<slug>.toml`.

## Repository layout

`kg/` holds only a `.gitkeep` placeholder in git — the actual server code and snapshot are cloned at build time and never committed. The directory is excluded from workflow sync and never copied to target repos.
