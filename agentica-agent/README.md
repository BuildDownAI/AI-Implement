# agentica-agent

Subprocess that runs Symbolica's [agentica](https://docs.symbolica.ai) hosted agent as an alternative implementation agent for AI-Implement. Spawned by the orchestrator's feedback-loop step when a project mapping's `agent = "agentica"`.

This is **not** part of `src/`. It's a separate compilation unit with its own `package.json` and `node_modules`, compiled with `tspc` (ts-patch) instead of plain `tsc` because the agentica SDK uses a TypeScript transformer to extract runtime type info from JS scope functions. Isolating it here keeps the main orchestrator's `tsc` build untouched.

See [docs/AGENTICA-AGENT.md](../docs/AGENTICA-AGENT.md) for the full design.

## Build

```bash
cd agentica-agent
npm install            # installs @symbolica/agentica + ts-patch
npm run build          # tspc → ../dist-agentica-agent/{main,tools}.js
```

Root convenience: `npm run build:agentica-agent` from the orchestrator root does the same.

## Smoke test

A self-contained run that bypasses workspace/prompt env requirements:

```bash
AGENTICA_API_KEY=... npm run smoke
```

The agent gets a tiny task (write `smoke.js` reversing a string, write tests, iterate to green) in `/tmp/agentica-agent-smoke`. Used to validate the binary end-to-end without an AI-Implement workspace.

## Production contract (read by `main.ts`)

| Env var | Required | Notes |
|---|---|---|
| `AGENTICA_API_KEY` | Yes | Hosted-agentica auth. |
| `WORKSPACE_DIR` | Yes | Absolute path to the repo root the agent edits. Tools default file paths relative to this. |
| `AGENTICA_AGENT_PROMPT` | Yes | Rendered `WORKFLOW.md` content (front matter stripped, ${VAR} substituted). Becomes the agent's `premise:`. |
| `ISSUE_TITLE` | No | Used in the user message. Defaults to `(no title)`. |
| `AGENTICA_MODEL_PRIMARY` | No | Defaults to `anthropic:claude-sonnet-4.6`. |
| `AGENTICA_MODEL_FALLBACK` | No | Defaults to `openai:gpt-4.1`. **Not consumed in phase 1** — reserved for the phase-5 fallback path. |
| `AGENTICA_AGENT_BASH_TIMEOUT_MS` | No | Per-bash-call timeout in ms. Default 300000 (5 min). |

## Exit codes

- `0` — agent completed without throwing
- `1` — fatal at startup (missing env, etc.)
- `2` — `agent.call` threw mid-run

## Phase status

Phase 1 only. The orchestrator does **not** yet spawn this subprocess; that's phase 3 (pipeline integration). Run it standalone today via `npm run smoke`.
