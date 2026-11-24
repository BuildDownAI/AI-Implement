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
// GitHub Actions and legacy local Docker capture polling; Fly captures the serve path with a gated runner call.
// Legacy Fly polling replay is covered in implementation-run-workflow.restate.test.ts.
//
// Regenerate only with UPDATE_JOURNAL_SNAPSHOTS=1; a missing snapshot fails. Run with `npm run test:restate`.
import * as http2 from "node:http2";
import * as restate from "@restatedev/restate-sdk";
import { createEndpointHandler } from "@restatedev/restate-sdk/node";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createImplementationRunWorkflow,
  type ImplementationRunDependencies,
  type ImplementationRunInput,
  type ImplementationRunStatusResult,
} from "../../restate/implementation-run-workflow.js";
import { registerRunnerDeployment } from "../../restate/endpoint.js";
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
function checkSnapshot(prefix: string, point: string, actual: JournalCommand[]): string | null {
  const file = join(SNAPSHOT_DIR, `${prefix}.${point}.json`);
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

const CASES = [
  { backend: "github-actions", prefix: "implementation-run", dispatchId: "implementation-journal-snapshot" },
  // Legacy local polling must retain exactly the same pre-serve commands.
  { backend: "local-docker", prefix: "implementation-run", dispatchId: "implementation-journal-snapshot-local" },
  { backend: "fly-machines", prefix: "implementation-run-fly", dispatchId: "implementation-journal-snapshot-fly" },
] as const satisfies ReadonlyArray<{ backend: ImplementationRunInput["backend"]; prefix: string; dispatchId: string }>;

for (const { backend, prefix, dispatchId } of CASES) {
  describe(`ImplementationRun journal at its pause points (${backend})`, () => {
    let envs: Map<string, RestateEnvironment>;
    let status: OwnedRunStatus = "started";
    const readGate = gate("confirm read");
    let holdReads = false;
    const runnerGate = gate("runner result");
    let runnerUri = "";
    let runnerServer: http2.Http2Server | undefined;
    const sessions = new Set<http2.ServerHttp2Session>();

    const deps: ImplementationRunDependencies = {
      ...SEAMS,
      reserve: async () => true,
      findExistingRun: async () => null,
      launch: async () => ({ outcome: "accepted", jobId: `job-${prefix}`, ...(backend === "fly-machines" ? { serve: true } : {}) }),
      // Production supplies these for every backend; their presence must not enable serve mode.
      runnerRegistration: () => {
        if (backend !== "fly-machines") throw new Error("legacy run registered a runner");
        return { readUri: () => runnerUri, readContainerState: () => "started", register: uri => registerRunnerDeployment(uri, { adminBaseUrl: envs.get("strict")!.adminAPIBaseUrl() }) };
      },
      markStarted: () => { if (backend !== "fly-machines") throw new Error("legacy run used serve started evidence"); },
      removeRunnerDeployment: async () => {},
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
      if (backend === "fly-machines") {
        const runner = restate.service({ name: `Runner_${dispatchId}`, handlers: {
          run: async (ctx: restate.Context) => { await ctx.run("result", () => runnerGate.wait()); return {}; },
        } });
        runnerServer = http2.createServer(createEndpointHandler({ services: [runner] }));
        runnerServer.on("session", session => { sessions.add(session); session.on("close", () => sessions.delete(session)); });
        await new Promise<void>(resolve => runnerServer!.listen(0, "127.0.0.1", resolve));
        const address = runnerServer.address();
        if (!address || typeof address === "string") throw new Error("missing runner address");
        runnerUri = `http://127.0.0.1:${address.port}`;
      }
      envs = await startVariants([createImplementationRunWorkflow(deps)]);
    }, 180_000);

    afterAll(async () => {
      holdReads = false;
      readGate.release();
      runnerGate.release();
      await stopAll(envs);
      if (runnerServer) await new Promise<void>(resolve => { runnerServer!.close(() => resolve()); for (const session of sessions) session.destroy(); });
    });

    it("matches the committed journal at the wait and the confirm pause points", async () => {
      const env = envs.get("strict");
      if (!env) throw new Error("missing Restate variant strict");
      const input: ImplementationRunInput = { dispatchId, teamKey: "ENG", issueId: "issue-journal", issueIdentifier: "ENG-1", launchContext: {}, maxJobMinutes: 90, backend };
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

        // Confirm pause: `report` wakes the wait. Polling holds its first status read; serve waits on the gated call.
        holdReads = true;
        await callWorkflow(env.baseUrl(), "ImplementationRun", dispatchId, "report");
        await waitForStep(read, "confirm");
        if (backend !== "fly-machines") await readGate.reached();
        const atConfirm = await eventually(commands, (c) => (backend === "fly-machines" ? c.at(-1)?.type === "Sleep" : c.at(-1)?.name.startsWith("read-") === true) && c.length > atWait.length, { label: "the confirm pause" });
        expect(atConfirm.slice(0, atWait.length), "the confirm journal extends the wait journal").toEqual(atWait);
        // Both points are checked before either failure is thrown, so a change before the wait fails both.
        const failures = [checkSnapshot(prefix, "wait", atWait), checkSnapshot(prefix, "confirm", atConfirm)].filter((m): m is string => m !== null);
        if (failures.length > 0) throw new Error(failures.join("\n\n"));
      } finally {
        holdReads = false;
        status = "ended";
        readGate.release();
        runnerGate.release();
      }
      await done;
    }, 60_000);
  });
}
