import { getDb } from "./dedup.js";

const GH_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "linear-dispatch-worker",
} as const;

function ghHeaders(token: string): Record<string, string> {
  return { ...GH_HEADERS, Authorization: `Bearer ${token}` };
}

function initMergeCaptureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS pr_merge_capture (
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      issue_id TEXT,
      merged_at INTEGER,
      approval_ts INTEGER,
      commits_runner INTEGER NOT NULL DEFAULT 0,
      commits_bot INTEGER NOT NULL DEFAULT 0,
      commits_human INTEGER NOT NULL DEFAULT 0,
      post_approval_lines INTEGER NOT NULL DEFAULT 0,
      findings_json TEXT NOT NULL DEFAULT '{}',
      review_escape INTEGER NOT NULL DEFAULT 0,
      captured_at INTEGER NOT NULL,
      PRIMARY KEY (repo, pr_number)
    )
  `);
}

function queryApprovalTs(issueId: string): number | null {
  try {
    const row = getDb()
      .prepare(
        `SELECT MAX(sl.ended_at) AS max_ended_at
         FROM step_log sl
         JOIN dispatch_log dl ON sl.job_id = dl.id
         WHERE dl.issue_id = ?
           AND sl.step_type = 'review'
           AND json_extract(sl.outputs_json, '$.approved') = 1`,
      )
      .get(issueId) as { max_ended_at: string | null } | undefined;
    const iso = row?.max_ended_at;
    if (!iso) return null;
    const ts = new Date(iso).getTime();
    return isNaN(ts) ? null : ts;
  } catch {
    return null;
  }
}

function bucketCommit(
  login: string,
  appBotLogin: string | undefined,
): "runner" | "bot" | "human" {
  if (appBotLogin && login === appBotLogin) return "runner";
  if (login.endsWith("[bot]")) return "bot";
  return "human";
}

function bucketFinding(
  login: string,
  body?: string,
): "claude-review" | "codex" | "human" {
  // External Claude review posts as github-actions[bot] with a body starting with "Claude finished"
  if (login === "github-actions[bot]" && body?.includes("Claude finished"))
    return "claude-review";
  if (login.toLowerCase().includes("codex")) return "codex";
  return "human";
}

type GhPullRequest = {
  merged_at: string | null;
};

type GhCommit = {
  sha: string;
  author: { login: string } | null;
  commit: { author: { date: string }; committer?: { date: string } };
};

type GhSingleCommit = {
  stats?: { additions?: number; deletions?: number };
};

type GhReview = {
  user: { login: string } | null;
  state: string;
  submitted_at: string;
};

type GhComment = {
  user: { login: string } | null;
  created_at: string;
};

type GhIssueComment = {
  user: { login: string } | null;
  body: string;
  created_at: string;
};

export async function capturePrMerge(opts: {
  repo: string;
  prNumber: number;
  issueId?: string;
  token: string;
  appBotLogin?: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { repo, prNumber, issueId, token, appBotLogin, fetchImpl = fetch } = opts;

  initMergeCaptureTable();

  const approvalTs = issueId ? queryApprovalTs(issueId) : null;

  const base = `https://api.github.com/repos/${repo}`;
  const headers = ghHeaders(token);

  const [prRes, commitsRes, reviewsRes, prCommentsRes, issueCommentsRes] = await Promise.all([
    fetchImpl(`${base}/pulls/${prNumber}`, { headers }),
    fetchImpl(`${base}/pulls/${prNumber}/commits?per_page=100`, { headers }),
    fetchImpl(`${base}/pulls/${prNumber}/reviews?per_page=100`, { headers }),
    fetchImpl(`${base}/pulls/${prNumber}/comments?per_page=100`, { headers }),
    fetchImpl(`${base}/issues/${prNumber}/comments?per_page=100`, { headers }),
  ]);

  if (!prRes.ok) throw new Error(`PR fetch failed: HTTP ${prRes.status}`);
  if (!commitsRes.ok) throw new Error(`commits fetch failed: HTTP ${commitsRes.status}`);
  if (!reviewsRes.ok) throw new Error(`reviews fetch failed: HTTP ${reviewsRes.status}`);
  if (!prCommentsRes.ok) throw new Error(`PR comments fetch failed: HTTP ${prCommentsRes.status}`);
  if (!issueCommentsRes.ok)
    throw new Error(`issue comments fetch failed: HTTP ${issueCommentsRes.status}`);

  const pr = (await prRes.json()) as GhPullRequest;
  const commits = (await commitsRes.json()) as GhCommit[];
  const reviews = (await reviewsRes.json()) as GhReview[];
  const prComments = (await prCommentsRes.json()) as GhComment[];
  const issueComments = (await issueCommentsRes.json()) as GhIssueComment[];

  const mergedAtMs = pr.merged_at ? new Date(pr.merged_at).getTime() : null;
  const mergedAt = mergedAtMs !== null && !isNaN(mergedAtMs) ? mergedAtMs : null;

  let commitsRunner = 0;
  let commitsBot = 0;
  let commitsHuman = 0;
  let postApprovalLines = 0;

  const postApprovalShas: string[] = [];

  for (const c of commits) {
    const login = c.author?.login ?? "";
    const commitDateStr = c.commit.committer?.date ?? c.commit.author.date;
    const commitTs = new Date(commitDateStr).getTime();

    if (approvalTs !== null && commitTs <= approvalTs) continue;

    // Only collect SHAs for line-count fetches when an approval timestamp exists,
    // since "post_approval_lines" is undefined without an approval.
    if (approvalTs !== null) {
      postApprovalShas.push(c.sha);
    }

    const bucket = login ? bucketCommit(login, appBotLogin) : "human";
    if (bucket === "runner") commitsRunner++;
    else if (bucket === "bot") commitsBot++;
    else commitsHuman++;
  }

  // Fetch per-commit stats from the single-commit endpoint; the list endpoint omits stats.
  for (const sha of postApprovalShas) {
    const res = await fetchImpl(`${base}/commits/${sha}`, { headers });
    if (res.ok) {
      const data = (await res.json()) as GhSingleCommit;
      postApprovalLines += (data.stats?.additions ?? 0) + (data.stats?.deletions ?? 0);
    }
  }

  const findings: Record<string, number> = { "claude-review": 0, codex: 0, human: 0 };

  for (const comment of prComments) {
    const login = comment.user?.login ?? "";
    if (appBotLogin && login === appBotLogin) continue;
    const commentTs = new Date(comment.created_at).getTime();
    if (approvalTs !== null && commentTs <= approvalTs) continue;
    findings[bucketFinding(login)]!++;
  }

  for (const comment of issueComments) {
    const login = comment.user?.login ?? "";
    if (appBotLogin && login === appBotLogin) continue;
    const commentTs = new Date(comment.created_at).getTime();
    if (approvalTs !== null && commentTs <= approvalTs) continue;
    findings[bucketFinding(login, comment.body)]!++;
  }

  for (const review of reviews) {
    if (review.state !== "CHANGES_REQUESTED" && review.state !== "COMMENTED") continue;
    const login = review.user?.login ?? "";
    if (appBotLogin && login === appBotLogin) continue;
    const reviewTs = new Date(review.submitted_at).getTime();
    if (approvalTs !== null && reviewTs <= approvalTs) continue;
    findings[bucketFinding(login)]!++;
  }

  const externalFindings =
    (findings["claude-review"] ?? 0) + (findings["codex"] ?? 0) + (findings["human"] ?? 0);

  const reviewEscape =
    approvalTs !== null && (commitsHuman + commitsBot > 0 || externalFindings > 0) ? 1 : 0;

  getDb()
    .prepare(
      `INSERT OR REPLACE INTO pr_merge_capture
         (repo, pr_number, issue_id, merged_at, approval_ts, commits_runner, commits_bot, commits_human,
          post_approval_lines, findings_json, review_escape, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      repo,
      prNumber,
      issueId ?? null,
      mergedAt,
      approvalTs,
      commitsRunner,
      commitsBot,
      commitsHuman,
      postApprovalLines,
      JSON.stringify(findings),
      reviewEscape,
      Date.now(),
    );
}
