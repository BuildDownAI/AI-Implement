import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";

interface KgTrackerDataInputs extends Record<string, unknown> {
  callbackUrl: string | null | undefined;
  workspaceDir: string;
  /** Test-only injectable fetch implementation. */
  fetchImpl?: typeof fetch;
  /** Test-only injectable fs.writeFileSync implementation. */
  writeFileSyncImpl?: (path: string, data: string) => void;
  /** Test-only injectable sources.yml reader. Returns team keys configured in the KG source repo. */
  sourcesYmlReaderImpl?: (workspaceDir: string) => string[];
}

interface KgTrackerDataOutputs extends Record<string, unknown> {
  fetched: boolean;
  issueCount: number;
}

/** Coded failure raised when the tracker-data fetch fails in a dispatched run. */
export class KgTrackerDataFetchError extends Error {
  readonly code = "KG_TRACKER_DATA_FETCH_FAILED";
  constructor(detail: string) {
    super(`KG_TRACKER_DATA_FETCH_FAILED: ${detail}`);
  }
}

interface TrackerIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  branchName: string | null;
  state: { name: string; type: string };
  labels: { nodes: Array<{ name: string }> };
  project: { name: string } | null;
  parent: { identifier: string } | null;
  comments: { nodes: Array<{ body: string; user: { name: string } | null; createdAt: string }> };
  relations: { nodes: Array<{ type: string; relatedIssue: { identifier: string } }> };
}

