// Real Restate coverage for the SetupChecks object (AII-1538), on both variants.
//
// Run with `npm run test:restate`; excluded from `npm test`.
import * as restate from "@restatedev/restate-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSetupChecks } from "../../restate/setup-checks.js";
import { claimSetupCheckRun, endSetupCheckProgress, getCachedSetupCheckRun, getSetupCheckProgress, runSetupChecks, runSetupChecksWithProgress, SETUP_CHECKS, type SetupCheckRun, type SetupCheckScope } from "../../setup-checks/index.js";
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
let nextWideRun: () => Promise<SetupCheckRun> = async () => runAt(0);
let nextScope: (scope: SetupCheckScope) => Promise<SetupCheckRun | null> = async () => null;
let mapped = ["ENG", "OPS"];
let envs: Map<string, RestateEnvironment>;

beforeAll(async () => {
  envs = await startVariants([createSetupChecks({
    runChecks: () => nextRun(),
    runChecksQuietly: () => nextQuietRun(),
    runProjectChecks: (project) => nextProjectRun(project),
    runOrchestratorWideChecks: () => nextWideRun(),
    mappedProjects: () => mapped,
    runScope: (scope) => nextScope(scope),
  })]);
}, 60_000);

type Row = SetupCheckRun["results"][number];
const row = (overrides: Partial<Row>): Row => ({ id: "tracker.linear.team-access", title: "Linear team access", group: "tracker", tier: "core", onAdminPath: false, state: "pass", ...overrides });

afterAll(async () => {
  await stopAll(envs);
});

