import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";

interface KgTrackerDataInputs extends Record<string, unknown> {
  callbackUrl: string | null | undefined;
  workspaceDir: string;
  /** Test-only injectable fetch implementation. */
  fetchImpl?: typeof fetch;
  /** Test-only injectable fs.writeFileSync implementation. */
  writeFileSyncImpl?: (path: string, data: string) => void;
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

    const base = callbackUrl.replace(/\/+$/, "");
    const url = `${base}/api/runner/kg-tracker-data`;
    const allIssues: TrackerIssue[] = [];
    let cursor: string | null = null;

    try {
      do {
        const res = await fetchFn(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${progressToken}`,
            "Content-Type": "application/json",
          },
          body: cursor ? JSON.stringify({ cursor }) : "{}",
        });
        if (!res.ok) {
          throw new KgTrackerDataFetchError(`endpoint returned ${res.status}`);
        }
        const page = (await res.json()) as TrackerDataPage;
        allIssues.push(...page.issues);
        cursor = page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? null) : null;
      } while (cursor !== null);
    } catch (err) {
      if (err instanceof KgTrackerDataFetchError) throw err;
      throw new KgTrackerDataFetchError(
        `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    writeFn(join(workspaceDir, "tracker-data.json"), JSON.stringify(allIssues));
    console.log(`[kg-tracker-data] fetched ${allIssues.length} issues`);
    return { fetched: true, issueCount: allIssues.length };
  },
};
