# Agentica support

AI-Implement ships with first-class support for [agentica](https://docs.symbolica.ai/), Symbolica AI's type-safe Python agent framework. Target repos that `from agentica import spawn` can use it inside Claude Code sessions without any per-repo setup.

## What AI-Implement provides (and what it doesn't)

AI-Implement is the **runtime + plumbing**, not an agentica callsite. The orchestrator dispatches Claude Code (Anthropic's CLI) into a container; that's the agent. Agentica is for **target-repo Python code** that calls `spawn()` itself. AI-Implement makes three things possible:

1. `from agentica import spawn` works inside the container (Python 3.12 + the package are baked in)
2. `os.environ["AGENTICA_API_KEY"]` is set so target-repo callsites can authenticate
3. `os.environ["AGENTICA_MODEL_PRIMARY"]` and `os.environ["AGENTICA_MODEL_FALLBACK"]` are set so callsites pick model IDs from the orchestrator's config instead of hardcoding

AI-Implement does **not** call agentica, does not implement fallback logic, and does not own a Python API surface inside the container. Customer code does that.

## How it works

Three pieces of plumbing make agentica usable from a session:

1. **Runner image** — `Dockerfile.session` installs Python 3.12 (via [uv](https://astral.sh/uv)) and `symbolica-agentica` system-wide. The system `python3` (3.11) is left untouched for the runner's own toml parser; agentica lives on `python3.12`.
2. **Secret passthrough** — `AGENTICA_API_KEY` is in `SECRET_ENV_KEYS` ([src/local-docker.ts](../src/local-docker.ts)) and mirrored in the Fly Machines builder ([src/fly-machines.ts](../src/fly-machines.ts)). When set on the orchestrator, it lands in the session's env via the same path as `ANTHROPIC_API_KEY` / `LINEAR_API_KEY`.
3. **Model env passthrough** — `AGENTICA_MODEL_PRIMARY` / `AGENTICA_MODEL_FALLBACK` are public (non-secret) env vars with orchestrator-level defaults. Customer code reads them via `os.environ`.

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

## Model selection

The orchestrator injects two non-secret env vars into every session:

| Env var | Default | Purpose |
|---|---|---|
| `AGENTICA_MODEL_PRIMARY` | `anthropic:claude-sonnet-4.6` | Same model AI-Implement uses for Claude Code by default |
| `AGENTICA_MODEL_FALLBACK` | `openai:gpt-4.1` | Non-Anthropic peer; target-repo code implements try/except to use this on failures |

Agentica accepts `provider:model-id` (colon) and OpenRouter slugs (`provider/model-id`); both forms work. Override per-orchestrator via `.env` or `fly secrets`; override per-project via the admin UI mapping's `extraEnv` field. The defaults are deliberately conservative — they match AI-Implement's existing Claude Code tier and give a cross-provider escape hatch.

### Customer-code contract

Target repos read the env vars and implement fallback themselves. The canonical pattern:

```python
import os
from agentica import spawn
from agentica.errors import AgenticaError

PRIMARY = os.environ.get("AGENTICA_MODEL_PRIMARY", "anthropic:claude-sonnet-4.6")
FALLBACK = os.environ.get("AGENTICA_MODEL_FALLBACK", "openai:gpt-4.1")

async def call_with_fallback(premise: str, prompt: str) -> str:
    try:
        agent = await spawn(premise=premise, model=PRIMARY)
        return await agent.call(str, prompt)
    except (AgenticaError, ConnectionError) as err:
        print(f"[agentica-fallback] primary={PRIMARY} failed ({err}); retrying with {FALLBACK}")
        agent = await spawn(premise=premise, model=FALLBACK)
        return await agent.call(str, prompt)
```

AI-Implement deliberately does **not** ship a helper module that wraps this pattern. The fallback semantics — what counts as a retryable error, whether to log to a custom telemetry table, whether to mark the run differently — are workload-specific. Each customer repo owns its own wrapper.

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
