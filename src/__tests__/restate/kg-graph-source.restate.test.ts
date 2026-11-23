// set_kg_graph_source (AII-1974) against the real Restate binary: the journaled test step,
// the save and the restart each run once per switch, and a test step that fails twice and
// passes on the third try still switches. The Stardog client and the sidecar are recording
// fakes, so the fake decides when a try passes — no wall clock and no fixed sleep decides.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  orchestratorTools,
  setKgGraphSourceToolDeps,
  setKgRefreshToolDeps,
  type KgGraphSourceToolDeps,
  STARDOG_TEST_MAX_RETRY_DURATION_MS,
} from "../../restate/tools.js";
import { createKgRepo, type KgRepoTriggerResult } from "../../restate/kg-repo.js";
import {
  setObjectStates, VARIANTS, callService, journaledRunResult, journalEntries, journalText,
  awaitSentInvocations, callObject, cancelInvocationIfLive, eventually, gate, queryInvocations, startRetryEnabled, startVariants, stopAll,
} from "./harness.js";
import type { RestateEnvironment } from "./harness.js";
import { KG_GRAPH_SOURCE_SETTING_KEY, setKgGraphSource, setStardogValues, type KgGraphSource } from "../../kg-graph-source.js";
import { getDb } from "../../dedup.js";
import { initSettingsTable } from "../../runner-mode.js";
import * as restate from "@restatedev/restate-sdk";

interface ToolResult {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}

const REPO_KEY = "org/kg";
const FIXED_SWITCH_REPO_KEY = "kg-graph-source-switch";
const FAKE_REFRESH_NAME = "KgGraphSourceRefresh";
const ADMIN = { kind: "system", email: null, role: "admin" } as const;
const USER = { kind: "human", email: "user@example.com", role: "user", grants: [] } as const;

const refreshRuns: string[] = [];
const fakeKgRefresh = restate.object({
  name: FAKE_REFRESH_NAME,
  handlers: {
    run: async (ctx: restate.ObjectContext, input: { triggerId: string }): Promise<void> => {
      refreshRuns.push(input.triggerId);
      await ctx.sleep(24 * 60 * 60 * 1000);
    },
  },
});

interface Fixture {
  source: KgGraphSource;
  /** Each call consumes one entry; the last repeats. `"pass"` returns the count, `"fail"` throws. */
  tries: Array<"pass" | "fail">;
  calls: number;
  restarts: number;
  saves: string[];
  logs: string[];
  sidecarPresent: boolean;
}

let fixture: Fixture;

function kgGraphSourceDeps(overrides: Partial<KgGraphSourceToolDeps> = {}): KgGraphSourceToolDeps {
  return {
    countTriples: async () => {
      const outcome = fixture.tries[fixture.calls] ?? fixture.tries[fixture.tries.length - 1];
      fixture.calls += 1;
      if (outcome === "fail") throw new Error("Stardog Run count query answered HTTP 503");
      return 42;
    },
    saveGraphSource: (source: KgGraphSource) => {
      fixture.saves.push(source);
      fixture.source = source;
      setKgGraphSource(source);
    },
    restartSidecar: async () => {
      fixture.restarts += 1;
      if (!fixture.sidecarPresent) throw new Error("sidecar did not start");
    },
    sidecarGraphPresent: () => fixture.sidecarPresent,
    effectiveSource: () => fixture.source,
    testPauseMs: 50,
    testMaxRetryDurationMs: 400,
    log: (from: KgGraphSource, to: KgGraphSource, ok: boolean) => fixture.logs.push(`[kg] graph source ${from} -> ${to}: ${ok ? "ok" : "failed"}`),
    ...overrides,
  };
}

function bindFixture(): void {
  setKgGraphSourceToolDeps(kgGraphSourceDeps());
}

function bindRefreshDeps(): void {
  setKgRefreshToolDeps({
    kgSourceRepo: REPO_KEY,
    isDeployHeld: () => false,
    callbackConfigured: () => true,
    mappingExists: () => true,
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    runPreflight: async () => ({ ok: true, checkedAt: 0, results: [] }),
    persistPreflightFailure: () => {},
    readStatusRecord: () => null,
    readServedStamp: async () => null,
  });
}

