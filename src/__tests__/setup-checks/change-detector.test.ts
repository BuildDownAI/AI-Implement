// The setup checks' change detector (AII-1544): what the saved setup holds, which runs a change needs, and the detector across
// poll cycles and across a restart, through its record.
import { beforeEach, describe, expect, it } from "vitest";
import type * as DedupModule from "../../dedup.js";
import type * as SetupChecksModule from "../../setup-checks/index.js";
import type * as ChangeDetectorModule from "../../setup-checks/change-detector.js";
import type { GitHubSetupFacts, SetupCheckContext, SetupCheckRunKind } from "../../setup-checks/index.js";
import { makeAccessEntry, makeMapping } from "../helpers/builders.js";
import { makeGitHubSetupFacts, makeSetupCheckContext } from "../helpers/fixtures/setup-checks.js";
import { testDb } from "../helpers/test-db.js";

let dedup: typeof DedupModule;
let checks: typeof SetupChecksModule;
let detection: typeof ChangeDetectorModule;

beforeEach(async () => {
  ({ dedup, checks, detection } = (await testDb({
    modules: {
      dedup: () => import("../../dedup.js"),
      checks: () => import("../../setup-checks/index.js"),
      detection: () => import("../../setup-checks/change-detector.js"),
    },
  })).modules);
});