interface TrackerDataPage {
  issues: TrackerIssue[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
}

/**
 * Reads `trackers[].team` from sources.yml using YAML parsing with a regex fallback.
 * Returns an empty array when the file is absent or contains no tracker entries.
 */
function readTrackerTeams(workspaceDir: string): string[] {
  const filePath = join(workspaceDir, "sources.yml");
  if (!existsSync(filePath)) return [];

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  // Try YAML parsing first
  try {
    const doc = parseYaml(raw) as unknown;
    if (
      doc !== null &&
      typeof doc === "object" &&
      Array.isArray((doc as Record<string, unknown>).trackers)
    ) {
      const teams = ((doc as Record<string, unknown>).trackers as unknown[])
        .filter(
          (t): t is Record<string, unknown> =>
            t !== null && typeof t === "object" && !Array.isArray(t),
        )
        .map((t) => (typeof t.team === "string" ? t.team.trim() : null))
        .filter((t): t is string => t !== null && t.length > 0);
      if (teams.length > 0) return teams;
    }
  } catch {
    // Fall through to regex fallback
  }

  // Fallback: matches indented `team:` lines; value stops before any trailing comment
  const matches = [...raw.matchAll(/^\s+team:\s+(\S+)/gm)];
  return matches.map((m) => m[1]);
}

/** Returns v when it looks like "owner/repo" (non-empty on both sides, no whitespace), else null. */
function ownerRepo(v: string): string | null {
  return /^[^\s/]+\/[^\s/]+$/.test(v) ? v : null;
}

/**
 * Reads `secondary_repos[].slug` and optional `branch` from sources.yml.
 * Returns entries where `slug` passes the "owner/repo" validation.
 * When `branch` is present and non-empty after trimming, it is included in the
 * returned entry; otherwise the entry has no `branch` key.
 * Returns an empty array when the file is absent, the key is missing, the list
 * is empty, or the file cannot be parsed.
 */
export function readSecondaryReposFromSourcesYml(workspaceDir: string): Array<{ slug: string; branch?: string }> {
  const filePath = join(workspaceDir, "sources.yml");
  if (!existsSync(filePath)) return [];

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  try {
    const doc = parseYaml(raw) as unknown;
    if (doc !== null && typeof doc === "object") {
      const secondaryRepos = (doc as Record<string, unknown>).secondary_repos;
      if (Array.isArray(secondaryRepos)) {
        return secondaryRepos
          .filter(
            (r): r is Record<string, unknown> =>
              r !== null && typeof r === "object" && !Array.isArray(r),
          )
          .flatMap((r) => {
            const slug = typeof r.slug === "string" ? ownerRepo(r.slug.trim()) : null;
            if (slug === null) return [];
            const branchRaw = typeof r.branch === "string" ? r.branch.trim() : "";
            const branch = branchRaw || undefined;
            return [{ slug, ...(branch !== undefined ? { branch } : {}) }];
          });
      }
    }
  } catch {
    // malformed YAML → return empty
  }

  return [];
}

/**
 * Reads the top-level `code_repo:` key from sources.yml.
 * Accepts two forms:
 *   - string:  `code_repo: owner/name`
 *   - mapping: `code_repo:\n  slug: owner/name\n  branch: <b>\n  ...`
 * Returns `{ slug, branch? }` or null when the key is absent, the file
 * is missing, or the file cannot be parsed.
 * When `branch` is present in the mapping form and non-empty after trimming,
 * it is included; values starting with `-` are silently rejected (would be
 * misinterpreted as git flags). The string form never carries a branch.
 */
export function readCodeRepoFromSourcesYml(workspaceDir: string): { slug: string; branch?: string } | null {
  const filePath = join(workspaceDir, "sources.yml");
  if (!existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  try {
    const doc = parseYaml(raw) as unknown;
    if (doc !== null && typeof doc === "object") {
      const codeRepo = (doc as Record<string, unknown>).code_repo;
      if (typeof codeRepo === "string") {
        const slug = ownerRepo(codeRepo.trim());
        return slug !== null ? { slug } : null;
      }
      if (
        codeRepo !== null &&
        typeof codeRepo === "object" &&
        !Array.isArray(codeRepo) &&
        typeof (codeRepo as Record<string, unknown>).slug === "string"
      ) {
        const slug = ownerRepo(((codeRepo as Record<string, unknown>).slug as string).trim());
        if (slug === null) return null;
        const branchRaw = typeof (codeRepo as Record<string, unknown>).branch === "string"
          ? ((codeRepo as Record<string, unknown>).branch as string).trim()
          : "";
        const branch = branchRaw && !branchRaw.startsWith("-") ? branchRaw : undefined;
        return { slug, ...(branch !== undefined ? { branch } : {}) };
      }
    }
  } catch {
    // Fall through to regex fallback
  }

  // String form fallback: code_repo: owner/name (value on the same line)
  // If ownerRepo returns null (e.g. the match captured "slug:" from a mapping form
  // where \s+ crossed the newline), fall through to the mapping-form regex.
  const matchStr = raw.match(/^code_repo:\s+(\S+)/m);
  if (matchStr) {
    const slug = ownerRepo(matchStr[1]);
    if (slug !== null) return { slug };
  }
  // Mapping form fallback: code_repo:\n  slug: owner/name
  // Use [ \t]* (not \s*) so the trailing \n is not consumed by the whitespace class.
  // Branch is not captured in the regex fallback path (broken-YAML best-effort).
  const matchMapping = raw.match(/^code_repo:[ \t]*\n[ \t]+slug:[ \t]+(\S+)/m);
  if (matchMapping) {
    const slug = ownerRepo(matchMapping[1]);
    return slug !== null ? { slug } : null;
  }
  return null;
}

export const kgTrackerDataStep: StepModule<KgTrackerDataInputs, KgTrackerDataOutputs> = {
  async run(
    _context: PipelineContext,
    inputs: KgTrackerDataInputs,
    _reporter: StepReporter,
  ): Promise<KgTrackerDataOutputs> {
    const {
      callbackUrl,
      workspaceDir,
      fetchImpl: fetchFn = fetch,
      writeFileSyncImpl: writeFn = writeFileSync,
      sourcesYmlReaderImpl: readTeams = readTrackerTeams,
    } = inputs;

    // Read the bearer secret directly from the environment so it never appears
    // in step inputs, which are persisted to the step log and exposed via the admin API.
    const progressToken = process.env.RUN_PROGRESS_TOKEN?.trim() || null;

    if (!callbackUrl) {
      console.log("[kg-tracker-data] no callback URL; skipping");
      return { fetched: false, issueCount: 0 };
    }
    if (!progressToken) {
      console.log("[kg-tracker-data] no progress token (RUN_PROGRESS_TOKEN); skipping");
      return { fetched: false, issueCount: 0 };
    }

    const teams = readTeams(workspaceDir);
    if (teams.length === 0) {
      console.warn("[kg-tracker-data] no teams found in sources.yml; skipping");
      return { fetched: false, issueCount: 0 };
    }
    console.log(`[kg-tracker-data] teams from sources.yml: ${teams.join(", ")}`);

    const base = callbackUrl.replace(/\/+$/, "");
    const url = `${base}/api/runner/kg-tracker-data`;
    const allIssues: TrackerIssue[] = [];

    for (const team of teams) {
      let cursor: string | null = null;
      const teamIssues: TrackerIssue[] = [];

      try {
        do {
          const body: Record<string, string> = { teamKey: team };
          if (cursor) body.cursor = cursor;
          const res = await fetchFn(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${progressToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });
          if (res.status === 503) {
            console.log("[kg-tracker-data] Tracker not configured (503) — skipping");
            return { fetched: false, issueCount: 0 };
          }
          if (!res.ok) {
            console.error(`[kg-tracker-data] ${url} returned HTTP ${res.status}`);
            throw new KgTrackerDataFetchError(`endpoint returned ${res.status}`);
          }
          const page = (await res.json()) as TrackerDataPage;
          teamIssues.push(...page.issues);
          cursor = page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? null) : null;
        } while (cursor !== null);
      } catch (err) {
        if (err instanceof KgTrackerDataFetchError) throw err;
        throw new KgTrackerDataFetchError(
          `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      console.log(`[kg-tracker-data] team ${team}: ${teamIssues.length} issues`);
      if (teamIssues.length === 0) {
        throw new KgTrackerDataFetchError(
          `team ${team} returned 0 issues — a configured team must not be empty`,
        );
      }
      allIssues.push(...teamIssues);
    }

    writeFn(join(workspaceDir, "tracker-data.json"), JSON.stringify(allIssues));
    console.log(`[kg-tracker-data] fetched ${allIssues.length} issues`);
    return { fetched: true, issueCount: allIssues.length };
  },
};