function newFixture(overrides: Partial<Fixture> = {}): Fixture {
  return { source: "sidecar", tries: ["pass"], calls: 0, restarts: 0, saves: [], logs: [], sidecarPresent: true, ...overrides };
}

function resetStoredValues(source: KgGraphSource = "sidecar"): void {
  getDb().prepare("DELETE FROM settings WHERE key IN (?, 'kg_stardog_db', 'kg_namespace')").run(KG_GRAPH_SOURCE_SETTING_KEY);
  if (source === "stardog_run") setKgGraphSource("stardog_run");
  setStardogValues({ db: "builddown-kg", namespace: "https://kg.example/", token: "test-run-token" });
}

async function switchSource(env: RestateEnvironment, source: "sidecar" | "stardog_run", headers?: Record<string, string>): Promise<ToolResult> {
  return callService<ToolResult>(env.baseUrl(), "orchestratorTools", "set_kg_graph_source", { caller: ADMIN, args: { source } }, headers);
}

async function triggerRefresh(env: RestateEnvironment): Promise<KgRepoTriggerResult> {
  return callObject<KgRepoTriggerResult>(env.baseUrl(), "KgRepo", REPO_KEY, "trigger", {});
}

/** An admitted trigger is exactly `{ triggerId }`; a refusal carries `status` as well. */
function refreshAdmitted(result: KgRepoTriggerResult): boolean {
  return !("status" in result);
}

function expectRefreshAdmitted(result: KgRepoTriggerResult): void {
  expect(result).toEqual({ triggerId: expect.any(String) });
}

function resultBody(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content![0]!.text) as Record<string, unknown>;
}

