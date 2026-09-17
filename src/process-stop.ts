import type { ChildProcess } from "node:child_process";

/**
 * Sends SIGTERM to a child process and waits up to stopTimeoutMs for it to close;
 * SIGKILLs and waits for close if it doesn't exit in time. Shared by KgSidecar
 * (src/kg-sidecar.ts) and RestateSidecar (src/restate/server.ts) — the one piece
 * their stop() methods share verbatim; spawn and readiness differ per sidecar.
 */
export async function stopChildWithBackstop(child: ChildProcess, stopTimeoutMs: number): Promise<void> {
  // Already dead — crashed or exited before stop() was called.
  if (child.exitCode !== null || child.signalCode !== null) return;

  // Register close listener before sending SIGTERM to avoid a race where
  // the process exits synchronously (impossible in JS but belt-and-suspenders).
  const closedPromise = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), stopTimeoutMs);
    timer.unref();
    child.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  child.kill("SIGTERM");

  const closed = await closedPromise;

  if (!closed) {
    child.kill("SIGKILL");
    await waitForClose(child);
  }
}

function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => child.once("close", resolve));
}
