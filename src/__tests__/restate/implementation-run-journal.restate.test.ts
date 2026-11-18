// Journal snapshot for ImplementationRun's pause points (AII-1558). A paused attempt resumes on new code after a
// deploy and replays its journal; a journaled action added, removed or reordered before a pause point makes the replay
// mismatch and the attempt retries for ever. This test compares the ordered command list of the journal at each pause
// point with a committed snapshot under journal-snapshots/. The control plane keeps the same check (CON-61).
//
// Only commands are compared (`entry_type` "Command: ..." and `name`): replay checks the commands the code issues, while
// the position of completion notifications between them depends on timing. Nothing else is stored: no ids, payloads or times.
//
// Pause points: `wait` (the durable sleep that races the `report` promise) and `confirm` (the first status read after
// `report`, held by a gate). The tick seams are huge, so no tick adds a `read-N` entry while a capture is read.
//
// Regenerate only with UPDATE_JOURNAL_SNAPSHOTS=1; a missing snapshot fails. Run with `npm run test:restate`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createImplementationRunWorkflow,
  type ImplementationRunDependencies,
  type ImplementationRunInput,
  type ImplementationRunStatusResult,
} from "../../restate/implementation-run-workflow.js";
import type { OwnedRunStatus } from "../../restate/owned-run-wait.js";
import {
  callWorkflow, eventually, gate, journalEntries, queryInvocations, startVariants, stopAll, waitForStep, type RestateEnvironment,
} from "./harness.js";

const SNAPSHOT_DIR = join(import.meta.dirname, "journal-snapshots");
const HOUR = 3_600_000;
const SEAMS = { tickMs: HOUR, confirmTickMs: HOUR, confirmWindowMs: HOUR, bootstrapMs: 2 * HOUR, totalMs: 4 * HOUR, stopMarginMs: 60_000, escapeWaitMs: 4_000, escapeTickMs: 100 };

interface JournalCommand { type: string; name: string }

const RULE = [
  "A journaled action of ImplementationRun changed before a pause point. A run paused here resumes on the new code after a deploy,",
  "replays its journal, finds a different action and retries for ever.",
  "Do not change journaled actions (ctx.run, ctx.set, ctx.sleep, ctx.date.now, promises) before a pause point.",
  "Put new work after the last pause point or in a new handler.",
  "If the change is unavoidable, drain paused attempts before the deploy and regenerate the snapshots with UPDATE_JOURNAL_SNAPSHOTS=1.",
].join("\n");

/** Compares one capture with its snapshot; returns the failure message, or null when it matches (or was regenerated). */
function checkSnapshot(point: string, actual: JournalCommand[]): string | null {
  const file = join(SNAPSHOT_DIR, `implementation-run.${point}.json`);
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env.UPDATE_JOURNAL_SNAPSHOTS === "1") {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(file, text);
    return null;
  }
  if (!existsSync(file)) {
    return `Journal snapshot ${file} is missing. Regenerate it with UPDATE_JOURNAL_SNAPSHOTS=1 npm run test:restate -- implementation-run-journal`;
  }
  const expected = JSON.parse(readFileSync(file, "utf8")) as JournalCommand[];
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    return `${RULE}\nSnapshot: ${file}\nExpected (${point}):\n${JSON.stringify(expected)}\nActual:\n${JSON.stringify(actual)}`;
  }
  return null;
}

describe("ImplementationRun journal at its pause points", () => {
  let envs: Map<string, RestateEnvironment>;
  let status: OwnedRunStatus = "started";
  const readGate = gate("confirm read");
  let holdReads = false;

  const deps: ImplementationRunDependencies = {
    ...SEAMS,
    reserve: async () => true,
    findExistingRun: async () => null,
    launch: async () => ({ outcome: "accepted", jobId: "job-journal" }),
    readStatus: async () => {
      if (holdReads) await readGate.wait();
      return status;
    },
    stop: async () => true,
    cleanup: async () => undefined,
    onOutcome: async () => undefined,
    finishJob: async () => ({}),
    release: async () => undefined,
  };

  beforeAll(async () => {
    envs = await startVariants([createImplementationRunWorkflow(deps)]);
  }, 180_000);

  afterAll(async () => {
    holdReads = false;
    readGate.release();
    await stopAll(envs);
  });

  it("matches the committed journal at the wait and the confirm pause points", async () => {
    const env = envs.get("disableRetries");
    if (!env) throw new Error("missing Restate variant disableRetries");
    const dispatchId = "implementation-journal-snapshot";
    const input: ImplementationRunInput = { dispatchId, teamKey: "ENG", issueId: "issue-journal", issueIdentifier: "ENG-1", launchContext: {}, maxJobMinutes: 90, backend: "github-actions" };
    const done = callWorkflow(env.baseUrl(), "ImplementationRun", dispatchId, "run", input);
    done.catch(() => undefined);
    const read = () => callWorkflow<ImplementationRunStatusResult>(env.baseUrl(), "ImplementationRun", dispatchId, "status");

    const commands = async (): Promise<JournalCommand[]> => {
      const rows = await queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'ImplementationRun' AND target_service_key = '${dispatchId}' AND target_handler_name = 'run'`);
      if (rows.length !== 1) return [];
      return (await journalEntries(env.adminAPIBaseUrl(), String(rows[0].id)))
        .filter((e) => String(e.entry_type).startsWith("Command: "))
        .map((e) => ({ type: String(e.entry_type).slice("Command: ".length), name: String(e.name ?? "") }));
    };

    try {
      // Wait pause: the first status read returned `started`, and the workflow sleeps on a tick that never fires.
      await waitForStep(read, "wait");
      const atWait = await eventually(commands, (c) => c.at(-1)?.type === "Sleep", { label: "the sleep of the wait pause" });

      // Confirm pause: `report` wakes the wait, and the first status read of the confirm window is held.
      holdReads = true;
      await callWorkflow(env.baseUrl(), "ImplementationRun", dispatchId, "report");
      await waitForStep(read, "confirm");
      await readGate.reached();
      const atConfirm = await eventually(commands, (c) => c.at(-1)?.name.startsWith("read-") === true && c.length > atWait.length, { label: "the confirm read" });
      expect(atConfirm.slice(0, atWait.length), "the confirm journal extends the wait journal").toEqual(atWait);
      // Both points are checked before either failure is thrown, so a change before the wait fails both.
      const failures = [checkSnapshot("wait", atWait), checkSnapshot("confirm", atConfirm)].filter((m): m is string => m !== null);
      if (failures.length > 0) throw new Error(failures.join("\n\n"));
    } finally {
      holdReads = false;
      status = "ended";
      readGate.release();
    }
    await done;
  }, 60_000);
});
