import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, YAMLSeq, isSeq } from "yaml";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import {
  readCodeRepoFromSourcesYml,
  readSecondaryReposFromSourcesYml,
  readTrackerRecords,
  ownerRepo,
  isSafeBranch,
} from "./kg-tracker-data.js";

interface KgScopeMapping {
  teamKey: string;
  repo: string;
  defaultBranch: string;
  ticketingProvider: string;
}

interface KgScopeReconcileInputs extends Record<string, unknown> {
  callbackUrl: string | null | undefined;
  workspaceDir: string;
  /** Dev-harness / dry-run mode: compute and log the diff but never write sources.yml. */
  dryRun?: boolean;
  /**
   * The KG source repo itself (`owner/name`, from the clone step). A KG repo is usually
   * mapped in the orchestrator too (its own issues run through the pipeline), and it
   * already self-ingests; it must never be added as its own secondary.
   */
  selfRepoSlug?: string;
  /** Test-only injectable fetch implementation. */
  fetchImpl?: typeof fetch;
  /** Test-only injectable fs.writeFileSync implementation. */
  writeFileSyncImpl?: (path: string, data: string) => void;
}

interface KgScopeReconcileOutputs extends Record<string, unknown> {
  addedRepos: number;
  addedTeams: number;
  /** Slugs added to secondary_repos this run — feeds the kg-snapshot-push report's Scope section. */
  addedRepoSlugs: string[];
  /** Team keys added to trackers this run — feeds the kg-snapshot-push report's Scope section. */
  addedTeamNames: string[];
  /** Total orchestrator mappings seen this run (0 when skipped: no callback URL/token, or the fetch failed). */
  mappedProjectCount: number;
}

/**
 * Validates a trimmed, possibly-empty branch value against `isSafeBranch`, logging and
 * dropping it when unsafe. Returns `undefined` for an empty or rejected value. A mapping's
 * defaultBranch is orchestrator-controlled, but this still validates before writing it into
 * a file that later gets `git checkout`'d as a branch ref (defense in depth).
 */
function sanitizeBranch(branchRaw: string, slug: string): string | undefined {
  if (branchRaw.length === 0) return undefined;
  if (isSafeBranch(branchRaw)) return branchRaw;
  console.warn(`[kg-scope-reconcile] rejecting unsafe branch for ${slug}: ${JSON.stringify(branchRaw)}`);
  return undefined;
}

/**
 * Appends `entries` to the YAMLSeq at `key`, creating the seq if the key is entirely
 * absent. Uses the yaml package's Document API rather than parse+stringify so untouched
 * keys, comments, and formatting survive byte-for-byte — sources.yml is an operator-owned,
 * hand-edited manifest (docs/kg-architecture.md), and a full round-trip would reformat it.
 * Note: flow-style collections elsewhere in the file (e.g. `globs: [a, b]`) may still be
 * reformatted by `doc.toString()` even when untouched — this codebase's sources.yml fixtures
 * use block style throughout, which round-trips losslessly.
 */
function appendSeqEntries(
  doc: ReturnType<typeof parseDocument>,
  key: string,
  entries: Array<Record<string, unknown>>,
): void {
  if (entries.length === 0) return;
  let seq = doc.get(key, true) as unknown;
  if (!isSeq(seq)) {
    seq = new YAMLSeq();
    doc.set(key, seq);
  }
  for (const entry of entries) {
    (seq as YAMLSeq).items.push(doc.createNode(entry));
  }
}

