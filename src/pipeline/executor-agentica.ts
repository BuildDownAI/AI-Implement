import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LLMExecutor, LLMResult } from "./types.js";

/**
 * LLMExecutor that spawns the agentica-agent subprocess instead of Claude Code CLI.
 * Same interface, same pipeline — just a different implementation agent.
 */
export class AgenticaAgentExecutor implements LLMExecutor {
  constructor(
    private readonly workspaceDir: string,
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
            "AgenticaAgentExecutor: agentica-agent/dist/main.js not found. " +
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