describe.each(VARIANTS.map(([label]) => label))("SetupChecks (%s)", (label) => {
  const env = () => envs.get(label)!;
  // Each scenario uses its own key, so one scenario's stored run never answers another's `get`.
  const call = <T>(key: string, handler: "run" | "get" | "runOrchestratorWide") => callObject<T>(env().baseUrl(), "SetupChecks", key, handler, undefined);
  const runProject = (key: string, project: string) => callObject<SetupCheckRun | null>(env().baseUrl(), "SetupChecks", key, "runProject", { project });
  const invocations = (key: string, handler: "run" | "get" | "runProject" | "runOrchestratorWide" | "recheck") =>
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
    expect(getCachedSetupCheckRun()).toEqual(run);
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
    expect(getCachedSetupCheckRun()).toEqual(run);
    expect(getSetupCheckProgress()).toBeNull();

    nextRun = async () => {
      await runSetupChecksWithProgress(makeSetupCheckContext());
      throw new restate.TerminalError("the run broke");
    };
    await expect(call<SetupCheckRun>("progress-failed", "run")).rejects.toThrow();
    expect(getSetupCheckProgress()).toBeNull();
  });

  it("merges one project's run into the stored run, keeps every other row, and journals the project's run", async () => {
    // A full run always holds github.app-identity's row, here in the state the project run finds it.
    nextRun = async () => ({ startedAt: 4000, checkedAt: 4001, results: [row({ id: "restate", group: "orchestrator" }), row({ id: "github.app-identity", group: "github" }), row({ project: "ENG", state: "fail" }), row({ project: "OPS", state: "fail" })] });
    await call<SetupCheckRun>("merge", "run");
    const projectRun: SetupCheckRun = {
      startedAt: 4100,
      checkedAt: 4101,
      results: [row({ id: "github.app-identity", group: "github" }), row({ project: "ENG" })],
      scope: { checks: ["github.app-identity", "tracker.linear.team-access"], projects: ["ENG"] },
    };
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
    expect(getCachedSetupCheckRun()).toEqual(expected);
    const rows = await invocations("merge", "runProject");
    expect(journaledRunResult(await journalEntries(env().adminAPIBaseUrl(), String(rows[0].id)), "run project checks")).toEqual(projectRun);
  });

  // An orchestrator-wide check's fault reaches every project that depends on it, whose stored rows only a full run can correct.
  it("answers a project run that finds an orchestrator-wide check failing with a full run, stored whole, and leaves a start's claim alone", async () => {
    nextRun = async () => ({ checkedAt: 4500, results: [row({ id: "tracker.provider" }), row({ project: "ENG" }), row({ project: "OPS" })] });
    await call<SetupCheckRun>("shared", "run");
    const full: SetupCheckRun = { startedAt: 4600, checkedAt: 4601, results: [row({ id: "tracker.provider", state: "fail" }), row({ project: "ENG", state: "cannot-verify" }), row({ project: "OPS", state: "cannot-verify" })] };
    let quiet = 0;
    nextQuietRun = async () => { quiet++; return full; };
    nextProjectRun = async () => ({ checkedAt: 4550, results: [row({ id: "tracker.provider", state: "fail" }), row({ project: "ENG", state: "cannot-verify" })], scope: { checks: ["tracker.linear.team-access"], projects: ["ENG"] } });
    expect(claimSetupCheckRun(() => 4599)).toBeNull();
    try {
      expect(await runProject("shared", "ENG")).toEqual(full);
      expect(quiet).toBe(1);
      expect(await call("shared", "get")).toEqual(full);
      expect(getCachedSetupCheckRun()).toEqual(full);
      expect(getSetupCheckProgress()?.startedAt).toBe(4599);
      const rows = await invocations("shared", "runProject");
      expect(journaledRunResult(await journalEntries(env().adminAPIBaseUrl(), String(rows[0].id)), "run checks")).toEqual(full);
    } finally {
      endSetupCheckProgress();
    }

    // The stored run already shows the fault on every project, so another project's run finding it merges as it is.
    nextProjectRun = async () => ({ checkedAt: 4650, results: [row({ id: "tracker.provider", state: "fail" }), row({ project: "OPS", state: "cannot-verify" })], scope: { checks: ["tracker.linear.team-access"], projects: ["OPS"] } });
    expect((await runProject("shared", "OPS"))!.results).toContainEqual(row({ project: "OPS", state: "cannot-verify", checkedAt: 4650 }));
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
    nextProjectRun = async () => { projectRunStarted = true; return { checkedAt: 6101, results: [row({ project: "ENG" })], scope: { checks: ["tracker.linear.team-access"], projects: ["ENG"] } }; };
    expect((await fetch(`${env().baseUrl()}/SetupChecks/behind/run/send`, { method: "POST" })).ok).toBe(true);
    await hold.reached();
    const merged = runProject("behind", "ENG");
    await settle(300);
    expect(projectRunStarted).toBe(false);
    hold.release();
    expect(await merged).toEqual({ checkedAt: 6001, results: [row({ project: "OPS", state: "warn" }), row({ project: "ENG", checkedAt: 6101 })] });
  });

  it("merges an orchestrator-wide run into the stored run, keeps every project's rows, and journals the run", async () => {
    nextRun = async () => ({ startedAt: 7000, checkedAt: 7001, results: [row({ id: "restate", group: "orchestrator", state: "fail" }), row({ project: "ENG", state: "fail" })] });
    await call<SetupCheckRun>("wide", "run");
    const wide: SetupCheckRun = { startedAt: 7100, checkedAt: 7101, results: [row({ id: "restate", group: "orchestrator" })], scope: { checks: ["restate"] } };
    nextWideRun = async () => wide;

    const expected = { startedAt: 7000, checkedAt: 7001, results: [row({ project: "ENG", state: "fail" }), row({ id: "restate", group: "orchestrator", checkedAt: 7101 })] };
    expect(await call("wide", "runOrchestratorWide")).toEqual(expected);
    expect(await call("wide", "get")).toEqual(expected);
    expect(getCachedSetupCheckRun()).toEqual(expected);
    const rows = await invocations("wide", "runOrchestratorWide");
    expect(journaledRunResult(await journalEntries(env().adminAPIBaseUrl(), String(rows[0].id)), "run orchestrator-wide checks")).toEqual(wide);
  });

  // Every project's rows wait on github.app-identity, so its change reaches projects a partial run did not read, whose stored rows only a full run can correct.
  describe("a shared check every project's rows wait on", () => {
    const appIdentity = (state: Row["state"]) => row({ id: "github.app-identity", group: "github", state });
    const waiting = (project: string) => row({ project, state: "cannot-verify", waitsOnCheck: "github.app-identity" });
    const recheck = (key: string) => callObject<SetupCheckRun | null>(env().baseUrl(), "SetupChecks", key, "recheck", { id: "github.app-identity" });

    it.each([
      ["an orchestrator-wide run", "shared-fails-wide", (key: string) => call<SetupCheckRun>(key, "runOrchestratorWide")],
      ["a recheck of it", "shared-fails-recheck", recheck],
    ] as const)("answers %s that finds it failing with a full run, stored whole", async (_case, key, start) => {
      nextRun = async () => ({ checkedAt: 7300, results: [appIdentity("pass"), row({ project: "ENG" }), row({ project: "OPS" })] });
      await call<SetupCheckRun>(key, "run");
      const failing: SetupCheckRun = { checkedAt: 7350, results: [appIdentity("fail")], scope: { checks: ["github.app-identity"] } };
      nextWideRun = async () => failing;
      nextScope = async () => failing;
      const full: SetupCheckRun = { checkedAt: 7401, results: [appIdentity("fail"), waiting("ENG"), waiting("OPS")] };
      let quiet = 0;
      nextQuietRun = async () => { quiet++; return full; };

      expect(await start(key)).toEqual(full);
      expect(quiet).toBe(1);
      expect(await call(key, "get")).toEqual(full);
    });

    it("answers a project run that finds it passing again with a full run, so no project's rows wait on a fault that has cleared", async () => {
      nextRun = async () => ({ checkedAt: 7450, results: [appIdentity("fail"), waiting("ENG"), waiting("OPS")] });
      await call<SetupCheckRun>("shared-recovers", "run");
      nextProjectRun = async () => ({ checkedAt: 7460, results: [appIdentity("pass"), row({ project: "ENG" })], scope: { checks: ["github.app-identity", "tracker.linear.team-access"], projects: ["ENG"] } });
      const full: SetupCheckRun = { checkedAt: 7471, results: [appIdentity("pass"), row({ project: "ENG" }), row({ project: "OPS" })] };
      let quiet = 0;
      nextQuietRun = async () => { quiet++; return full; };

      expect(await runProject("shared-recovers", "ENG")).toEqual(full);
      expect(quiet).toBe(1);
    });

    // A check no project's rows wait on reaches no project's rows, so its change merges as it is.
    it("merges an orchestrator-wide run whose only change is to a check no project waits on", async () => {
      nextRun = async () => ({ checkedAt: 7480, results: [appIdentity("pass"), row({ id: "restate", group: "orchestrator" }), row({ project: "ENG" })] });
      await call<SetupCheckRun>("unshared-change", "run");
      nextWideRun = async () => ({ checkedAt: 7490, results: [appIdentity("pass"), row({ id: "restate", group: "orchestrator", state: "fail" })], scope: { checks: ["github.app-identity", "restate"] } });
      let quiet = 0;
      nextQuietRun = async () => { quiet++; return runAt(0); };

      const merged = await call<SetupCheckRun>("unshared-change", "runOrchestratorWide");
      expect(quiet).toBe(0);
      expect(merged.results).toContainEqual(row({ id: "restate", group: "orchestrator", state: "fail", checkedAt: 7490 }));
      expect(merged.results).toContainEqual(row({ project: "ENG" }));
    });
  });

  // The project list is read in a step, so a retried merge drops the same projects the first attempt saw.
  it("drops a deleted project's rows when it next merges a run, and journals the project list it read", async () => {
    nextRun = async () => ({ checkedAt: 7501, results: [row({ project: "ENG" }), row({ project: "GONE", state: "fail" })] });
    await call<SetupCheckRun>("deleted", "run");
    nextWideRun = async () => ({ checkedAt: 7601, results: [], scope: { checks: ["restate"] } });
    mapped = ["ENG"];
    try {
      expect(await call("deleted", "runOrchestratorWide")).toEqual({ checkedAt: 7501, results: [row({ project: "ENG" })] });
      const rows = await invocations("deleted", "runOrchestratorWide");
      expect(journaledRunResult(await journalEntries(env().adminAPIBaseUrl(), String(rows[0].id)), "mapped projects")).toEqual(["ENG"]);
    } finally {
      mapped = ["ENG", "OPS"];
    }
  });

  // With nothing stored, a partial run would stand for every check, so every check runs instead and is stored whole.
  it.each([
    ["an orchestrator-wide run", "empty-wide", (key: string) => call<SetupCheckRun>(key, "runOrchestratorWide")],
    ["a project run", "empty-project", (key: string) => runProject(key, "ENG")],
  ] as const)("answers %s with a full run, stored whole, when nothing is stored", async (_case, key, start) => {
    const full: SetupCheckRun = { startedAt: 7700, checkedAt: 7701, results: [row({ id: "restate", group: "orchestrator" }), row({ project: "ENG" }), row({ project: "OPS", state: "fail" })] };
    let quiet = 0;
    nextQuietRun = async () => { quiet++; return full; };
    nextWideRun = async () => ({ checkedAt: 7650, results: [row({ id: "restate", group: "orchestrator" })], scope: { checks: ["restate"] } });
    nextProjectRun = async () => ({ checkedAt: 7650, results: [row({ project: "ENG" })], scope: { checks: ["tracker.linear.team-access"], projects: ["ENG"] } });
    expect(await start(key)).toEqual(full);
    expect(quiet).toBe(1);
    expect(await call(key, "get")).toEqual(full);
  });

  // A stored run from a check list declared otherwise has no rows for a check it lacked, and copies the old declaration into the rest.
  it.each([
    ["an orchestrator-wide run", "relisted-wide", (key: string) => call<SetupCheckRun>(key, "runOrchestratorWide")],
    ["a project run", "relisted-project", (key: string) => runProject(key, "ENG")],
    ["a recheck", "relisted-recheck", (key: string) => callObject<SetupCheckRun | null>(env().baseUrl(), "SetupChecks", key, "recheck", { id: "restate" })],
  ] as const)("answers %s with a full run, stored whole, when the stored run came from a check list declared otherwise", async (_case, key, start) => {
    nextRun = async () => ({ checkedAt: 7660, results: [row({ id: "restate", group: "orchestrator" }), row({ project: "ENG" })], checkListFingerprint: "before" });
    await call<SetupCheckRun>(key, "run");
    const partial = (results: Row[], scope: SetupCheckScope): SetupCheckRun => ({ checkedAt: 7670, results, scope, checkListFingerprint: "after" });
    nextWideRun = async () => partial([row({ id: "restate", group: "orchestrator" })], { checks: ["restate"] });
    nextProjectRun = async () => partial([row({ project: "ENG" })], { checks: ["tracker.linear.team-access"], projects: ["ENG"] });
    nextScope = async () => partial([row({ id: "restate", group: "orchestrator" })], { checks: ["restate"] });
    const full: SetupCheckRun = { checkedAt: 7681, results: [row({ id: "restate", group: "orchestrator" }), row({ project: "ENG" }), row({ project: "OPS" })], checkListFingerprint: "after" };
    let quiet = 0;
    nextQuietRun = async () => { quiet++; return full; };
    expect(await start(key)).toEqual(full);
    expect(quiet).toBe(1);
    expect(await call(key, "get")).toEqual(full);
  });

  // The project run's own escalation is already a full run, which nothing stored needs no second one for.
  it("runs every check once for a project run that finds a shared fault when nothing is stored", async () => {
    const full: SetupCheckRun = { checkedAt: 7801, results: [row({ id: "tracker.provider", state: "fail" }), row({ project: "ENG", state: "cannot-verify" })] };
    let quiet = 0;
    nextQuietRun = async () => { quiet++; return full; };
    nextProjectRun = async () => ({ checkedAt: 7750, results: [row({ id: "tracker.provider", state: "fail" }), row({ project: "ENG", state: "cannot-verify" })], scope: { checks: ["tracker.linear.team-access"], projects: ["ENG"] } });
    expect(await runProject("empty-escalated", "ENG")).toEqual(full);
    expect(quiet).toBe(1);
  });

  describe("recheck", () => {
    const recheck = (key: string, request: { id: string; project?: string; cause?: string }) =>
      callObject<SetupCheckRun | null>(env().baseUrl(), "SetupChecks", key, "recheck", request);
    // Records each scope asked for as its check and project, and answers the canned run for its check.
    function answering(answers: Record<string, SetupCheckRun>) {
      const asked: Array<[string, string | undefined]> = [];
      nextScope = async (scope) => { asked.push([scope.checks[0], scope.projects?.[0]]); return answers[scope.checks[0]] ?? null; };
      return asked;
    }

    it("re-runs one check for one project, replaces only that row with the cause beside it, and journals the run", async () => {
      nextRun = async () => ({ checkedAt: 8001, results: [row({ project: "ENG" }), row({ project: "OPS" })] });
      await call<SetupCheckRun>("recheck-one", "run");
      const answer: SetupCheckRun = { checkedAt: 8101, results: [row({ project: "ENG", state: "fail" })], scope: { checks: ["tracker.linear.team-access"], projects: ["ENG"] } };
      const asked = answering({ "tracker.linear.team-access": answer });

      const expected = { checkedAt: 8001, results: [row({ project: "OPS" }), row({ project: "ENG", state: "fail", checkedAt: 8101, cause: "dispatch-404" })] };
      expect(await recheck("recheck-one", { id: "tracker.linear.team-access", project: "ENG", cause: "dispatch-404" })).toEqual(expected);
      expect(asked).toEqual([["tracker.linear.team-access", "ENG"]]);
      expect(await call("recheck-one", "get")).toEqual(expected);
      const rows = await invocations("recheck-one", "recheck");
      expect(journaledRunResult(await journalEntries(env().adminAPIBaseUrl(), String(rows[0].id)), "recheck")).toEqual(answer);
    });

    // A failure path can send a recheck on every poll, so the hour bounds how often its check runs, whatever the check answered.
    it("does nothing for the same rows within the hour after a recheck, even when the check passed", async () => {
      const asked = answering({ "github.app-identity": { checkedAt: 8201, results: [row({ id: "github.app-identity", group: "github" })], scope: { checks: ["github.app-identity"] } } });
      expect(await recheck("recheck-held", { id: "github.app-identity" })).not.toBeNull();
      expect(await recheck("recheck-held", { id: "github.app-identity", cause: "dispatch-404" })).toBeNull();
      expect(asked).toHaveLength(1);
    });

    it("does nothing while every stored row of the check already needs attention and was checked within the hour", async () => {
      nextRun = async () => ({ checkedAt: Date.now(), results: [row({ project: "ENG", state: "fail" })] });
      await call<SetupCheckRun>("recheck-failing", "run");
      const asked = answering({});
      expect(await recheck("recheck-failing", { id: "tracker.linear.team-access", project: "ENG" })).toBeNull();
      expect(asked).toEqual([]);
    });

    it("re-runs each check the rechecked rows wait on, so none waits on an older row", async () => {
      // github.app-identity already fails in the stored run, so its recheck merges rather than escalating to a full run.
      nextRun = async () => ({ checkedAt: 8300, results: [row({ project: "ENG" }), row({ id: "github.app-identity", group: "github", state: "fail" })] });
      await call<SetupCheckRun>("recheck-waits", "run");
      const waiting = row({ project: "ENG", state: "cannot-verify", waitsOnCheck: "github.app-identity" });
      const asked = answering({
        "tracker.linear.team-access": { checkedAt: 8301, results: [waiting], scope: { checks: ["tracker.linear.team-access"], projects: ["ENG"] } },
        "github.app-identity": { checkedAt: 8302, results: [row({ id: "github.app-identity", group: "github", state: "fail" })], scope: { checks: ["github.app-identity"] } },
      });
      const merged = await recheck("recheck-waits", { id: "tracker.linear.team-access", project: "ENG" });
      // The waited-on check is orchestrator-wide, so it runs for no project.
      expect(asked).toEqual([["tracker.linear.team-access", "ENG"], ["github.app-identity", undefined]]);
      expect(merged!.results.map((answered) => [answered.id, answered.state])).toEqual([["tracker.linear.team-access", "cannot-verify"], ["github.app-identity", "fail"]]);
    });

    // Every project's rows of a per-project check can wait on one orchestrator-wide check, so the hour holds the check they wait on too.
    it("re-runs a check several projects' rows wait on once within the hour", async () => {
      const asked: Array<[string, string | undefined]> = [];
      nextScope = async (scope) => {
        asked.push([scope.checks[0], scope.projects?.[0]]);
        return scope.checks[0] === "github.app-identity"
          ? { checkedAt: 8352, results: [row({ id: "github.app-identity", group: "github", state: "fail" })], scope }
          : { checkedAt: 8351, results: [row({ project: scope.projects![0], state: "cannot-verify", waitsOnCheck: "github.app-identity" })], scope };
      };
      await recheck("recheck-shared", { id: "tracker.linear.team-access", project: "ENG" });
      await recheck("recheck-shared", { id: "tracker.linear.team-access", project: "OPS" });
      expect(asked).toEqual([["tracker.linear.team-access", "ENG"], ["github.app-identity", undefined], ["tracker.linear.team-access", "OPS"]]);
    });

    // Exclusivity is per key across every exclusive handler, so a recheck never merges into a run another handler is about to replace.
    it("waits behind a full run in progress, then merges into the run it stored", async () => {
      const hold = gate("full run before a recheck");
      nextRun = async () => {
        await hold.wait();
        return { checkedAt: 8401, results: [row({ project: "ENG" }), row({ project: "OPS", state: "warn" })] };
      };
      let started = false;
      nextScope = async () => { started = true; return { checkedAt: 8501, results: [row({ project: "ENG", state: "fail" })], scope: { checks: ["tracker.linear.team-access"], projects: ["ENG"] } }; };
      expect((await fetch(`${env().baseUrl()}/SetupChecks/recheck-behind/run/send`, { method: "POST" })).ok).toBe(true);
      await hold.reached();
      const merged = recheck("recheck-behind", { id: "tracker.linear.team-access", project: "ENG" });
      await settle(300);
      expect(started).toBe(false);
      hold.release();
      expect(await merged).toEqual({ checkedAt: 8401, results: [row({ project: "OPS", state: "warn" }), row({ project: "ENG", state: "fail", checkedAt: 8501 })] });
    });

    it("answers a recheck with a full run, stored whole, when nothing is stored", async () => {
      const full: SetupCheckRun = { checkedAt: 8601, results: [row({ project: "ENG" }), row({ project: "OPS", state: "fail" })] };
      nextQuietRun = async () => full;
      answering({ "tracker.linear.team-access": { checkedAt: 8600, results: [row({ project: "ENG", state: "fail" })], scope: { checks: ["tracker.linear.team-access"], projects: ["ENG"] } } });
      expect(await recheck("recheck-empty", { id: "tracker.linear.team-access", project: "ENG" })).toEqual(full);
      expect(await call("recheck-empty", "get")).toEqual(full);
    });

    // The hold is dated by the journaled clock, so a retry that resumes past the hour's edge takes the branch the first attempt took.
    it("dates its hold by a journaled clock read", async () => {
      answering({ "github.app-identity": { checkedAt: 8701, results: [row({ id: "github.app-identity", group: "github" })], scope: { checks: ["github.app-identity"] } } });
      const before = Date.now();
      await recheck("recheck-clock", { id: "github.app-identity" });
      const rows = await invocations("recheck-clock", "recheck");
      const entries = (await journalEntries(env().adminAPIBaseUrl(), String(rows[0].id))).map((e) => JSON.parse(String(e.entry_json ?? "null")) as Record<string, any> | null);
      const unnamed = entries.find((e) => e?.Command?.Run && !e.Command.Run.name);
      expect(unnamed).toBeDefined();
      const done = entries.find((e) => e?.Notification?.Completion?.Run?.completion_id === unnamed!.Command.Run.completion_id);
      const read = JSON.parse(Buffer.from(done!.Notification.Completion.Run.result.Success as number[]).toString("utf8")) as number;
      expect(read).toBeGreaterThanOrEqual(before);
      expect(read).toBeLessThanOrEqual(Date.now());
    });

    it("answers null for a check not on the list, and runs nothing", async () => {
      const asked = answering({});
      expect(await recheck("recheck-unknown", { id: "no.such-check" })).toBeNull();
      expect(asked).toEqual([]);
    });
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
