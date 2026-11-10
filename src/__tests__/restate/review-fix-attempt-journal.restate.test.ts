// Journal snapshot for ReviewFixAttempt's pause points (AII-1711).
// Only ordered command types and names are stored: no ids, payloads or times.
// Regenerate only with UPDATE_JOURNAL_SNAPSHOTS=1; a missing snapshot fails.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkflowContext, WorkflowHandlerOpts } from "@restatedev/restate-sdk";
import { createReviewFixAttempt } from "../../restate/review-fix-attempt.js";
import type { PreparedReviewFixAttempt } from "../../review-fix-ports.js";
import { makeReviewFixResult } from "../helpers/builders.js";
import { callWorkflow, eventually, gate, journalEntries, queryInvocations, startVariants, stopAll, type RestateEnvironment } from "./harness.js";

// ReviewFixAttempt has no normal-path timing seams. Wrap only its workflow
// context: every sleep still issues the real SDK command, with an hour-long tick.
// No journal operation is added, removed or reordered by this test-only seam.
vi.mock("@restatedev/restate-sdk", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@restatedev/restate-sdk")>();
  return { ...sdk, handlers: { ...sdk.handlers, workflow: { ...sdk.handlers.workflow,
    workflow: (options: WorkflowHandlerOpts<unknown, unknown>, handler: (ctx: WorkflowContext, input: unknown) => Promise<unknown>) =>
      sdk.handlers.workflow.workflow(options, (ctx: WorkflowContext, input: unknown) => handler(new Proxy(ctx, {
        get(target, key) {
          if (key === "sleep") return () => target.sleep(3_600_000);
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }), input)),
  } } };
});

const SNAPSHOT_DIR = join(import.meta.dirname, "journal-snapshots");
interface JournalCommand { type: string; name: string }

const RULE = [
  "A journaled action of ReviewFixAttempt changed before a pause point. A run paused here resumes on the new code after a deploy,",
  "replays its journal, finds a different action and retries for ever.",
  "Do not change journaled actions (ctx.run, ctx.set, ctx.sleep, ctx.date.now, promises) before a pause point.",
  "Put new work after the last pause point or in a new handler.",
  "If the change is unavoidable, drain paused attempts before the deploy and regenerate the snapshots with UPDATE_JOURNAL_SNAPSHOTS=1.",
].join("\n");

/** Compares one capture with its snapshot; returns the failure message, or null when it matches (or was regenerated). */
function checkSnapshot(point: string, actual: JournalCommand[]): string | null {
  const file = join(SNAPSHOT_DIR, `review-fix-attempt.${point}.json`);
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env.UPDATE_JOURNAL_SNAPSHOTS === "1") {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(file, text);
    return null;
  }
  if (!existsSync(file)) {
    return `Journal snapshot ${file} is missing. Regenerate it with UPDATE_JOURNAL_SNAPSHOTS=1 npm run test:restate -- review-fix-attempt-journal`;
  }
  const expected = JSON.parse(readFileSync(file, "utf8")) as JournalCommand[];
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    return `${RULE}\nSnapshot: ${file}\nExpected (${point}):\n${JSON.stringify(expected)}\nActual:\n${JSON.stringify(actual)}`;
  }
  return null;
}