function readSourcesYmlRaw(workspaceDir: string): string {
  const filePath = join(workspaceDir, "sources.yml");
  if (!existsSync(filePath)) return "";
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

const EMPTY_OUTPUTS: KgScopeReconcileOutputs = {
  addedRepos: 0,
  addedTeams: 0,
  addedRepoSlugs: [],
  addedTeamNames: [],
  mappedProjectCount: 0,
};

export const kgScopeReconcileStep: StepModule<KgScopeReconcileInputs, KgScopeReconcileOutputs> = {
  async run(
    _context: PipelineContext,
    inputs: KgScopeReconcileInputs,
    _reporter: StepReporter,
  ): Promise<KgScopeReconcileOutputs> {
    const {
      callbackUrl,
      workspaceDir,
      dryRun = false,
      fetchImpl: fetchFn = fetch,
      writeFileSyncImpl: writeFn = writeFileSync,
    } = inputs;

    if (!callbackUrl) {
      console.log("[kg-scope-reconcile] no callback URL; scope reconcile skipped");
      return EMPTY_OUTPUTS;
    }

    // Read the bearer secret directly from the environment so it never appears
    // in step inputs, which are persisted to the step log and exposed via the admin API.
    const progressToken = process.env.RUN_PROGRESS_TOKEN?.trim() || null;
    if (!progressToken) {
      console.log("[kg-scope-reconcile] no progress token (RUN_PROGRESS_TOKEN); scope reconcile skipped");
      return EMPTY_OUTPUTS;
    }

    const base = callbackUrl.replace(/\/+$/, "");
    const url = `${base}/api/runner/kg-scope`;
    let mappings: KgScopeMapping[];
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${progressToken}` },
      });
      if (!res.ok) {
        console.warn(`[kg-scope-reconcile] ${url} returned HTTP ${res.status}; scope reconcile skipped`);
        return EMPTY_OUTPUTS;
      }
      const parsed = (await res.json()) as unknown;
      mappings = Array.isArray(parsed) ? (parsed as KgScopeMapping[]) : [];
    } catch (err) {
      console.warn(
        `[kg-scope-reconcile] fetch failed: ${err instanceof Error ? err.message : String(err)}; scope reconcile skipped`,
      );
      return EMPTY_OUTPUTS;
    }

    const codeRepoSlug = readCodeRepoFromSourcesYml(workspaceDir)?.slug ?? null;
    const selfSlug = typeof inputs.selfRepoSlug === "string" ? inputs.selfRepoSlug.trim().toLowerCase() : null;
    const existingSecondarySlugs = new Set(readSecondaryReposFromSourcesYml(workspaceDir).map((r) => r.slug));
    const existingTeams = new Set(readTrackerRecords(workspaceDir).map((t) => t.team));

    const repoAdditions: Array<{ slug: string; branch?: string }> = [];
    const teamAdditions: Array<{ kind: string; team: string; tier: string }> = [];
    const seenRepoSlugs = new Set<string>();
    const seenTeams = new Set<string>();

    for (const m of mappings) {
      const slug = typeof m.repo === "string" ? ownerRepo(m.repo.trim()) : null;
      if (slug === null) {
        console.warn(`[kg-scope-reconcile] dropping mapping team=${m.teamKey ?? "?"} with unsafe/invalid repo: ${JSON.stringify(m.repo)}`);
      } else if (selfSlug !== null && slug.toLowerCase() === selfSlug) {
        console.log(`[kg-scope-reconcile] skipping ${slug}: it is this KG repo (self-ingested, never a secondary of itself)`);
      } else if (slug !== codeRepoSlug && !existingSecondarySlugs.has(slug) && !seenRepoSlugs.has(slug)) {
        const branchRaw = typeof m.defaultBranch === "string" ? m.defaultBranch.trim() : "";
        const branch = sanitizeBranch(branchRaw, slug);
        repoAdditions.push({ slug, ...(branch !== undefined ? { branch } : {}) });
        seenRepoSlugs.add(slug);
      }

      const team = typeof m.teamKey === "string" ? m.teamKey.trim() : "";
      if (team && !existingTeams.has(team) && !seenTeams.has(team)) {
        const kind =
          typeof m.ticketingProvider === "string" && m.ticketingProvider.trim() ? m.ticketingProvider.trim() : "linear";
        teamAdditions.push({ kind, team, tier: "secondary" });
        seenTeams.add(team);
      }
    }

    const mappedProjectCount = mappings.length;

    if (repoAdditions.length === 0 && teamAdditions.length === 0) {
      console.log("[kg-scope-reconcile] scope in sync");
      return { ...EMPTY_OUTPUTS, mappedProjectCount };
    }

    const addedRepoSlugs = repoAdditions.map((r) => r.slug);
    const addedTeamNames = teamAdditions.map((t) => t.team);

    if (dryRun) {
      console.log(`[kg-scope-reconcile] dry-run: would add repos=${repoAdditions.length} teams=${teamAdditions.length}`);
      return { addedRepos: repoAdditions.length, addedTeams: teamAdditions.length, addedRepoSlugs, addedTeamNames, mappedProjectCount };
    }

    const raw = readSourcesYmlRaw(workspaceDir);
    let doc = parseDocument(raw);
    if (doc.errors.length > 0) {
      console.warn(`[kg-scope-reconcile] sources.yml has ${doc.errors.length} parse error(s); reconciling from an empty manifest`);
      doc = parseDocument("");
    }

    appendSeqEntries(doc, "secondary_repos", repoAdditions);
    appendSeqEntries(doc, "trackers", teamAdditions);

    writeFn(join(workspaceDir, "sources.yml"), doc.toString());
    console.log(`[kg-scope-reconcile] added repos=${repoAdditions.length} teams=${teamAdditions.length}`);
    return { addedRepos: repoAdditions.length, addedTeams: teamAdditions.length, addedRepoSlugs, addedTeamNames, mappedProjectCount };
  },
};

export default kgScopeReconcileStep;
