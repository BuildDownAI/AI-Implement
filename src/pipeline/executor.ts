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
      // Pass the prompt on stdin rather than as an argv element. A large prompt
      // (e.g. one carrying full planning context) can exceed the OS single-argument
      // limit — MAX_ARG_STRLEN, 128 KiB on Linux — which makes spawn fail with E2BIG.
      // `claude -p` reads the prompt from stdin, so there is no size ceiling.
      args.push("-p");

      const proc = spawn("claude", args, {
        cwd: this.workspaceDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      proc.stdin.on("error", reject);
      proc.stdin.end(params.prompt);

      const chunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      proc.stdout.on("data", (d: Buffer) => chunks.push(d));
      proc.stderr.on("data", (d: Buffer) => stderrChunks.push(d));

      proc.on("close", (code) => {
        // tokensUsed is not available from Claude CLI stdout; budget enforcement
        // should rely on the orchestrator's own token tracking.
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