describe("the saved setup", () => {
  it("is the same across reads with nothing saved between them", () => {
    const ctx = makeSetupCheckContext({ mappings: () => ({ ENG: makeMapping() }) });
    expect(detection.readSavedSetup(ctx)).toEqual(detection.readSavedSetup(ctx));
  });

  // The sync worker rewrites updatedAt as it runs, and a first sign-in writes an address's bindings, neither of which is a save.
  it("leaves out what the orchestrator writes for itself: a sync's update time, and an address's sign-in bindings", () => {
    const at = (updatedAt: number, bindings: Array<{ provider: string; subject: string }>) => detection.readSavedSetup(makeSetupCheckContext({
      mappings: () => ({ ENG: makeMapping() }),
      githubSetupFacts: () => makeGitHubSetupFacts({ workflowSync: () => ({ id: 1, teamKey: "ENG", status: "running", result: null, error: null, createdAt: 1, updatedAt }) }),
      effectiveAllowlist: () => ({ entries: [makeAccessEntry({ bindings })], source: "db" }),
    }));
    expect(at(2, [])).toEqual(at(3, [{ provider: "google", subject: "sub-1" }]));
  });

  // A sync is read only by a per-project check, and a project's stage revision only by an orchestrator-wide one.
  it("holds a project's sources by which checks read them: its own, the orchestrator-wide ones, or both", () => {
    const at = (overrides: Partial<SetupCheckContext>) => detection.readSavedSetup(makeSetupCheckContext({ mappings: () => ({ ENG: makeMapping() }), ...overrides }));
    const base = at({});
    const synced = at({ githubSetupFacts: () => makeGitHubSetupFacts({ workflowSync: () => ({ id: 1, teamKey: "ENG", status: "completed", result: null, error: null, createdAt: 1, updatedAt: 1 }) }) });
    expect(synced.perProject.ENG.projectChecks).not.toBe(base.perProject.ENG.projectChecks);
    expect(synced.perProject.ENG.orchestratorWideChecks).toBe(base.perProject.ENG.orchestratorWideChecks);
    expect(synced.orchestratorWide).toBe(base.orchestratorWide);
    // A sync queued again keeps its row's id, so only its error tells a retry that failed differently apart.
    const failedWith = (message: string) => at({ githubSetupFacts: () => makeGitHubSetupFacts({ workflowSync: () => ({ id: 1, teamKey: "ENG", status: "failed", result: null, error: { category: "unknown", message }, createdAt: 1, updatedAt: 1 }) }) });
    expect(failedWith("the App lacks workflows: write").perProject.ENG.projectChecks).not.toBe(failedWith("the default branch is protected").perProject.ENG.projectChecks);
    const adopted = at({ projectStageConfig: () => ({ configRevisionId: "rev-2", revision: 2, config: {} as never, createdAt: 1, createdBy: null, supersedesRevisionId: null }) });
    expect(adopted.perProject.ENG.orchestratorWideChecks).not.toBe(base.perProject.ENG.orchestratorWideChecks);
    expect(adopted.perProject.ENG.projectChecks).toBe(base.perProject.ENG.projectChecks);
    const remapped = at({ mappings: () => ({ ENG: makeMapping({ repo: "other" }) }) });
    expect(remapped.perProject.ENG.projectChecks).not.toBe(base.perProject.ENG.projectChecks);
    expect(remapped.perProject.ENG.orchestratorWideChecks).not.toBe(base.perProject.ENG.orchestratorWideChecks);
  });

  it("reads each project's own sources for that project alone", () => {
    const at = (opsRepo: string) => detection.readSavedSetup(makeSetupCheckContext({ mappings: () => ({ ENG: makeMapping(), OPS: makeMapping({ repo: opsRepo }) }) }));
    const before = at("ops");
    const after = at("ops-renamed");
    expect(after.perProject.OPS).not.toEqual(before.perProject.OPS);
    expect(after.perProject.ENG).toEqual(before.perProject.ENG);
  });

  // A check that reads one of these must see its change, so each part is pinned on its own.
  it.each([
    ["an allowlist entry's kind", { effectiveAllowlist: () => ({ entries: [makeAccessEntry({ kind: "domain", value: "example.com" })], source: "db" as const }) }],
    ["an allowlist entry's address", { effectiveAllowlist: () => ({ entries: [makeAccessEntry({ value: "other@example.com" })], source: "db" as const }) }],
    ["an allowlist entry's role", { effectiveAllowlist: () => ({ entries: [makeAccessEntry({ role: "user" })], source: "db" as const }) }],
    ["where the allowlist comes from", { effectiveAllowlist: () => ({ entries: [makeAccessEntry()], source: "env" as const }) }],
    ["the agent defaults' revision", { orchestratorDefaults: () => ({ configRevisionId: "rev-2", revision: 2, config: {} as never, createdAt: 1, createdBy: null, supersedesRevisionId: null }) }],
    ["the Fly sessions app", { flySessions: () => ({ token: null, app: "other-sessions", region: "iad", source: { app: "restate" as const, region: "restate" as const } }) }],
    ["the Fly sessions region", { flySessions: () => ({ token: null, app: "sessions", region: "lhr", source: { app: "restate" as const, region: "restate" as const } }) }],
    ["where the Fly sessions settings come from", { runnerBackendSource: () => "not-loaded" as const }],
    ["a seed-once setting", { readSetting: (key: string) => (key === "kg_base_repo" ? "acme/other-kg-base" : null) }],
  ] as const)("changes what the orchestrator-wide checks read when %s changes", (_part, change) => {
    const base: Partial<SetupCheckContext> = {
      mappings: () => ({ ENG: makeMapping() }),
      effectiveAllowlist: () => ({ entries: [makeAccessEntry()], source: "db" }),
      flySessions: () => ({ token: null, app: "sessions", region: "iad", source: { app: "restate", region: "restate" } }),
    };
    const before = detection.readSavedSetup(makeSetupCheckContext(base));
    const after = detection.readSavedSetup(makeSetupCheckContext({ ...base, ...change }));
    expect(after.orchestratorWide).not.toBe(before.orchestratorWide);
    expect(after.perProject).toEqual(before.perProject);
  });

  it("puts the runner mode and the pickup label with what reaches checks of both kinds", () => {
    const base = detection.readSavedSetup(makeSetupCheckContext());
    const local = detection.readSavedSetup(makeSetupCheckContext({ runnerMode: () => ({ mode: "local", source: "db" }) }));
    const relabeled = detection.readSavedSetup(makeSetupCheckContext({ readSetting: (key) => (key === "linear_pickup_label" ? "Pick-Me" : null) }));
    expect(local.allChecks).not.toBe(base.allChecks);
    expect(relabeled.allChecks).not.toBe(base.allChecks);
  });

  // Each seed-once variable is set to a value that seeds, so settings.seeded reads its row.
  it("reads every settings row a check reads", async () => {
    const read = new Set<string>();
    const ctx = makeSetupCheckContext({
      env: { KG_BASE_REPO: "acme/kg-base", KG_MATERIALIZE_DIRECT: "true", KG_EXECUTION_MODE: "fly-machines", LINEAR_PICKUP_LABEL: "AI-Implement", RUNNER_IMAGE_ALLOWED_PREFIXES: "ghcr.io/acme/", RUNNER_MODE: "fly", FLY_PROCESS_LEVEL_SECRETS: "true" },
      readSetting: (key) => { read.add(key); return null; },
    });
    await checks.runSetupChecks(ctx);
    expect(read.size).toBeGreaterThan(0);
    expect([...read].filter((key) => !detection.SAVED_SETUP_SETTINGS.includes(key))).toEqual([]);
  });

  // A check's declaration is what routes a change to its rows, so the rows its run reads must all be declared.
  it("is the settings rows each check declares, read by no check beyond them", async () => {
    const env = { KG_BASE_REPO: "acme/kg-base", KG_MATERIALIZE_DIRECT: "true", KG_EXECUTION_MODE: "fly-machines", LINEAR_PICKUP_LABEL: "AI-Implement", RUNNER_IMAGE_ALLOWED_PREFIXES: "ghcr.io/acme/", RUNNER_MODE: "fly", FLY_PROCESS_LEVEL_SECRETS: "true" };
    for (const check of checks.SETUP_CHECKS) {
      const read = new Set<string>();
      await check.run(makeSetupCheckContext({ env, readSetting: (key) => { read.add(key); return null; } }));
      expect([...read].filter((key) => !(check.settingsRows ?? []).includes(key)), check.id).toEqual([]);
    }
  });

  // The type makes every reader placed; this holds each placement to what readSavedSetup does, a GitHub read named as githubSetupFacts.<read>.
  it("reads exactly the context readers placed in the saved setup", () => {
    const read = new Set<string>();
    const recording = <T extends object>(target: T, prefix: string): T => new Proxy(target, {
      get(on, name, receiver) {
        const value = Reflect.get(on, name, receiver);
        if (typeof name !== "string") return value;
        if (name !== "githubSetupFacts") read.add(prefix + name);
        return name === "githubSetupFacts" ? () => recording((value as () => GitHubSetupFacts)(), "githubSetupFacts.") : value;
      },
    });
    detection.readSavedSetup(recording(makeSetupCheckContext({ mappings: () => ({ ENG: makeMapping() }) }), ""));
    const { githubSetupFacts, ...readers } = detection.SAVED_SETUP_READERS;
    const placed = [...Object.entries(readers), ...Object.entries(githubSetupFacts).map(([name, place]) => [`githubSetupFacts.${name}`, place] as const)];
    expect([...read].sort()).toEqual(placed.filter(([, place]) => "saved" in place).map(([name]) => name).sort());
  });
});

