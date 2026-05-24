import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LLMExecutor, LLMResult } from "./types.js";

/**
 * Spawns the agentica-agent subprocess built from `agentica-agent/` into
 * `dist-agentica-agent/main.js`. Mirrors the ClaudeCliExecutor interface so
 * any pipeline step that already calls `context.llmExecutor.invoke()` works
 * unchanged when the executor is swapped.
 *
 * Subprocess contract (env vars; see agentica-agent/README.md):
 *   AGENTICA_API_KEY        required (passed through from runner env)
 *   WORKSPACE_DIR           required (set per-call)
 *   AGENTICA_AGENT_PROMPT   required (set per-call from `prompt`)
 *   ISSUE_TITLE             optional (set from issue context if available)
 *   AGENTICA_MODEL_PRIMARY  optional (taken from `params.model` if provided)
 *   AGENTICA_MODEL_FALLBACK optional (passed through if set in env)
 *
 * Exit codes:
 *   0 — agent completed without throwing
 *   1 — fatal at startup (missing env)
 *   2 — agent.call threw mid-run
 *
 * The `maxTurns` and `tools` params from the LLMExecutor interface are
 * accepted for compatibility but ignored — agentica's iteration count is
 * model-driven, not orchestrator-driven, and tool surface is baked into
 * the agentica-agent subprocess. Documented as a known difference in
 * docs/AGENTICA-AGENT.md.
 */
export class AgenticaAgentExecutor implements LLMExecutor {
  constructor(
    private readonly workspaceDir: string,
    /** Override path to the compiled subprocess for tests. */
    private readonly entryPath?: string,
  ) {}

  async invoke(params: {
    prompt: string;
    model: string;
    maxTurns?: number;
    tools?: string[];
  }): Promise<LLMResult> {
    const result = await this.spawnAgent(params.prompt, params.model);

    const fallbackModel = process.env.AGENTICA_MODEL_FALLBACK;
    if (result.exitCode === 2 && fallbackModel && fallbackModel !== params.model) {
      console.log(
        `[agentica] primary model failed (exit 2), retrying with fallback: ${fallbackModel}`,
      );
      return this.spawnAgent(params.prompt, fallbackModel);
    }

    return result;
  }

  private spawnAgent(prompt: string, model: string): Promise<LLMResult> {
    return new Promise((resolve, reject) => {
      const entry = this.resolveEntry();
      if (!entry) {
        resolve({
          stdout: "",
          stderr:
            "AgenticaAgentExecutor: dist-agentica-agent/main.js not found. " +
            "Run `npm run build:agentica-agent` (or rebuild the runner image).",
          exitCode: 1,
          tokensUsed: 0,
        });
        return;
      }

      const env = { ...process.env };
      env.WORKSPACE_DIR = this.workspaceDir;
      env.AGENTICA_AGENT_PROMPT = prompt;
      if (model) env.AGENTICA_MODEL_PRIMARY = model;

      const proc = spawn("node", [entry], {
        cwd: this.workspaceDir,
        stdio: ["ignore", "pipe", "pipe"],
        env,
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

  /**
   * Locate `agentica-agent/dist/main.js`. Searched paths in order:
   *   1. Constructor override (for tests).
   *   2. `${AGENTICA_AGENT_DIST}/main.js` env override.
   *   3. Runner image canonical: `/app/agentica-agent/dist/main.js`.
   *   4. Local dev: `<cwd>/agentica-agent/dist/main.js`.
   *
   * Note: agentica-agent compiles to its own `dist/` (not the orchestrator's
   * `dist/`), so the path retains the `agentica-agent/` prefix.
   */
  private resolveEntry(): string | null {
    if (this.entryPath) return existsSync(this.entryPath) ? this.entryPath : null;
    const envOverride = process.env.AGENTICA_AGENT_DIST;
    if (envOverride) {
      const candidate = join(envOverride, "main.js");
      return existsSync(candidate) ? candidate : null;
    }
    const candidates = [
      "/app/agentica-agent/dist/main.js",
      join(process.cwd(), "agentica-agent", "dist", "main.js"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }
}
