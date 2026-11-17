import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelInvocationEnv } from "../src/model-auth-client.js";
import { openrouterProviderArgs } from "../src/pipeline/codex-executor.js";
import { CodexStreamParser } from "../src/pipeline/codex-stream.js";
import { redactEvidence } from "../src/pipeline/failure-classification.js";
import { createAndResolveOpenRouterAccount } from "./openrouter-account-live-check.js";

export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-1017";
export interface AgentCheckDeps {
  env?: NodeJS.ProcessEnv;
  spawn?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: "pipe" }) => ChildProcessWithoutNullStreams;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  log?: (line: string) => void;
  account?: typeof createAndResolveOpenRouterAccount;
}

export async function runOpenRouterAgentLiveCheck({ env = process.env, spawn = nodeSpawn,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = console.log,
  account = createAndResolveOpenRouterAccount,
}: AgentCheckDeps = {}): Promise<number> {
  const print = (result: string) => log(`openrouter-agent-live-check: ${result}`);
  const key = env.OPENROUTER_TEST_API_KEY;
  if (!key) { print("skipped (no key)"); return 0; }
  try {
    const run = (env.GITHUB_RUN_ID && `${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT ?? "1"}`) || env.OPENROUTER_ACCOUNT_CHECK_RUN_ID;
    if (run) {
      const marker = join(tmpdir(), `openrouter-agent-live-check-${createHash("sha256").update(run).digest("hex")}.marker`);
      try { writeFileSync(marker, String(now()), { flag: "wx", mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        print("skipped (ran before in this run)"); return 0;
      }
    }
    let credential: string;
    try { credential = await account(key, { now }); }
    catch { print("skipped (no test account)"); return 0; }
    for (const [name, selectedKey] of [["codex", credential], ["codex wrong-key", "sk-or-v1-invalid"]]) {
      const directory = mkdtempSync(join(tmpdir(), "openrouter-agent-live-check-"));
      try {
        const result = await new Promise<string>((done) => {
          const parser = new CodexStreamParser();
          let errors = "";
          let timer: ReturnType<typeof setTimeout> | undefined;
          let settled = false;
          const finish = (result: string) => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimer(timer);
            done(result);
          };
          let child: ChildProcessWithoutNullStreams;
          try {
            child = spawn("codex", ["exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--model",
              env.OPENROUTER_TEST_MODEL || DEFAULT_MODEL, ...openrouterProviderArgs(), "--sandbox", "read-only", "-"], {
              cwd: directory, env: buildModelInvocationEnv({ authMode: "openrouter-api-key",
                secret: { kind: "api-key", apiKey: selectedKey }, inheritedEnv: env }).env,
              detached: true, stdio: "pipe",
            });
          } catch (error) {
            finish((error as NodeJS.ErrnoException).code === "ENOENT" ? "skipped (binary not found)" : "fail (could not start)"); return;
          }
          child.stdout.on("data", (chunk: Buffer) => parser.push(chunk.toString()));
          child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
          child.stdin.on("error", () => {}); // A refused invocation can close stdin immediately.
          child.on("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" ? "skipped (binary not found)" : "fail (could not start)"));
          child.on("close", (code) => {
            parser.end();
            const ok = /\bOK\b/.test(parser.finalMessage ?? "");
            const errorOutput = errors || parser.toResult({ exitCode: code ?? 1 }).errorMessage || "";
            const evidence = redactEvidence(errorOutput, [key, credential, selectedKey])
              .replace(/(?:authorization|proxy-authorization)\s*:[^\r\n]*/gi, "***")
              .split(/\r?\n/).filter((line) => line.trim()).at(-1)?.slice(0, 300) ?? "";
            if (errorOutput.includes("--skip-git-repo-check") || errorOutput.includes("Not inside a trusted directory")) {
              finish(`fail (not sent): ${evidence}`); return;
            }
            if (name === "codex wrong-key") {
              // A process failure alone does not prove that OpenRouter rejected the key.
              const authenticationRefusal = /\b(?:401|403|unauthorized)\b|\binvalid[ _-]+api[ _-]+key\b|\bauthentication\s+(?:failed|required|error)\b/i.test(errorOutput);
              finish(code !== 0 || parser.terminalStatus?.isError ? authenticationRefusal
                ? `refused as expected (exit ${code}): ${evidence}`
                : `fail (no authentication refusal, exit ${code}): ${evidence}`
                : ok ? "fail (wrong key was accepted)" : "fail (no OK in the answer)");
            } else finish(code !== 0 ? `fail (exit ${code}): ${evidence}` : ok ? "pass" : "fail (no OK in the answer)");
          });
          timer = setTimer(() => {
            // Kill the whole isolated process group, including any descendants.
            try { if (child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
            catch { child.kill("SIGKILL"); }
            finish("fail (no answer)");
          }, 120_000);
          child.stdin.end("Reply with the one word OK.");
        });
        print(`${name} ${result}`);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  } catch { print("skipped (no test account)"); }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runOpenRouterAgentLiveCheck();
}
