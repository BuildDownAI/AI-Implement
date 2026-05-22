# Agentica support

AI-Implement ships with first-class support for [agentica](https://docs.symbolica.ai/), Symbolica AI's type-safe Python agent framework. Target repos that `from agentica import spawn` can use it inside Claude Code sessions without any per-repo setup.

## How it works

Two pieces of plumbing make agentica available inside a session:

1. **Runner image** — `Dockerfile.session` installs Python 3.12 (via [uv](https://astral.sh/uv)) and `symbolica-agentica` system-wide. The system `python3` (3.11) is left untouched for the runner's own toml parser; agentica lives on `python3.12`.
2. **Secret passthrough** — `AGENTICA_API_KEY` is in `SECRET_ENV_KEYS` ([src/local-docker.ts](../src/local-docker.ts)) and mirrored in the Fly Machines builder ([src/fly-machines.ts](../src/fly-machines.ts)). When set on the orchestrator, it lands in the session's env via the same path as `ANTHROPIC_API_KEY` / `LINEAR_API_KEY`.

The entrypoint script does a soft import smoke-test at session boot:

```
[session] ... agentica available (python3.12 import OK; AGENTICA_API_KEY set)
```

or, when the key is unset:

```
[session] ... agentica skipped (AGENTICA_API_KEY not set)
```

If the key is set but the import fails, the entrypoint logs a `WARN` and continues — agentica is never required.

## Setting the key

Pick one based on your deploy mode:

| Mode | Where to set `AGENTICA_API_KEY` |
|---|---|
| Local Docker (`npm run dev:local`) | `.env` in the orchestrator repo |
| Fly Machines | `fly secrets set AGENTICA_API_KEY=... --app <orchestrator-app>` and (for global session injection) the **Global Machine Secrets** section in the admin UI's Settings page |
| GitHub Actions runner | Add `AGENTICA_API_KEY` as a repo or org secret in the target repo; `workflows/claude-implement.yml` already forwards arbitrary secrets via standard GH Actions mechanics |

## Version pinning

The runner pins `symbolica-agentica` and the Python version as build args at the top of `Dockerfile.session`:

```dockerfile
ARG PYTHON_AGENTICA_VERSION=3.12
ARG AGENTICA_VERSION=0.4.0
```

Bump them together with any agentica release that changes call signatures. There is no model-routing logic in AI-Implement itself — agentica callsites in target repos pick their own models.

## Smoke-testing locally

After `npm run build:runner:local`, you can verify the image directly:

```bash
docker run --rm \
  -e AGENTICA_API_KEY=anything \
  --entrypoint python3.12 \
  ai-implement-runner:local \
  -c "from agentica import spawn; print('ok')"
```

Or run an end-to-end implementation against a real Linear issue with `npm run dev:local` — the session's stdout will show the `agentica available` line at boot.

## Why agentica is in the upstream image (not per-repo)

We considered making agentica a per-repo opt-in via `.ai-implement/image.yml`. We chose to bake it into upstream because:

- The cost is bounded (a Python 3.12 toolchain + the agentica wheel, ~80–150 MB).
- The mechanism (secret passthrough) needs to live upstream anyway.
- Customer repos shouldn't have to think about building a runner image just to use a single Python dependency.

If you don't use agentica, the only cost is image size — the entrypoint skips the import path cleanly when `AGENTICA_API_KEY` is unset.
