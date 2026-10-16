/**
 * Runs the real GHA bootstrap step script, then builds the Run step's environment from the workflow's own
 * `env:` mapping and the bootstrap's step outputs (AII-1427). Nothing here adds a value the workflow fails
 * to provide, so a missing handoff surfaces as a missing variable in the production runner factory.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { vi } from "vitest";
import type { ResolvedAgentSnapshotV1, RunConfigV1 } from "../run-config.js";
import type { ModelAuthContextV1, ModelAuthGrantBootstrapV1 } from "../model-auth-contract.js";
import { makeGrant } from "./configured-run-fixture.js";

export const GHA_IMPLEMENT_WORKFLOWS = ["workflows/claude-implement.yml", ".github/workflows/claude-implement.yml"];
export const GHA_PLAN_WORKFLOWS = ["workflows/claude-plan.yml", ".github/workflows/claude-plan.yml"];

/** Trusted launch context a dispatcher would author for the synthetic grant from `makeGrant`. */
export const GHA_CONTEXT: ModelAuthContextV1 = {
  version: 1,
  dispatchId: "disp-1",
  projectKey: "proj",
  backend: "gha",
  modelAuthUrl: "https://orchestrator.invalid/model-auth",
};

export function ghaGrant(snapshot: ResolvedAgentSnapshotV1, over: Partial<ModelAuthGrantBootstrapV1> = {}): ModelAuthGrantBootstrapV1 {
  return makeGrant(snapshot, { backend: "gha", ...over });
}

export interface GhaHandoff {
  bootStatus: number | null;
  bootStderr: string;
  githubEnv: string;
  /** Environment of the Run step: only the workflow's mapped values. */
  runEnv: Record<string, string>;
}

type HandoffInput = { snapshot?: ResolvedAgentSnapshotV1; grant?: ModelAuthGrantBootstrapV1; context?: unknown; callback?: boolean };

/** Wire form of the dispatch envelope, built directly so a deliberately invalid or missing context reaches the bootstrap, not the encoder. */
export function ghaRunConfig(file: string, input: HandoffInput): string {
  const envelope = {
    v: 1,
    issue: { id: "i1", identifier: "ENG-9", title: "T", description: "D" },
    ...(input.callback === false ? {} : { runnerCallbackUrl: "http://cb.test/cb" }),
    ...(input.snapshot ? { agentConfig: input.snapshot } : {}),
    credentials: {
      version: 1,
      resultToken: "res-synthetic",
      progressToken: "prog-synthetic",
      ...(file.includes("implement") ? { publicationToken: "pub-synthetic" } : {}),
      ...(input.grant ? { modelAuthGrant: input.grant } : {}),
      ...(input.context !== undefined ? { modelAuthContext: input.context } : {}),
    },
  } as unknown as RunConfigV1;
  return Buffer.from(JSON.stringify(envelope)).toString("base64");
}

/** The OLD Run-step environment: the envelope alone, as a pre-AII-1427 template delivered it. Built directly, never through the repaired bootstrap. */
export function oldShapedRunEnv(file: string, input: HandoffInput): Record<string, string> {
  return { AI_IMPLEMENT_RUN_CONFIG: ghaRunConfig(file, input) };
}

export function ghaRunStepEnv(
  file: string,
  input: HandoffInput,
): GhaHandoff {
  const workflow = parse(readFileSync(file, "utf8"));
  const job = workflow.jobs.implement ?? workflow.jobs.plan;
  const mask = job.steps.find((s: { name: string }) => s.name === "Mask runner callback tokens");
  const run = job.steps.find((s: { name: string }) => s.name === "Run pipeline" || s.name === "Run planning");
  const runConfig = ghaRunConfig(file, input);

  const dir = mkdtempSync(join(tmpdir(), "gha-handoff-"));
  try {
    const inputs = { run_config: runConfig, run_token: "", run_progress_token: "", run_attempt_token: "" };
    const eventPath = join(dir, "event.json");
    const envPath = join(dir, "github.env");
    const outPath = join(dir, "github.output");
    writeFileSync(eventPath, JSON.stringify({ inputs }));
    writeFileSync(envPath, "");
    writeFileSync(outPath, "");
    const boot = spawnSync("sh", ["-e", "-c", mask.run], {
      env: { PATH: process.env.PATH, GITHUB_EVENT_PATH: eventPath, GITHUB_ENV: envPath, GITHUB_OUTPUT: outPath },
      encoding: "utf8",
    });
    const githubEnv = readFileSync(envPath, "utf8");
    const base = { bootStatus: boot.status, bootStderr: boot.stderr, githubEnv };
    if (boot.status !== 0) return { ...base, runEnv: {} };
    const lines = readFileSync(outPath, "utf8").split("\n");
    const outputs: Record<string, string> = {};
    for (let i = 0; i < lines.length; i++) {
      const m = /^([a-z_]+)<<(.+)$/.exec(lines[i]);
      if (!m) continue;
      const end = lines.indexOf(m[2], i + 1);
      outputs[m[1]] = lines.slice(i + 1, end).join("\n");
      i = end;
    }
    const runEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(run.env ?? {})) {
      if (typeof v !== "string") continue;
      const o = /^\$\{\{\s*steps\.bootstrap\.outputs\.(\w+)\s*\}\}$/.exec(v);
      if (o) runEnv[k] = outputs[o[1]] ?? "";
      else if (/^\$\{\{\s*inputs\.run_config\s*\}\}$/.test(v)) runEnv[k] = runConfig;
      else if (!v.includes("${{")) runEnv[k] = v;
    }
    return { ...base, runEnv };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Installs a Run step environment as the process environment (empty strings are treated as absent by the runner). */
export function stubRunEnv(env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}
