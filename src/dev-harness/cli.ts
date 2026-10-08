import { execFile as nodeExecFile, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  collectRunArtifacts,
  getRunStatus,
  startDevRun,
  stopDevRun,
  streamLogs,
  streamLogsUntilShellReady,
} from "./index.js";
import type { DevRunHandle } from "./index.js";

export interface DevHarnessCliDependencies {
  startDevRun: typeof startDevRun;
  streamLogs: typeof streamLogs;
  streamLogsUntilShellReady: typeof streamLogsUntilShellReady;
  getRunStatus: typeof getRunStatus;
  collectRunArtifacts: typeof collectRunArtifacts;
  stopSession: typeof stopDevRun;
  stopContainer?: (handle: DevRunHandle) => Promise<void>;
  spawnDocker: (args: string[], stdio: "inherit" | "ignore") => number;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  now: () => number;
  cancelSignal?: AbortSignal;
}

const execFile = promisify(nodeExecFile);

const DEFAULT_DEPENDENCIES: DevHarnessCliDependencies = {
  startDevRun,
  streamLogs,
  streamLogsUntilShellReady,
  getRunStatus,
  collectRunArtifacts,
  stopSession: stopDevRun,
  stopContainer: async (handle) => {
    await execFile("docker", ["stop", "--time", "10", handle.containerName], { timeout: 15_000 });
  },
  spawnDocker: (args, stdio) => spawnSync("docker", args, { stdio }).status ?? 1,
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
  now: () => Date.now(),
};

function runtimeCancelSignal(): AbortSignal | undefined {
  if (typeof process === "undefined" || typeof AbortController === "undefined") return undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  controller.signal.addEventListener("abort", () => {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }, { once: true });
  return controller.signal;
}

function monitorCancellation(handle: DevRunHandle, deps: DevHarnessCliDependencies): {
  wasCancelled(): boolean;
  waitForStop(): Promise<void>;
  dispose(): void;
} {
  let cancelled = false;
  const signal = deps.cancelSignal;
  let settleStop!: () => void;
  const stopDone = new Promise<void>((resolve) => { settleStop = resolve; });
  if (!signal) return { wasCancelled: () => cancelled, waitForStop: () => Promise.resolve(), dispose: () => undefined };
  const stop = () => {
    if (cancelled) return;
    cancelled = true;
    deps.writeStderr("[dev:run] cancellation requested; stopping container...\n");
    const stopContainer = deps.stopContainer ?? DEFAULT_DEPENDENCIES.stopContainer!;
    void stopContainer(handle).catch(() => undefined).finally(() => settleStop());
  };
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  return {
    wasCancelled: () => cancelled,
    waitForStop: () => stopDone,
    dispose: () => {
      signal.removeEventListener("abort", stop);
      if (!cancelled) settleStop();
    },
  };
}

async function finalizeLocalAuth(handle: DevRunHandle, deps: DevHarnessCliDependencies): Promise<void> {
  if (!handle.localAuth) return;
  let state: Awaited<ReturnType<DevHarnessCliDependencies["getRunStatus"]>> | undefined;
  try {
    state = await deps.getRunStatus(handle);
  } catch {
    state = undefined;
  }
  await handle.localAuth.close().catch(() => undefined);
  const proof = state?.running === false && state.exitCode !== null ? "confirmed" : "unknown";
  await handle.localAuth.releaseAfterTermination(async () => proof).catch(() => undefined);
}

