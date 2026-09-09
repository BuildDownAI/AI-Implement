import type { LLMResult } from "./types.js";

export const UNAPPROVED_TITLE_PREFIX = "[NEEDS REVIEW — unapproved] ";

export interface OpenOrFindPullRequestInputs {
  repoOwner: string;
  repoRepo: string;
  githubToken: string;
  prTitle: string;
  branchName: string;
  baseBranch: string;
  prBody: string;
  draft: boolean;
}

/**
 * Create the PR, tolerating 422 (already exists) by finding the open PR. Shared
 * between push.ts (implementation PRs, which may be draft) and kg-snapshot-push.ts
 * (refresh PRs, always non-draft) — see ADR 013: no second PR helper.
 */
export async function openOrFindPullRequest(
  inputs: OpenOrFindPullRequestInputs,
): Promise<{ url: string; number: number; draft: boolean }> {
  const { repoOwner, repoRepo, githubToken, prTitle, branchName, baseBranch, prBody, draft } = inputs;

  const create = async (title: string, asDraft: boolean): Promise<Response> =>
    fetch(`https://api.github.com/repos/${repoOwner}/${repoRepo}/pulls`, {
      method: "POST",
      headers: { Authorization: `Bearer ${githubToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title, head: branchName, base: baseBranch, body: prBody, ...(asDraft ? { draft: true } : {}) }),
    });

  const parseCreated = async (res: Response, asDraft: boolean): Promise<{ url: string; number: number; draft: boolean }> => {
    const pr = (await res.json()) as { html_url?: unknown; number?: unknown };
    if (typeof pr.html_url !== "string" || typeof pr.number !== "number") {
      throw new Error("Unexpected PR creation response shape from GitHub API");
    }
    return { url: pr.html_url, number: pr.number, draft: asDraft };
  };

  const prRes = await create(prTitle, draft);
  if (prRes.ok) return parseCreated(prRes, draft);

  if (prRes.status === 422) {
    // Ambiguous: either the PR already exists, or the repo plan rejects draft
    // PRs. Check for an existing open PR first (existing behavior), then — if
    // we were drafting — retry as a clearly-titled normal PR so the work is
    // never vaporized on Free-plan private repos.
    const listRes = await fetch(
      `https://api.github.com/repos/${repoOwner}/${repoRepo}/pulls?head=${repoOwner}:${branchName}&state=open`,
      { headers: { Authorization: `Bearer ${githubToken}` } },
    );
    if (!listRes.ok) {
      const listBody = await listRes.text().catch(() => "");
      throw new Error(`PR already exists (422) but listing open PRs failed with HTTP ${listRes.status}: ${listBody}`);
    }
    const prs = (await listRes.json()) as Array<{ html_url?: unknown; number?: unknown; draft?: unknown }>;
    if (prs.length > 0) {
      const existing = prs[0];
      if (typeof existing.html_url === "string" && typeof existing.number === "number") {
        return { url: existing.html_url, number: existing.number, draft: existing.draft === true };
      }
    }
    if (draft) {
      const retryRes = await create(`${UNAPPROVED_TITLE_PREFIX}${prTitle}`, false);
      if (retryRes.ok) return parseCreated(retryRes, false);
      const retryBody = await retryRes.text().catch(() => "");
      throw new Error(`Draft PR rejected (422) and non-draft fallback failed with HTTP ${retryRes.status}: ${retryBody}`);
    }
    throw new Error(`PR already exists (422) but no open PR found for branch ${branchName}`);
  }

  const body = await prRes.text().catch(() => "");
  throw new Error(`PR creation failed with HTTP ${prRes.status}: ${body}`);
}

export function formatLlmResultDetail(result: { stdout?: string; stderr?: string }): string {
  const detail = (result.stderr || result.stdout || "").trim();
  return detail ? `: ${detail}` : "";
}

export function formatGitNameStatusSummary(stdout: string): string {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return "";

  return lines.map((line) => {
    const [status, file] = line.split(/\s+/, 2);
    const label = status === "A" ? "Added" : status === "M" ? "Modified" : status === "D" ? "Deleted" : "Changed";
    return `- ${label}: \`${file ?? line}\``;
  }).join("\n");
}

/** Both review stages require a successful terminal event before using a verdict. */
export function terminalResultFailureMessage(
  result: Pick<LLMResult, "terminalStatus" | "telemetry" | "stdout" | "stderr">,
  label: string,
): string | null {
  const detail = formatLlmResultDetail(result);
  if (!result.terminalStatus) return `${label} did not return a terminal result event${detail}`;
  const { subtype, isError } = result.terminalStatus;
  if (isError === true) return `${label} returned an error terminal result (subtype=${subtype ?? "unknown"})${detail}`;
  if (subtype !== "success") return `${label} finished without a successful terminal result (subtype=${subtype ?? "unknown"})${detail}`;
  if (result.telemetry?.outcome && result.telemetry.outcome !== "success") {
    return `${label} finished without a successful terminal result (${result.telemetry.outcome})${detail}`;
  }
  return null;
}
