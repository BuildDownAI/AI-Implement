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

function bucketFinding(login: string): "claude-review" | "codex" | "human" {
  const lower = login.toLowerCase();
  if (lower.includes("claude")) return "claude-review";
  if (lower.includes("codex")) return "codex";
  return "human";
}

type GhCommit = {
  author: { login: string } | null;
  commit: { author: { date: string }; committer?: { date: string } };
  stats?: { additions?: number; deletions?: number };
};

type GhReview = {
  user: { login: string } | null;
  state: string;
};

type GhComment = {
  user: { login: string } | null;
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

  const base = `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
  const headers = ghHeaders(token);

  const [commitsRes, reviewsRes, commentsRes] = await Promise.all([
    fetchImpl(`${base}/commits?per_page=100`, { headers }),
    fetchImpl(`${base}/reviews?per_page=100`, { headers }),
    fetchImpl(`${base}/comments?per_page=100`, { headers }),
  ]);

  if (!commitsRes.ok) throw new Error(`commits fetch failed: HTTP ${commitsRes.status}`);
  if (!reviewsRes.ok) throw new Error(`reviews fetch failed: HTTP ${reviewsRes.status}`);
  if (!commentsRes.ok) throw new Error(`comments fetch failed: HTTP ${commentsRes.status}`);

  const commits = (await commitsRes.json()) as GhCommit[];
  const reviews = (await reviewsRes.json()) as GhReview[];
  const comments = (await commentsRes.json()) as GhComment[];

  let commitsRunner = 0;
  let commitsBot = 0;
  let commitsHuman = 0;
  let postApprovalLines = 0;

  for (const c of commits) {
    const login = c.author?.login ?? "";
    const commitDateStr = c.commit.committer?.date ?? c.commit.author.date;
    const commitTs = new Date(commitDateStr).getTime();

    if (approvalTs !== null && commitTs <= approvalTs) continue;

    const bucket = login ? bucketCommit(login, appBotLogin) : "human";
    if (bucket === "runner") commitsRunner++;
    else if (bucket === "bot") commitsBot++;
    else commitsHuman++;

    postApprovalLines += (c.stats?.additions ?? 0) + (c.stats?.deletions ?? 0);
  }

  const findings: Record<string, number> = { "claude-review": 0, codex: 0, human: 0 };

  for (const comment of comments) {
    const login = comment.user?.login ?? "";
    findings[bucketFinding(login)]!++;
  }

  for (const review of reviews) {
    if (review.state !== "CHANGES_REQUESTED" && review.state !== "COMMENTED") continue;
    const login = review.user?.login ?? "";
    findings[bucketFinding(login)]!++;
  }

  const externalFindings = (findings["codex"] ?? 0) + (findings["human"] ?? 0);
  const reviewEscape =
    approvalTs !== null && (commitsHuman + commitsBot > 0 || externalFindings > 0) ? 1 : 0;

  getDb()
    .prepare(
      `INSERT OR REPLACE INTO pr_merge_capture
         (repo, pr_number, issue_id, merged_at, approval_ts, commits_runner, commits_bot, commits_human,
          post_approval_lines, findings_json, review_escape, captured_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      repo,
      prNumber,
      issueId ?? null,
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
