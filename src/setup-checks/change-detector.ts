/**
 * The setup checks' change detector: on each poll cycle it reads the setup that saves change, as the checks read it, and sends the run
 * a change since the last cycle needs. Its record outlives the process, in a settings row of its own. The list, the context a check reads,
 * the runs and their merge are index.ts and contract.ts.
 */

import { createHash } from "node:crypto";
import { getDb } from "../dedup.js";
import { KG_BASE_REPO_KEY, LINEAR_PICKUP_LABEL_KEY } from "../orchestrator-settings.js";
import type { GitHubSetupReader, SetupCheck, SetupCheckContext, SetupCheckReader } from "./contract.js";
import { SETUP_CHECKS } from "./index.js";

// The setup checks' time in this module. The recheck hold is in index.ts, the ingress bounds in src/restate/setup-checks.ts, the Setup page's polls in its own module.
/** The least time between two runs of one kind, so a burst of saves is checked once it settles, and the last save is always checked. */
export const MIN_SETUP_CHECK_RUN_INTERVAL_MS = 5 * 60_000;

/** A kind of run the change detector sends: every check, the orchestrator-wide checks, or one project's checks. */
export type SetupCheckRunKind = { kind: "full" } | { kind: "orchestrator-wide" } | { kind: "project"; project: string };

/**
 * The setup that saves change, as the checks read it from this orchestrator's own state, split by which checks read each part,
 * so a change names the run it needs. Which part a source lands in comes from the checks' declarations, never from a hand-placed list.
 * Nothing the orchestrator writes for itself is in it, so two cycles with nothing saved between them match.
 */
export interface SavedSetup {
  /** Each project's own saved sources: what that project's checks read of them, and what the orchestrator-wide checks read of them. */
  perProject: Record<string, { projectChecks: string; orchestratorWideChecks: string }>;
  /** The other sources that only orchestrator-wide checks read. */
  orchestratorWide: string;
  /** The other sources that a per-project check reads, so a change to them reaches every project. */
  allChecks: string;
}

/** The saved setup a reader's result is built from, though the result itself is not saved. Every check that calls the reader reads it too. */
interface BuiltFrom {
  contextReaders?: readonly SetupCheckReader[];
  settingsRows?: readonly string[];
}

/**
 * A reader's place in the saved setup: saved, as one value per project or one for the orchestrator, or by settings row for readSetting;
 * or left out for the reason given, with the saved setup its result is built from when it has any.
 */
type SavedSetupReader =
  | { saved: "per-project"; read: (ctx: SetupCheckContext, project: string) => unknown }
  | { saved: "orchestrator"; read: (ctx: SetupCheckContext) => unknown }
  | { saved: "by-settings-row" }
  | { leftOut: string; builtFrom?: BuiltFrom };

const GITHUB_READ: SavedSetupReader = { leftOut: "Read from GitHub, where no save here changes it." };

/**
 * Every reader a check can call, and its place in the saved setup, so a reader added to the context does not compile until it is placed.
 * Which checks read each saved part is read from the checks' declarations.
 */
