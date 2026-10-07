/** Backend-run rules shared by `confirmAdmissionTerminated` (src/index.ts) and the Restate composers
 * (`planning-run-production.ts`, `kg-refresh-production.ts`), so each rule exists once. */
import type { AppConfig } from "./index.js";
import { destroyMachine, getMachine, readMachineExit, stopMachine, type Machine, type MachineExit } from "./fly-machines.js";
import { inspectLocalContainer, stopLocalContainer } from "./local-docker.js";

export type BackendRunState = "ended" | "started" | "unknown";

/** One read of a backend run: its state, plus the machine's exit when Fly reported one. */
export interface BackendRunRead {
  state: BackendRunState;
  exit: MachineExit | null;
}

const NO_EXIT: MachineExit = { exitCode: null, signal: null, oomKilled: null, timestamp: null };

function flyMachineState(machine: Machine): BackendRunState {
  if (machine.state === "destroyed" || machine.state === "stopped") return "ended";
  return machine.state === "started" ? "started" : "unknown";
}

type FlyConfig = Pick<AppConfig, "flySessionsToken" | "flySessionsApp">;

/** `destroyed`, `stopped` or a 404 is `ended`; `started` is `started`; anything else, including a
 *  lookup error or missing credentials, is `unknown` (an error never proves the machine is gone). */
export async function classifyFlyMachine(config: FlyConfig, machineId: string): Promise<BackendRunState> {
  if (!config.flySessionsToken || !config.flySessionsApp) return "unknown";
  try {
    return flyMachineState(await getMachine(config.flySessionsToken, config.flySessionsApp, machineId));
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

/** Stops the exact machine or container. `false` for a backend with no machine to stop. A Fly machine is
 *  destroyed, unless `keep` is set: a machine a pipeline keeps between runs is only stopped (AII-1136). */
export async function stopBackendRun(config: FlyConfig, mode: string, id: string, opts: { keep?: boolean } = {}): Promise<boolean> {
  if (mode === "fly-machines") {
    if (!config.flySessionsToken || !config.flySessionsApp) {
      throw new Error("FLY_SESSIONS_TOKEN + FLY_SESSIONS_APP are not configured; cannot stop the machine");
    }
    if (opts.keep) await stopMachine(config.flySessionsToken, config.flySessionsApp, id);
    else await destroyMachine(config.flySessionsToken, config.flySessionsApp, id);
    return true;
  }
  if (mode === "local-docker") {
    await stopLocalContainer(id);
    return true;
  }
  return false;
}

/** One status read of the exact machine or container. For Fly it reads the machine once and returns the
 *  state with the newest exit event (never an event count: `updateMachine` resets the history). A 404 is
 *  `ended` with an empty exit; a lookup error is `unknown`. A container has no exit; any other mode is `unknown`. */
export async function readBackendRun(config: FlyConfig, mode: string, id: string): Promise<BackendRunRead> {
  if (mode === "fly-machines") {
    if (!config.flySessionsToken || !config.flySessionsApp) return { state: "unknown", exit: null };
    try {
      const machine = await getMachine(config.flySessionsToken, config.flySessionsApp, id);
      const state = flyMachineState(machine);
      return { state, exit: state === "ended" ? readMachineExit(machine) : null };
    // A lookup error is `unknown` by design (AII-1125); the watch step's retry bound applies to the step, not to this read.
    } catch (err) {
      if (err instanceof Error && err.message.includes("404")) return { state: "ended", exit: { ...NO_EXIT } };
      console.error(`[backend-run] Failed to read Fly machine ${id}:`, err);
      return { state: "unknown", exit: null };
    }
  }
  if (mode === "local-docker") return { state: await classifyLocalContainer(id), exit: null };
  return { state: "unknown", exit: null };
}
