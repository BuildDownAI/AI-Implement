import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { LLMExecutor, LLMResult, LogLevel } from "./types.js";
import {
  parseLine,
  formatEvent,
  finalText,
  extractTelemetry,
  summaryLine,
  type StreamEvent,
} from "./claude-stream.js";

const GITHUB_WRITE_CREDENTIAL_KEYS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GIT_PASSWORD",
] as const;

const MODEL_CHILD_CREDENTIAL_KEYS = [
  "RUN_PROGRESS_TOKEN",
  "RUN_PUBLICATION_TOKEN",
  "RUN_TOKEN",
] as const;

function claudeEnvironment(allowRepositoryWrites: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of MODEL_CHILD_CREDENTIAL_KEYS) delete env[key];
  if (!allowRepositoryWrites) {
    for (const key of GITHUB_WRITE_CREDENTIAL_KEYS) delete env[key];
  }
  // Strip forwarded secrets — hooks see them via process.env, but Claude must not.
  const forwarded = (env.AI_IMPLEMENT_FORWARDED_SECRETS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  for (const key of forwarded) delete env[key];
  return env;
}

function suspendOriginWriteCredential(workspaceDir: string): (() => void) | null {
  const current = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (current.status !== 0) return null;

  const originalRemote = current.stdout.toString().trim();
  let parsed: URL;
  try {
    parsed = new URL(originalRemote);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.username && !parsed.password) return null;

  parsed.username = "";
  parsed.password = "";
  const protectedRemote = parsed.toString();
  const protect = spawnSync("git", ["remote", "set-url", "origin", protectedRemote], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (protect.status !== 0) {
    throw new Error("Failed to remove the repository write credential before invoking Claude");
  }

  return () => {
    const restore = spawnSync("git", ["remote", "set-url", "origin", originalRemote], {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (restore.status !== 0) {
      throw new Error("Failed to restore the repository credential after invoking Claude");
    }
  };
}

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
    private readonly allowRepositoryWrites = false,
  ) {}

  invoke(params: {
    prompt: string;
    model: string;
    maxTurns?: number;
    tools?: string[];
  }): Promise<LLMResult> {
    let restoreOrigin: (() => void) | null = null;
    if (!this.allowRepositoryWrites) {
      try {
        restoreOrigin = suspendOriginWriteCredential(this.workspaceDir);
      } catch (err) {
        return Promise.reject(err);
      }
    }

    return new Promise((resolve, reject) => {
      let originRestored = false;
      const restoreProtectedOrigin = (): void => {
        if (originRestored) return;
        originRestored = true;
        restoreOrigin?.();
      };
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
      // Pass the prompt on stdin rather than as an argv element. A large prompt
      // (e.g. one carrying full planning context) can exceed the OS single-argument
      // limit — MAX_ARG_STRLEN, 128 KiB on Linux — which makes spawn fail with E2BIG.
      // `claude -p` reads the prompt from stdin, so there is no size ceiling.
      args.push("-p");

      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = spawn("claude", args, {
          cwd: this.workspaceDir,
          stdio: ["pipe", "pipe", "pipe"],
          env: claudeEnvironment(this.allowRepositoryWrites),
        });
      } catch (err) {
        try {
          restoreProtectedOrigin();
          reject(err);
        } catch (restoreErr) {
          reject(restoreErr);
        }
        return;
      }

      const events: StreamEvent[] = [];
      const stderrChunks: Buffer[] = [];
      let buf = "";
      let settled = false;

      proc.stdin.on("error", (err) => {
        // EPIPE here means the child exited before consuming the prompt. Mark
        // settled so the close handler doesn't log a phantom success summary.
        settled = true;
        try {
          restoreProtectedOrigin();
          reject(err);
        } catch (restoreErr) {
          reject(restoreErr);
        }
      });
      proc.stdin.end(params.prompt);

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
        if (settled) return;
        settled = true;
        if (buf.trim()) handleLine(buf); // flush trailing partial line
        const stderr = Buffer.concat(stderrChunks).toString();
        // Surface CLI stderr (auth failures, bad model IDs, rate limits) — it is
        // otherwise invisible in GHA logs at any log level.
        if (stderr.trim()) console.error("[claude] stderr:", stderr.trim());
        const telemetry = extractTelemetry(events);
        console.log(summaryLine(telemetry));
        try {
          restoreProtectedOrigin();
        } catch (err) {
          reject(err);
          return;
        }
        resolve({
          stdout: finalText(events),
          stderr,
          exitCode: code ?? 1,
          tokensUsed: (telemetry.tokensIn ?? 0) + (telemetry.tokensOut ?? 0),
          telemetry,
        });
      });

      proc.on("error", (err) => {
        settled = true;
        try {
          restoreProtectedOrigin();
          reject(err);
        } catch (restoreErr) {
          reject(restoreErr);
        }
      });
    });
  }
}