export const SAVED_SETUP_READERS: { [K in SetupCheckReader]: SavedSetupReader } & { githubSetupFacts: Record<GitHubSetupReader, SavedSetupReader> } = {
  env: { leftOut: "A variable changes only with a restart, and boot runs the checks." },
  readSetting: { saved: "by-settings-row" },
  orchestratorDefaults: { saved: "orchestrator", read: (ctx) => ctx.orchestratorDefaults()?.configRevisionId ?? null },
  projectStageConfig: { saved: "per-project", read: (ctx, project) => ctx.projectStageConfig(project)?.configRevisionId ?? null },
  runnerMode: { saved: "orchestrator", read: (ctx) => ctx.runnerMode().mode },
  flySessions: { saved: "orchestrator", read: (ctx) => { const fly = ctx.flySessions(); return [fly.app, fly.region]; } },
  runnerBackendSource: { saved: "orchestrator", read: (ctx) => ctx.runnerBackendSource() },
  mappings: { saved: "per-project", read: (ctx, project) => ctx.mappings()[project] },
  storedAccessEntries: { leftOut: "A check reads only whether the saved list holds entries, which effectiveAllowlist's source says." },
  effectiveAllowlist: {
    saved: "orchestrator",
    // An address's bindings are written at its first sign-in, which no check judges.
    read: (ctx) => { const allowlist = ctx.effectiveAllowlist(); return allowlist && { source: allowlist.source, entries: allowlist.entries.map(({ kind, value, role }) => [kind, value, role]) }; },
  },
  allowlistReadAvailable: { leftOut: "No check reads it. Bootstrap mode on GET / does, live, outside the stored run." },
  restateStatus: { leftOut: "The process's own state, not a save." },
  databasePath: { leftOut: "Resolved once per process, from a variable." },
  onSeparateFilesystem: { leftOut: "The machine's mounts, not a save." },
  trackerProvider: { leftOut: "Built from the variables and the mappings.", builtFrom: { contextReaders: ["mappings"] } },
  // The Linear provider judges the pickup label it reads itself.
  trackerSetupFacts: { leftOut: "Read from the ticketing system, where no save here changes it.", builtFrom: { contextReaders: ["mappings"], settingsRows: [LINEAR_PICKUP_LABEL_KEY] } },
  orchestratorHealthAt: { leftOut: "A network read, which no save changes." },
  orchestratorInstanceId: { leftOut: "Fixed for the process's life." },
  githubSetupFacts: {
    app: GITHUB_READ,
    installation: GITHUB_READ,
    installationRepositories: GITHUB_READ,
    repositories: { ...GITHUB_READ, builtFrom: { contextReaders: ["mappings"] } },
    publicRepository: GITHUB_READ,
    deliveries: GITHUB_READ,
    kgSourceRepo: { leftOut: "Set by KG_SOURCE_REPO, a variable." },
    kgPreflight: { ...GITHUB_READ, builtFrom: { settingsRows: [KG_BASE_REPO_KEY] } },
    // A sync queued again keeps its row's id, so a retry that fails differently shows only in the error the workflow check reads.
    workflowSync: { saved: "per-project", read: (ctx, project) => { const job = ctx.githubSetupFacts().workflowSync(project); return job && [job.id, job.status, job.error?.message ?? null]; } },
  },
};

/** Where a piece of the saved setup a check reads comes from: a reader whose value is saved, named as the checks name it, or a settings row. */
type SavedSetupSource = { reader: string; place: Extract<SavedSetupReader, { read: unknown }> } | { settingsRow: string };

/** Every saved setup source `check` reads: its readers that are saved, what its other readers are built from, and its settings rows. */
function savedSetupSourcesOf(check: SetupCheck): SavedSetupSource[] {
  const sources: SavedSetupSource[] = [];
  const add = (reader: string, place: SavedSetupReader) => {
    if ("read" in place) sources.push({ reader, place });
    else if ("leftOut" in place) {
      for (const source of place.builtFrom?.contextReaders ?? []) add(source, SAVED_SETUP_READERS[source]);
      for (const row of place.builtFrom?.settingsRows ?? []) sources.push({ settingsRow: row });
    }
  };
  for (const reader of check.contextReaders) add(reader, SAVED_SETUP_READERS[reader]);
  for (const reader of check.githubReaders ?? []) add(`githubSetupFacts.${reader}`, SAVED_SETUP_READERS.githubSetupFacts[reader]);
  for (const row of check.settingsRows ?? []) sources.push({ settingsRow: row });
  return sources;
}

/** Each saved setup source once, keyed by name, with which kinds of check read it. */
function readBy(): Map<string, { source: SavedSetupSource; perProject: boolean; orchestratorWide: boolean }> {
  const read = new Map<string, { source: SavedSetupSource; perProject: boolean; orchestratorWide: boolean }>();
  for (const check of SETUP_CHECKS) {
    for (const source of savedSetupSourcesOf(check)) {
      const key = "reader" in source ? source.reader : `settings row ${source.settingsRow}`;
      const entry = read.get(key) ?? { source, perProject: false, orchestratorWide: false };
      if (check.perProject) entry.perProject = true;
      else entry.orchestratorWide = true;
      read.set(key, entry);
    }
  }
  return read;
}

const SAVED_SETUP_SOURCES = [...readBy()].sort(([a], [b]) => a.localeCompare(b));

