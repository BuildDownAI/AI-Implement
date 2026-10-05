/** Backend-run rules shared by `confirmAdmissionTerminated` (src/index.ts) and the Restate composers
 * (`planning-run-production.ts`, `kg-refresh-production.ts`), so each rule exists once. */
import type { AppConfig } from "./index.js";
import { destroyMachine, getMachine } from "./fly-machines.js";
import { inspectLocalContainer, stopLocalContainer } from "./local-docker.js";

export type BackendRunState = "ended" | "started" | "unknown";

type FlyConfig = Pick<AppConfig, "flySessionsToken" | "flySessionsApp">;

/** `destroyed`, `stopped` or a 404 is `ended`; `started` is `started`; anything else, including a
 *  lookup error or missing credentials, is `unknown` (an error never proves the machine is gone). */
export async function classifyFlyMachine(config: FlyConfig, machineId: string): Promise<BackendRunState> {
  if (!config.flySessionsToken || !config.flySessionsApp) return "unknown";
  try {
    const machine = await getMachine(config.flySessionsToken, config.flySessionsApp, machineId);
    if (machine.state === "destroyed" || machine.state === "stopped") return "ended";
    return machine.state === "started" ? "started" : "unknown";
  } catch (err) {
    if (err instanceof Error && err.message.includes("404")) return "ended"; // already gone
    console.error(`[backend-run] Failed to check Fly machine state for ${machineId}:`, err);
    return "unknown";
  }
}

/** Not running, or `No such container`, is `ended`; running is `started`. `docker inspect` fails
 *  identically for "container gone" and "daemon unreachable", so any other error is `unknown`. */
export async function classifyLocalContainer(containerId: string): Promise<BackendRunState> {
  try {
    const state = await inspectLocalContainer(containerId);
    return state.running ? "started" : "ended";
  } catch (err) {
    return err instanceof Error && /No such container/i.test(err.message) ? "ended" : "unknown";
  }
}

/** Stops the exact machine or container. `false` for a backend with no machine to stop. */
export async function stopBackendRun(config: FlyConfig, mode: string, id: string): Promise<boolean> {
  if (mode === "fly-machines") {
    if (!config.flySessionsToken || !config.flySessionsApp) {
      throw new Error("FLY_SESSIONS_TOKEN + FLY_SESSIONS_APP are not configured; cannot stop the machine");
    }
    await destroyMachine(config.flySessionsToken, config.flySessionsApp, id);
    return true;
  }
  if (mode === "local-docker") {
    await stopLocalContainer(id);
    return true;
  }
  return false;
}
