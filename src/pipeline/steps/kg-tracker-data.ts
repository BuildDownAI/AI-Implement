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
  state: { name: string; type: string };
  comments: Array<{ body: string; createdAt: string }>;
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

/**
 * Reads the top-level `code_repo:` key from sources.yml.
 * Returns the value as `"owner/repo"` or null when the key is absent, the file
 * is missing, or the file cannot be parsed.
 */
export function readCodeRepoFromSourcesYml(workspaceDir: string): string | null {
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
    if (
      doc !== null &&
      typeof doc === "object" &&
      typeof (doc as Record<string, unknown>).code_repo === "string"
    ) {
      const value = ((doc as Record<string, unknown>).code_repo as string).trim();
      return value || null;
    }
  } catch {
    // Fall through to regex fallback
  }

  // Fallback: matches a top-level `code_repo:` line; value stops before any trailing comment
  const match = raw.match(/^code_repo:\s+(\S+)/m);
  return match ? match[1] : null;
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