/** The settings rows the checks read, directly or through a reader. */
export const SAVED_SETUP_SETTINGS: readonly string[] = SAVED_SETUP_SOURCES.flatMap(([, { source }]) => ("settingsRow" in source ? [source.settingsRow] : []));

const PER_PROJECT = SAVED_SETUP_SOURCES.filter(([, { source }]) => "reader" in source && source.place.saved === "per-project");
const ORCHESTRATOR = SAVED_SETUP_SOURCES.filter(([, { source }]) => !("reader" in source && source.place.saved === "per-project"));
/** Whether an orchestrator-wide check reads a project's own sources, so a project added or deleted changes its rows. */
const ORCHESTRATOR_WIDE_READS_PROJECTS = PER_PROJECT.some(([, { orchestratorWide }]) => orchestratorWide);

export function readSavedSetup(ctx: SetupCheckContext): SavedSetup {
  const value = (source: SavedSetupSource, project?: string): unknown => {
    if ("settingsRow" in source) return ctx.readSetting(source.settingsRow);
    return source.place.saved === "per-project" ? source.place.read(ctx, project!) : source.place.read(ctx);
  };
  const part = (sources: typeof SAVED_SETUP_SOURCES, project?: string) => JSON.stringify(sources.map(([key, { source }]) => [key, value(source, project)]));
  return {
    perProject: Object.fromEntries(Object.keys(ctx.mappings()).map((project) => [project, {
      projectChecks: part(PER_PROJECT.filter(([, by]) => by.perProject), project),
      orchestratorWideChecks: part(PER_PROJECT.filter(([, by]) => by.orchestratorWide), project),
    }])),
    orchestratorWide: part(ORCHESTRATOR.filter(([, by]) => !by.perProject)),
    allChecks: part(ORCHESTRATOR.filter(([, by]) => by.perProject)),
  };
}

/** The runs a change from one saved setup to the next needs. */
export function runsForSavedChange(before: SavedSetup, after: SavedSetup): SetupCheckRunKind[] {
  if (after.allChecks !== before.allChecks) return [{ kind: "full" }];
  const runs: SetupCheckRunKind[] = [];
  let orchestratorWide = after.orchestratorWide !== before.orchestratorWide
    || (ORCHESTRATOR_WIDE_READS_PROJECTS && Object.keys(before.perProject).some((project) => !(project in after.perProject)));
  for (const [project, now] of Object.entries(after.perProject)) {
    const was = before.perProject[project];
    if (was === undefined ? ORCHESTRATOR_WIDE_READS_PROJECTS : was.orchestratorWideChecks !== now.orchestratorWideChecks) orchestratorWide = true;
    if (was === undefined || was.projectChecks !== now.projectChecks) runs.push({ kind: "project", project });
  }
  if (orchestratorWide) runs.push({ kind: "orchestrator-wide" });
  return runs;
}

/** More project runs than this waiting at once are replaced by one full run. */
export const MAX_WAITING_PROJECT_RUNS = 3;

const runKey = (run: SetupCheckRunKind): string => (run.kind === "project" ? `project:${run.project}` : run.kind);
const runName = (run: SetupCheckRunKind): string =>
  run.kind === "full" ? "every check" : run.kind === "orchestrator-wide" ? "the orchestrator-wide checks" : `the checks of ${run.project}`;

/** The saved setup with each part replaced by its fingerprint, which tells a change apart without holding the setup itself. */
export function fingerprintSavedSetup(saved: SavedSetup): SavedSetup {
  const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
  return {
    perProject: Object.fromEntries(Object.entries(saved.perProject).map(([project, parts]) => [project, {
      projectChecks: fingerprint(parts.projectChecks),
      orchestratorWideChecks: fingerprint(parts.orchestratorWideChecks),
    }])),
    orchestratorWide: fingerprint(saved.orchestratorWide),
    allChecks: fingerprint(saved.allChecks),
  };
}

/** What the change detector writes for the next process: the fingerprints of the saved setup it last read, and the runs still waiting. */
export interface ChangeDetectorRecord {
  savedSetup: SavedSetup;
  waiting: SetupCheckRunKind[];
}

