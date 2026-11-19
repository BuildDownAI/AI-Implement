/**
 * The setup checks' change detector: on each poll cycle it reads the setup that saves change, as the checks read it, and sends the run
 * a change since the last cycle needs. Its record outlives the process, in a settings row of its own. The list, the context a check reads,
 * the runs and their merge are index.ts and contract.ts.
 */

import { createHash } from "node:crypto";
import { getDb } from "../dedup.js";
import { LINEAR_PICKUP_LABEL_KEY } from "../orchestrator-settings.js";
import { FLY_PROCESS_LEVEL_SECRETS_SETTING_KEY, RUNNER_MODE_SETTING_KEY } from "../runner-mode.js";
import { SEED_ONCE_SETTINGS } from "../seed-once-settings.js";
import type { GitHubSetupFacts, SetupCheckContext } from "./contract.js";

// The setup checks' time in this module. The recheck hold is in index.ts, the ingress bounds in src/restate/setup-checks.ts, the Setup page's polls in its own module.
/** The least time between two runs of one kind, so a burst of saves is checked once it settles, and the last save is always checked. */
export const MIN_SETUP_CHECK_RUN_INTERVAL_MS = 5 * 60_000;

/** A kind of run the change detector sends: every check, the orchestrator-wide checks, or one project's checks. */
export type SetupCheckRunKind = { kind: "full" } | { kind: "orchestrator-wide" } | { kind: "project"; project: string };

/**
 * The setup that saves change, as the checks read it from this orchestrator's own state, split by which checks read each part,
 * so a change names the run it needs. Nothing the orchestrator writes for itself is in it, so two cycles with nothing saved between them match.
 */
export interface SavedSetup {
  /** Each project's saved mapping, and its workflow sync's id and state, which that project's own checks read. */
  perProject: Record<string, { mapping: string; sync: string }>;
  /** What only the orchestrator-wide checks read. */
  orchestratorWide: string;
  /** What reaches checks of both kinds: the runner mode, and the pickup label each Linear project's checks judge. */
  allChecks: string;
}

/** The settings rows the checks read: each seed-once row, and the two runner rows a variable can override. */
export const SAVED_SETUP_SETTINGS: readonly string[] = [...SEED_ONCE_SETTINGS.map((setting) => setting.key), RUNNER_MODE_SETTING_KEY, FLY_PROCESS_LEVEL_SECRETS_SETTING_KEY];

export function readSavedSetup(ctx: SetupCheckContext): SavedSetup {
  const mappings = ctx.mappings();
  const sync = ctx.githubSetupFacts().workflowSync;
  const perProject = Object.fromEntries(Object.entries(mappings).map(([project, mapping]) => {
    const job = sync(project);
    // A sync queued again keeps its row's id, so a retry that fails differently shows only in the error the workflow check reads.
    return [project, { mapping: JSON.stringify(mapping), sync: JSON.stringify(job && [job.id, job.status, job.error?.message ?? null]) }];
  }));
  const allowlist = ctx.effectiveAllowlist();
  const fly = ctx.flySessions();
  return {
    perProject,
    orchestratorWide: JSON.stringify({
      settings: SAVED_SETUP_SETTINGS.map((key) => ctx.readSetting(key)),
      defaults: ctx.orchestratorDefaults()?.configRevisionId ?? null,
      stages: Object.keys(mappings).map((project) => ctx.projectStageConfig(project)?.configRevisionId ?? null),
      // An address's bindings are written at its first sign-in, which no check judges.
      allowlist: allowlist && { source: allowlist.source, entries: allowlist.entries.map(({ kind, value, role }) => [kind, value, role]) },
      allowlistReadable: ctx.allowlistReadAvailable(),
      fly: [ctx.runnerBackendSource(), fly.app, fly.region],
    }),
    allChecks: JSON.stringify([ctx.runnerMode().mode, ctx.readSetting(LINEAR_PICKUP_LABEL_KEY)]),
  };
}

/** A context reader's place in the saved setup: read by readSavedSetup, or left out for the reason given. */
type SavedSetupReader = "saved" | { leftOut: string };

/**
 * Every reader a check can call, and its place in the saved setup, so a reader added to the context does not compile until it is placed.
 * A reader is placed whole: which settings rows readSetting covers is SAVED_SETUP_SETTINGS and the pickup label.
 */
export const SAVED_SETUP_READERS: { [K in Exclude<keyof SetupCheckContext, "githubSetupFacts">]: SavedSetupReader } & {
  githubSetupFacts: Record<keyof GitHubSetupFacts, SavedSetupReader>;
} = {
  env: { leftOut: "A variable changes only with a restart, and boot runs the checks." },
  readSetting: "saved",
  orchestratorDefaults: "saved",
  projectStageConfig: "saved",
  runnerMode: "saved",
  flySessions: "saved",
  runnerBackendSource: "saved",
  mappings: "saved",
  storedAccessEntries: { leftOut: "A check reads only whether the saved list holds entries, which effectiveAllowlist's source says." },
  effectiveAllowlist: "saved",
  allowlistReadAvailable: "saved",
  restateStatus: { leftOut: "The process's own state, not a save." },
  databasePath: { leftOut: "Resolved once per process, from a variable." },
  onSeparateFilesystem: { leftOut: "The machine's mounts, not a save." },
  trackerProvider: { leftOut: "Built from the variables and the mappings, which are placed already." },
  trackerSetupFacts: { leftOut: "Read from the ticketing system, where no save here changes it." },
  orchestratorHealthAt: { leftOut: "A network read, which no save changes." },
  orchestratorInstanceId: { leftOut: "Fixed for the process's life." },
  githubSetupFacts: {
    app: { leftOut: "Read from GitHub, where no save here changes it." },
    installation: { leftOut: "Read from GitHub, where no save here changes it." },
    installationRepositories: { leftOut: "Read from GitHub, where no save here changes it." },
    repositories: { leftOut: "Read from GitHub, where no save here changes it." },
    publicRepository: { leftOut: "Read from GitHub, where no save here changes it." },
    deliveries: { leftOut: "Read from GitHub, where no save here changes it." },
    kgSourceRepo: { leftOut: "Set by KG_SOURCE_REPO, a variable." },
    kgPreflight: { leftOut: "Read from GitHub, where no save here changes it." },
    workflowSync: "saved",
  },
};

/** The runs a change from one saved setup to the next needs. */
export function runsForSavedChange(before: SavedSetup, after: SavedSetup): SetupCheckRunKind[] {
  if (after.allChecks !== before.allChecks) return [{ kind: "full" }];
  const runs: SetupCheckRunKind[] = [];
  // tracker.provider, model.credentials-adopted, runner.fly-sessions and runner.project-backend name projects, so a project saved, added or deleted changes their rows too.
  let orchestratorWide = after.orchestratorWide !== before.orchestratorWide || Object.keys(before.perProject).some((project) => !(project in after.perProject));
  for (const [project, now] of Object.entries(after.perProject)) {
    const was = before.perProject[project];
    if (was === undefined || was.mapping !== now.mapping) orchestratorWide = true;
    if (was === undefined || was.mapping !== now.mapping || was.sync !== now.sync) runs.push({ kind: "project", project });
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
    perProject: Object.fromEntries(Object.entries(saved.perProject).map(([project, { mapping, sync }]) => [project, { mapping: fingerprint(mapping), sync: fingerprint(sync) }])),
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
