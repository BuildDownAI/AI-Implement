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
import { createKgRepo } from "../../restate/kg-repo.js";
import {
  setObjectStates, VARIANTS, callService, journaledRunResult, journalEntries, journalText,
  queryInvocations, startVariants, stopAll,
} from "./harness.js";
import type { RestateEnvironment } from "./harness.js";
import { KG_GRAPH_SOURCE_SETTING_KEY, setKgGraphSource, setStardogValues, type KgGraphSource } from "../../kg-graph-source.js";
import { getDb } from "../../dedup.js";
import { initSettingsTable } from "../../runner-mode.js";

interface ToolResult {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}

const REPO_KEY = "org/kg";
const ADMIN = { kind: "system", email: null, role: "admin" } as const;
const USER = { kind: "human", email: "user@example.com", role: "user", grants: [] } as const;

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
    testPauseMs: 0,
    testMaxRetryDurationMs: 2_000,
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

function resultBody(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content![0]!.text) as Record<string, unknown>;
}

describe("set_kg_graph_source (Restate)", () => {
  let environments: Map<string, RestateEnvironment>;
  const originalSecret = process.env.RUNNER_TOKEN_SECRET;

  beforeAll(async () => {
    getDb();
    initSettingsTable();
    process.env.RUNNER_TOKEN_SECRET = "kg-graph-source-restate-test-key";
    bindRefreshDeps();
    bindFixture();
    environments = await startVariants([orchestratorTools, createKgRepo({ workflowName: "KgRefresh" })]);
  }, 60_000);

  beforeEach(() => {
    fixture = newFixture();
    resetStoredValues();
  });

  afterEach(async () => {
    for (const env of environments.values()) {
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
    await stopAll(environments);
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

  it("a fake that fails twice, then passes, switches (alwaysReplay)", async () => {
    const env = environments.get("alwaysReplay")!;
    fixture = newFixture({ tries: ["fail", "fail", "pass"] });
    const result = await switchSource(env, "stardog_run");
    expect(result.isError).not.toBe(true);
    expect(resultBody(result)).toEqual({ switched: true, source: "stardog_run", triples: 42 });
    expect(fixture.calls).toBe(3);
    expect(fixture.saves).toEqual(["stardog_run"]);
    expect(fixture.restarts).toBe(1);
  });

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

  it.each(VARIANTS.map(([label]) => label))("switches with no refresh configured, skipping the admission read (%s)", async (label) => {
    const env = environments.get(label)!;
    // The KgRepo object still has no marker: the point is that the tool never reads it.
    setKgRefreshToolDeps(null);
    try {
      const result = await switchSource(env, "stardog_run");
      expect(resultBody(result)).toEqual({ switched: true, source: "stardog_run", triples: 42 });
      expect(fixture.calls).toBe(1);
      expect(fixture.saves).toEqual(["stardog_run"]);
      expect(fixture.restarts).toBe(1);
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
