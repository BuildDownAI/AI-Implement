# Knowledge-graph architecture

End-to-end shape of the knowledge graph: the two repositories it spans, the technology at each
lifecycle stage, and the single fact that governs every operational decision — **the orchestrator
and the KG are one deployable unit.**

Reference for the configured KG source repository (set via `KG_SOURCE_REPO`; unset builds without a
sidecar — `/mcp` returns 503), its `kg_ingest/`, `kg_query/`,
and `snapshot/` directories, the KG stages of `Dockerfile`, `docker-entrypoint.sh`, and
`src/deploy.ts`. For the `/mcp` endpoint, the OAuth flow, and the ways a build ships degraded, see
[kg-sidecar.md](kg-sidecar.md). For deploy paths and their flags, see [deployment.md](deployment.md).

## The monolith

The orchestrator, the MCP proxy, and the knowledge graph's data ship in **one Docker image**, run in
**one Fly machine**, and carry **one release version**. There is no separate KG service, no separate
app, no separate lifecycle. The sidecar listens on `127.0.0.1:8765` and is unreachable from outside
the container.

This is a deliberate trade: it removes a service to operate, a network hop, and a second set of
credentials. What it costs is that graph data and orchestrator code cannot move independently. Six
consequences follow, and every one of them has surprised somebody.

### A data refresh is a code deploy

Updating the graph means building a new image and replacing the machine. `runDeploy` takes a deploy
hold first, so **dispatch stops**, then waits for in-flight work to drain — up to 75 minutes, after
which the deploy fails rather than interrupting a run. A KG refresh during a busy period therefore
either waits or fails.

Refreshing the graph is an operational event on the pipeline, not a data-only change. Plan it like
a release.

### A code deploy is a data refresh

The Dockerfile clones the KG repository with `git clone --depth 1` and **no ref pin**, so every build
takes whatever is on that repository's default branch (`main`) at that moment.

An orchestrator release that touches nothing about the KG will still re-materialize the graph from
the newest committed snapshot. **The graph's age stamp can change without anyone running a refresh.**
An operator who deploys a code fix and then finds the graph newer than they left it is seeing this,
not a bug.

The reverse also holds, and it is the sequencing rule in `bd-kg-refresh`: confirm the snapshot push
has landed *before* triggering the deploy. The deploy is the only thing that picks it up.

### A broken snapshot blocks unrelated code deploys

Of the four KG build stages, three fail soft. The graph materialize step does not — it is the one KG
stage with no fallback, so a snapshot that will not parse fails the whole image build.

That is correct for the graph and awkward for everything else: while the KG default branch carries a
bad snapshot, **no orchestrator deploy succeeds**, including a fix for an unrelated production
problem. The recovery is to repair or revert the snapshot in the KG repository first.

### Rollback is all-or-nothing

Rolling the orchestrator back to an earlier release rolls the graph back with it. The two cannot be
versioned apart, because they are the same artifact.

### Coupling is at deploy time, not run time

The monolith does **not** couple availability. Sidecar failure is non-fatal at every stage: a missing
entry point, a crash, or a readiness timeout all leave `KG_SIDECAR_URL` unset and let the orchestrator
boot normally. `/mcp` degrades and every other route is unaffected.

So a dead graph never takes the pipeline down. Only a *deploy* joins their fates.

### Resources are shared

The machine runs at **512 MB** — raised from 256 MB for the sidecar in AII-322. The published setup
docs still describe 256 MB, which is right only for an orchestrator built without the KG.

Memory is also shared at build time, and that has bitten once already: the embed step was OOM-killed
at ~21k quads once DocSection cards entered the graph (KGB-8). Growth in the graph is a constraint on
the image build, not only on query latency.

## The five stages

| Stage | Name | Where | Note |
|---|---|---|---|
| 1 | **Ingest** | local machine, python ≥ 3.10 | the only stage that fetches source data |
| 2 | **Commit** | git — `snapshot/parts/*.nt` | the transport between the repos |
| 3 | **Build** | Docker: node:24-slim + python venv | the graph is materialized here |
| 4 | **Serve** | Fly machine, 512 MB | lazy load on first query |
| 5 | **Access** | MCP client over HTTPS + OAuth | |

