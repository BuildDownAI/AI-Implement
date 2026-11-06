/**
 * Runs the orchestrator setup checks on the host, with no server, Restate or sign-in needed.
 *
 *   node dist/check-setup.js [--json]
 *
 * The authority is shell access, as for access recovery, so the output shows every check's detail
 * and fix. The database is opened read-only and never created, and Restate's status comes from the
 * running orchestrator's own health route.
 */

import { useReadOnlyDb } from "./dedup.js";
import { parseHealthPort } from "./http-server.js";
import { configureLinearAuthFromEnv } from "./linear-app-auth.js";
import { refreshRunnerBackendCache } from "./orchestrator-settings.js";
import { countFailingCore, createSetupCheckContext, runSetupChecks, SETUP_CHECKS, type SetupCheck, type SetupCheckContext, type SetupCheckRestateStatus, type SetupCheckResult, type SetupCheckRun } from "./setup-checks/index.js";

export interface CheckSetupDependencies {
  checks: readonly SetupCheck[];
  /** Runs before any check reads, so no reader opens the database read-write. */
  useReadOnlyDb: () => void;
  /** Configures tracker credentials as boot does, so the tracker checks can build their providers. */
  configureTrackers: () => void;
  createContext: (restateStatus: () => SetupCheckRestateStatus) => SetupCheckContext;
  /** Fills the Fly sessions cache from Restate, as the server does each poll. */
  refreshRunnerBackend: () => Promise<void>;
  fetch: typeof fetch;
  /** The orchestrator's own port, whose `GET /` reports its Restate status. */
  port: number;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
}

const DEFAULT_DEPENDENCIES: CheckSetupDependencies = {
  checks: SETUP_CHECKS,
  useReadOnlyDb,
  configureTrackers: () => {
    configureLinearAuthFromEnv();
  },
  createContext: (restateStatus) => createSetupCheckContext({ restateStatus }),
  refreshRunnerBackend: refreshRunnerBackendCache,
  fetch: (input, init) => fetch(input, init),
  port: parseHealthPort(process.env.PORT),
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

const HEALTH_TIMEOUT_MS = 5_000;

const STATE_LABELS: Record<SetupCheckResult["state"], string> = {
  pass: "PASS",
  warn: "WARN",
  fail: "FAIL",
  "cannot-verify": "CANNOT VERIFY",
  "not-applicable": "N/A",
};

const LABEL_WIDTH = 13;

const USAGE = `Usage: node dist/check-setup.js [--json]

  --json  print the run as JSON instead of a table
`;

/** The orchestrator's own Restate status, or why it could not be read. */
async function readRestateStatus(deps: CheckSetupDependencies): Promise<SetupCheckRestateStatus | Error> {
  let response: Response;
  try {
    response = await deps.fetch(`http://127.0.0.1:${deps.port}/`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
  } catch {
    return new Error(`The orchestrator is not answering on port ${deps.port}, so its Restate status cannot be read.`);
  }
  const body = (await response.json().catch(() => null)) as { restate?: SetupCheckRestateStatus } | null;
  return body?.restate ?? new Error(`Port ${deps.port} answered without a Restate status, so it may not be this orchestrator.`);
}

/** One check's lines: its state, id and title, then its detail and fix beneath. The provisioning command prints its own checks this way too. */
export function formatCheckRow(r: Pick<SetupCheckResult, "state" | "id" | "project" | "title" | "detail" | "fix">): string[] {
  const indent = " ".repeat(LABEL_WIDTH + 4);
  const lines = [`  ${STATE_LABELS[r.state].padEnd(LABEL_WIDTH)}  ${r.id}${r.project ? ` (${r.project})` : ""}: ${r.title}`];
  if (r.detail) lines.push(`${indent}${r.detail}`);
  if (r.fix) lines.push(`${indent}Fix: ${r.fix}`);
  return lines;
}

function formatRun(run: SetupCheckRun, failingCore: number): string {
  const lines: string[] = [];
  for (const group of new Set(run.results.map((r) => r.group))) {
    lines.push(group);
    for (const r of run.results.filter((result) => result.group === group)) lines.push(...formatCheckRow(r));
    lines.push("");
  }
  lines.push(failingCore === 0 ? "No core check fails." : `${failingCore} core ${failingCore === 1 ? "check fails" : "checks fail"}.`);
  return `${lines.join("\n")}\n`;
}

export async function runCheckSetup(
  args: string[],
  deps: CheckSetupDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") {
      deps.writeStdout(USAGE);
      return 0;
    } else {
      deps.writeStderr(`Unknown argument: ${arg}\n\n${USAGE}`);
      return 2;
    }
  }

  deps.useReadOnlyDb();
  deps.configureTrackers();
  const restate = await readRestateStatus(deps);
  // The Fly sessions app can live only in Restate, so read it the way the server does once Restate answers.
  if (!(restate instanceof Error) && restate.registration.state === "registered") await deps.refreshRunnerBackend();

  const context = deps.createContext(() => {
    if (restate instanceof Error) throw restate;
    return restate;
  });
  const run = await runSetupChecks(context, deps.checks);
  const failingCore = countFailingCore(run);
  deps.writeStdout(json ? `${JSON.stringify(run, null, 2)}\n` : formatRun(run, failingCore));
  return failingCore > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCheckSetup(process.argv.slice(2))
    .then((exitCode) => process.exit(exitCode))
    .catch((err) => {
      process.stderr.write(`The setup checks could not run: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
