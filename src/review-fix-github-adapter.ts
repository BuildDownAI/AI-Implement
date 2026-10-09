/** GitHub effects and live approval gates for the Restate review-fix finalizer.
 * Installation credentials are resolved inside each call and never returned to
 * a Restate step. The stable attempt marker makes a lost POST acknowledgement
 * observable on retry before another comment is written. */
import type { AttemptId, ScopedPrIdentity } from "./review-fix-contract.js";
import type { ReviewFixGitHubAdapter } from "./review-fix-finalize.js";
import type { ReviewFixWorkerCredentialResolver } from "./review-fix-worker.js";
import { defaultFetchSignal } from "./github.js";

export interface ReviewFixGithubAdapterDeps {
  credentials: ReviewFixWorkerCredentialResolver;
  fetchImpl?: typeof fetch;
}

function coordinates(scope: ScopedPrIdentity): { owner: string; repo: string } {
  const parts = scope.repository.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("invalid review-fix repository");
  return { owner: parts[0], repo: parts[1] };
}

function marker(attemptId: AttemptId): string {
  return `<!-- ai-implement:review-fix:${attemptId} -->`;
}

function nextPage(response: Response): string | null {
  const link = response.headers.get("link") ?? "";
  const match = /<([^>]+)>;\s*rel="next"/.exec(link);
  return match?.[1] ?? null;
}

export function createReviewFixGithubAdapter(deps: ReviewFixGithubAdapterDeps): ReviewFixGitHubAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function request(scope: ScopedPrIdentity, path: string, init?: RequestInit): Promise<Response> {
    const credential = await deps.credentials.resolve(scope);
    if (credential.installationId !== scope.installationId) throw new Error("review-fix installation changed");
    const { owner, repo } = coordinates(scope);
    const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}${path}`, {
      ...init,
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${credential.token}`,
        "x-github-api-version": "2022-11-28", ...init?.headers },
      signal: init?.signal ?? defaultFetchSignal(),
    });
    if (!response.ok) throw new Error(`review-fix GitHub request failed: HTTP ${response.status}`);
    return response;
  }

  async function pull(scope: ScopedPrIdentity): Promise<{ state?: string; draft?: boolean; merged?: boolean;
    mergeable?: boolean | null; mergeable_state?: string; head?: { sha?: string } }> {
    return await (await request(scope, `/pulls/${scope.prNumber}`)).json();
  }

  async function comments(scope: ScopedPrIdentity): Promise<Array<{ body: string }>> {
    const { owner, repo } = coordinates(scope);
    let path: string | null = `/issues/${scope.prNumber}/comments?per_page=100`;
    const all: Array<{ body: string }> = [];
    while (path) {
      const response = await request(scope, path);
      const rows = await response.json() as Array<{ body?: string }>;
      all.push(...rows.map((row) => ({ body: row.body ?? "" })));
      const next = nextPage(response);
      if (!next) break;
      const expected = `https://api.github.com/repos/${owner}/${repo}/`;
      if (!next.startsWith(expected)) throw new Error("review-fix comments pagination escaped repository");
      path = `/${next.slice(expected.length)}`;
    }
    return all;
  }

  return {
    async getPrHeadSha(scope) {
      try {
        const pr = await pull(scope);
        return pr.state === "open" && !pr.merged && /^[0-9a-f]{40}$/.test(pr.head?.sha ?? "")
          ? pr.head!.sha! : null;
      } catch { return null; }
    },
    async evaluateMergePolicy(scope, _dispositions) {
      try {
        const pr = await pull(scope);
        if (pr.state !== "open" || pr.draft || pr.merged || pr.mergeable !== true || pr.mergeable_state !== "clean") return false;
        const sha = pr.head?.sha;
        if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return false;
        const checks = await request(scope, `/commits/${sha}/check-runs?per_page=100`);
        const checkData = await checks.json() as { total_count?: number;
          check_runs?: Array<{ status?: string; conclusion?: string | null }> };
        if ((checkData.total_count ?? 0) > (checkData.check_runs?.length ?? 0) || nextPage(checks)) return false;
        const failed = new Set(["failure", "timed_out", "cancelled", "action_required", "stale"]);
        if ((checkData.check_runs ?? []).some((check) => check.status !== "completed" ||
          (check.conclusion !== null && check.conclusion !== undefined && failed.has(check.conclusion)))) return false;
        const status = await (await request(scope, `/commits/${sha}/status`)).json() as { state?: string; total_count?: number };
        if ((status.total_count ?? 0) > 0 && status.state !== "success") return false;
        const reviews = await request(scope, `/pulls/${scope.prNumber}/reviews?per_page=100`);
        const rows = await reviews.json() as Array<{ user?: { id?: number }; state?: string }>;
        const latest = new Map<number, string>();
        for (const row of rows) {
          if (typeof row.user?.id === "number" && row.state && row.state !== "COMMENTED") latest.set(row.user.id, row.state);
        }
        return ![...latest.values()].includes("CHANGES_REQUESTED") && !nextPage(reviews);
      } catch { return false; }
    },
    async hasAppliedApprovalEffect(scope, attemptId) {
      return (await comments(scope)).some((comment) => comment.body.startsWith(marker(attemptId)));
    },
    async applyApprovalEffect(scope, attemptId, result, dispositions) {
      if ((await comments(scope)).some((comment) => comment.body.startsWith(marker(attemptId)))) return;
      const body = `${marker(attemptId)}\nReview-fix attempt completed for commit \`${result.outputCommit}\`.\n\n` +
        (dispositions.length
          ? dispositions.map((item) => `- \`${item.findingKey}\`: ${item.disposition}`).join("\n")
          : "No structured findings were included in this attempt.");
      await request(scope, `/issues/${scope.prNumber}/comments`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }),
      });
    },
  };
}
