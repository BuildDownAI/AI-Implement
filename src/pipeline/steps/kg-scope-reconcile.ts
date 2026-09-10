import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, YAMLSeq, isSeq, isMap, isScalar } from "yaml";
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

/** Number of spaces before the `-` on a fresh, top-level seq item, e.g. `  - slug: x`. */
const DEFAULT_DASH_INDENT = 2;

/**
 * Renders `entries` as standalone `- key: value` YAML fragment text (no leading key line),
 * indented so each item's dash sits `dashIndent` spaces in. Values are stringified through a
 * scratch `Document` — separate from the real one — so quoting matches the rest of the file
 * without ever touching an existing node.
 */
function renderSeqEntries(entries: Array<Record<string, unknown>>, dashIndent: number): string {
  const scratch = parseDocument("");
  const seq = new YAMLSeq();
  for (const entry of entries) seq.items.push(scratch.createNode(entry));
  scratch.set("_", seq);
  const rendered = scratch.toString();
  const body = rendered.slice(rendered.indexOf("\n") + 1);
  const delta = dashIndent - DEFAULT_DASH_INDENT;
  if (delta === 0) return body;
  return body
    .split("\n")
    .map((line) => {
      if (line.length === 0) return line;
      const leading = line.match(/^ */)?.[0].length ?? 0;
      return " ".repeat(Math.max(0, leading + delta)) + line.slice(leading);
    })
    .join("\n");
}

/** Number of spaces before the `-` on the seq item's own source line, e.g. 2 for `  - slug: x`. */
function dashIndentOf(raw: string, item: { range: readonly [number, number, number] }): number {
  const lineStart = raw.lastIndexOf("\n", item.range[0] - 1) + 1;
  const dashIdx = raw.slice(lineStart, item.range[0]).indexOf("-");
  return dashIdx === -1 ? DEFAULT_DASH_INDENT : dashIdx;
}

type Splice = { start: number; end: number; text: string };

/**
 * Computes how to add `entries` under `key` without re-serializing the document: a splice
 * into the existing raw text — appended after the last item, or replacing an empty/absent
 * value with a fresh block — or, when the key doesn't exist at all, a block to append once at
 * the end of the file. Returns null when there's nothing to add.
 */
function planSeqAddition(
  raw: string,
  doc: ReturnType<typeof parseDocument>,
  key: string,
  entries: Array<Record<string, unknown>>,
): { splice: Splice } | { appendBlock: string } | null {
  if (entries.length === 0) return null;

  const contents = doc.contents;
  const pair = isMap(contents) ? contents.items.find((p) => isScalar(p.key) && p.key.value === key) : undefined;

  if (!pair) {
    return { appendBlock: `${key}:\n${renderSeqEntries(entries, DEFAULT_DASH_INDENT)}` };
  }

  const value = pair.value;
  if (isSeq(value) && value.items.length > 0) {
    const dashIndent = dashIndentOf(raw, value.items[0] as { range: readonly [number, number, number] });
    const insertAt = (value.range as readonly [number, number, number])[1];
    const needsLeadingNewline = raw[insertAt - 1] !== "\n";
    const text = (needsLeadingNewline ? "\n" : "") + renderSeqEntries(entries, dashIndent);
    return { splice: { start: insertAt, end: insertAt, text } };
  }

  const isEmptyValue = (isSeq(value) && value.items.length === 0) || (isScalar(value) && value.value === null);
  if (!isEmptyValue) {
    console.warn(`[kg-scope-reconcile] "${key}" is not a sequence; skipping ${entries.length} addition(s)`);
    return null;
  }

  // Block-empty (`key:`) or flow-empty (`key: []`) — nothing to preserve, so replace the
  // value span with a freshly rendered block at the default indent.
  const start = (pair.key as { range: readonly [number, number, number] }).range[1];
  const end = (value as { range: readonly [number, number, number] }).range[2];
  return { splice: { start, end, text: `\n${renderSeqEntries(entries, DEFAULT_DASH_INDENT)}` } };
}

/**
 * Applies additions for several keys to `raw` by splicing new text around the untouched
 * original, never re-stringifying the whole document — so comment alignment, flow-style
 * collections, and every unrelated line survive byte-for-byte. `doc` is used only to locate
 * insertion points and sibling formatting; it is never serialized. Splices are computed
 * against the original `raw` for every key, then applied highest-offset-first so one splice
 * never invalidates another's offset.
 */
function applySeqAdditions(
  raw: string,
  doc: ReturnType<typeof parseDocument>,
  additions: Array<{ key: string; entries: Array<Record<string, unknown>> }>,
): string {
  const splices: Splice[] = [];
  const appendBlocks: string[] = [];

  for (const { key, entries } of additions) {
    const plan = planSeqAddition(raw, doc, key, entries);
    if (plan === null) continue;
    if ("splice" in plan) splices.push(plan.splice);
    else appendBlocks.push(plan.appendBlock);
  }

  splices.sort((a, b) => b.start - a.start);
  let out = raw;
  for (const { start, end, text } of splices) {
    out = out.slice(0, start) + text + out.slice(end);
  }

  if (appendBlocks.length > 0) {
    if (out.length > 0 && !out.endsWith("\n")) out += "\n";
    out += appendBlocks.join("");
  }

  return out;
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
    let baseRaw = raw;
    if (doc.errors.length > 0) {
      console.warn(`[kg-scope-reconcile] sources.yml has ${doc.errors.length} parse error(s); reconciling from an empty manifest`);
      doc = parseDocument("");
      baseRaw = "";
    }

    const output = applySeqAdditions(baseRaw, doc, [
      { key: "secondary_repos", entries: repoAdditions },
      { key: "trackers", entries: teamAdditions },
    ]);

    writeFn(join(workspaceDir, "sources.yml"), output);
    console.log(`[kg-scope-reconcile] added repos=${repoAdditions.length} teams=${teamAdditions.length}`);
    return { addedRepos: repoAdditions.length, addedTeams: teamAdditions.length, addedRepoSlugs, addedTeamNames, mappedProjectCount };
  },
};

export default kgScopeReconcileStep;