const CHANGE_DETECTOR_RECORD_KEY = "setup_checks_change_detector";

/** The record a previous process wrote, or null when none was written or the row does not read as one. */
export function readChangeDetectorRecord(): ChangeDetectorRecord | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(CHANGE_DETECTOR_RECORD_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    const record = JSON.parse(row.value) as Partial<ChangeDetectorRecord>;
    const saved = record.savedSetup;
    const readable = typeof saved?.perProject === "object" && typeof saved.orchestratorWide === "string" && typeof saved.allChecks === "string" && Array.isArray(record.waiting);
    return readable ? (record as ChangeDetectorRecord) : null;
  } catch {
    return null;
  }
}

export function writeChangeDetectorRecord(record: ChangeDetectorRecord): void {
  getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(CHANGE_DETECTOR_RECORD_KEY, JSON.stringify(record));
}

/**
 * The change detector, called on each poll cycle: it reads the saved setup and sends the runs a change since the last cycle needs.
 * Its record outlives the process, so the first cycle compares with what the last process read, and a restart is not a change
 * while a save before it, or a run still waiting, keeps its run. With no record written, the first cycle only reads.
 * A run that is not sent, or is due within its interval, waits for a later cycle, so a change always gets its run.
 */
export function createSetupCheckChangeDetector(deps: {
  readSavedSetup: () => SavedSetup;
  /** Sends a run without waiting for it, answering whether it was sent. */
  send: (run: SetupCheckRunKind) => Promise<boolean>;
  log: (line: string) => void;
  now?: () => number;
  /** The record the last process wrote, read at the first cycle. */
  readRecord?: () => ChangeDetectorRecord | null;
  /** Writes the record for the next process, each cycle it changes. */
  writeRecord?: (record: ChangeDetectorRecord) => void;
}): { onPollCycle: () => Promise<void> } {
  const now = deps.now ?? Date.now;
  const readRecord = deps.readRecord ?? readChangeDetectorRecord;
  const writeRecord = deps.writeRecord ?? writeChangeDetectorRecord;
  const failed = (what: string, err: unknown) => deps.log(`[setup-checks] ${what}: ${err instanceof Error ? err.message : String(err)}`);
  let last: SavedSetup | null = null;
  let recordRead = false;
  let written: string | null = null;
  const waiting = new Map<string, SetupCheckRunKind>();
  const sentAt = new Map<string, number>();
  return {
    onPollCycle: async () => {
      let current: SavedSetup;
      try {
        current = fingerprintSavedSetup(deps.readSavedSetup());
      } catch (err) {
        failed("the saved setup could not be read, so no change was looked for", err);
        return;
      }
      if (!recordRead) {
        let record: ChangeDetectorRecord | null;
        try {
          record = readRecord();
        } catch (err) {
          // The record may hold runs still waiting, so it is read again next cycle rather than written over.
          failed("the last process's record could not be read, so no change was looked for", err);
          return;
        }
        recordRead = true;
        if (record) {
          last = record.savedSetup;
          for (const run of record.waiting) waiting.set(runKey(run), run);
          written = JSON.stringify(record);
        }
      }
      if (last !== null) for (const run of runsForSavedChange(last, current)) waiting.set(runKey(run), run);
      last = current;
      if ([...waiting.values()].filter((run) => run.kind === "project").length > MAX_WAITING_PROJECT_RUNS) waiting.set("full", { kind: "full" });
      // A full run answers for every other run.
      if (waiting.has("full")) for (const key of waiting.keys()) if (key !== "full") waiting.delete(key);
      for (const [key, run] of waiting) {
        if (now() - (sentAt.get(key) ?? -Infinity) < MIN_SETUP_CHECK_RUN_INTERVAL_MS) continue;
        if (!(await deps.send(run))) continue;
        sentAt.set(key, now());
        waiting.delete(key);
        deps.log(`[setup-checks] started ${runName(run)} after a saved change`);
      }
      const record: ChangeDetectorRecord = { savedSetup: last, waiting: [...waiting.values()] };
      if (JSON.stringify(record) === written) return;
      try {
        writeRecord(record);
        written = JSON.stringify(record);
      } catch (err) {
        failed("the saved setup could not be written for the next process", err);
      }
    },
  };
}