The repository boundary sits between stages 2 and 3. The configured KG source repository owns the
mechanism and the data. `AI-Implement` owns the image, the proxy, and the release.

### Stage 1 — Ingest

Runs on an operator's machine. **Nothing here runs in production**; the container ships no ingest path.

| Library | Role |
|---|---|
| `rdflib` >= 7.0 | Builds the graph. Every ingest module emits triples. |
| `pyshacl` >= 0.30 | Validates against `ontology/shapes.ttl`; reports `SHACL conforms`. |
| `python-frontmatter` | Parses ADRs, plans, and solutions docs into `kg:Decision` / `kg:Learning`. |
| `requests` | Linear GraphQL API. Raises without `LINEAR_API_KEY`, so a tracker run never silently produces an empty graph. |
| `beautifulsoup4` + `lxml` | Crawls documentation sites into `DocSite` / `DocPage` / `DocSection`. Imported lazily. |
| `pyyaml` | Reads `sources.yml`, the scope manifest. |
| `subprocess` → `git`, `gh` | The git spine: commits, files, PRs. No Python git binding. |
| `fastembed` + `numpy` | Builds the vector index. Imported lazily, so the core ingest never depends on them. |

The graph has two layers. The **spine** is deterministic — git, GitHub, tracker. The **semantic**
layer is parsed or extracted, and every node carries provenance. Vocabularies are `rdf`, `rdfs`,
`owl`, `prov`, `dcterms`, `skos`, `foaf`, `xsd`, defined in `ontology/kg.ttl`.

The ingest stamps `dcterms:modified` on the spine IRI before serialization (AII-326), so the age
lands in the committed snapshot rather than being computed at build time.

### Stage 2 — Committed formats

| Artifact | Format | Committed | Size |
|---|---|---|---|
| `snapshot/parts/*.nt` | N-Triples, split by subject type, sorted | Yes | ~5.7 MB |
| `snapshot/digest.md` | Markdown inventory, one line per issue | Yes | ~44 KB |
| `out/graph.trig` | TriG — the loadable form | No, gitignored | ~15 MB |
| `out/embeddings.npz` | NumPy zip: vectors, iris, types, titles, snippets, meta | No, gitignored | — |

Determinism is the point. No blank nodes, stable IRIs from stable keys, everything sorted, no
timestamps in the parts. Identical data produces identical bytes, so a tracker refresh shows a diff
in `issue.nt` and `comment.nt` and nothing else. `cat snapshot/parts/*.nt` reconstitutes the graph,
which makes the parts a checked-in backup as well as a transport.

### Stage 3 — Image build

| Step | Technology | On failure |
|---|---|---|
| Clone the KG repo | BuildKit `--mount=type=secret` | Soft — sidecar-less image |
| `pip install` into `/app/kg/.venv` | `python3 -m venv` | Soft |
| Warm the model | `fastembed`, ONNX into `FASTEMBED_CACHE_PATH` | Soft — lexical only |
| Materialize `--no-embed` | `rdflib` reads `*.nt`, writes `graph.trig` | **Hard — build fails** |
| Materialize with embed | `fastembed` + `numpy` | Soft — writes `.embeddings-failed` |

The base image is `node:24-slim`, not Alpine: `fastembed` and `onnxruntime` ship glibc wheels only.

