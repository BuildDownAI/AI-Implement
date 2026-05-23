# Agentica as an alternative implementation agent

**Status**: Design doc, post-POC. POC passed 2026-05-23. Implementation not started.

## TL;DR

AI-Implement today drives one implementation agent — `claude-code` (Anthropic's CLI). This doc proposes **agentica** (Symbolica's TypeScript SDK, hosted via `AGENTICA_API_KEY`) as a per-project alternative, isolated as its own subprocess so the existing pipeline is untouched.

A spike proved the primitive works (`agentica-spike/spike.ts`): a hosted-agentica agent, given two JS functions in `scope`, correctly reasoned about the task and called the functions to transform a file. End-to-end ran on the AGENTICA_API_KEY only — no agentica-server, no OpenRouter key.

## Why an alternative agent at all

Three reasons we'd want this option:

1. **Customer preference / lock-in avoidance.** Some target repos (alphawheel) already standardize on agentica for their own runtime agents. Letting them implement code via the same framework is a coherence win.
2. **Cross-provider model flexibility at the agent layer.** Agentica accepts any OpenRouter model slug; the runtime agent can flip between Claude/GPT/Gemini per project without changing AI-Implement plumbing.
3. **A second option keeps the architecture honest.** AI-Implement was designed for pluggable agents; today there's only one. Building agentica forces the seams to be real.

## What the POC proved (and didn't)

✅ **Proved.** `@symbolica/agentica` 0.4.1 with `AGENTICA_API_KEY` can:
- Spawn a hosted agent with a `premise:` (system-prompt analog)
- Accept plain JS functions as `scope` — no JSON Schema or MCP wrapping
- Stream output via a `listener:` callback
- Execute multi-step Python-style code in its sandbox, calling our JS functions

