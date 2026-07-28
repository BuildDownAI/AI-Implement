# Runner Observability Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make implementation runs observable — stream Claude's per-turn activity to the log (gated by a verbosity setting) and always capture structured run telemetry (turns/duration/cost/tokens/outcome).

**Architecture:** Switch `ClaudeCliExecutor` to `--output-format stream-json --verbose`. A new pure module `claude-stream.ts` parses the JSONL event stream into log lines and telemetry. The executor returns Claude's final text as `stdout` (preserving existing consumers) plus a new `telemetry` field. Verbosity comes from `AI_IMPLEMENT_LOG_LEVEL` (`summary` default | `stream`), read in `run-autonomous.ts` and passed to the executor.

**Tech Stack:** TypeScript (ESM, NodeNext), Vitest, Node `child_process.spawn`, the `claude` CLI in the runner image.

**Spec:** `docs/superpowers/specs/2026-06-03-runner-observability-foundation-design.md`

**Dependency:** Soft-depends on PR #72 (`fix/review-prompt-too-long-nonfatal`). Land/rebase after it merges to `testing`. This branch (`feat/runner-observability-foundation`) is cut from `testing`.

**Refinement vs spec:** Per-line timestamps are dropped from stream output — GitHub Actions timestamps every log line already, and a timestamp-free `formatEvent` stays pure/deterministic. All other behavior matches the spec.

---

## File Structure

- **Create** `src/pipeline/claude-stream.ts` — pure parser/formatter: `StreamEvent`, `parseLine`, `finalText`, `extractTelemetry`, `formatEvent`, `summaryLine`. No I/O.
- **Create** `src/__tests__/claude-stream.test.ts` — fixture-driven unit tests for the parser.
- **Modify** `src/pipeline/types.ts` — add `LogLevel`, `RunTelemetry`, and `LLMResult.telemetry`.
- **Modify** `src/pipeline/executor.ts` — stream-json args, line-buffered parsing, live logging, telemetry, `logLevel` ctor arg.
- **Modify** `src/__tests__/` (new file `executor.test.ts`) — fake-`claude` integration test.
- **Modify** `src/run-autonomous.ts` — resolve `AI_IMPLEMENT_LOG_LEVEL`, pass to executor; export `resolveLogLevel`.
- **Modify** `src/__tests__/run-autonomous.test.ts` — test `resolveLogLevel`.
- **Modify** `workflows/claude-implement.yml` — forward `vars.AI_IMPLEMENT_LOG_LEVEL` into the container env.
- **Create** `src/__tests__/workflow-log-level.test.ts` — guard that the template forwards the variable.
- **Modify** `CLAUDE.md` — document `AI_IMPLEMENT_LOG_LEVEL`.

---

## Task 1: Types — `LogLevel`, `RunTelemetry`, `LLMResult.telemetry`

**Files:**
- Modify: `src/pipeline/types.ts:89-103` (the `LLMResult` / `LLMExecutor` block)

- [ ] **Step 1: Add the types**

In `src/pipeline/types.ts`, replace the existing `LLMResult` interface (currently lines 89-94) with the version below and add the two new types immediately above it:

```ts
export type LogLevel = "summary" | "stream";

export interface RunTelemetry {
  outcome: "success" | "max_turns" | "error" | "unknown";
  numTurns: number | null;
  durationMs: number | null;
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

export interface LLMResult {
  stdout: string;
  stderr?: string;
  exitCode: number;
  tokensUsed: number;
  telemetry?: RunTelemetry;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no usages broken — `telemetry` is optional).

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/types.ts
git commit -m "feat(types): add LogLevel and RunTelemetry; telemetry on LLMResult"
```

---

## Task 2: Parser module — telemetry + final text