describe("ReviewFixAttempt journal at its pause points", () => {
  let envs: Map<string, RestateEnvironment>;
  const execution = { githubRunId: 782, githubRunAttempt: 1 };
  const reportGate = gate("report held until wait captured");
  let unknownLaunch = true;
  let bound = false;
  let inspections = 0;
  let reconciled = false;
  let prepared: PreparedReviewFixAttempt;

  const workflow = createReviewFixAttempt({
    store: {
      admit: async () => { throw new Error("admission belongs to the PR coordinator"); },
      getPreparedAttempt: async () => prepared,
      recordLaunchIntent: async () => ({ status: "recorded" }),
      hasCurrentAuthority: async () => true,
      bindExecution: async () => { bound = true; return { status: "bound" }; },
      revokeAuthority: async () => undefined,
      recordResult: async (_id, result) => ({ status: "stored", result }),
      releaseOwner: async () => ({ status: "released" }),
    },
    worker: {
      prepare: async (attempt) => ({ ...attempt }),
      launch: async () => unknownLaunch ? { status: "unknown" } : { status: "accepted", execution },
      reconcile: async () => { reconciled = true; return { status: "unknown" }; },
      cancel: async () => ({ status: "cancelled" }),
      inspectTerminal: async () => { inspections++; return { reached: false }; },
    },
    finalizer: {
      recordOutcome: async (_outcome, now) => ({ status: "recorded", completedAt: now }),
      applyApproval: async (input) => ({ status: "applied", effectId: input.attemptId }),
    },
    loadApprovalEvidence: async () => ({ currentPrHeadSha: "a".repeat(40), findingDispositions: [], policyAllows: true, dispositionsComplete: true }),
  });

  beforeAll(async () => { envs = await startVariants([workflow]); }, 180_000);
  afterAll(async () => { reportGate.release(); await stopAll(envs); });

  it("matches the committed journal at the reconcile, wait and inspect pause points", async () => {
    const env = envs.get("disableRetries");
    if (!env) throw new Error("missing Restate variant disableRetries");
    const commands = async (key: string): Promise<JournalCommand[]> => {
      const rows = await queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'ReviewFixAttempt' AND target_service_key = '${key}' AND target_handler_name = 'run'`);
      if (rows.length !== 1) return [];
      return (await journalEntries(env.adminAPIBaseUrl(), String(rows[0].id)))
        .filter((e) => String(e.entry_type).startsWith("Command: "))
        .map((e) => ({ type: String(e.entry_type).slice("Command: ".length), name: String(e.name ?? "") }));
    };
    const start = () => {
      const attemptId = randomUUID();
      prepared = { attemptId, owner: attemptId, scope: { installationId: 7, repository: "BuildDownAI/AI-Implement", prNumber: 42 },
        taskText: "Fix the reported findings", findings: [{ findingKey: "finding-1", version: 1 }], deadlineAt: Date.now() + 4 * 3_600_000 };
      void callWorkflow(env.baseUrl(), "ReviewFixAttempt", attemptId, "run", { attemptId }).catch(() => undefined);
      return attemptId;
    };
    const sleeping = (c: JournalCommand[]) => c.at(-1)?.type === "Sleep";
    try {
      const reconcileKey = start();
      const atReconcile = await eventually(() => commands(reconcileKey), (c) => reconciled && sleeping(c), { label: "unknown launch and reconcile sleep" });
      unknownLaunch = false;
      const key = start();
      const report = (async () => {
        await reportGate.wait();
        await callWorkflow(env.baseUrl(), "ReviewFixAttempt", key, "result", makeReviewFixResult({
          attemptId: key, ...prepared.scope, deadlineAt: prepared.deadlineAt, ...execution, outputCommit: "a".repeat(40),
        }));
      })();
      report.catch(() => undefined);
      const atWait = await eventually(() => commands(key), (c) => bound && inspections === 1 && sleeping(c), { label: "bound execution waiting with report gate held" });
      reportGate.release();
      await report;
      const atInspect = await eventually(() => commands(key), (c) => inspections >= 2 && c.length > atWait.length && sleeping(c), { label: "report received and terminal inspection false" });
      expect(atInspect.slice(0, atWait.length), "the inspect journal extends the wait journal").toEqual(atWait);
      const failures = [checkSnapshot("reconcile", atReconcile), checkSnapshot("wait", atWait), checkSnapshot("inspect", atInspect)].filter((m): m is string => m !== null);
      if (failures.length > 0) throw new Error(failures.join("\n\n"));
    } finally {
      reportGate.release();
    }
  }, 60_000);
});
