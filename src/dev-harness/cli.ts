import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  collectRunArtifacts,
  getRunStatus,
  startDevRun,
  stopDevRun,
  streamLogs,
  streamLogsUntilShellReady,
} from "./index.js";

export interface DevHarnessCliDependencies {
  startDevRun: typeof startDevRun;
  streamLogs: typeof streamLogs;
  streamLogsUntilShellReady: typeof streamLogsUntilShellReady;
  getRunStatus: typeof getRunStatus;
  collectRunArtifacts: typeof collectRunArtifacts;
  stopSession: typeof stopDevRun;
  spawnDocker: (args: string[], stdio: "inherit" | "ignore") => number;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  now: () => number;
}

const DEFAULT_DEPENDENCIES: DevHarnessCliDependencies = {
  startDevRun,
  streamLogs,
  streamLogsUntilShellReady,
  getRunStatus,
  collectRunArtifacts,
  stopSession: stopDevRun,
  spawnDocker: (args, stdio) => spawnSync("docker", args, { stdio }).status ?? 1,
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
  now: () => Date.now(),
};

export async function runDevHarnessCli(
  args: string[],
  deps: DevHarnessCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  let workspace = "";
  let task = "";
  let trackerData = "";
  let image: string | undefined;
  let untilStep: string | undefined;
  let shell = false;
  let phase: "implementation" | "planning" | "full" | "kg-refresh" = "implementation";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--workspace" || arg === "-w") && args[i + 1]) workspace = args[++i] as string;
    else if ((arg === "--task" || arg === "-t") && args[i + 1]) task = args[++i] as string;
    else if (arg === "--tracker-data" && args[i + 1]) trackerData = args[++i] as string;
    else if (arg === "--image" && args[i + 1]) image = args[++i];
    else if (arg === "--until" && args[i + 1]) untilStep = args[++i];
    else if (arg === "--phase") {
      const value = args[i + 1];
      if (value !== "implementation" && value !== "planning" && value !== "full" && value !== "kg-refresh") {
        deps.writeStderr("Invalid --phase: expected implementation, planning, full, or kg-refresh\n");
        return 1;
      }
      phase = value;
      i++;
    }
    else if (arg === "--shell") shell = true;
  }

  if (!workspace) {
    deps.writeStderr(
      "Usage: npm run dev:run -- --workspace <dir> [--task <task.md>] [--phase implementation|planning|full|kg-refresh] [--tracker-data <file>] [--image <image>] [--until <step>] [--shell]\n",
    );
    return 1;
  }
  if (phase !== "kg-refresh" && !task) {
    deps.writeStderr(
      "Usage: npm run dev:run -- --workspace <dir> --task <task.md> [--phase implementation|planning|full] [--image <image>] [--until <step>] [--shell]\n",
    );
    return 1;
  }
  if (phase === "kg-refresh" && !trackerData) {
    deps.writeStderr("--tracker-data <file> is required for --phase kg-refresh\n");
    return 1;
  }
  if (phase !== "implementation" && phase !== "kg-refresh" && (untilStep || shell)) {
    deps.writeStderr("--until and --shell are only supported for --phase implementation or kg-refresh\n");
    return 1;
  }

  const handle = await deps.startDevRun({
    workspace: resolve(workspace),
    task: task ? resolve(task) : undefined,
    trackerData: trackerData ? resolve(trackerData) : undefined,
    image,
    untilStep,
    shell,
    phase,
  });

  deps.writeStderr(
    `[dev:run] task=${handle.task.identifier} "${handle.task.title}"\n` +
    `[dev:run] container=${handle.containerName} (${handle.containerId.slice(0, 12)})\n` +
    `[dev:run] artifacts=${handle.artifactsDir}\n` +
    (untilStep ? `[dev:run] staged: running until step "${untilStep}"\n` : "") +
    `[dev:run] streaming logs...\n`,
  );

  if (shell) {
    const { ready, exitCode: pipelineExitCode } = await deps.streamLogsUntilShellReady(
      handle,
      (line) => deps.writeStdout(`${line}\n`),
    );
    let finalExitCode: number | null = pipelineExitCode;
    let artifactsCollected = false;

    if (ready) {
      deps.writeStderr(
        `[dev:run] pipeline complete (exit=${pipelineExitCode})\n` +
        `[dev:run] hook env exports sourced from /tmp/dev-run-env.sh\n` +
        `[dev:run] attaching shell at /workspace — type "exit" when done\n`,
      );
      const shellExitCode = deps.spawnDocker(
        ["exec", "-it", "--workdir", "/workspace", handle.containerName, "bash", "--init-file", "/tmp/dev-run-env.sh"],
        "inherit",
      );
      if (shellExitCode !== 0) finalExitCode = shellExitCode;

      try {
        await deps.collectRunArtifacts(handle, finalExitCode);
        artifactsCollected = true;
      } finally {
        deps.writeStderr("[dev:run] shell exited; removing container...\n");
        await deps.stopSession(handle).catch(() => undefined);
      }
    } else {
      const state = await deps.getRunStatus(handle);
      finalExitCode = state.exitCode;
    }

    if (!artifactsCollected) await deps.collectRunArtifacts(handle, finalExitCode);
    const durationSec = ((deps.now() - handle.startedAt.getTime()) / 1000).toFixed(1);
    deps.writeStderr(
      `[dev:run] done: exit=${finalExitCode ?? "unknown"} duration=${durationSec}s\n` +
      `[dev:run] artifacts saved to ${handle.artifactsDir}/\n` +
      `[dev:run] inspect changes: cd ${handle.workspace} && git diff\n`,
    );
    return finalExitCode ?? 1;
  }

  await deps.streamLogs(handle, (line) => deps.writeStdout(`${line}\n`));
  const state = await deps.getRunStatus(handle);
  const exitCode = state.exitCode;
  const durationSec = ((deps.now() - handle.startedAt.getTime()) / 1000).toFixed(1);
  await deps.collectRunArtifacts(handle, exitCode);
  deps.writeStderr(
    `[dev:run] done: exit=${exitCode ?? "unknown"} duration=${durationSec}s\n` +
    `[dev:run] artifacts saved to ${handle.artifactsDir}/\n` +
    `[dev:run] inspect changes: cd ${handle.workspace} && git diff\n`,
  );
  return exitCode ?? 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDevHarnessCli(process.argv.slice(2))
    .then((exitCode) => process.exit(exitCode))
    .catch((err) => {
      process.stderr.write(`[dev:run] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