describe("what a change since the last cycle sends", () => {
  type Saved = ChangeDetectorModule.SavedSetup;
  const base: Saved = { perProject: { ENG: { projectChecks: "p1", orchestratorWideChecks: "w1" } }, orchestratorWide: "o1", allChecks: "a1" };
  const after = (changes: Partial<Saved>): Saved => ({ ...base, ...changes });

  it.each([
    ["nothing", after({}), []],
    ["what both kinds of check read of a project, as of its mapping", after({ perProject: { ENG: { projectChecks: "p2", orchestratorWideChecks: "w2" } } }), [{ kind: "project", project: "ENG" }, { kind: "orchestrator-wide" }]],
    ["a new project", after({ perProject: { ...base.perProject, OPS: { projectChecks: "p1", orchestratorWideChecks: "w1" } } }), [{ kind: "project", project: "OPS" }, { kind: "orchestrator-wide" }]],
    ["what only a project's checks read of it, as of its workflow sync", after({ perProject: { ENG: { projectChecks: "p2", orchestratorWideChecks: "w1" } } }), [{ kind: "project", project: "ENG" }]],
    ["what only orchestrator-wide checks read of a project, as of its stage revision", after({ perProject: { ENG: { projectChecks: "p1", orchestratorWideChecks: "w2" } } }), [{ kind: "orchestrator-wide" }]],
    ["a deleted project, whose rows the merge drops", after({ perProject: {} }), [{ kind: "orchestrator-wide" }]],
    ["what only the orchestrator-wide checks read", after({ orchestratorWide: "o2" }), [{ kind: "orchestrator-wide" }]],
    ["what reaches checks of both kinds", after({ allChecks: "a2", orchestratorWide: "o2" }), [{ kind: "full" }]],
  ] as const)("for %s", (_change, current, runs) => {
    expect(detection.runsForSavedChange(base, current)).toEqual(runs);
  });
});

