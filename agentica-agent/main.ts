/**
 * agentica-agent — subprocess entry point.
 *
 * Spawned by AI-Implement's feedback-loop step when a mapping's
 * `agent = "agentica"`. Reads env-passed prompt + workspace, runs a
 * hosted agentica agent with the tool surface from ./tools.ts, streams
 * stdout to the parent (the orchestrator reporter), exits with status.
 *
 * The orchestrator subprocess contract (read on every spawn):
 *
 *   AGENTICA_API_KEY        required — hosted-agentica auth
 *   WORKSPACE_DIR           required — repo root the agent edits
 *   AGENTICA_AGENT_PROMPT   required — rendered WORKFLOW.md content
 *
 *   ISSUE_TITLE             optional — used in the user message
 *   AGENTICA_MODEL_PRIMARY  optional — defaults to anthropic:claude-sonnet-4.6
 *   AGENTICA_MODEL_FALLBACK optional — defaults to openai:gpt-4.1 (NOT used in
 *                                       phase 1; reserved for phase 5 fallback)
 *
 * Smoke-test mode: set AGENTICA_AGENT_SMOKE=1 to bypass the WORKSPACE_DIR /
 * AGENTICA_AGENT_PROMPT requirements and run a self-contained task in
 * /tmp/agentica-agent-smoke. Used by `npm run smoke`.
 */

import { spawn } from "@symbolica/agentica";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { readFile, writeFile, editFile, bash, fileExists, listDir } from "./tools.js";

interface RuntimeEnv {
  apiKey: string;
  model: string;
  modelFallback: string;
  workspaceDir: string;
  prompt: string;
  issueTitle: string;
  smoke: boolean;
}

const SMOKE_PROMPT = [
  "You are a sandboxed code-implementing assistant. The work directory is",
  "the current working directory.",
  "",
  "Task:",
  "  1. Write smoke.js exporting `reverse(s)` that returns the input string",
  "     reversed character-by-character (ES module syntax).",
  "  2. Write smoke.test.js using node:test + node:assert/strict, asserting",
  "     reverse('hello') === 'olleh' and reverse('') === ''.",
  "  3. Run the tests with: bash(\"node --test smoke.test.js\")",
  "  4. If tests fail, fix the source and re-run.",
  "  5. Stop when exitCode is 0.",
].join("\n");

function loadEnv(): RuntimeEnv {
  const smoke = process.env.AGENTICA_AGENT_SMOKE === "1";
  const required = (key: string, smokeFallback?: string): string => {
    const value = process.env[key];
    if (value) return value;
    if (smoke && smokeFallback !== undefined) return smokeFallback;
    throw new Error(`Missing required env var: ${key}`);
  };

  return {
    apiKey: required("AGENTICA_API_KEY"),
    model: process.env.AGENTICA_MODEL_PRIMARY ?? "anthropic:claude-sonnet-4.6",
    modelFallback: process.env.AGENTICA_MODEL_FALLBACK ?? "openai:gpt-4.1",
    workspaceDir: required("WORKSPACE_DIR", "/tmp/agentica-agent-smoke"),
    prompt: required("AGENTICA_AGENT_PROMPT", SMOKE_PROMPT),
    issueTitle: process.env.ISSUE_TITLE ?? (smoke ? "smoke test" : "(no title)"),
    smoke,
  };
}

function prepareSmokeWorkspace(workspaceDir: string): void {
  if (existsSync(workspaceDir)) rmSync(workspaceDir, { recursive: true, force: true });
  mkdirSync(workspaceDir, { recursive: true });
  // node --test needs ESM signal for `import` syntax.
  writeFileSync(`${workspaceDir}/package.json`, JSON.stringify({ type: "module" }, null, 2));
  process.env.WORKSPACE_DIR = workspaceDir;
}

async function main(): Promise<void> {
  const env = loadEnv();
  console.log(`[agentica-agent] start smoke=${env.smoke} workspace=${env.workspaceDir} model=${env.model}`);

  if (env.smoke) prepareSmokeWorkspace(env.workspaceDir);

  await using agent = await spawn({ premise: env.prompt });

  const userMessage = env.smoke
    ? "Implement the task described in your premise."
    : [
        `Implement the work described in your premise. The issue title is "${env.issueTitle}".`,
        ``,
        `Stopping rules (important — read these before starting):`,
        `- Make each file edit at most ONCE. If editFile fails with "oldString not found",`,
        `  the edit was likely already made — skip it, do not retry.`,
        `- Do NOT re-read files after editing them to verify.`,
        `- Stop as soon as the workspace diff matches the issue's "Done when" criteria.`,
        `- Do NOT run tests, do NOT commit, do NOT push, do NOT open PRs — the pipeline`,
        `  handles git and PR creation after you exit.`,
      ].join("\n");

  const startedAt = Date.now();

  try {
    await agent.call<void>(
      userMessage,
      { readFile, writeFile, editFile, bash, fileExists, listDir },
      {
        listener: (_iid: string, chunk: { role?: string; content?: string }) => {
          if (chunk.role === "agent" && chunk.content) {
            process.stdout.write(chunk.content);
          }
        },
      },
    );
  } catch (err) {
    console.error(`\n[agentica-agent] agent.call threw:`, err);
    process.exit(2);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n[agentica-agent] done in ${elapsed}s`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[agentica-agent] FATAL`, err);
  process.exit(1);
});