**Files:**
- Create: `src/pipeline/claude-stream.ts`
- Test: `src/__tests__/claude-stream.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/claude-stream.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  parseLine,
  finalText,
  extractTelemetry,
  type StreamEvent,
} from "../pipeline/claude-stream.js";

const initEvent: StreamEvent = { type: "system", subtype: "init", model: "claude-x", cwd: "/workspace" };
const toolEvent: StreamEvent = {
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm check" } }] },
};
const textEvent: StreamEvent = {
  type: "assistant",
  message: { content: [{ type: "text", text: "All done." }] },
};
const resultSuccess: StreamEvent = {
  type: "result",
  subtype: "success",
  result: "Final answer text",
  num_turns: 12,
  duration_ms: 372000,
  total_cost_usd: 0.83,
  usage: { input_tokens: 182000, output_tokens: 4100 },
};

describe("parseLine", () => {
  it("parses a JSON line", () => {
    expect(parseLine('{"type":"result"}')).toEqual({ type: "result" });
  });
  it("returns null for a non-JSON line", () => {
    expect(parseLine("not json")).toBeNull();
  });
  it("returns null for a blank line", () => {
    expect(parseLine("   ")).toBeNull();
  });
});

describe("finalText", () => {
  it("returns the result event's text", () => {
    expect(finalText([initEvent, resultSuccess])).toBe("Final answer text");
  });
  it("falls back to concatenated assistant text when no result event", () => {
    expect(finalText([initEvent, textEvent])).toBe("All done.");
  });
});

describe("extractTelemetry", () => {
  it("extracts metrics from a success result", () => {
    const t = extractTelemetry([initEvent, toolEvent, resultSuccess]);
    expect(t).toEqual({
      outcome: "success",
      numTurns: 12,
      durationMs: 372000,
      costUsd: 0.83,
      tokensIn: 182000,
      tokensOut: 4100,
    });
  });
  it("maps error_max_turns to outcome=max_turns", () => {
    const t = extractTelemetry([{ type: "result", subtype: "error_max_turns", num_turns: 50 }]);
    expect(t.outcome).toBe("max_turns");
    expect(t.numTurns).toBe(50);
  });
  it("returns outcome=unknown with nulls when no result event", () => {
    expect(extractTelemetry([initEvent])).toEqual({
      outcome: "unknown",
      numTurns: null,
      durationMs: null,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    });
  });
  it("tolerates a Bedrock result with no cost", () => {
    const t = extractTelemetry([{ type: "result", subtype: "success", num_turns: 3, usage: { input_tokens: 10, output_tokens: 2 } }]);
    expect(t.costUsd).toBeNull();
    expect(t.outcome).toBe("success");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/claude-stream.test.ts`
Expected: FAIL — cannot resolve `../pipeline/claude-stream.js`.

- [ ] **Step 3: Create the module (telemetry + final text portion)**

Create `src/pipeline/claude-stream.ts`:

```ts
import type { RunTelemetry } from "./types.js";

export interface StreamEvent {
  type?: string;
  subtype?: string;
  [key: string]: unknown;
}

export function parseLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as StreamEvent;
  } catch {
    return null;
  }
}

function lastResult(events: StreamEvent[]): StreamEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "result") return events[i];
  }
  return undefined;
}

export function finalText(events: StreamEvent[]): string {
  const result = lastResult(events);
  if (result && typeof result.result === "string") return result.result;
  const texts: string[] = [];
  for (const e of events) {
    if (e.type !== "assistant") continue;
    const msg = e.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
    for (const block of msg?.content ?? []) {
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
  }
  return texts.join("\n");
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function mapOutcome(subtype: unknown): RunTelemetry["outcome"] {
  if (subtype === "success") return "success";
  if (subtype === "error_max_turns") return "max_turns";
  if (typeof subtype === "string" && subtype.startsWith("error")) return "error";
  return "unknown";
}

export function extractTelemetry(events: StreamEvent[]): RunTelemetry {
  const result = lastResult(events);
  if (!result) {
    return { outcome: "unknown", numTurns: null, durationMs: null, costUsd: null, tokensIn: null, tokensOut: null };
  }
  const usage = (result.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
  return {
    outcome: mapOutcome(result.subtype),
    numTurns: num(result.num_turns),
    durationMs: num(result.duration_ms),
    costUsd: num(result.total_cost_usd),
    tokensIn: num(usage.input_tokens),
    tokensOut: num(usage.output_tokens),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/claude-stream.test.ts`
Expected: PASS (all `parseLine`/`finalText`/`extractTelemetry` tests).

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/claude-stream.ts src/__tests__/claude-stream.test.ts
git commit -m "feat(claude-stream): parse stream-json into telemetry and final text"
```

---

## Task 3: Parser module — `formatEvent` + `summaryLine`

**Files:**
- Modify: `src/pipeline/claude-stream.ts`
- Test: `src/__tests__/claude-stream.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/__tests__/claude-stream.test.ts`:

```ts
import { formatEvent, summaryLine } from "../pipeline/claude-stream.js";

