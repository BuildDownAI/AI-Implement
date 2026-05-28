# Implementation Agent Architecture

AI-Implement uses a pluggable executor model to support multiple coding agents. The pipeline (clone, install, implement, review, push) is shared — only the `LLMExecutor` implementation changes.

## How it works

```
Orchestrator (index.ts)
  │
  │  dispatches to Runner (Fly Machine / local Docker / GHA)
  │  passes AI_IMPLEMENT_AGENT env var ("claude-code" or "agentica")
  ▼
Runner (run-autonomous.ts)
  │
  │  selects LLMExecutor based on AI_IMPLEMENT_AGENT
  ▼
Pipeline Steps (implement.ts, review.ts, etc.)
  │
  │  call context.llmExecutor.invoke({ prompt, model, maxTurns })
  ▼
LLMExecutor implementation
  ├── ClaudeCliExecutor  → spawns `claude` CLI
  └── AgenticaAgentExecutor → spawns `node agentica-agent/dist/main.js`
```

## The LLMExecutor interface

```typescript
// src/pipeline/types.ts
interface LLMExecutor {
  invoke(params: {
    prompt: string;
    model: string;
    maxTurns?: number;
    tools?: string[];
  }): Promise<LLMResult>;
}

interface LLMResult {
  stdout: string;
  stderr?: string;
  exitCode: number;
  tokensUsed: number;
}
```

Every executor receives the same inputs and returns the same outputs. Pipeline steps are completely agent-agnostic — they never know or care which agent is running.

## Existing executors

### ClaudeCliExecutor (`src/pipeline/executor.ts`)

Spawns Anthropic's `claude` CLI with the prompt and model. Requires `claude` on PATH (installed in the runner image). Auth via `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`.

### AgenticaAgentExecutor (`src/pipeline/executor-agentica.ts`)

Spawns `node agentica-agent/dist/main.js` — a self-contained subprocess that uses the `@symbolica/agentica` SDK. Passes the prompt via `AGENTICA_AGENT_PROMPT` env var. Auth via `AGENTICA_API_KEY`. Retries once with `AGENTICA_MODEL_FALLBACK` on exit-code-2 (mid-run failure).

The `agentica-agent/` directory is a standalone package with its own `package.json`, `tsconfig.json`, and build step (`tspc` for the agentica transformer). It has its own tool surface (readFile, writeFile, editFile, bash, fileExists, listDir) that mirrors what Claude Code provides natively.

## Adding a new agent (e.g. OpenCode, Aider, Codex)

### 1. Create the executor

Add `src/pipeline/executor-<name>.ts`:

```typescript
import { spawn } from "node:child_process";
import type { LLMExecutor, LLMResult } from "./types.js";

export class OpenCodeExecutor implements LLMExecutor {
  constructor(private readonly workspaceDir: string) {}

  invoke(params: { prompt: string; model: string; maxTurns?: number; tools?: string[] }): Promise<LLMResult> {
    return new Promise((resolve, reject) => {
      // Spawn the agent's CLI or subprocess
      const proc = spawn("opencode", ["--prompt", params.prompt, "--model", params.model], {
        cwd: this.workspaceDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      const chunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      proc.stdout.on("data", (d: Buffer) => chunks.push(d));
      proc.stderr.on("data", (d: Buffer) => stderrChunks.push(d));

      proc.on("close", (code) => {
        resolve({
          stdout: Buffer.concat(chunks).toString(),
          stderr: Buffer.concat(stderrChunks).toString(),
          exitCode: code ?? 1,
          tokensUsed: 0,
        });
      });
      proc.on("error", reject);
    });
  }
}
```

The pattern is always: spawn a subprocess, pass the prompt somehow (CLI arg, env var, stdin), capture output, return `LLMResult`.

### 2. Register it in the selector

In `src/run-autonomous.ts`, add the new agent to the selection branch:

```typescript
import { OpenCodeExecutor } from "./pipeline/executor-opencode.js";

const agentSelector = process.env.AI_IMPLEMENT_AGENT ?? "claude-code";
const llmExecutor = opts.llmExecutor ?? (() => {
  switch (agentSelector) {
    case "agentica": return new AgenticaAgentExecutor(workspaceDir);
    case "opencode": return new OpenCodeExecutor(workspaceDir);
    default:         return new ClaudeCliExecutor(workspaceDir);
  }
})();
```

### 3. Add the agent ID to config

In `src/config.ts`:

```typescript
export type AgentId = "claude-code" | "agentica" | "opencode";
```

### 4. Plumb any agent-specific env vars

If the new agent needs its own API key or config:
- Add to `AppConfig` in `src/index.ts`
- Add to `SessionMachineInput` in `src/fly-machines.ts`
- Add to `LocalRunnerInput` in `src/local-docker.ts`
- Add to `SECRET_ENV_KEYS` in `src/local-docker.ts` if it's a secret

Follow the same pattern as `agenticaApiKey` or `anthropicApiKey`.

### 5. (Optional) Add a subprocess package

If the agent needs a custom tool surface or adapter (like agentica does), add a directory at the repo root (e.g. `opencode-agent/`) with its own package.json and build. Add the build to the runner Dockerfile.

If the agent has a CLI that accepts a prompt and works in a directory (like Claude Code does), you don't need a subprocess package — just spawn the CLI directly.

## Selection flow

```
Admin UI → mapping.agent column → orchestrator env var → runner selection → executor
```

1. Per-project `agent` field is stored in the `mappings` DB table
2. Orchestrator reads `mapping.agent` and sets `AI_IMPLEMENT_AGENT` env var on the runner
3. Runner reads the env var and instantiates the correct executor
4. All pipeline steps use the executor identically

## Design principles

- **Pipeline steps never branch on agent type.** If you find yourself writing `if (agent === "agentica")` inside a step, the abstraction is leaking.
- **Executors are simple.** They spawn a process, pass a prompt, capture output. No business logic.
- **Auth and model config are env vars.** The orchestrator plumbs them; the executor reads them. No special config objects.
- **Failure semantics are exit codes.** 0 = success, non-zero = failure. Steps read `exitCode` to decide what to do.
