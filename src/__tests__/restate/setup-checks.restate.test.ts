// Real Restate coverage for the SetupChecks object (AII-1538), on both variants.
//
// Run with `npm run test:restate`; excluded from `npm test`.
import * as restate from "@restatedev/restate-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSetupChecks } from "../../restate/setup-checks.js";
import { claimSetupCheckRun, endSetupCheckProgress, getLastSetupCheckRun, getSetupCheckProgress, runSetupChecks, runSetupChecksWithProgress, SETUP_CHECKS, type SetupCheckRun } from "../../setup-checks/index.js";
import { makeSentinelSetupCheckContext, makeSetupCheckContext } from "../helpers/fixtures/setup-checks.js";
import type { RestateEnvironment } from "./harness.js";
import { VARIANTS, callObject, eventually, gate, journalEntries, journalText, journaledRunResult, queryInvocations, settle, startVariants, stopAll } from "./harness.js";

const runAt = (checkedAt: number): SetupCheckRun => ({
  checkedAt,
  results: [{ id: "restate", title: "Restate engine", group: "orchestrator", tier: "core", onAdminPath: false, state: "pass", detail: "Restate is ready" }],
});

let nextRun: () => Promise<SetupCheckRun> = async () => runAt(0);
let nextQuietRun: () => Promise<SetupCheckRun> = async () => runAt(0);
let nextProjectRun: (project: string) => Promise<SetupCheckRun | null> = async () => null;
let envs: Map<string, RestateEnvironment>;

beforeAll(async () => {
  envs = await startVariants([createSetupChecks({ runChecks: () => nextRun(), runChecksQuietly: () => nextQuietRun(), runProjectChecks: (project) => nextProjectRun(project) })]);
}, 60_000);

type Row = SetupCheckRun["results"][number];
const row = (overrides: Partial<Row>): Row => ({ id: "tracker.linear.team-access", title: "Linear team access", group: "tracker", tier: "core", onAdminPath: false, state: "pass", ...overrides });

afterAll(async () => {
  await stopAll(envs);
});