async function cleanupDevRun(handle: DevRunHandle, deps: DevHarnessCliDependencies): Promise<void> {
  try {
    await finalizeLocalAuth(handle, deps);
  } finally {
    await handle.sourceWorkspaceCleanup?.().catch(() => undefined);
  }
}

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
  let workspaceMode: "mounted" | "copy" = "mounted";
  let agentConfig: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--workspace" || arg === "-w") && args[i + 1]) workspace = args[++i] as string;
    else if ((arg === "--task" || arg === "-t") && args[i + 1]) task = args[++i] as string;
    else if (arg === "--tracker-data" && args[i + 1]) trackerData = args[++i] as string;
    else if (arg === "--image" && args[i + 1]) image = args[++i];
    else if (arg === "--agent-config") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) {
        deps.writeStderr("Missing value for --agent-config\n");
        return 1;
      }
      agentConfig = resolve(args[++i] as string);
    }
    else if (arg === "--workspace-mode") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) {
        deps.writeStderr("Missing value for --workspace-mode\n");
        return 1;
      }
      if (value !== "mounted" && value !== "copy") {
        deps.writeStderr("Invalid --workspace-mode: expected mounted or copy\n");
        return 1;
      }
      workspaceMode = value;
      i++;
    }
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
  if (phase !== "implementation" && phase !== "kg-refresh" && (untilStep || shell)) {
    deps.writeStderr("--until and --shell are only supported for --phase implementation or kg-refresh\n");
    return 1;
  }

  let handle;
  try {
    handle = await deps.startDevRun({
      workspace: resolve(workspace),
      task: task ? resolve(task) : undefined,
      trackerData: trackerData ? resolve(trackerData) : undefined,
      image,
      agentConfig,
      workspaceMode,
      untilStep,
      shell,
      phase,
    });
  } catch (err) {
    deps.writeStderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  deps.writeStderr(
    `[dev:run] task=${handle.task.identifier} "${handle.task.title}"\n` +
    `[dev:run] container=${handle.containerName} (${handle.containerId.slice(0, 12)})\n` +
    `[dev:run] artifacts=${handle.artifactsDir}\n` +
    (untilStep ? `[dev:run] staged: running until step "${untilStep}"\n` : "") +
    `[dev:run] streaming logs...\n`,
  );

  if (shell) {
    const cancel = monitorCancellation(handle, deps);
    try {
      const logResult = deps.streamLogsUntilShellReady(
        handle,
        (line) => deps.writeStdout(`${line}\n`),
      ).catch(() => ({ ready: false, exitCode: null }));
      const { ready, exitCode: pipelineExitCode } = await Promise.race([
        logResult,
        cancel.waitForStop().then(() => ({ ready: false, exitCode: null })),
      ]);
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

        await deps.collectRunArtifacts(handle, finalExitCode);
        artifactsCollected = true;
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
      return cancel.wasCancelled() ? 130 : finalExitCode ?? 1;
    } finally {
      cancel.dispose();
      await cancel.waitForStop();
      await cleanupDevRun(handle, deps);
      deps.writeStderr("[dev:run] removing container...\n");
      await deps.stopSession(handle).catch(() => undefined);
    }
  }

  const cancel = monitorCancellation(handle, deps);
  try {
    const logs = deps.streamLogs(handle, (line) => deps.writeStdout(`${line}\n`)).catch(() => undefined);
    await Promise.race([logs, cancel.waitForStop()]);
    const state = await deps.getRunStatus(handle);
    const exitCode = state.exitCode;
    const durationSec = ((deps.now() - handle.startedAt.getTime()) / 1000).toFixed(1);
    await deps.collectRunArtifacts(handle, exitCode);
    deps.writeStderr(
      `[dev:run] done: exit=${exitCode ?? "unknown"} duration=${durationSec}s\n` +
      `[dev:run] artifacts saved to ${handle.artifactsDir}/\n` +
      `[dev:run] inspect changes: cd ${handle.workspace} && git diff\n`,
    );
    return cancel.wasCancelled() ? 130 : exitCode ?? 1;
  } finally {
    cancel.dispose();
    await cancel.waitForStop();
    await cleanupDevRun(handle, deps);
    if (cancel.wasCancelled()) await deps.stopSession(handle).catch(() => undefined);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDevHarnessCli(process.argv.slice(2), { ...DEFAULT_DEPENDENCIES, cancelSignal: runtimeCancelSignal() })
    .then((exitCode) => process.exit(exitCode))
    .catch((err) => {
      process.stderr.write(`[dev:run] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
