import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { repoProcessEnv } from "../process-env.js";

/** Per-command output cap; Node's execSync default of 1 MiB kills a large test suite (ENOBUFS). */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

interface PreflightInputs extends Record<string, unknown> {
  workspaceDir: string;
  packageManager?: string;
}

interface PreflightOutputs extends Record<string, unknown> {
  passed: boolean;
  testOutput: string;
  testsRun: number;
  summary: string;
}

export const preflightStep: StepModule<PreflightInputs, PreflightOutputs> = {
  async run(
    _context: PipelineContext,
    inputs: PreflightInputs,
    _reporter: StepReporter,
  ): Promise<PreflightOutputs> {
    const { workspaceDir } = inputs;
    console.warn(
      "[preflight] Repository code and task documents are executed directly. " +
        "This runner does not isolate repository commands from the model process or the host environment — " +
        "only use with trusted repositories and task documents.",
    );
    const pm = String(inputs.packageManager ?? "npm");
    const runCmd = pm === "yarn" ? "yarn" : pm === "pnpm" ? "pnpm run" : "npm run";

    const pkgJsonPath = path.join(workspaceDir, "package.json");
    const pkgJson = fs.existsSync(pkgJsonPath)
      ? (JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as { scripts?: Record<string, string> })
      : { scripts: {} };

    const outputLines: string[] = [];
    const checks: string[] = [];
    let testsRun = 0;
    let passed = true;

    let failureReason = "error";

    const run = (cmd: string): string => {
      try {
        const out = execSync(cmd, {
          cwd: workspaceDir,
          stdio: "pipe",
          env: repoProcessEnv(),
          maxBuffer: MAX_OUTPUT_BYTES,
        }).toString();
        return out;
      } catch (err) {
        const e = err as {
          message?: string;
          stdout?: unknown;
          stderr?: unknown;
          status?: unknown;
          code?: unknown;
          signal?: unknown;
        };
        passed = false;
        const code = typeof e.code === "string" ? e.code : undefined;
        let marker: string;
        if (typeof e.status === "number") {
          failureReason = `exit ${e.status}`;
          marker = `[exit ${e.status}]`;
        } else if (code === "ENOBUFS") {
          failureReason = "ENOBUFS: output over 64 MiB";
          marker = `[${code}]`;
        } else {
          failureReason = code ?? (typeof e.signal === "string" ? e.signal : "error");
          marker = `[${code ?? failureReason}]`;
        }
        const streams = [e.stdout, e.stderr]
          .filter((s) => s != null)
          .map((s) => String(s))
          .filter((s) => s.length > 0);
        if (streams.length === 0 && e.message) streams.push(e.message);
        return [...streams, marker].join("\n");
      }
    };

    if (pkgJson.scripts?.typecheck) {
      const out = run(`${runCmd} typecheck`);
      outputLines.push(`=== typecheck ===\n${out}`);
      if (passed) checks.push("typecheck: passed");
      else checks.push(`typecheck: failed (${failureReason})`);
    }

    if (passed && pkgJson.scripts?.lint) {
      const out = run(`${runCmd} lint`);
      outputLines.push(`=== lint ===\n${out}`);
      if (passed) checks.push("lint: passed");
      else checks.push(`lint: failed (${failureReason})`);
    }

    if (passed && pkgJson.scripts?.test) {
      const testCmd = pm === "yarn" ? "yarn test" : pm === "pnpm" ? "pnpm test" : "npm test";
      const out = run(testCmd);
      outputLines.push(`=== tests ===\n${out}`);
      if (passed) {
        // Rough heuristic: count "pass" or "✓" lines
        testsRun = (out.match(/(?:pass|✓|✔|ok\s+\d)/gi) ?? []).length;
        checks.push(`tests: passed (${testsRun} assertions)`);
      } else {
        checks.push(`tests: failed (${failureReason})`);
      }
    }

    return {
      passed,
      testOutput: outputLines.join("\n"),
      testsRun,
      summary: checks.join(", ") || "no preflight checks configured",
    };
  },
};
