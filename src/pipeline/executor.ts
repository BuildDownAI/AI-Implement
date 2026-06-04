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