describe("formatEvent", () => {
  it("formats an init event", () => {
    expect(formatEvent({ type: "system", subtype: "init", model: "claude-x", cwd: "/workspace" }))
      .toBe("[claude] init model=claude-x cwd=/workspace");
  });
  it("formats a tool_use as tool name + command", () => {
    expect(
      formatEvent({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm check" } }] } }),
    ).toBe("[claude] tool Bash pnpm check");
  });
  it("truncates long tool input", () => {
    const long = "x".repeat(500);
    const out = formatEvent({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { command: long } }] } });
    expect(out!.length).toBeLessThan(220);
    expect(out!.endsWith("…")).toBe(true);
  });
  it("returns null for a result event (summary handles it)", () => {
    expect(formatEvent({ type: "result", subtype: "success" })).toBeNull();
  });
  it("returns null for an unknown event type", () => {
    expect(formatEvent({ type: "whatever" })).toBeNull();
  });
});

describe("summaryLine", () => {
  it("renders a full success summary", () => {
    expect(
      summaryLine({ outcome: "success", numTurns: 12, durationMs: 372000, costUsd: 0.83, tokensIn: 182000, tokensOut: 4100 }),
    ).toBe("[claude] result=success turns=12 duration=6m12s cost=$0.83 tokens=182.0k/4.1k (in/out)");
  });
  it("omits cost when null", () => {
    const line = summaryLine({ outcome: "success", numTurns: 3, durationMs: 5000, costUsd: null, tokensIn: 10, tokensOut: 2 });
    expect(line).not.toContain("cost=");
    expect(line).toContain("result=success");
  });
  it("shows max_turns outcome at summary level", () => {
    expect(summaryLine({ outcome: "max_turns", numTurns: 50, durationMs: null, costUsd: null, tokensIn: null, tokensOut: null }))
      .toContain("result=max_turns");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/claude-stream.test.ts`
Expected: FAIL — `formatEvent`/`summaryLine` are not exported.

- [ ] **Step 3: Implement formatting**

Append to `src/pipeline/claude-stream.ts`:

```ts
const TOOL_INPUT_MAX = 160;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function summarizeToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const candidate =
      (typeof obj.command === "string" && obj.command) ||
      (typeof obj.file_path === "string" && obj.file_path) ||
      (typeof obj.path === "string" && obj.path) ||
      (typeof obj.pattern === "string" && obj.pattern) ||
      JSON.stringify(obj);
    return truncate(String(candidate), TOOL_INPUT_MAX);
  }
  return truncate(String(input), TOOL_INPUT_MAX);
}

export function formatEvent(event: StreamEvent): string | null {
  switch (event.type) {
    case "system":
      if (event.subtype === "init") {
        const model = typeof event.model === "string" ? event.model : "?";
        const cwd = typeof event.cwd === "string" ? event.cwd : "?";
        return `[claude] init model=${model} cwd=${cwd}`;
      }
      return null;
    case "assistant": {
      const msg = event.message as { content?: Array<Record<string, unknown>> } | undefined;
      const lines: string[] = [];
      for (const block of msg?.content ?? []) {
        if (block.type === "tool_use") {
          const name = typeof block.name === "string" ? block.name : "tool";
          lines.push(`[claude] tool ${name} ${summarizeToolInput(block.input)}`.trimEnd());
        } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          lines.push(`[claude] assistant: ${truncate(block.text.trim(), TOOL_INPUT_MAX)}`);
        }
      }
      return lines.length ? lines.join("\n") : null;
    }
    case "user":
      return "[claude] tool_result";
    default:
      return null;
  }
}

function humanizeMs(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m${rem.toString().padStart(2, "0")}s` : `${rem}s`;
}

function kfmt(n: number | null): string {
  if (n == null) return "?";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function summaryLine(t: RunTelemetry): string {
  const parts = [`[claude] result=${t.outcome}`];
  if (t.numTurns != null) parts.push(`turns=${t.numTurns}`);
  if (t.durationMs != null) parts.push(`duration=${humanizeMs(t.durationMs)}`);
  if (t.costUsd != null && t.costUsd > 0) parts.push(`cost=$${t.costUsd.toFixed(2)}`);
  if (t.tokensIn != null || t.tokensOut != null) {
    parts.push(`tokens=${kfmt(t.tokensIn)}/${kfmt(t.tokensOut)} (in/out)`);
  }
  return parts.join(" ");
}
```

Note: `result` (the case) is handled by returning `null` via the `default` branch — `formatEvent` intentionally has no `case "result"` since `summaryLine` renders it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/claude-stream.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/claude-stream.ts src/__tests__/claude-stream.test.ts
git commit -m "feat(claude-stream): formatEvent and summaryLine renderers"
```

---

## Task 4: Wire the executor to stream-json + telemetry

**Files:**
- Modify: `src/pipeline/executor.ts` (full rewrite of the class body)
- Test: `src/__tests__/executor.test.ts`

- [ ] **Step 1: Write the failing test (fake `claude` on PATH)**

Create `src/__tests__/executor.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCliExecutor } from "../pipeline/executor.js";

let binDir: string;
let originalPath: string | undefined;

// Writes a fake `claude` that prints the given lines to stdout then exits `code`.
function installFakeClaude(stdoutLines: string[], code = 0): void {
  const script = `#!/usr/bin/env bash
cat <<'JSONL'
${stdoutLines.join("\n")}
JSONL
exit ${code}
`;
  const path = join(binDir, "claude");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

const SUCCESS_LINES = [
  JSON.stringify({ type: "system", subtype: "init", model: "claude-x", cwd: "/workspace" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm check" } }] } }),
  JSON.stringify({ type: "result", subtype: "success", result: "Done implementing.", num_turns: 4, duration_ms: 5000, usage: { input_tokens: 100, output_tokens: 20 } }),
];

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(binDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("ClaudeCliExecutor", () => {
  it("returns the result event's text as stdout (compat) plus telemetry", async () => {
    installFakeClaude(SUCCESS_LINES, 0);
    const exec = new ClaudeCliExecutor("/tmp", "summary");
    const result = await exec.invoke({ prompt: "do it", model: "claude-x" });

    expect(result.stdout).toBe("Done implementing.");
    expect(result.exitCode).toBe(0);
    expect(result.telemetry?.outcome).toBe("success");
    expect(result.telemetry?.numTurns).toBe(4);
    expect(result.tokensUsed).toBe(120);
  });

  it("does NOT print per-event lines at summary level, but prints the summary", async () => {
    installFakeClaude(SUCCESS_LINES, 0);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await new ClaudeCliExecutor("/tmp", "summary").invoke({ prompt: "p", model: "m" });

    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith("[claude] result="))).toBe(true);
    expect(lines.some((l) => l.startsWith("[claude] tool "))).toBe(false);
  });

  it("prints per-event lines at stream level", async () => {
    installFakeClaude(SUCCESS_LINES, 0);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await new ClaudeCliExecutor("/tmp", "stream").invoke({ prompt: "p", model: "m" });

    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("tool Bash pnpm check"))).toBe(true);
    expect(lines.some((l) => l.startsWith("[claude] result="))).toBe(true);
  });

  it("propagates a non-zero exit code and degrades telemetry to unknown", async () => {
    installFakeClaude(["not even json"], 1);
    const result = await new ClaudeCliExecutor("/tmp", "summary").invoke({ prompt: "p", model: "m" });
    expect(result.exitCode).toBe(1);
    expect(result.telemetry?.outcome).toBe("unknown");
    expect(result.stdout).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/executor.test.ts`
Expected: FAIL — current executor doesn't return `telemetry`, returns raw stdout, and never logs a summary.

- [ ] **Step 3: Rewrite the executor**

Replace the entire body of `src/pipeline/executor.ts` with:

```ts
import { spawn } from "node:child_process";
import type { LLMExecutor, LLMResult, LogLevel } from "./types.js";
import {
  parseLine,
  formatEvent,
  finalText,
  extractTelemetry,
  summaryLine,
  type StreamEvent,
} from "./claude-stream.js";

/**
 * Shells out to the Claude Code CLI in stream-json mode. Each JSONL event is
 * parsed for live logging (when logLevel="stream") and accumulated for final
 * telemetry. The CLI's final `result` text is returned as `stdout` so existing
 * consumers (e.g. review-step JSON extraction) are unaffected by the format
 * change. A one-line summary is always logged.
 */
export class ClaudeCliExecutor implements LLMExecutor {
  constructor(
    private readonly workspaceDir: string,
    private readonly logLevel: LogLevel = "summary",
  ) {}

  invoke(params: {
    prompt: string;
    model: string;
    maxTurns?: number;
    tools?: string[];
  }): Promise<LLMResult> {
    return new Promise((resolve, reject) => {
      const args: string[] = [
        "--dangerously-skip-permissions",
        "--output-format",
        "stream-json",
        "--verbose",
      ];
      if (params.model) args.push("--model", params.model);
      if (params.maxTurns != null) args.push("--max-turns", String(params.maxTurns));
      if (params.tools && params.tools.length > 0) {
        args.push("--allowed-tools", params.tools.join(","));
      }
      args.push("-p", params.prompt);

      const proc = spawn("claude", args, {
        cwd: this.workspaceDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      const events: StreamEvent[] = [];
      const stderrChunks: Buffer[] = [];
      let buf = "";

      const handleLine = (line: string) => {
        const event = parseLine(line);
        if (!event) return;
        events.push(event);
        if (this.logLevel === "stream") {
          const formatted = formatEvent(event);
          if (formatted) console.log(formatted);
        }
      };

      proc.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          handleLine(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      });
      proc.stderr.on("data", (d: Buffer) => stderrChunks.push(d));

      proc.on("close", (code) => {
        if (buf.trim()) handleLine(buf); // flush trailing partial line
        const telemetry = extractTelemetry(events);
        console.log(summaryLine(telemetry));
        resolve({
          stdout: finalText(events),
          stderr: Buffer.concat(stderrChunks).toString(),
          exitCode: code ?? 1,
          tokensUsed: (telemetry.tokensIn ?? 0) + (telemetry.tokensOut ?? 0),
          telemetry,
        });
      });

      proc.on("error", reject);
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/executor.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/executor.ts src/__tests__/executor.test.ts
git commit -m "feat(executor): stream-json mode with live logging and telemetry"
```

---

## Task 5: Resolve `AI_IMPLEMENT_LOG_LEVEL` in run-autonomous

**Files:**
- Modify: `src/run-autonomous.ts:175` (executor construction) + add exported helper
- Modify: `src/run-autonomous.ts` imports (add `LogLevel`)
- Test: `src/__tests__/run-autonomous.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/run-autonomous.test.ts` (inside the file, near other unit tests — adjust the import to include `resolveLogLevel`):

```ts
import { resolveLogLevel } from "../run-autonomous.js";

describe("resolveLogLevel", () => {
  it("returns stream when set to stream", () => {
    expect(resolveLogLevel("stream")).toBe("stream");
  });
  it("defaults to summary when unset", () => {
    expect(resolveLogLevel(undefined)).toBe("summary");
  });
  it("defaults to summary for an unrecognized value", () => {
    expect(resolveLogLevel("loud")).toBe("summary");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/run-autonomous.test.ts`
Expected: FAIL — `resolveLogLevel` is not exported.

- [ ] **Step 3: Add the helper and use it**

In `src/run-autonomous.ts`, add `LogLevel` to the existing type import from `./pipeline/types.js` (line 8):

```ts
import type { LLMExecutor, LogLevel, PipelineDefinition, StepReporter } from "./pipeline/types.js";
```

Add this exported helper near the top of the file (after imports, before the main function):

```ts
export function resolveLogLevel(raw: string | undefined): LogLevel {
  return raw === "stream" ? "stream" : "summary";
}
```

Change line 175 from:

```ts
  const llmExecutor = opts.llmExecutor ?? new ClaudeCliExecutor(workspaceDir);
```

to:

```ts
  const logLevel = resolveLogLevel(process.env.AI_IMPLEMENT_LOG_LEVEL);
  const llmExecutor = opts.llmExecutor ?? new ClaudeCliExecutor(workspaceDir, logLevel);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/run-autonomous.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/run-autonomous.ts src/__tests__/run-autonomous.test.ts
git commit -m "feat(runner): resolve AI_IMPLEMENT_LOG_LEVEL and pass to executor"
```

---

## Task 6: Forward the variable through the GHA workflow template

**Files:**
- Modify: `workflows/claude-implement.yml:230` (the "Run pipeline" env block)
- Test: `src/__tests__/workflow-log-level.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/workflow-log-level.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("claude-implement.yml forwards AI_IMPLEMENT_LOG_LEVEL", () => {
  it("passes the repo variable into the pipeline container env", () => {
    const yml = readFileSync(join(process.cwd(), "workflows/claude-implement.yml"), "utf-8");
    expect(yml).toContain("AI_IMPLEMENT_LOG_LEVEL: ${{ vars.AI_IMPLEMENT_LOG_LEVEL }}");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/workflow-log-level.test.ts`
Expected: FAIL — string not present.

- [ ] **Step 3: Add the env line**

In `workflows/claude-implement.yml`, in the `Run pipeline` step's `env:` block, add this line immediately after `AI_IMPLEMENT_MAX_ITERATIONS: ${{ inputs.max_iterations }}` (line 230):

```yaml
          AI_IMPLEMENT_LOG_LEVEL: ${{ vars.AI_IMPLEMENT_LOG_LEVEL }}
```

This reads the repo/org variable directly (like `AI_IMPLEMENT_RUNNER_IMAGE`), so both orchestrator-dispatched and `/ai-implement` comment-triggered runs (which both ultimately run `claude-implement.yml`) pick it up with no `workflow_dispatch` input and no orchestrator change.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/workflow-log-level.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workflows/claude-implement.yml src/__tests__/workflow-log-level.test.ts
git commit -m "feat(workflow): forward AI_IMPLEMENT_LOG_LEVEL repo variable to runner"
```

---

## Task 7: Document the setting + full verification

**Files:**
- Modify: `CLAUDE.md` (env var table + a short note)

- [ ] **Step 1: Document in CLAUDE.md**

In `CLAUDE.md`, add a row to the "Key environment variables" table:

```markdown
| `AI_IMPLEMENT_LOG_LEVEL` | No | Runner log verbosity: `summary` (default) or `stream`. `stream` tees per-turn tool activity to the log. Telemetry (turns/cost/tokens/outcome) is captured at both levels. |
```

And add this note near the per-project caps / variables discussion:

```markdown
### Runner log verbosity

`AI_IMPLEMENT_LOG_LEVEL` controls how much the runner logs during an implement pass:
- `summary` (default): logs a single result line per Claude invocation — outcome (incl. `max_turns`), turns, duration, cost (when reported), tokens.
- `stream`: additionally tees each per-turn tool call (name + truncated input; not tool output) to the log.

Set it as a repository or organization **variable** (Settings → Secrets and variables → Actions → Variables), mirroring `AI_IMPLEMENT_PROVIDER`. It is read inside the runner container, so it applies to both orchestrator-initiated and `/ai-implement` comment-triggered runs **after the target repo has re-synced `claude-implement.yml`**. It is not a per-project admin field and not a dispatch input.
```

- [ ] **Step 2: Commit docs**

```bash
git add CLAUDE.md
git commit -m "docs: document AI_IMPLEMENT_LOG_LEVEL runner verbosity setting"
```

- [ ] **Step 3: Full verification**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass (the full suite plus the new `claude-stream`, `executor`, `run-autonomous`, and `workflow-log-level` tests).

- [ ] **Step 4: Push the branch**

```bash
git push -u origin feat/runner-observability-foundation
```

---

## Self-Review

**Spec coverage:**
- §1 verbosity setting (`AI_IMPLEMENT_LOG_LEVEL`, summary default, env/repo-variable, not per-project/dispatch) → Tasks 5, 6, 7. ✓
- §2 stream-json executor + parser + `RunTelemetry` + stdout compat → Tasks 1, 2, 3, 4. ✓
- §3 summary line (always) + stream lines (gated) + secret-safety (tool input not output) → Task 3 (`summaryLine`, `formatEvent` emits tool name+input only) + Task 4 (gating). ✓
- §4 error handling (non-JSON skipped, missing-result degrades, exitCode preserved) → Task 2 (`parseLine`/`extractTelemetry` nulls), Task 4 (exit-code test). ✓
- §5 testing (claude-stream unit, fake-claude executor, run-autonomous resolution) → Tasks 2-6. ✓
- Non-goals (persist/Linear) correctly excluded; telemetry rides on `LLMResult.telemetry` seam. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `RunTelemetry` fields (`outcome`/`numTurns`/`durationMs`/`costUsd`/`tokensIn`/`tokensOut`) identical across types.ts, claude-stream.ts, and tests. `LogLevel` (`summary`|`stream`) consistent in types.ts, executor ctor, `resolveLogLevel`. `StreamEvent` and all exported function names (`parseLine`/`finalText`/`extractTelemetry`/`formatEvent`/`summaryLine`) match between module and tests. ✓

**Deviation from spec:** per-line timestamps dropped (GHA already timestamps log lines; keeps `formatEvent` pure). Documented in header. ✓
