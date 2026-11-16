import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelInvocationEnv } from "../src/model-auth-client.js";
import { openrouterProviderArgs } from "../src/pipeline/codex-executor.js";
import { parseCodexStream } from "../src/pipeline/codex-stream.js";
import { redactEvidence } from "../src/pipeline/failure-classification.js";

export const CLAUDE_MODEL = "anthropic/claude-haiku-5.5";
export const CODEX_MODEL = "openai/gpt-5.1-codex-mini";
export const WRONG_KEY = "sk-or-v1-invalid";
export const PROMPT = "Reply with the one word OK.";
const prefix = "openrouter-agent-live-check: ";
type Spawn = (binary: string, args: string[], options: { cwd: string; env: Record<string, string>; detached: boolean }) => ChildProcessWithoutNullStreams;
export interface CheckOptions {
  spawn?: Spawn;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  clock?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  tempRoot?: string;
}

// Keep complete lines only after overflow. A retained suffix of a secret cannot
// be redacted by value, including when its remaining bytes arrive in a later chunk.
function boundedCapture(limit: number) {
  let text = "", discardLine = false;
  return {
    append(chunk: string) {
      if (discardLine) {
        const end = chunk.indexOf("\n");
        if (end < 0) return;
        chunk = chunk.slice(end + 1);
        discardLine = false;
      }
      text += chunk;
      if (text.length > limit) {
        const end = text.indexOf("\n", text.length - limit);
        discardLine = end < 0;
        text = discardLine ? "" : text.slice(end + 1);
      }
    },
    read: () => text,
  };
}

export async function runOpenRouterAgentLiveCheck({
  spawn = nodeSpawn, env = process.env, log = console.log,
  clock = { setTimeout, clearTimeout }, tempRoot = tmpdir(),
}: CheckOptions = {}): Promise<number> {
  const key = env.OPENROUTER_TEST_API_KEY;
  if (!key) { log(prefix + "skipped (no key)"); return 0; }
  // Tokens/envelopes are hashed, never used verbatim in a path or log.
  const identity = env.SESSION_TOKEN || env.RUN_TOKEN || (env.GITHUB_RUN_ID && `${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}`)
    || env.AI_IMPLEMENT_RUN_CONFIG || env.OPENROUTER_LIVE_RUN_ID || String(process.ppid);
  const marker = join(tempRoot, `openrouter-agent-live-${createHash("sha256").update(identity).digest("hex")}`);
  try { await writeFile(marker, "", { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    log(prefix + "skipped (ran before in this run)"); return 0;
  }
  for (const wrong of [false, true]) for (const agent of ["claude", "codex"] as const) {
    const selectedKey = wrong ? WRONG_KEY : key;
    const label = agent + (wrong ? " wrong-key" : "");
    const cwd = await mkdtemp(join(tempRoot, "openrouter-agent-call-"));
    try {
      const childEnv = buildModelInvocationEnv({ authMode: "openrouter-api-key",
        secret: { kind: "api-key", apiKey: selectedKey }, inheritedEnv: env }).env;
      const args = agent === "claude"
        ? ["--print", "--output-format", "json", "--model", env.OPENROUTER_TEST_CLAUDE_MODEL || CLAUDE_MODEL]
        : ["exec", "--json", "--ignore-user-config", "--ignore-rules", "--model", env.OPENROUTER_TEST_CODEX_MODEL || CODEX_MODEL,
          ...openrouterProviderArgs(), "--sandbox", "read-only", "-"];
      const result = await new Promise<string>((done) => {
        let child: ChildProcessWithoutNullStreams;
        const output = boundedCapture(1_000_000), errors = boundedCapture(64_000);
        let finished = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: string) => {
          if (finished) return;
          finished = true;
          if (timer) clock.clearTimeout(timer);
          done(result);
        };
        const spawnError = (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT"
          ? "skipped (binary not found)" : "fail (no answer)");
        try { child = spawn(agent, args, { cwd, env: childEnv, detached: true }); }
        catch (error) { spawnError(error as NodeJS.ErrnoException); return; }
        child.on("error", spawnError);
        child.stdin.on("error", () => {}); // EPIPE is reported by the process outcome.
        child.stdout.on("data", (data) => { output.append(String(data)); });
        child.stderr.on("data", (data) => { errors.append(String(data)); });
        child.on("close", (code) => {
          const stdout = output.read(), stderr = errors.read();
          let answer = "", errorText = "", isError = false;
          if (agent === "codex") {
            const parsed = parseCodexStream(stdout);
            answer = parsed.finalMessage ?? "";
            isError = parsed.terminalStatus?.isError === true;
            errorText = parsed.toResult({ exitCode: code ?? -1 }).errorMessage ?? "";
          } else {
            try {
              const parsed = JSON.parse(stdout);
              answer = typeof parsed.result === "string" ? parsed.result : "";
              isError = parsed.is_error === true;
              if (isError) errorText = answer || (Array.isArray(parsed.errors) ? parsed.errors.join("\n") : "");
            } catch { answer = stdout; }
          }
          const safe = redactEvidence(stderr || errorText, [key, WRONG_KEY])
            .replace(/^\s*(?:["']?(?:authorization|(?:x-)?api[-_]key|request headers)["']?\s*[:=])[^\n]*/gim, "");
          const evidence = (safe.trim().split(/\r?\n/).filter((line) => line.trim()).at(-1) ?? "").slice(0, 300);
          const ok = /\bOK\b/.test(answer);
          if (wrong && (code !== 0 || isError)) finish(`refused as expected (exit ${code}): ${evidence}`);
          else if (wrong && ok) finish("fail (wrong key was accepted)");
          else if (code !== 0) finish(`fail (exit ${code}): ${evidence}`);
          else finish(ok && !isError ? "pass" : "fail (no OK in the answer)");
        });
        timer = clock.setTimeout(() => {
          // Kill the process group too: a CLI may have spawned helpers.
          if (spawn === nodeSpawn && child.pid) {
            try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
          } else child.kill("SIGKILL");
          finish("fail (no answer)");
        }, 120_000);
        child.stdin.end(PROMPT);
      });
      log(prefix + label + " " + result);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runOpenRouterAgentLiveCheck(); }
  catch { console.log(prefix + "fail (no answer)"); }
  process.exitCode = 0;
}
