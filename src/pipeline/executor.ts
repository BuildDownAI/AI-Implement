import { spawn } from "node:child_process";
import type { LLMExecutor, LLMResult } from "./types.js";

/**
 * Shells out to the Claude Code CLI installed in the session image.
 * Used on Fly Machines where the CLI is present in the runner image.
 * Other runtimes (GitHub Actions, direct API) inject a different executor.
 */
export class ClaudeCliExecutor implements LLMExecutor {
  constructor(private readonly workspaceDir: string) {}

  invoke(params: {
    prompt: string;
    model: string;
    maxTurns?: number;
    tools?: string[];
  }): Promise<LLMResult> {
    return new Promise((resolve, reject) => {
      const args: string[] = ["--dangerously-skip-permissions"];
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

      const chunks: Buffer[] = [];
      proc.stdout.on("data", (d: Buffer) => chunks.push(d));

      proc.on("close", (code) => {
        // tokensUsed is not available from Claude CLI stdout; budget enforcement
        // should rely on the orchestrator's own token tracking.
        resolve({
          stdout: Buffer.concat(chunks).toString(),
          exitCode: code ?? 1,
          tokensUsed: 0,
        });
      });

      proc.on("error", reject);
    });
  }
}
