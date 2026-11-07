import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { redactEvidence } from "../failure-classification.js";
import { redactionSecrets } from "../redaction.js";
import { repoProcessEnv } from "../process-env.js";

export interface HookResult {
  exitCode: number;
  /** Bounded tail of the hook's combined stdout/stderr in arrival order (it was already streamed to the runner log). Unredacted. */
  output: string;
}

/** Lines of hook output kept for feedback, PR body and ticket comment. */
export const HOOK_OUTPUT_TAIL_LINES = 200;
/** Character ceiling on that tail, for the case of a few very long lines. */
const HOOK_OUTPUT_TAIL_MAX_CHARS = 8000;
/** Characters of hook output kept in memory; the tail only needs the end. */
const HOOK_CAPTURE_MAX_CHARS = 256 * 1024;

/**
 * The end of a hook's output: redacted, at most the last `HOOK_OUTPUT_TAIL_LINES` lines and
 * `HOOK_OUTPUT_TAIL_MAX_CHARS` characters. One helper so the next implement pass's prompt, the
 * PR body and the ticket comment show the same text. Forwarded secrets reach the hook, and the
 * prompt and PR body are model-visible and public, hence the redaction.
 */
export function hookOutputTail(output: string): string {
  let tail = redactEvidence(output, redactionSecrets()).replace(/\s+$/, "");
  const lines = tail.split("\n");
  if (lines.length > HOOK_OUTPUT_TAIL_LINES) tail = lines.slice(-HOOK_OUTPUT_TAIL_LINES).join("\n");
  if (tail.length > HOOK_OUTPUT_TAIL_MAX_CHARS) tail = tail.slice(-HOOK_OUTPUT_TAIL_MAX_CHARS);
  return tail;
}

/**
 * Runs a WORKFLOW.md hook script (setup/verify/teardown) relative to the repo
 * root with `set -euo pipefail`. stdout and stderr are written to the runner's
 * stdout/stderr as each chunk arrives; only a bounded tail is kept in memory and
 * returned in `output`, so a very chatty hook neither stalls the log nor aborts.
 * `$GITHUB_ENV` points at a managed temp file; any `KEY=value` lines the script
 * appends to it are merged into process.env so subsequent Claude invocations
 * (which spawn with `env: { ...process.env }`) inherit them.
 *
 * Only the simple `KEY=value` form is supported — NOT GitHub Actions' heredoc
 * multiline syntax (`KEY<<EOF` … `EOF`). A line that looks like a heredoc opener
 * is logged as a warning and skipped rather than silently dropped.
 *
 * Throws if the resolved script path does not exist. Returns the child's exit
 * code otherwise (caller decides whether a non-zero code aborts). The returned
 * promise settles only after the hook exits and the env merge completes, so the
 * pipeline stays strictly ordered for callers that await it.
 */
export async function runHookScript(
  name: string,
  scriptPath: string,
  workspaceDir: string,
): Promise<HookResult> {
  const resolved = isAbsolute(scriptPath) ? scriptPath : resolve(workspaceDir, scriptPath);
  if (!existsSync(resolved)) {
    throw new Error(`${name} hook script not found: ${scriptPath} (resolved: ${resolved})`);
  }

  const envDir = mkdtempSync(join(tmpdir(), "ai-implement-hook-"));
  const githubEnvFile = join(envDir, "github_env");
  writeFileSync(githubEnvFile, "");

  try {
    let tail = "";
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    const keep = (text: string): void => {
      if (!text) return;
      tail += text;
      if (tail.length > 2 * HOOK_CAPTURE_MAX_CHARS) tail = tail.slice(-HOOK_CAPTURE_MAX_CHARS);
    };

    const exitCode = await new Promise<number>((resolveExit, reject) => {
      const child = spawn("bash", ["-euo", "pipefail", resolved], {
        cwd: workspaceDir,
        env: { ...repoProcessEnv(), GITHUB_ENV: githubEnvFile },
        stdio: ["ignore", "pipe", "pipe"],
      });
      // When the runner log cannot keep up, pause the child's stream until the sink drains
      // so a chatty hook cannot balloon memory behind the write queue.
      const forward = (source: NodeJS.ReadableStream, sink: NodeJS.WriteStream, decoder: StringDecoder): void => {
        source.on("data", (chunk: Buffer) => {
          if (!sink.write(chunk)) {
            source.pause();
            sink.once("drain", () => source.resume());
          }
          keep(decoder.write(chunk));
        });
      };
      forward(child.stdout, process.stdout, outDecoder);
      forward(child.stderr, process.stderr, errDecoder);
      // A failed spawn (e.g. bash missing) leaves no meaningful env to merge.
      child.on("error", reject);
      child.on("close", (code) => {
        keep(outDecoder.end());
        keep(errDecoder.end());
        resolveExit(code ?? 1);
      });
    });

    mergeGithubEnv(githubEnvFile);
    return { exitCode, output: tail.length > HOOK_CAPTURE_MAX_CHARS ? tail.slice(-HOOK_CAPTURE_MAX_CHARS) : tail };
  } finally {
    rmSync(envDir, { recursive: true, force: true });
  }
}

/** Parses KEY=value lines from a $GITHUB_ENV-style file into process.env. */
function mergeGithubEnv(file: string): void {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      // A `KEY<<EOF` heredoc opener has no `=` before the `<<`. Warn so users
      // porting GHA hooks that use multiline values aren't silently surprised.
      if (trimmed.includes("<<")) {
        console.warn(
          `[hooks] Ignoring GITHUB_ENV line "${trimmed}": heredoc/multiline values are not supported, only KEY=value.`,
        );
      }
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (key) process.env[key] = value;
  }
}
