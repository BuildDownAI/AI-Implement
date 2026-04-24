import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";

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

    const run = (cmd: string): string => {
      try {
        const out = execSync(cmd, { cwd: workspaceDir, stdio: "pipe" }).toString();
        return out;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        passed = false;
        return message;
      }
    };

    if (pkgJson.scripts?.typecheck) {
      const out = run(`${runCmd} typecheck`);
      outputLines.push(`=== typecheck ===\n${out}`);
      if (passed) checks.push("typecheck: passed");
      else checks.push(`typecheck: failed`);
    }

    if (passed && pkgJson.scripts?.lint) {
      const out = run(`${runCmd} lint`);
      outputLines.push(`=== lint ===\n${out}`);
      if (passed) checks.push("lint: passed");
      else checks.push(`lint: failed`);
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
        checks.push("tests: failed");
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
