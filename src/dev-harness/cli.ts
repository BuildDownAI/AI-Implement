import { resolve } from "node:path";
import { collectRunArtifacts, getRunStatus, startDevRun, streamLogs } from "./index.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let workspace = "";
  let task = "";
  let image: string | undefined;
  let push = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--workspace" || arg === "-w") && args[i + 1]) {
      workspace = args[++i] as string;
    } else if ((arg === "--task" || arg === "-t") && args[i + 1]) {
      task = args[++i] as string;
    } else if (arg === "--image" && args[i + 1]) {
      image = args[++i];
    } else if (arg === "--push") {
      push = true;
    }
  }

  if (!workspace || !task) {
    process.stderr.write(
      "Usage: npm run dev:run -- --workspace <dir> --task <task.md> [--push] [--image <image>]\n",
    );
    process.exit(1);
  }

  const handle = await startDevRun({
    workspace: resolve(workspace),
    task: resolve(task),
    image,
    push,
  });

  process.stderr.write(
    `[dev:run] task=${handle.task.identifier} "${handle.task.title}"\n` +
    `[dev:run] container=${handle.containerName} (${handle.containerId.slice(0, 12)})\n` +
    `[dev:run] artifacts=${handle.artifactsDir}\n` +
    `[dev:run] streaming logs...\n`,
  );

  // Stream container logs to stdout until the container exits.
  await streamLogs(handle, (line) => process.stdout.write(`${line}\n`));

  // Container has exited — get exit code.
  const state = await getRunStatus(handle);
  const exitCode = state.exitCode;
  const durationSec = ((Date.now() - handle.startedAt.getTime()) / 1000).toFixed(1);

  // Persist artifacts.
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