Every soft failure that skips real work must leave a receipt. The embed step writes
`/app/kg/.embeddings-failed`, which `docker-entrypoint.sh` turns into `KG_EMBEDDINGS_DEGRADED=1` at
boot, surfaced as `kgDegraded` on `GET /`, in the deploy notification, and in `get_tenant_health`
(AII-422). See [deployment.md](deployment.md#kg-embeddings-health).

### Stage 4 — Serve

**Python sidecar** on `127.0.0.1:8765`:

| Library | Runtime role |
|---|---|
| `mcp` (FastMCP) | The MCP server. `transport="streamable-http"` under `KG_HTTP=1`, else stdio. |
| `rdflib` | The database. Parses `graph.trig` into a `Dataset`, flattens quads into one union `Graph`, runs SPARQL SELECT in process. |
| `numpy` | Cosine similarity as one normalized matrix-vector product. No ANN index at this scale. |
| `fastembed` | Embeds the **query** at request time — `BAAI/bge-small-en-v1.5`, 384 dimensions, ONNX, no torch. |
| `requests` | Only under `KG_BACKEND=stardog`. That seam is evaluated, not committed. |

**Node orchestrator**, same container:

| Library | Runtime role |
|---|---|
| `node:http` / `node:https` | `src/mcp.ts` is a hand-written JSON-RPC proxy. It uses no MCP SDK. |
| `openid-client` | OIDC delegation for `/mcp/authorize`. |
| `node:crypto` | PKCE, auth codes, token hashing. |
| `better-sqlite3` | `mcp_refresh_tokens` and the rest of the SQLite file. |

**Loading is lazy.** Three singletons build on first use, not at boot: the store parses `graph.trig`
on the first `kg_*` call, the index reads `embeddings.npz` on the first semantic query, and
`TextEmbedding` loads ONNX weights from the baked cache once.

The entrypoint's readiness poll only proves the port accepts connections — any HTTP response counts.
The first real query pays the parse and the model load. **Booting is not serving**, and this is why.

### Stage 5 — Search behaviour

`kg_hybrid_search` is the preferred tool. It fuses lexical SPARQL and vector cosine with Reciprocal
Rank Fusion (`RRF_K = 60`). An exact-identifier boost of `1.0` dominates any RRF sum (~0.03), so issue
keys and `SCREAMING_SNAKE` flags lead. A missing index sets `degraded: true` and returns lexical
results; it never raises.

Six read-only KG tools: `kg_search`, `kg_semantic_search`, `kg_hybrid_search`, `kg_neighbors`,
`kg_provenance`, `kg_path`. The orchestrator adds its own diagnostics — `get_tenant_health`,
`list_projects`, `get_fleet_report` and others — which answer from SQLite and need no sidecar.

## Freshness

**There is no runtime ingestion.** Nothing crawls or re-materializes while the orchestrator runs.
Graph age has two inputs: when the snapshot was committed, and when the image was built. A perfectly
healthy sidecar can serve a months-old view, and nothing in a query response says so.

The one reliable signal is `dcterms:modified` on `https://kg.builddown.dev/resource/graph/spine`,
read with `kg_neighbors`. Compare it against the ingest date. An unchanged stamp after a deploy means
the build served the old snapshot — usually because the push had not landed, or because the remote
builder's git cache served a stale `--depth 1` clone. Both are benign. Wait, redeploy, re-verify.

## Process: refreshing the graph

With the refresh rail (AII-426), publishing data no longer rides a release. Run `bd-kg-refresh`,
or these steps by hand.

1. Reconcile scope, ingest, and commit + push the snapshot — steps 1–5 below, unchanged.
2. **Trigger the refresh**: `POST /api/kg/refresh` with an admin session token (or the
   Deployments page's "Refresh graph now"). `202` = accepted; `409` = a refresh or a deploy is
   already in progress; `422` = runner callback not configured (see below). The orchestrator
   first checks whether the source repo already has a newer snapshot:
   - **If a newer snapshot exists**: fetches `KG_SOURCE_REPO`, stages under `/data/kg/staging`
     (materialize with the image's venv — nothing embeds), writes the completion marker last,
     swaps by rename, and restarts the sidecar.
   - **If no newer snapshot** (AII-495): dispatches a `kg-refresh` Claude runner job to ingest
     and push a new snapshot. Requires `RUNNER_CALLBACK_BASE_URL` and `RUNNER_TOKEN_SECRET`;
     without them the trigger returns `422 callback-unconfigured`. The stage advances from
     `ingest-running` to `snapshot-landed` when the runner reports back, then the local rail
     runs as above.
3. **The four gates run on the serving graph**: the sidecar answers; the vectors are present;
   a canary query returns non-empty with `degraded: false`; and the served age stamp is
   strictly newer than before the swap. Any failure reverts to the previous overlay and
   restarts again. `GET /api/kg/status` reports the outcome and the gate that fired.

`GET /api/kg/status` exposes a `stage` field with fine-grained lifecycle states:

| Stage | Meaning |
|---|---|
| `idle` | No refresh in progress |
| `checking` | Refresh triggered; comparing snapshot dates |
| `ingest-running` | Runner job dispatched; waiting for callback |
| `snapshot-landed` | Callback received; snapshot commit verified |
| `staging` | Local rail running (fetch → materialize → swap) |
| `serving` | Rail succeeded; sidecar serving new graph |
| `reverted` | Gate failed; rolled back to previous overlay |
| `failed` | Terminal failure (ingest, snapshot verification, or staging) |

Stage is persisted to the DB so a restart mid-rail fails fast (stage → `failed`) rather than
blocking all future refreshes for the remainder of the 4-hour ingest TTL. A live process that
dispatched a runner and received no callback within the TTL self-heals at the next `POST
/api/kg/refresh` call.

**Redeploy remains the fallback** — an orchestrator predating the rail (the route answers 404),
or a change that touches the sidecar's code rather than its data, still refreshes by deploy:

1. **Reconcile scope.** Call `list_projects` on the orchestrator MCP, diff against `sources.yml`, and
   commit the manifest before ingesting.
2. **Ingest** in the KG checkout:
   `./.venv/bin/python -m kg_ingest.cli --repo ../AI-Implement --tracker --secondary`
3. **Read the report.** Quads, cards, `SHACL conforms`, the age stamp, and the docs-crawl line. Treat
   `embeddings SKIPPED` as a warning, not an aside.
4. **Commit and push** `snapshot/` to `main`. Generated data goes straight to the default branch.
5. **Confirm the push landed** with `git log origin/main`. This is the monolith's sequencing rule:
   the deploy is what reads the snapshot, so a deploy that races the push builds the old graph.
6. **Self-deploy** — `POST /api/deploy` with an admin session token. Expect `202`, or `409` if one is
   already running. Never a plain `fly deploy`; see [deployment.md](deployment.md#deploy-paths).
7. **Verify live.** Non-empty results, `degraded: false`, and an age stamp equal to step 3. Check
   `kgDegraded` on `GET /` as well — a lexical-only image answers queries and looks healthy.

Steps 5 to 7 exist entirely because of the monolith. In a two-service design the data would be
reloadable on its own; here it rides a release, so the release has to be sequenced and verified.

## Refresh rail implementation (AII-426, AII-495)

[AII-426](https://linear.app/eudoxus/issue/AII-426) shipped the local refresh rail; the "Planned"
tracking issue was [AII-424](https://linear.app/eudoxus/issue/AII-424). AII-495 extended it with
runner dispatch for the ingest step. The six children (KGB-9, KGB-10, KGA-3, KGA-4, AII-425,
AII-426) are all landed. The redeploy path remains for code changes or sidecar updates.


```mermaid
flowchart TD
    subgraph CODE["CODE — deploy (same shape, safer build)"]
        C1["deploy hold · drain"] --> C2["rebuild — the image COPIES committed vectors:<br/>nothing embeds, no OOM path"]
        C2 --> C3["machine replaced"]
        C3 --> C4["boot: Node SUPERVISES the sidecar<br/>(owned child, testable)"]
    end

    subgraph DATA["DATA — refresh (new; rides no release)"]
        D1["POST /api/kg/refresh<br/>(admin session; refused while a deploy holds)"]
        D1 --> D2["fetch KG_SOURCE_REPO<br/>(read-only single-repo token)"]
        D2 --> D3["stage /data/kg/staging → materialize, no embed<br/>completion marker written LAST"]
        D3 --> D4["atomic rename:<br/>current → previous · staging → current"]
        D4 --> D5["restart sidecar<br/>(seconds; only /mcp blinks — dispatch untouched)"]
        D5 --> G{"4 gates on the SERVING graph:<br/>answers · vectors stamp-matched ·<br/>canary non-empty · stamp newer"}
        G -->|pass| P["refresh done — age stamp moved"]
        G -->|fail| F["revert to previous · restart · report the gate"]
    end

    S["SERVING RULE — where the two paths meet:<br/>the sidecar serves /data/kg/current when valid (marker present), else the baked copy.<br/>delete /data/kg + restart = full rollback"]
    CODE -.-> S
    DATA -.-> S
```

### What changes, and what deliberately does not

- **The image keeps baking a graph.** The runtime copy at `/data/kg/current` is an overlay the
  sidecar prefers when present. Deleting it and restarting returns the orchestrator to exactly
  the behaviour this doc describes — that is the rollback path.
- **"A data refresh is a code deploy" stops being true.** A refresh restarts only the sidecar:
  no deploy hold, no dispatch pause, no drain. `/mcp` blinks for a few seconds — already a
  non-fatal condition.
- **"A code deploy is a data refresh" stays true.** The build still clones the configured KG
  source repository's default branch unpinned, so a release still re-materializes the graph.
  The overlay then wins over whatever the release baked. The refresh fetches that same
  configured repository (`KG_SOURCE_REPO`), never a hard-coded slug.
- **The embeddings become a committed artifact** (`snapshot/embeddings.npz`, written with
  `np.savez_compressed`), because the serving machine can never compute them — KGB-8's OOM is
  the proof. The graph stays derived; only the vectors ship. Measured 2026-08-21 at ~21k quads:
  12.0 MB uncompressed (7.0 MB of it fixed-width-column zero-padding), 2.5 MB compressed.
  Peak refresh footprint is ~75 MB against the 1 GB volume — tenfold headroom.

### The `index.ts` budget

Full separation from `index.ts` is not achievable, because reuse forbids it: admin auth reaches
a route only through `handleAdminRequest` → `AdminDeps` → `index.ts`, and an endpoint anywhere
else would mean a new public surface and a new credential. The design is therefore a budget,
not an absence — `index.ts` gains exactly **one config field, one supervisor construction, one
`main()` lifecycle hook, and one `AdminDeps` entry**. All logic lives in injected-dependency
modules (`src/kg-sidecar.ts`, `src/kg-refresh.ts`), built in the `makeStartDeploy` shape from
the start. No new top-level function, no new route branch.

### Invariants the refresh must hold

- **Atomic overlay.** `current` is only ever created by a rename of a fully staged directory
  whose completion marker was written last. Boot ignores a `current` without the marker, so a
  crash mid-stage can never mask the baked fallback.
- **Respect the deploy hold.** A manual refresh refuses while a deploy holds; an automatic mode,
  when it lands, rides the existing poll loop the way the availability passenger does — never
  its own timer, because the hold is only observed from that loop.
- **Four gates, after the restart** — sidecar answers; vectors present and stamp-matched;
  canary query non-empty and `degraded: false`; served age stamp strictly newer. Validating the
  serving graph rather than a staged copy keeps memory at one graph. Any gate failing reverts
  to `previous` and restarts again.
- **Signals are the supervisor's problem.** Once Node spawns the sidecar instead of the shell
  `exec` chain, the orchestrator owns forwarding, reaping, and a bounded kill — a child must
  never outlive shutdown or block it.

## kg-refresh run kind

AII-493 adds a `kg-refresh` Claude runner that follows the ingest playbook autonomously — cloning the
KG source repository, running the ingest scripts, and pushing the snapshot. AII-494 adds the two
runner-callback endpoints that give this run kind its privileged access without ever vending a
long-lived credential to the runner. AII-495 wires `POST /api/kg/refresh` to dispatch the runner
when the source repo has no newer snapshot: the orchestrator mints a run token, encodes a
`RunConfigV1` with `runnerPhase: "kg-refresh"`, and dispatches via Fly Machines or local Docker.
When the runner completes, it calls `POST /api/runner/result` which routes to `onRunnerComplete` in
`src/kg-refresh.ts`. If a `snapshotCommit` SHA is included, the orchestrator verifies the commit is
visible via the GitHub API (one retry for git-cache lag) before starting the local staging rail.

Both callback endpoints require a `kg-refresh`-phase progress token (multi-use, `consume: false`);
any other phase or a missing/invalid token receives `403 Unauthorized` with no distinguishing body.
The orchestrator performs all external writes with its own credentials; the runner receives only the
minted token or the requested data.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/runner/kg-push-token` | POST | Vends a short-lived GitHub installation token with `contents: write` scoped to the single KG source repo. `forceRefresh: true` ensures the credential helper always receives a full-lifetime token. |
| `/api/runner/kg-tracker-data` | POST | Returns one paginated page (50 issues) of Linear issues for the run's team, including comments. The orchestrator performs the read; no Linear credential ever leaves the orchestrator. |

The git credential helper (`session/git-credential-helper-kg-push.sh`) re-mints on expiry using
the same progress token. `stripEmbeddedTokenFromOrigin` in `kg-snapshot-push.ts` re-strips the
token from the remote URL right before push to counter `refreshRunnerGithubCredentials`
re-embedding it after clone.

## Failure history

Each of these shipped a degraded or blocked deploy, and each is now covered by a guard.

| Date | Failure | Fix |
|---|---|---|
| 2026-08-07 | Sidecar deployed by hand from an rsync'd tree; `kg/` empty in git, machine at 256 MB | AII-322 — build-secret clone, materialize from snapshot, 512 MB committed |
| 2026-08 | "No embeddings" reports blamed on the embed step | AII-323 — it was the Docker layer cache reusing a stale materialize layer; a build secret is not a cache key, so `--no-cache` is mandatory |
| 2026-08 | Model fetched from the network at build and at query time | AII-323 — bake the model into `FASTEMBED_CACHE_PATH`, warm it as its own step |
| 2026-08 | Type-filtered tools returned empty against a loaded graph | `sources.yml` missing from the image; without it the server falls back to a placeholder IRI namespace |
| 2026-08-18 | Self-deploy v111 built the previous snapshot; v112 minutes later was correct | Remote-builder git-cache lag on a `--depth 1` clone — wait and redeploy |
| 2026-08-19 | v115 shipped lexical-only after the embed step was OOM-killed at ~21k quads / 1,438 cards | KGB-8 — free the rdflib graph before embedding, pre-allocate the output array, embed in slices of 64 |
| 2026-08-20 | A degraded build was indistinguishable from a healthy one | AII-422 — `.embeddings-failed` receipt, `KG_EMBEDDINGS_DEGRADED`, `kgDegraded` on health, notification, and `get_tenant_health` |

## Lineage

| Wave | Issues | Result |
|---|---|---|
| MCP endpoint | AII-296, AII-297, AII-302 | `/mcp` route, OAuth, single-machine deploy |
| Durable image | AII-322, AII-323 | Build-secret clone, materialize from snapshot, baked model |
| Shared graph | AII-324, AII-326, AII-327, AII-328, AII-329 | Orchestrator KG as source of truth, age stamp, skills migrated |
| Usability | AII-346 | Refresh tokens — hourly re-auth was unusable |
| Deploy ownership | AII-353, AII-355 | Self-deploy, source stamps, availability |
| Docs ingestion | KGB-2 through KGB-5, KGA-2, BDS-38 | Crawl, section chunks, citable anchors |
| Scaling | KGB-8, AII-422 | Bounded-memory embedding, and a receipt when it still fails |
| Autonomous ingest | AII-493, AII-494 | kg-refresh run kind: Claude runner follows the ingest playbook; runner-callback endpoints vend scoped push token and tracker data |
| Runner dispatch + stage machine | AII-495 | `POST /api/kg/refresh` dispatches the runner when ingest is needed; persisted stage machine (idle → checking → ingest-running → snapshot-landed → staging → terminal) survives restarts; live TTL watchdog; `/admin#deployments` stage badges |