describe.each(VARIANTS.map(([label]) => label))("SetupChecks (%s)", (label) => {
  const env = () => envs.get(label)!;
  // Each scenario uses its own key, so one scenario's stored run never answers another's `get`.
  const call = <T>(key: string, handler: "run" | "get") => callObject<T>(env().baseUrl(), "SetupChecks", key, handler, undefined);
  const runProject = (key: string, project: string) => callObject<SetupCheckRun | null>(env().baseUrl(), "SetupChecks", key, "runProject", { project });
  const invocations = (key: string, handler: "run" | "get" | "runProject") =>
    eventually(
      () => queryInvocations(env().adminAPIBaseUrl(), `target_service_name = 'SetupChecks' AND target_service_key = '${key}' AND target_handler_name = '${handler}'`),
      (rows) => rows.length > 0,
      { label: `${key} ${handler} invocation` },
    );

  it("answers null before the first run", async () => {
    expect(await call("never-run", "get")).toBeNull();
  });

  it("runs the checks once, journals the run, and keeps it for get", async () => {
    let calls = 0;
    const checkedAt = Date.now();
    nextRun = async () => runAt(checkedAt + ++calls);
    const run = await call<SetupCheckRun>("once", "run");

    expect(run).toEqual(runAt(checkedAt + 1));
    expect(getLastSetupCheckRun()).toEqual(run);
    expect(calls).toBe(1);
    expect(await call("once", "get")).toEqual(runAt(checkedAt + 1));
    const rows = await invocations("once", "run");
    expect(journaledRunResult(await journalEntries(env().adminAPIBaseUrl(), String(rows[0].id)), "run checks")).toEqual(runAt(checkedAt + 1));
  });

  it("never runs two check runs at once, and keeps the later one", async () => {
    const hold = gate("first run");
    let running = 0;
    let max = 0;
    let calls = 0;
    nextRun = async () => {
      const n = ++calls;
      running++;
      max = Math.max(max, running);
      if (n === 1) await hold.wait();
      running--;
      return runAt(2000 + n);
    };
    const send = () => fetch(`${env().baseUrl()}/SetupChecks/queued/run/send`, { method: "POST" });
    expect((await send()).ok).toBe(true);
    await hold.reached();
    expect((await send()).ok).toBe(true);
    await settle(300);
    expect(calls).toBe(1);
    hold.release();
    await eventually(async () => calls, (n) => n === 2, { label: "both runs ran" });
    expect(max).toBe(1);
    expect(await eventually(() => call<SetupCheckRun | null>("queued", "get"), (stored) => stored?.checkedAt === 2002, { label: "the later run stored" })).toEqual(runAt(2002));
  });

  it("clears the run's progress only once the run is stored, and when the run fails", async () => {
    let progressWhileStoring: unknown = "unread";
    nextRun = async () => {
      const run = await runSetupChecksWithProgress(makeSetupCheckContext(), () => 3000);
      progressWhileStoring = getSetupCheckProgress()?.startedAt;
      return run;
    };
    const run = await call<SetupCheckRun>("progress", "run");
    expect(progressWhileStoring).toBe(3000);
    expect(getLastSetupCheckRun()).toEqual(run);
    expect(getSetupCheckProgress()).toBeNull();

    nextRun = async () => {
      await runSetupChecksWithProgress(makeSetupCheckContext());
      throw new restate.TerminalError("the run broke");
    };
    await expect(call<SetupCheckRun>("progress-failed", "run")).rejects.toThrow();
    expect(getSetupCheckProgress()).toBeNull();
  });

  it("merges one project's run into the stored run, keeps every other row, and journals the project's run", async () => {
    nextRun = async () => ({ startedAt: 4000, checkedAt: 4001, results: [row({ id: "restate", group: "orchestrator" }), row({ project: "ENG", state: "fail" }), row({ project: "OPS", state: "fail" })] });
    await call<SetupCheckRun>("merge", "run");
    const projectRun: SetupCheckRun = { startedAt: 4100, checkedAt: 4101, results: [row({ id: "github.app-identity", group: "github" }), row({ project: "ENG" })] };
    const asked: string[] = [];
    nextProjectRun = async (project) => { asked.push(project); return projectRun; };

    const merged = await runProject("merge", "ENG");
    const expected = {
      startedAt: 4000,
      checkedAt: 4001,
      results: [row({ id: "restate", group: "orchestrator" }), row({ project: "OPS", state: "fail" }), row({ id: "github.app-identity", group: "github", checkedAt: 4101 }), row({ project: "ENG", checkedAt: 4101 })],
    };
    expect(merged).toEqual(expected);
    expect(asked).toEqual(["ENG"]);
    expect(await call("merge", "get")).toEqual(expected);
    expect(getLastSetupCheckRun()).toEqual(expected);
    const rows = await invocations("merge", "runProject");
    expect(journaledRunResult(await journalEntries(env().adminAPIBaseUrl(), String(rows[0].id)), "run project checks")).toEqual(projectRun);
  });

  // A shared check's fault reaches every project on it, whose stored rows only a full run can correct.
  it("answers a project run that finds a shared check failing with a full run, stored whole, and leaves a start's claim alone", async () => {
    nextRun = async () => ({ checkedAt: 4500, results: [row({ id: "tracker.provider" }), row({ project: "ENG" }), row({ project: "OPS" })] });
    await call<SetupCheckRun>("shared", "run");
    const full: SetupCheckRun = { startedAt: 4600, checkedAt: 4601, results: [row({ id: "tracker.provider", state: "fail" }), row({ project: "ENG", state: "cannot-verify" }), row({ project: "OPS", state: "cannot-verify" })] };
    let quiet = 0;
    nextQuietRun = async () => { quiet++; return full; };
    nextProjectRun = async () => ({ checkedAt: 4550, results: [row({ id: "tracker.provider", state: "fail" }), row({ project: "ENG", state: "cannot-verify" })] });
    expect(claimSetupCheckRun(() => 4599)).toBeNull();
    try {
      expect(await runProject("shared", "ENG")).toEqual(full);
      expect(quiet).toBe(1);
      expect(await call("shared", "get")).toEqual(full);
      expect(getLastSetupCheckRun()).toEqual(full);
      expect(getSetupCheckProgress()?.startedAt).toBe(4599);
      const rows = await invocations("shared", "runProject");
      expect(journaledRunResult(await journalEntries(env().adminAPIBaseUrl(), String(rows[0].id)), "run checks")).toEqual(full);
    } finally {
      endSetupCheckProgress();
    }

    nextProjectRun = async () => ({ checkedAt: 4700, results: [row({ id: "tracker.provider" }), row({ project: "ENG" })] });
    await runProject("shared", "ENG");
    expect(quiet).toBe(1);
  });

  it("answers null and leaves the stored run as it was for a project no mapping has", async () => {
    nextRun = async () => runAt(5000);
    await call<SetupCheckRun>("gone", "run");
    nextProjectRun = async () => null;
    expect(await runProject("gone", "GONE")).toBeNull();
    expect(await call("gone", "get")).toEqual(runAt(5000));
  });

  it("waits behind a full run in progress, then merges into the run it stored", async () => {
    const hold = gate("full run");
    nextRun = async () => {
      await hold.wait();
      return { checkedAt: 6001, results: [row({ project: "ENG", state: "fail" }), row({ project: "OPS", state: "warn" })] };
    };
    let projectRunStarted = false;
    nextProjectRun = async () => { projectRunStarted = true; return { checkedAt: 6101, results: [row({ project: "ENG" })] }; };
    expect((await fetch(`${env().baseUrl()}/SetupChecks/behind/run/send`, { method: "POST" })).ok).toBe(true);
    await hold.reached();
    const merged = runProject("behind", "ENG");
    await settle(300);
    expect(projectRunStarted).toBe(false);
    hold.release();
    expect(await merged).toEqual({ checkedAt: 6001, results: [row({ project: "OPS", state: "warn" }), row({ project: "ENG", checkedAt: 6101 })] });
  });

  it("keeps no secret's value in its state or its journal", async () => {
    nextRun = () => runSetupChecks(makeSentinelSetupCheckContext());
    const run = await call<SetupCheckRun>("sentinel", "run");
    const stored = await call<SetupCheckRun>("sentinel", "get");

    // Every check answers but those that depend on a Jira or Filesystem project, which the context's one Linear project leaves out.
    const answering = SETUP_CHECKS.filter((check) => (!check.id.startsWith("tracker.jira.") || check.id === "tracker.jira.credentials") && check.id !== "tracker.filesystem.directory");
    expect(new Set(run.results.map((result) => result.id)).size).toBe(answering.length);
    expect(JSON.stringify(stored)).not.toContain("sentinel-");
    for (const handler of ["run", "get"] as const) {
      const rows = await invocations("sentinel", handler);
      for (const row of rows) expect(journalText(await journalEntries(env().adminAPIBaseUrl(), String(row.id)))).not.toContain("sentinel-");
    }
  });
});