✅ **Build pattern.** The TS transformer (`@symbolica/agentica/transformer`) runs via `tspc` (ts-patch's wrapper). Standalone project compiles cleanly with `ts-patch install -s` + `tspc -p tsconfig.json`.

❌ **Not proven (yet).** The spike was a single-shot file transform. Open questions for real implementation work:
- Does agentica do **multi-turn iterative tool use** the way Claude Code does (read → plan → edit → test → fix → repeat across 30+ tool calls)? Or is it one-prompt-one-program-one-result?
- How does it behave when tool calls **fail mid-run** (file not found, shell command non-zero exit)?
- **Cost** under sustained tool-using sessions — is there a per-tool-call markup?
- Can `premise:` be as long as `WORKFLOW.md` typically gets (often 200+ lines)?

These all want a deeper POC before integration locks in.

## Architecture: agentica as a subprocess

```
Today (Claude Code path):
  feedback-loop.ts step → spawns `claude-code` CLI subprocess
                          → claude-code reads WORKFLOW.md, edits files,
                             commits, exits with status
                          → feedback-loop reports + advances pipeline

Proposed (agentica path):
  feedback-loop.ts step → branches on mapping.agent
    ├ "claude-code" → existing flow (unchanged)
    └ "agentica"    → spawns `node /app/agentica-agent/dist/main.js`
                       → agentica-agent reads WORKFLOW.md, spawns hosted
                          agent with tool scope, agent edits files,
                          subprocess exits with status
                       → feedback-loop reports + advances pipeline
```

The agentica-agent code lives in its own directory (`src-agentica-agent/` or similar), compiles with `tspc` to its own `dist/` (so the transformer doesn't touch the rest of AI-Implement). The orchestrator's main TS compile stays on plain `tsc` — zero risk to existing tests/builds.

### Why subprocess (not in-process import)

| Concern | Subprocess (chosen) | In-process import |
|---|---|---|
| Build chain | Two independent compiles; main untouched | Whole orchestrator must switch to `tspc` |
| Risk to existing tests | Zero | Re-runs entire build under new compiler |
| Mirrors Claude Code | Yes — same shape as current | No, new pattern |
| Process isolation | Crashes don't take down orchestrator | Crashes do |
| Cost | Spawning overhead ~10ms (negligible vs 60s+ implementation runs) | None |

## Tool surface

Port Claude Code's primary tools to JS functions passed in `scope`:

```typescript
// src-agentica-agent/tools.ts
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { glob } from "glob";
import { dirname } from "node:path";

export function readFile(path: string): string {
  return readFileSync(path, "utf8");
}

export function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

export function editFile(path: string, oldString: string, newString: string): void {
  const content = readFileSync(path, "utf8");
  if (!content.includes(oldString)) {
    throw new Error(`editFile: oldString not found in ${path}`);
  }
  writeFileSync(path, content.replace(oldString, newString), "utf8");
}

export function bash(command: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? err.message,
      exitCode: err.status ?? 1,
    };
  }
}

export async function globFiles(pattern: string): Promise<string[]> {
  return await glob(pattern, { dot: false });
}

export function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
```

`grep` is left to `bash` (`bash("rg <pattern> <paths>")`) since `ripgrep` is already in the runner image — no reason to reinvent it.

## Prompt translation

`WORKFLOW.md` already supports `${ISSUE_DESCRIPTION}` etc. substitution; the existing renderer is reused unchanged. The rendered output becomes the agentica `premise:`:

```typescript
// src-agentica-agent/main.ts (sketch)
import { spawn } from "@symbolica/agentica";
import { readFile, writeFile, editFile, bash, globFiles, fileExists } from "./tools.js";

const renderedPrompt = process.env.WORKFLOW_PROMPT!; // pipeline pre-renders
const issueTitle = process.env.ISSUE_TITLE!;

await using agent = await spawn({
  premise: renderedPrompt,
  // model: process.env.AGENTICA_MODEL_PRIMARY  // (see Model selection below)
});

const userPrompt = `Implement the work described in your premise. The issue title is "${issueTitle}".`;

await agent.call<void>(
  userPrompt,
  { readFile, writeFile, editFile, bash, globFiles, fileExists },
  {
    listener: (_iid, chunk) => {
      if (chunk.role === "agent" && chunk.content) {
        process.stdout.write(chunk.content);
      }
    },
  },
);

// Subprocess exit code communicates success; orchestrator reads stdout.
```

**Open question on prompt shape.** Claude Code's prompt is conversational ("You are implementing this issue. Read WORKFLOW.md, plan, edit, test, commit"). Agentica's `premise:` is a system-prompt analog. The line between "premise" and "first user prompt" might need experimentation. The deeper POC should answer this.

## Model selection

Reuse `AGENTICA_MODEL_PRIMARY` / `AGENTICA_MODEL_FALLBACK` from the closed `add-agentica-support` branch (those env vars made sense even when the implementation-agent direction wasn't decided). The agentica subprocess reads:

```typescript
const PRIMARY = process.env.AGENTICA_MODEL_PRIMARY ?? "anthropic:claude-sonnet-4.6";
const FALLBACK = process.env.AGENTICA_MODEL_FALLBACK ?? "openai:gpt-4.1";
```

For first-cut implementation, **primary only** — no automatic fallback. Fallback logic (retry on transient errors with the alternate model) is a phase-2 enhancement once we see real-world failure modes.

## Per-project switching

New field on the mapping schema:

```sql
ALTER TABLE mappings ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude-code';
-- values: 'claude-code' | 'agentica'
```

Admin UI: dropdown next to **Provider** (anthropic/bedrock) in the project drawer.

Pipeline step (`feedback-loop.ts`) branches:

```typescript
if (mapping.agent === "agentica") {
  return await runAgenticaSubprocess({ workspaceDir, renderedPrompt, env });
}
return await runClaudeCodeSubprocess({ workspaceDir, renderedPrompt, env });
```

## Build & packaging

```
AI-Implement/
├── src/                       # main orchestrator, compiled with tsc (unchanged)
├── src-agentica-agent/        # agentica subprocess code (new)
│   ├── main.ts
│   ├── tools.ts
│   ├── package.json           # only @symbolica/agentica + ts-patch
│   └── tsconfig.json          # transformer plugin
├── dist/                      # orchestrator output (tsc)
└── dist-agentica-agent/       # subprocess output (tspc)
```

Build scripts in root `package.json`:

```json
{
  "scripts": {
    "build": "tsc && npm run build:agentica-agent",
    "build:agentica-agent": "cd src-agentica-agent && npx ts-patch install -s && npx tspc",
    "typecheck": "tsc --noEmit"
  }
}
```

`Dockerfile.session` copies both dist directories. Runner-image size impact: small (`@symbolica/agentica` is ~5 MB unpacked; no extra Python needed since we're not using the Python framework here).

## Phased implementation plan

| Phase | Scope | Acceptance |
|---|---|---|
| **0. Deeper POC** | Spike a realistic agent task: clone a repo, give agentica all tools, ask it to implement a small Linear-issue-shaped task end-to-end. Iterative tool use, real test runs. | Agent successfully edits multi-file change + passes a test. Document any framework limits found. |
| **1. Subprocess skeleton** | `src-agentica-agent/` builds, main.ts spawns hosted agent with stub tools, reads env-passed prompt, exits with status code. | `npm run build:agentica-agent` produces `dist-agentica-agent/main.js` that runs end-to-end against a hard-coded prompt. |
| **2. Tool surface** | Implement all tools from §"Tool surface". Unit tests for each. | Tests pass; tools mirror Claude Code's behaviour on simple file/shell operations. |
| **3. Pipeline integration** | `feedback-loop.ts` branches on `mapping.agent`. Subprocess invocation matches Claude Code's invocation pattern (env-var contract, exit codes, stdout streaming). | E2E test: a Linear issue with `agent=agentica` mapping runs through the pipeline, opens a PR. Same Linear issue with `agent=claude-code` opens an equivalent PR. |
| **4. Admin UI + schema** | DB migration adds `agent` column; admin UI drawer exposes the dropdown. | New project mappings default to `claude-code`; agentica selectable via UI. |
| **5. Fallback logic** | Primary→fallback model retry on transient errors. Telemetry tags agentica runs in `dispatch_log`. | Forced failures retry on fallback; logs reflect routing. |

Phases 0–3 are the MVP. Phases 4–5 polish.

## Risks & open questions

1. **Iterative tool-use behaviour.** The POC ran one Python block. Real implementations need many turns. Need to confirm agentica handles this gracefully before phase 1.
2. **Long premises.** Some `WORKFLOW.md` files are 200+ lines. Need to confirm no token cap or perf cliff.
3. **Streaming format.** The POC saw raw Python pseudocode in the agent's output. The reporter currently formats Claude Code's JSON event stream. We may need a new reporter parser for agentica, or strip the code-block noise.
4. **Cost.** Agentica's hosted markup is 5% on OpenRouter pricing. For a typical 60s Claude Code session at ~100k tokens, this adds a few cents — probably negligible, but worth measuring under load.
5. **Error semantics.** When a tool throws (file not found), does the framework let the agent recover, or does the whole `agent.call` reject? Determines retry strategy.
6. **Persistence across sub-calls.** Claude Code maintains context across many turns naturally. Agentica's `persist:true` flag exists; needs verification it survives subprocess crashes / orchestrator restarts.

## Out of scope (for this design)

- Replacing Claude Code entirely. Both agents stay supported.
- Bedrock for agentica. Hosted agentica → OpenRouter, period (no AWS path).
- The `add-agentica-support` branch's runtime-library work. That branch stays parked on the remote; if a customer wants both runtime library + agent (alphawheel might), we resurrect it later.
- Workflow file changes. `WORKFLOW.md`'s schema stays the same; just the consumer changes.

## Next decisions for you

1. Approve / amend phasing — especially whether phase 0 (deeper POC) is required before phase 1.
2. Confirm subprocess approach over in-process import (already chosen in design conversation, but worth pinning).
3. Decide whether `agent: "agentica"` should also surface in the admin UI for fresh projects (vs being a hidden field set via DB only at first).
