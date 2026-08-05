import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  collectRunArtifacts,
  getRunStatus,
  startDevRun,
  streamLogs,
  streamLogsUntilShellReady,
} from "./index.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let workspace = "";
  let task = "";
  let image: string | undefined;
  let untilStep: string | undefined;
  let shell = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--workspace" || arg === "-w") && args[i + 1]) {
      workspace = args[++i] as string;
    } else if ((arg === "--task" || arg === "-t") && args[i + 1]) {
      task = args[++i] as string;
    } else if (arg === "--image" && args[i + 1]) {
      image = args[++i];
    } else if (arg === "--until" && args[i + 1]) {
      untilStep = args[++i];
    } else if (arg === "--shell") {
      shell = true;
    }
  }

  if (!workspace || !task) {
    process.stderr.write(
      "Usage: npm run dev:run -- --workspace <dir> --task <task.md> [--image <image>] [--until <step>] [--shell]\n",
    );
    process.exit(1);
  }

  const handle = await startDevRun({
    workspace: resolve(workspace),
    task: resolve(task),
    image,
    untilStep,
    shell,
  });

  process.stderr.write(
    `[dev:run] task=${handle.task.identifier} "${handle.task.title}"\n` +
    `[dev:run] container=${handle.containerName} (${handle.containerId.slice(0, 12)})\n` +
    `[dev:run] artifacts=${handle.artifactsDir}\n` +
    (untilStep ? `[dev:run] staged: running until step "${untilStep}"\n` : "") +
    `[dev:run] streaming logs...\n`,
  );

  if (shell) {
    // Watch logs for the shell-ready sentinel "[dev:run] shell-ready exit=N".
    // Non-sentinel lines go to stdout as usual.
    const { ready, exitCode: pipelineExitCode } = await streamLogsUntilShellReady(
      handle,
      (line) => process.stdout.write(`${line}\n`),
    );

    let finalExitCode: number | null = pipelineExitCode;

    if (ready) {
      process.stderr.write(
        `[dev:run] pipeline complete (exit=${pipelineExitCode})\n` +
        `[dev:run] hook env exports sourced from /tmp/dev-run-env.sh\n` +
        `[dev:run] attaching shell at /workspace — type "exit" when done\n`,
      );

      // Attach an interactive bash session. --init-file sources the env file
      // written by run-autonomous.ts so hook-exported GITHUB_ENV vars are
      // visible in the shell. --workdir /workspace starts in the mounted repo.
      // spawnSync with stdio:inherit passes the terminal through for readline.
      spawnSync(
        "docker",
        ["exec", "-it", "--workdir", "/workspace", handle.containerName, "bash", "--init-file", "/tmp/dev-run-env.sh"],
        { stdio: "inherit" },
      );

      process.stderr.write(`[dev:run] shell exited; removing container...\n`);
      // Force-remove the container (it is still alive, waiting for SIGKILL).
      spawnSync("docker", ["rm", "-f", handle.containerId], { stdio: "ignore" });
    } else {
      // Container exited before the sentinel (shouldn't happen when SHELL_MODE is
      // set, but handle it gracefully — get the real exit code from inspect).
      const state = await getRunStatus(handle);
      finalExitCode = state.exitCode;
    }

    const durationSec = ((Date.now() - handle.startedAt.getTime()) / 1000).toFixed(1);
    await collectRunArtifacts(handle, finalExitCode);

    process.stderr.write(
      `[dev:run] done: exit=${finalExitCode ?? "unknown"} duration=${durationSec}s\n` +
      `[dev:run] artifacts saved to ${handle.artifactsDir}/\n` +
      `[dev:run] inspect changes: cd ${handle.workspace} && git diff\n`,
    );

    process.exit(finalExitCode ?? 1);
  }

  // Non-shell mode: stream logs until the container exits.
  await streamLogs(handle, (line) => process.stdout.write(`${line}\n`));

  const state = await getRunStatus(handle);
  const exitCode = state.exitCode;
  const durationSec = ((Date.now() - handle.startedAt.getTime()) / 1000).toFixed(1);

  await collectRunArtifacts(handle, exitCode);

  process.stderr.write(
    `[dev:run] done: exit=${exitCode ?? "unknown"} duration=${durationSec}s\n` +
    `[dev:run] artifacts saved to ${handle.artifactsDir}/\n` +
    `[dev:run] inspect changes: cd ${handle.workspace} && git diff\n`,
  );

  process.exit(exitCode ?? 1);
}

main().catch((err) => {
  process.stderr.write(
    `[dev:run] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