describe("the change detector", () => {
  type Saved = ChangeDetectorModule.SavedSetup;
  const at = (projects: Record<string, string>, orchestratorWide = "o1", allChecks = "a1"): Saved => ({
    perProject: Object.fromEntries(Object.entries(projects).map(([project, mapping]) => [project, { projectChecks: mapping, orchestratorWideChecks: mapping }])),
    orchestratorWide,
    allChecks,
  });
  // Each cycle reads the next saved setup, and the last one again once the list runs out, as cycles with nothing saved do.
  function detect(reads: Saved[], accept: (run: SetupCheckRunKind) => boolean = () => true) {
    let clock = 0;
    const sent: SetupCheckRunKind[] = [];
    const lines: string[] = [];
    const queue = [...reads];
    const detector = detection.createSetupCheckChangeDetector({
      readSavedSetup: () => (queue.length > 1 ? queue.shift()! : queue[0]),
      send: async (run) => { if (!accept(run)) return false; sent.push(run); return true; },
      log: (line) => { lines.push(line); },
      now: () => clock,
    });
    return { detector, sent, lines, advance: (ms: number) => { clock += ms; } };
  }

  it("sends nothing on its first call, so a restart is not a change", async () => {
    const { detector, sent } = detect([at({ ENG: "m1" })]);
    await detector.onPollCycle();
    expect(sent).toEqual([]);
  });

  it("sends each run a change needs once, and logs a line for each", async () => {
    const { detector, sent, lines, advance } = detect([at({ ENG: "m1" }), at({ ENG: "m2" })]);
    await detector.onPollCycle();
    await detector.onPollCycle();
    // Past the interval, so only a change could send again.
    advance(detection.MIN_SETUP_CHECK_RUN_INTERVAL_MS);
    await detector.onPollCycle();
    expect(sent).toEqual([{ kind: "project", project: "ENG" }, { kind: "orchestrator-wide" }]);
    expect(lines).toEqual(["[setup-checks] started the checks of ENG after a saved change", "[setup-checks] started the orchestrator-wide checks after a saved change"]);
  });

  it("holds a change within its run's interval until the interval has passed, then sends it once", async () => {
    const { detector, sent, advance } = detect([at({}, "o1"), at({}, "o2"), at({}, "o3")]);
    await detector.onPollCycle();
    await detector.onPollCycle();
    advance(detection.MIN_SETUP_CHECK_RUN_INTERVAL_MS - 1);
    await detector.onPollCycle();
    expect(sent).toHaveLength(1);
    advance(1);
    await detector.onPollCycle();
    await detector.onPollCycle();
    expect(sent).toEqual([{ kind: "orchestrator-wide" }, { kind: "orchestrator-wide" }]);
  });

  it("tries a run that was not sent again on the next call", async () => {
    let accept = false;
    const { detector, sent } = detect([at({}, "o1"), at({}, "o2")], () => accept);
    await detector.onPollCycle();
    await detector.onPollCycle();
    accept = true;
    await detector.onPollCycle();
    expect(sent).toEqual([{ kind: "orchestrator-wide" }]);
  });

  it.each([
    ["three projects changed, a run for each", ["A", "B", "C"], ["project", "project", "project", "orchestrator-wide"]],
    ["four projects changed, one full run", ["A", "B", "C", "D"], ["full"]],
  ] as const)("sends, for %s", async (_case, changed, kinds) => {
    const before = { A: "m1", B: "m1", C: "m1", D: "m1" };
    const { detector, sent } = detect([at(before), at({ ...before, ...Object.fromEntries(changed.map((key) => [key, "m2"])) })]);
    await detector.onPollCycle();
    await detector.onPollCycle();
    expect(sent.map((run) => run.kind)).toEqual(kinds);
  });

  it("lets a full run waiting within its interval answer for every change after it", async () => {
    const { detector, sent, advance } = detect([at({ ENG: "m1" }, "o1", "a1"), at({ ENG: "m1" }, "o1", "a2"), at({ ENG: "m1" }, "o1", "a3"), at({ ENG: "m2" }, "o2", "a3")]);
    await detector.onPollCycle();
    await detector.onPollCycle();
    await detector.onPollCycle();
    await detector.onPollCycle();
    expect(sent).toEqual([{ kind: "full" }]);
    advance(detection.MIN_SETUP_CHECK_RUN_INTERVAL_MS);
    await detector.onPollCycle();
    expect(sent).toEqual([{ kind: "full" }, { kind: "full" }]);
  });

  it("logs one line and sends nothing when the saved setup cannot be read, then compares with the last one it read", async () => {
    const reads: Array<Saved | Error> = [at({}, "o1"), new Error("the database is locked"), at({}, "o2")];
    const sent: SetupCheckRunKind[] = [];
    const lines: string[] = [];
    const detector = detection.createSetupCheckChangeDetector({
      readSavedSetup: () => { const next = reads.shift()!; if (next instanceof Error) throw next; return next; },
      send: async (run) => { sent.push(run); return true; },
      log: (line) => { lines.push(line); },
    });
    await detector.onPollCycle();
    await detector.onPollCycle();
    expect(lines).toEqual(["[setup-checks] the saved setup could not be read, so no change was looked for: the database is locked"]);
    expect(sent).toEqual([]);
    await detector.onPollCycle();
    expect(sent).toEqual([{ kind: "orchestrator-wide" }]);
  });

  describe("its record, which outlives the process", () => {
    // A detector over one shared record, standing in for the settings row a process writes and the next one reads.
    type Store = { record: ChangeDetectorModule.ChangeDetectorRecord | null; reads: number; writes: number };
    function processOver(store: Store, read: () => Saved, accept = () => true) {
      const sent: SetupCheckRunKind[] = [];
      const lines: string[] = [];
      const detector = detection.createSetupCheckChangeDetector({
        readSavedSetup: read,
        send: async (run) => { if (!accept()) return false; sent.push(run); return true; },
        log: (line) => { lines.push(line); },
        readRecord: () => { store.reads++; return store.record; },
        writeRecord: (record) => { store.record = record; store.writes++; },
      });
      return { detector, sent, lines };
    }
    const fresh = (): Store => ({ record: null, reads: 0, writes: 0 });

    it("lets the next process send a run that was still waiting when this one stopped", async () => {
      const store = fresh();
      let current = at({}, "o1");
      const first = processOver(store, () => current, () => false);
      await first.detector.onPollCycle();
      current = at({}, "o2");
      await first.detector.onPollCycle();
      expect(first.sent).toEqual([]);
      const next = processOver(store, () => current);
      await next.detector.onPollCycle();
      expect(next.sent).toEqual([{ kind: "orchestrator-wide" }]);
    });

    it("sends the run a save needs when the save came after this process's last cycle", async () => {
      const store = fresh();
      await processOver(store, () => at({ ENG: "m1" })).detector.onPollCycle();
      const next = processOver(store, () => at({ ENG: "m2" }));
      await next.detector.onPollCycle();
      expect(next.sent).toEqual([{ kind: "project", project: "ENG" }, { kind: "orchestrator-wide" }]);
    });

    it("sends nothing after a restart with nothing saved", async () => {
      const store = fresh();
      await processOver(store, () => at({ ENG: "m1" })).detector.onPollCycle();
      const next = processOver(store, () => at({ ENG: "m1" }));
      await next.detector.onPollCycle();
      expect(next.sent).toEqual([]);
    });

    // What the detector holds then mirrors the record, so reading it again would only cost a database read each cycle.
    it("reads the record on its first cycle alone, and writes it only in a cycle that changes it", async () => {
      const store = fresh();
      const { detector } = processOver(store, () => at({ ENG: "m1" }));
      await detector.onPollCycle();
      await detector.onPollCycle();
      expect([store.reads, store.writes]).toEqual([1, 1]);
      await processOver(store, () => at({ ENG: "m1" })).detector.onPollCycle();
      expect(store.writes).toBe(1);
    });

    // A write that failed left the next process nothing to compare with, so the record is written again though nothing changed.
    it("writes the record again on the next cycle when its write failed", async () => {
      const lines: string[] = [];
      const writes: Array<"failed" | "written"> = [];
      const detector = detection.createSetupCheckChangeDetector({
        readSavedSetup: () => at({ ENG: "m1" }),
        send: async () => true,
        log: (line) => { lines.push(line); },
        readRecord: () => null,
        writeRecord: () => {
          if (writes.length === 0) { writes.push("failed"); throw new Error("the database is locked"); }
          writes.push("written");
        },
      });
      await detector.onPollCycle();
      await detector.onPollCycle();
      expect(writes).toEqual(["failed", "written"]);
      expect(lines).toEqual(["[setup-checks] the saved setup could not be written for the next process: the database is locked"]);
    });

    it("holds fingerprints of the saved setup, never the setup itself", async () => {
      const store = fresh();
      await processOver(store, () => at({ ENG: "a-mapping-read-in-full" }, "the-orchestrator-wide-part")).detector.onPollCycle();
      const kept = JSON.stringify(store.record);
      expect(kept).not.toContain("a-mapping-read-in-full");
      expect(kept).not.toContain("the-orchestrator-wide-part");
      expect(store.record!.savedSetup).toEqual(detection.fingerprintSavedSetup(at({ ENG: "a-mapping-read-in-full" }, "the-orchestrator-wide-part")));
    });

    // The record may hold a run still waiting, which writing a fresh record over it would lose.
    it("looks for no change and writes nothing while the record cannot be read, then reads it on a later cycle", async () => {
      const sent: SetupCheckRunKind[] = [];
      const lines: string[] = [];
      let writes = 0;
      const reads: Array<ChangeDetectorModule.ChangeDetectorRecord | Error> = [
        new Error("the database is locked"),
        { savedSetup: detection.fingerprintSavedSetup(at({}, "o2")), waiting: [{ kind: "orchestrator-wide" }] },
      ];
      const detector = detection.createSetupCheckChangeDetector({
        readSavedSetup: () => at({}, "o2"),
        send: async (run) => { sent.push(run); return true; },
        log: (line) => { lines.push(line); },
        readRecord: () => { const next = reads.shift()!; if (next instanceof Error) throw next; return next; },
        writeRecord: () => { writes++; },
      });
      await detector.onPollCycle();
      expect([sent, writes]).toEqual([[], 0]);
      expect(lines).toEqual(["[setup-checks] the last process's record could not be read, so no change was looked for: the database is locked"]);
      await detector.onPollCycle();
      expect(sent).toEqual([{ kind: "orchestrator-wide" }]);
    });

    it("keeps the record in a settings row, and reads a row that is not one as none", () => {
      expect(detection.readChangeDetectorRecord()).toBeNull();
      const record = { savedSetup: detection.fingerprintSavedSetup(at({ ENG: "m1" })), waiting: [{ kind: "full" as const }] };
      detection.writeChangeDetectorRecord(record);
      expect(detection.readChangeDetectorRecord()).toEqual(record);
      dedup.getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("setup_checks_change_detector", JSON.stringify({ waiting: [] }));
      expect(detection.readChangeDetectorRecord()).toBeNull();
    });
  });
});

describe("the saved setup's fingerprints", () => {
  const saved = { perProject: { ENG: { projectChecks: "p1", orchestratorWideChecks: "w1" } }, orchestratorWide: "o1", allChecks: "a1" };

  it("match for the same saved setup, and change only the part that changed", () => {
    expect(detection.fingerprintSavedSetup(saved)).toEqual(detection.fingerprintSavedSetup({ ...saved }));
    const before = detection.fingerprintSavedSetup(saved);
    const after = detection.fingerprintSavedSetup({ ...saved, perProject: { ENG: { projectChecks: "p2", orchestratorWideChecks: "w1" } } });
    expect(after.perProject.ENG.projectChecks).not.toBe(before.perProject.ENG.projectChecks);
    expect(after.perProject.ENG.orchestratorWideChecks).toBe(before.perProject.ENG.orchestratorWideChecks);
    expect([after.orchestratorWide, after.allChecks]).toEqual([before.orchestratorWide, before.allChecks]);
  });
});
