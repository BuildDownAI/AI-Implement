// Real Restate coverage for the SetupChecks object (AII-1538), on both variants.
//
// Run with `npm run test:restate`; excluded from `npm test`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSetupChecks } from "../../restate/setup-checks.js";
import { getLastSetupCheckRun, runSetupChecks, SETUP_CHECKS, type SetupCheckRun } from "../../setup-checks/index.js";
import { makeSentinelSetupCheckContext } from "../helpers/fixtures/setup-checks.js";
import type { RestateEnvironment } from "./harness.js";
import { VARIANTS, callObject, eventually, gate, journalEntries, journalText, journaledRunResult, queryInvocations, settle, startVariants, stopAll } from "./harness.js";

const runAt = (checkedAt: number): SetupCheckRun => ({
  checkedAt,
  results: [{ id: "restate", title: "Restate engine", group: "orchestrator", tier: "core", onAdminPath: false, state: "pass", detail: "Restate is ready" }],
});

let nextRun: () => Promise<SetupCheckRun> = async () => runAt(0);
let envs: Map<string, RestateEnvironment>;

beforeAll(async () => {
  envs = await startVariants([createSetupChecks({ runChecks: () => nextRun() })]);
}, 60_000);

afterAll(async () => {
  await stopAll(envs);
});

describe.each(VARIANTS.map(([label]) => label))("SetupChecks (%s)", (label) => {
  const env = () => envs.get(label)!;
  // Each scenario uses its own key, so one scenario's stored run never answers another's `get`.
  const call = <T>(key: string, handler: "run" | "get") => callObject<T>(env().baseUrl(), "SetupChecks", key, handler, undefined);
  const invocations = (key: string, handler: "run" | "get") =>
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

  it("keeps no secret's value in its state or its journal", async () => {
    nextRun = () => runSetupChecks(makeSentinelSetupCheckContext());
    const run = await call<SetupCheckRun>("sentinel", "run");
    const stored = await call<SetupCheckRun>("sentinel", "get");

    expect(new Set(run.results.map((result) => result.id)).size).toBe(SETUP_CHECKS.length);
    expect(JSON.stringify(stored)).not.toContain("sentinel-");
    for (const handler of ["run", "get"] as const) {
      const rows = await invocations("sentinel", handler);
      for (const row of rows) expect(journalText(await journalEntries(env().adminAPIBaseUrl(), String(row.id)))).not.toContain("sentinel-");
    }
  });
});
