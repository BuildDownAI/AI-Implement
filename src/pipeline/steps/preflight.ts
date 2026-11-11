import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { repoProcessEnv } from "../process-env.js";

/** Fixed safety stop, deliberately not configurable by the pipeline. */
const COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
/** Bound captured output while allowing large test suites (ENOBUFS above this cap). */
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

/** Internal construction seam for short deadlines in tests; production has no timeout setting. */
export function createPreflightStep(timeoutMs = COMMAND_TIMEOUT_MS): StepModule<PreflightInputs, PreflightOutputs> {
  return {
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

      const run = (cmd: string): Promise<string> => new Promise((resolve) => {
        const started = Date.now();
        console.log(`[preflight] start: ${cmd}`);
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let bytes = 0;
        let reason: string | undefined;
        let marker: string | undefined;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (status: number | null, signal?: string | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (!reason && status !== 0) reason = status === null ? signal ?? "error" : `exit ${status}`;
          if (reason) {
            passed = false;
            failureReason = reason;
          }
          console.log(`[preflight] end: ${cmd} — ${reason ? `failed (${reason})` : "exit 0"}; duration ${Date.now() - started} ms`);
          const streams = [Buffer.concat(stdout).toString(), Buffer.concat(stderr).toString()].filter(Boolean);
          if (reason) streams.push(`[${marker ?? reason}]`);
          resolve(streams.join("\n"));
        };
        try {
          const child = spawn(cmd, {
            cwd: workspaceDir,
            shell: true,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: repoProcessEnv(),
          });
          const stopGroup = () => {
            if (!child.pid) return;
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
            }
          };
          const capture = (target: Buffer[], chunk: Buffer) => {
            const remaining = MAX_OUTPUT_BYTES - bytes;
            if (remaining > 0) target.push(chunk.subarray(0, remaining));
            bytes += chunk.length;
            if (bytes > MAX_OUTPUT_BYTES && !reason) {
              reason = "ENOBUFS: output over 64 MiB";
              marker = "ENOBUFS";
              stopGroup();
            }
          };
          child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
          child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
          child.on("error", (error: NodeJS.ErrnoException) => {
            reason ??= error.code ?? "error";
            if (bytes === 0) stderr.push(Buffer.from(error.message));
            stopGroup();
            finish(null);
          });
          child.on("close", finish);
          // Keep the deadline until close: descendants may hold pipes after the parent exits.
          timer = setTimeout(() => {
            reason ??= `timed out after ${timeoutMs / 60_000} min`;
            stopGroup();
          }, timeoutMs);
        } catch (error) {
          const e = error as NodeJS.ErrnoException;
          reason = e.code ?? "error";
          stderr.push(Buffer.from(e.message));
          finish(null);
        }
      });

      if (pkgJson.scripts?.typecheck) {
        const out = await run(`${runCmd} typecheck`);
        outputLines.push(`=== typecheck ===\n${out}`);
        if (passed) checks.push("typecheck: passed");
        else checks.push(`typecheck: failed (${failureReason})`);
      }

      if (passed && pkgJson.scripts?.lint) {
        const out = await run(`${runCmd} lint`);
        outputLines.push(`=== lint ===\n${out}`);
        if (passed) checks.push("lint: passed");
        else checks.push(`lint: failed (${failureReason})`);
      }

      if (passed && pkgJson.scripts?.test) {
        const testCmd = pm === "yarn" ? "yarn test" : pm === "pnpm" ? "pnpm test" : "npm test";
        const out = await run(testCmd);
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
}

export const preflightStep = createPreflightStep();