describe("set_kg_graph_source (Restate)", () => {
  let environments: Map<string, RestateEnvironment>;
  let retryEnv: RestateEnvironment;
  const originalSecret = process.env.RUNNER_TOKEN_SECRET;

  beforeAll(async () => {
    getDb();
    initSettingsTable();
    process.env.RUNNER_TOKEN_SECRET = "kg-graph-source-restate-test-key";
    bindRefreshDeps();
    bindFixture();
    const services = [orchestratorTools, createKgRepo({ workflowName: FAKE_REFRESH_NAME }), fakeKgRefresh];
    [environments, retryEnv] = await Promise.all([
      startVariants(services),
      startRetryEnabled(services, { variant: "alwaysReplay", storage: "memory" }),
    ]);
  }, 60_000);

  beforeEach(() => {
    fixture = newFixture();
    resetStoredValues();
  });

  afterEach(async () => {
    for (const env of [...environments.values(), retryEnv]) {
      await setObjectStates(env.adminAPIBaseUrl(), "KgRepo", REPO_KEY, { inFlight: null, held: null }).catch(() => undefined);
    }
    bindRefreshDeps();
    bindFixture();
  });

  afterAll(async () => {
    setKgRefreshToolDeps(null);
    setKgGraphSourceToolDeps(null);
    if (originalSecret === undefined) delete process.env.RUNNER_TOKEN_SECRET;
    else process.env.RUNNER_TOKEN_SECRET = originalSecret;
    await Promise.all([stopAll(environments), retryEnv?.stop()]);
  });

  it.each(VARIANTS.map(([label]) => label))("a passing test query saves stardog_run and restarts once (%s)", async (label) => {
    const env = environments.get(label)!;
    const result = await switchSource(env, "stardog_run");
    expect(result.isError).not.toBe(true);
    expect(resultBody(result)).toEqual({ switched: true, source: "stardog_run", triples: 42 });
    expect(fixture.calls).toBe(1);
    expect(fixture.saves).toEqual(["stardog_run"]);
    expect(fixture.restarts).toBe(1);
    expect(fixture.logs).toEqual(["[kg] graph source sidecar -> stardog_run: ok"]);
  });

  it("a fake that fails twice, then passes, switches (retry-enabled)", async () => {
    const env = retryEnv;
    fixture = newFixture({ tries: ["fail", "fail", "pass"] });
    const result = await switchSource(env, "stardog_run");
    expect(result.isError).not.toBe(true);
    expect(resultBody(result)).toEqual({ switched: true, source: "stardog_run", triples: 42 });
    expect(fixture.calls).toBe(3);
    expect(fixture.saves).toEqual(["stardog_run"]);
    expect(fixture.restarts).toBe(1);
  });

  it("a switch suspended on a failing Stardog test keeps the lock until it ends (retry-enabled)", async () => {
    const env = retryEnv;
    const retry = gate("the Stardog test's second attempt");
    setKgGraphSourceToolDeps(kgGraphSourceDeps({
      countTriples: async () => {
        fixture.calls += 1;
        // The first attempt fails, so the engine suspends the invocation and retries the test.
        if (fixture.calls === 1) throw new Error("Stardog Run count query answered HTTP 503");
        return retry.wait().then(() => 42);
      },
    }));

    const first = switchSource(env, "stardog_run", { "idempotency-key": "switch-suspended-first" });
    await retry.reached();
    // The first switch is between attempts; the lock must still be its own, not released by the unwind.
    const second = await switchSource(env, "stardog_run", { "idempotency-key": "switch-suspended-second" });
    expect(second.isError).not.toBe(true);
    expect(resultBody(second)).toEqual({ switched: false, error: "switch-in-flight" });
    expect(fixture.saves).toEqual([]);
    expect(fixture.restarts).toBe(0);

    retry.release();
    expect(resultBody(await first)).toEqual({ switched: true, source: "stardog_run", triples: 42 });
    expect(fixture.calls).toBe(2);
    expect(fixture.saves).toEqual(["stardog_run"]);
    expect(fixture.restarts).toBe(1);
    // The switch's own end frees the lock; a new refresh is admitted without waiting for `watchSwitch`.
    expectRefreshAdmitted(await triggerRefresh(env));
  }, 60_000);

  it.each(VARIANTS.map(([label]) => label))("a fake that never passes returns switched:false and runs no effect (%s)", async (label) => {
    const env = environments.get(label)!;
    fixture = newFixture({ tries: ["fail"] });
    const result = await switchSource(env, "stardog_run");
    expect(result.isError).not.toBe(true);
    const body = resultBody(result);
    expect(body.switched).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(fixture.saves).toEqual([]);
    expect(fixture.restarts).toBe(0);
    expect(getDb().prepare("SELECT value FROM settings WHERE key = ?").get(KG_GRAPH_SOURCE_SETTING_KEY)).toBeUndefined();
  });

  it.each(VARIANTS.map(([label]) => label))("a refresh trigger while a switch waits in its Stardog test is refused; the switch then completes (%s)", async (label) => {
    const env = environments.get(label)!;
    const stardogTest = gate("Stardog test before a refresh trigger");
    setKgGraphSourceToolDeps(kgGraphSourceDeps({
      countTriples: async () => {
        fixture.calls += 1;
        return stardogTest.wait().then(() => 42);
      },
    }));

    const switching = switchSource(env, "stardog_run", { "idempotency-key": `switch-refresh-race-${label}` });
    await stardogTest.reached();
    expect(await triggerRefresh(env)).toMatchObject({ status: "refresh-in-progress" });
    expect(fixture.saves).toEqual([]);
    expect(fixture.restarts).toBe(0);

    stardogTest.release();
    const result = await switching;
    expect(resultBody(result)).toEqual({ switched: true, source: "stardog_run", triples: 42 });
    expect(fixture.saves).toEqual(["stardog_run"]);
    expect(fixture.restarts).toBe(1);
  });

  it.each(VARIANTS.map(([label]) => label))("a switch while a refresh owns the lock answers refresh-in-flight and does not save (%s)", async (label) => {
    const env = environments.get(label)!;
    expectRefreshAdmitted(await triggerRefresh(env));

    const result = await switchSource(env, "stardog_run");
    expect(result.isError).not.toBe(true);
    expect(resultBody(result)).toEqual({ switched: false, error: "refresh-in-flight" });
    expect(fixture.calls).toBe(0);
    expect(fixture.saves).toEqual([]);
    expect(fixture.restarts).toBe(0);
  });

  it.each(VARIANTS.flatMap(([label]) => [
    [`${label} with a refresh rail`, label, true] as const,
    [`${label} with no refresh rail`, label, false] as const,
  ]))("two switches with different keys: the second answers switch-in-flight and only one restart runs (%s)", async (_description, label, bindRefresh) => {
    const env = environments.get(label)!;
    if (!bindRefresh) setKgRefreshToolDeps(null);
    try {
      const stardogTest = gate(`first switch (${bindRefresh ? "configured" : "fixed"} lock)`);
      setKgGraphSourceToolDeps(kgGraphSourceDeps({
        countTriples: async () => {
          fixture.calls += 1;
          return stardogTest.wait().then(() => 42);
        },
      }));

      const first = switchSource(env, "stardog_run", { "idempotency-key": `switch-a-${label}-${bindRefresh}` });
      await stardogTest.reached();
      const second = await switchSource(env, "stardog_run", { "idempotency-key": `switch-b-${label}-${bindRefresh}` });
      expect(second.isError).not.toBe(true);
      expect(resultBody(second)).toEqual({ switched: false, error: "switch-in-flight" });
      expect(fixture.restarts).toBe(0);

      stardogTest.release();
      expect(resultBody(await first)).toEqual({ switched: true, source: "stardog_run", triples: 42 });
      expect(fixture.calls).toBe(1);
      expect(fixture.saves).toEqual(["stardog_run"]);
      expect(fixture.restarts).toBe(1);
    } finally {
      bindRefreshDeps();
    }
  });

  it.each(VARIANTS.map(([label]) => label))("a new refresh is admitted after a failed Stardog test (%s)", async (label) => {
    const env = environments.get(label)!;
    fixture = newFixture({ tries: ["fail"] });
    const result = await switchSource(env, "stardog_run");
    expect(resultBody(result).switched).toBe(false);
    expect(fixture.saves).toEqual([]);

    expectRefreshAdmitted(await triggerRefresh(env));
  });

  it.each(VARIANTS.map(([label]) => label))("a new refresh is admitted after a failed restart (%s)", async (label) => {
    const env = environments.get(label)!;
    fixture = newFixture({ sidecarPresent: false });
    const result = await switchSource(env, "stardog_run");
    expect(resultBody(result)).toMatchObject({ switched: false, error: "sidecar-restart-failed" });
    expect(fixture.saves).toEqual(["stardog_run"]);
    expect(fixture.restarts).toBe(1);

    expectRefreshAdmitted(await triggerRefresh(env));
  });

  it.each(VARIANTS.map(([label]) => label))("a cancelled switch releases the lock, so a new refresh is admitted (%s)", async (label) => {
    const env = environments.get(label)!;
    const stardogTest = gate("Stardog test cancelled before release");
    setKgGraphSourceToolDeps(kgGraphSourceDeps({
      countTriples: async () => {
        fixture.calls += 1;
        return stardogTest.wait().then(() => 42);
      },
    }));

    // `watchSwitch` is sent by the switch's `acquireSwitch` call, so identify this test's watcher
    // as the one row that did not exist before the switch.
    const knownWatches = new Set((await queryInvocations(
      env.adminAPIBaseUrl(),
      `target_service_name = 'KgRepo' AND target_service_key = '${REPO_KEY}' AND target_handler_name = 'watchSwitch'`,
    )).map((row) => String(row.id)));

    // The ingress call may never return after a cancel in the replay variant: the release is proved
    // by admission, not by the canceled caller's response.
    void switchSource(env, "stardog_run", { "idempotency-key": `switch-cancelled-${label}` }).catch(() => undefined);
    await stardogTest.reached();
    const rows = await eventually(
      () => queryInvocations(env.adminAPIBaseUrl(), "target_service_name = 'orchestratorTools' AND target_handler_name = 'set_kg_graph_source' ORDER BY created_at DESC LIMIT 1"),
      (found) => found.length === 1,
      { label: "the switch invocation row" },
    );
    const switchId = String(rows[0]!.id);
    await cancelInvocationIfLive(env.adminAPIBaseUrl(), switchId);

    // A Restate cancel does not interrupt a running `ctx.run`: the switch sees it at its next
    // await. Let the gated step end, then the switch's finally and its `watchSwitch` release.
    stardogTest.release();
    // Wait for the watcher's own release send before proving admission: a barrier call to `KgRepo`
    // does not order a send made by another invocation.
    const watchId = await eventually(
      async () => (await queryInvocations(
        env.adminAPIBaseUrl(),
        `target_service_name = 'KgRepo' AND target_service_key = '${REPO_KEY}' AND target_handler_name = 'watchSwitch'`,
      )).find((row) => !knownWatches.has(String(row.id)))?.id,
      (id) => id !== undefined,
      { label: "the switch watcher invocation", timeoutMs: 30_000 },
    );
    await awaitSentInvocations(
      env.adminAPIBaseUrl(),
      env.baseUrl(),
      { service: "KgRepo", key: REPO_KEY, handler: "releaseSwitch" },
      `invoked_by_id = '${String(watchId)}'`,
    );

    // The finally's release, or watchSwitch, must free the lock; a refusal here is not
    // admission, so the predicate rejects every `{ status, triggerId }` shape.
    expectRefreshAdmitted(await eventually(
      () => triggerRefresh(env),
      refreshAdmitted,
      { label: "a refresh admitted after the switch is cancelled", timeoutMs: 30_000 },
    ));
    expect(fixture.saves).toEqual([]);
    expect(fixture.restarts).toBe(0);
  }, 60_000);

  it.each(VARIANTS.map(([label]) => label))("a sidecar switch saves and restarts with no test (%s)", async (label) => {
    const env = environments.get(label)!;
    fixture = newFixture({ source: "stardog_run" });
    resetStoredValues("stardog_run");
    const result = await switchSource(env, "sidecar");
    expect(resultBody(result)).toEqual({ switched: true, source: "sidecar" });
    expect(fixture.calls).toBe(0);
    expect(fixture.saves).toEqual(["sidecar"]);
    expect(fixture.restarts).toBe(1);
  });

  it.each(VARIANTS.map(([label]) => label))("the same Idempotency-Key repeats the first result and runs no effect twice (%s)", async (label) => {
    const env = environments.get(label)!;
    const key = `kg-switch-${label}`;
    const first = await switchSource(env, "stardog_run", { "idempotency-key": key });
    const second = await switchSource(env, "stardog_run", { "idempotency-key": key });
    expect(second).toEqual(first);
    expect(fixture.calls).toBe(1);
    expect(fixture.saves).toEqual(["stardog_run"]);
    expect(fixture.restarts).toBe(1);
  });

  it.each(VARIANTS.map(([label]) => label))("refuses a sidecar switch on a base-only image and changes nothing (%s)", async (label) => {
    const env = environments.get(label)!;
    fixture = newFixture({ source: "stardog_run", sidecarPresent: false });
    resetStoredValues("stardog_run");
    const result = await switchSource(env, "sidecar");
    expect(result.isError).not.toBe(true);
    expect(resultBody(result)).toEqual({ switched: false, error: "no-sidecar-graph" });
    expect(fixture.calls).toBe(0);
    expect(fixture.saves).toEqual([]);
    expect(fixture.restarts).toBe(0);
  });

  it.each(VARIANTS.map(([label]) => label))("refuses while a refresh is in flight, with no hold, and does not restart (%s)", async (label) => {
    const env = environments.get(label)!;
    await setObjectStates(env.adminAPIBaseUrl(), "KgRepo", REPO_KEY, {
      inFlight: { triggerId: "t-running", startedAt: 1, invocationId: "inv-running" },
      held: null,
    });
    const result = await switchSource(env, "stardog_run");
    expect(result.isError).not.toBe(true);
    expect(resultBody(result)).toEqual({ switched: false, error: "refresh-in-flight" });
    expect(fixture.calls).toBe(0);
    expect(fixture.saves).toEqual([]);
    expect(fixture.restarts).toBe(0);
  });

  it.each(VARIANTS.map(([label]) => label))("refuses while a refresh is held and does not restart (%s)", async (label) => {
    const env = environments.get(label)!;
    // One write: the admin API's new_state replaces the object's whole state, not one key.
    await setObjectStates(env.adminAPIBaseUrl(), "KgRepo", REPO_KEY, {
      inFlight: { triggerId: "t-held", startedAt: 1 },
      held: {
        triggerId: "t-held", dispatchId: "d-held", decideBy: 9_999_999_999_999,
        report: { snapshotPr: 1, partTable: [] }, steps: [],
      },
    });
    const result = await switchSource(env, "stardog_run");
    expect(result.isError).not.toBe(true);
    expect(resultBody(result)).toEqual({ switched: false, error: "refresh-in-flight" });
    expect(fixture.calls).toBe(0);
    expect(fixture.saves).toEqual([]);
    expect(fixture.restarts).toBe(0);
  });

  it.each(VARIANTS.map(([label]) => label))("refuses stardog_run when stored values are missing (%s)", async (label) => {
    const env = environments.get(label)!;
    setStardogValues({ token: "" });
    getDb().prepare("DELETE FROM settings WHERE key = 'kg_stardog_db'").run();
    const result = await switchSource(env, "stardog_run");
    expect(result.isError).not.toBe(true);
    expect(resultBody(result)).toEqual({ switched: false, error: "stardog-values-missing" });
    expect(fixture.calls).toBe(0);
    expect(fixture.restarts).toBe(0);
  });

  it.each(VARIANTS.map(([label]) => label))("refuses stardog_run when only the namespace is missing (%s)", async (label) => {
    const env = environments.get(label)!;
    setStardogValues({ namespace: "" });
    const result = await switchSource(env, "stardog_run");
    expect(result.isError).not.toBe(true);
    expect(resultBody(result)).toEqual({ switched: false, error: "stardog-values-missing" });
    expect(fixture.calls).toBe(0);
    expect(fixture.restarts).toBe(0);

    // The namespace is the only value the fixture had to add back: db and token were already stored.
    setStardogValues({ namespace: "https://kg.example/" });
    expect(resultBody(await switchSource(env, "stardog_run"))).toEqual({ switched: true, source: "stardog_run", triples: 42 });
  });

  it.each(VARIANTS.map(([label]) => label))("a non-admin caller is refused and nothing runs (%s)", async (label) => {
    const env = environments.get(label)!;
    const result = await callService<ToolResult>(env.baseUrl(), "orchestratorTools", "set_kg_graph_source", {
      caller: USER, args: { source: "stardog_run" },
    });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toBe("forbidden: set_kg_graph_source requires the admin role");
    expect(fixture.calls).toBe(0);
    expect(fixture.restarts).toBe(0);
  });

  it.each(VARIANTS.map(([label]) => label))("switches with no refresh configured, using the fixed switch lock (%s)", async (label) => {
    const env = environments.get(label)!;
    setKgRefreshToolDeps(null);
    try {
      const result = await switchSource(env, "stardog_run");
      expect(resultBody(result)).toEqual({ switched: true, source: "stardog_run", triples: 42 });
      expect(fixture.calls).toBe(1);
      expect(fixture.saves).toEqual(["stardog_run"]);
      expect(fixture.restarts).toBe(1);
      expect(await callObject<unknown>(env.baseUrl(), "KgRepo", FIXED_SWITCH_REPO_KEY, "status", {})).toBeNull();
    } finally {
      bindRefreshDeps();
    }
  });

  it.each(VARIANTS.map(([label]) => label))("journals only the count, never a credential or a header (%s)", async (label) => {
    const env = environments.get(label)!;
    const SECRET = "SENTINEL-STARDOG-TOKEN-in-journal-1234567890";
    const PASS = "SENTINEL-EDGE-PASS-in-journal";
    const BEARER = "SENTINEL-EDGE-BEARER-in-journal";
    setStardogValues({ token: SECRET });
    // The fake client stands in for the code that does see the credential; it touches every
    // one and returns only the count, the shape the real client returns.
    setKgGraphSourceToolDeps(kgGraphSourceDeps({
      countTriples: async () => {
        fixture.calls += 1;
        // A positive payload control: a closure that DID read the credential still returns the count.
        void [SECRET, PASS, BEARER].join(":");
        return 42;
      },
    }));
    const result = await switchSource(env, "stardog_run");
    expect(resultBody(result)).toEqual({ switched: true, source: "stardog_run", triples: 42 });

    const rows = await queryInvocations(env.adminAPIBaseUrl(), "target_service_name = 'orchestratorTools' AND target_handler_name = 'set_kg_graph_source' ORDER BY created_at DESC LIMIT 1");
    expect(rows).toHaveLength(1);
    const entries = await journalEntries(env.adminAPIBaseUrl(), String(rows[0]!.id));
    const text = journalText(entries);
    // Positive control: the journal was read and the test step is in it.
    expect(text).toContain("stardog-test");
    expect(text).toContain("switched");
    // The step's journaled result is the count alone.
    expect(journaledRunResult(entries, "stardog-test")).toBe(42);
    for (const secret of [SECRET, PASS, BEARER, "Bearer", "authorization", "Authorization"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("the production test budget covers a Stardog wake", () => {
    expect(STARDOG_TEST_MAX_RETRY_DURATION_MS).toBe(6 * 60_000);
  });
});
