import { spawnSync } from "node:child_process";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { formatGitNameStatusSummary } from "../step-utils.js";
import { span } from "../timing.js";
import { findSensitiveFiles, SensitiveFilesError } from "../sensitive-files.js";

const LS_REMOTE_MAX_ATTEMPTS = 3;
const LS_REMOTE_RETRY_DELAYS_MS = [250, 1000];

export const UNAPPROVED_TITLE_PREFIX = "[NEEDS REVIEW — unapproved] ";

export interface ReviewSummary extends Record<string, unknown> {
  terminationReason: string;
  iterations: number;
  finalFeedback: string;
  passes: Array<{ iteration: number; implementTurns: number | null; implementOutcome: string; costUsd: number | null; reviewApproved: boolean | null }>;
  postMortem?: string;
}

interface PushInputs extends Record<string, unknown> {
  workspaceDir: string;
  repoOwner: string;
  repoRepo: string;
  githubToken: string;
  branchName: string;
  baseBranch?: string;
  prTitle?: string;
  implementationSummary?: string;
  testsSummary?: string;
  sensitiveFiles?: { add?: string[]; allow?: string[] };
  draft?: boolean;
  reviewSummary?: ReviewSummary;
  /** True when this is a grouping parent's own closing-work run. When the agent produces
   *  no changes (no working-tree diff and no commits ahead of base), the step returns a
   *  clean no-op instead of throwing, letting the orchestrator trigger the roll-up PR. */
  groupingParent?: boolean;
}

interface PushOutputs extends Record<string, unknown> {
  prUrl: string | null;
  prNumber: number | null;
  branchPushed: boolean;
  commitSha: string | null;
  draft: boolean;
}

export const pushStep: StepModule<PushInputs, PushOutputs> = {
  async run(
    context: PipelineContext,
    inputs: PushInputs,
    _reporter: StepReporter,
  ): Promise<PushOutputs> {
    if (
      process.env.AI_IMPLEMENT_WORKSPACE_MODE === "mounted" &&
      process.env.AI_IMPLEMENT_DEV_NO_PUSH === "true"
    ) {
      // Dev harness no-push mode: leave working-tree changes in the bind-mounted
      // workspace for inspection with `git diff`. Skip push and PR creation.
      return { prUrl: null, prNumber: null, branchPushed: false, commitSha: null, draft: false };
    }

    const { workspaceDir, repoOwner, repoRepo, githubToken, branchName } = inputs;
    const { issueIdentifier, issueTitle } = context.data;
    const baseBranch = String(inputs.baseBranch ?? context.data.branch ?? "").trim();
    if (!baseBranch) {
      throw new Error("Missing base branch for PR creation");
    }
    const prTitle = String(inputs.prTitle ?? `${issueIdentifier}: ${issueTitle || "AI implementation"}`);

    if (!branchName || branchName === baseBranch) {
      throw new Error(`Refusing to push implementation branch "${branchName}" over base branch "${baseBranch}"`);
    }

    runGit(workspaceDir, ["checkout", "-B", branchName], githubToken, "git checkout");

    const hasWTChanges = hasWorkingTreeChanges(workspaceDir, githubToken);
    // Only check commits-ahead when working tree is clean: if there ARE working-tree changes
    // we always take the standard add→commit path regardless of prior commits.
    const agentCommitted = !hasWTChanges && hasCommitsAheadOfBase(workspaceDir, baseBranch, githubToken);

    if (!hasWTChanges && !agentCommitted) {
      if (inputs.groupingParent) {
        // Case B: grouping-parent run that genuinely produced no changes. Return a clean
        // no-op so the orchestrator can finalize the issue and merge-up.ts opens the
        // feature→base roll-up PR instead of stalling the parent In Progress.
        return { prUrl: null, prNumber: null, branchPushed: false, commitSha: null, draft: false };
      }
      throw new Error("Nothing to commit: Claude left no file changes in the working tree");
    }

    runGit(workspaceDir, ["config", "user.name", "ai-implement[bot]"], githubToken, "git config user.name");
    runGit(
      workspaceDir,
      ["config", "user.email", "ai-implement[bot]@users.noreply.github.com"],
      githubToken,
      "git config user.email",
    );

    let commitSha: string | null;
    if (hasWTChanges) {
      // Standard path: stage all changes → sensitive-file guard → commit.
      runGit(workspaceDir, ["add", "-A"], githubToken, "git add");
      // --diff-filter=d excludes staged deletions: removing an accidentally-committed
      // secret (e.g. deleting a .env) is exactly what the guard wants to allow.
      const stagedResult = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=d"], {
        cwd: workspaceDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (stagedResult.status !== 0) {
        // Fail closed: an empty list on git failure would silently skip the guard.
        const stderr = (stagedResult.stderr?.toString() ?? "").replaceAll(githubToken, "***");
        throw new Error(`git diff --cached failed (exit ${stagedResult.status ?? "null"}): ${stderr}`);
      }
      const stagedFiles = stagedResult.stdout.toString().split("\n").map((f) => f.trim()).filter(Boolean);
      const sensitiveHits = findSensitiveFiles(stagedFiles, inputs.sensitiveFiles);
      if (sensitiveHits.length > 0) {
        throw new SensitiveFilesError(sensitiveHits);
      }
      runGit(workspaceDir, ["commit", "-m", buildCommitMessage(issueIdentifier, issueTitle)], githubToken, "git commit");
      commitSha = resolveCommitSha(workspaceDir);
    } else {
      // Case A: agent committed its own changes — working tree is clean but commits exist
      // ahead of base. The sensitive-file guard runs against the full committed diff below.
      commitSha = resolveCommitSha(workspaceDir);
    }

    // Authoritative sensitive-file guard: scan the FULL committed diff (baseBranch..HEAD) —
    // the complete set of files that will land in the PR — before push. This closes the
    // mixed commit+working-tree gap where the standard path's --cached scan (newly-staged
    // files only) would miss files the agent committed itself earlier in the run (present in
    // HEAD but not the index). --diff-filter=d allows intentional deletions (e.g. removing a
    // committed secret); getCommittedDiffFiles fails closed on git error.
    const committedDiffFiles = getCommittedDiffFiles(workspaceDir, baseBranch, githubToken);
    const committedSensitiveHits = findSensitiveFiles(committedDiffFiles, inputs.sensitiveFiles);
    if (committedSensitiveHits.length > 0) {
      throw new SensitiveFilesError(committedSensitiveHits);
    }

    const changedFilesSummary = summarizeCommittedChanges(workspaceDir, githubToken, agentCommitted ? baseBranch : undefined);
    const prBody = buildPullRequestBody(context, inputs, changedFilesSummary);

    // Embed token in URL but use stdio: "pipe" so it is never printed to inherited
    // stdout/stderr. Token is redacted from any error messages.
    const remote = `https://x-access-token:${githubToken}@github.com/${repoOwner}/${repoRepo}.git`;
    const remoteRef = `refs/heads/${branchName}`;
    const expectedRemoteSha = await span("git-ls-remote", async () =>
      resolveRemoteBranchSha(workspaceDir, remote, branchName, githubToken),
    );
    const tracePush = process.env.AI_IMPLEMENT_LOG_LEVEL === "stream";
    const { args: pushArgs, env: pushEnv } = buildGitPushInvocation(
      remote,
      remoteRef,
      expectedRemoteSha,
      tracePush,
    );
    const pushResult = await span("git-push", async () =>
      spawnSync("git", pushArgs, {
        cwd: workspaceDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: pushEnv,
      }),
    );
    if (tracePush) {
      // Diagnostic for slow pushes: GIT_TRACE2_PERF region timings (pack-objects
      // vs send-pack vs server wait) + --verbose object counts. Redact the token
      // with replaceAll — the tokenized remote URL can recur many times here.
      // Trim each stream and join with a newline so partial-line stdout doesn't
      // run onto the first byte of stderr.
      const trace = [pushResult.stdout?.toString() ?? "", pushResult.stderr?.toString() ?? ""]
        .map((s) => s.trim())
        .filter(Boolean)
        .join("\n")
        .replaceAll(githubToken, "***");
      if (trace) console.error(`[git-push trace]\n${trace}`);
    }
    if (pushResult.status !== 0) {
      const stderr = (pushResult.stderr?.toString() ?? "").replaceAll(githubToken, "***");
      throw new Error(`git push failed (exit ${pushResult.status ?? "null"}): ${stderr}`);
    }

    const draft = inputs.draft === true;
    // Span covers the POST and the 422 list-open-PRs fallback so re-runs (which
    // hit 422 and pay an extra round-trip) are timed in full, not just the POST.
    const pr = await span("pr-create", async () =>
      createOrFindPullRequest({ repoOwner, repoRepo, githubToken, prTitle, branchName, baseBranch, prBody, draft }),
    );
    return { prUrl: pr.url, prNumber: pr.number, branchPushed: true, commitSha, draft: pr.draft };
  },
};

interface CreatePrInputs {
  repoOwner: string;
  repoRepo: string;
  githubToken: string;
  prTitle: string;
  branchName: string;
  baseBranch: string;
  prBody: string;
  draft: boolean;
}

/** Create the PR, tolerating 422 (already exists) by finding the open PR. */
async function createOrFindPullRequest(
  inputs: CreatePrInputs,
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

/**
 * Build the `git push` argv and spawn env. When `trace` is true (driven by
 * AI_IMPLEMENT_LOG_LEVEL=stream), it adds `--verbose` and `GIT_TRACE2_PERF=1`
 * so a slow push can be diagnosed — region timings (pack-objects vs send-pack
 * vs server wait) plus object counts land on the captured stderr.
 */
export function buildGitPushInvocation(
  remote: string,
  remoteRef: string,
  expectedRemoteSha: string | null,
  trace: boolean,
): { args: string[]; env: NodeJS.ProcessEnv } {
  const args = [
    "push",
    ...(trace ? ["--verbose"] : []),
    remote,
    `HEAD:${remoteRef}`,
    `--force-with-lease=${remoteRef}:${expectedRemoteSha ?? ""}`,
  ];
  const env = trace ? { ...process.env, GIT_TRACE2_PERF: "1" } : process.env;
  return { args, env };
}

function buildCommitMessage(issueIdentifier: string, issueTitle: string): string {
  const title = (issueTitle || "AI implementation").replace(/\s+/g, " ").trim();
  return `${issueIdentifier}: ${title}`.slice(0, 120);
}

function buildPullRequestBody(
  context: PipelineContext,
  inputs: PushInputs,
  changedFilesSummary: string,
): string {
  const { issueIdentifier, issueTitle, issueDescription } = context.data;
  const preflightOutputs = context.getOutputs("preflight");
  const title = stringValue(issueTitle) ?? "AI implementation";
  const description = stringValue(issueDescription);

  const implementationSummary =
    stringValue(inputs.implementationSummary) ??
    `Implemented the requested work for ${issueIdentifier}: ${title}.`;
  const explicitTestsSummary = stringValue(inputs.testsSummary) ?? stringValue(preflightOutputs.summary);
  // No explicit/preflight summary to fall back on: say what actually happened. An unapproved
  // run (reviewSummary present) skipped preflight/verify entirely — claiming verification ran
  // would contradict the "Automated review did not approve" section above it.
  const testsSummary =
    explicitTestsSummary ??
    (inputs.reviewSummary
      ? "Automated verification was skipped — the review loop did not approve this change."
      : "Automated verification was run by the AI-Implement pipeline before opening this PR.");
  const testsSummaryChecked = explicitTestsSummary != null || !inputs.reviewSummary;

  const unapprovedSection = buildUnapprovedSection(inputs.reviewSummary as ReviewSummary | undefined, inputs.draft === true);

  return [
    ...(unapprovedSection ? [unapprovedSection, ""] : []),
    "## Summary",
    implementationSummary,
    "",
    "## Approach",
    `Implements ${issueIdentifier}: ${title}.`,
    description ? "The implementation follows the ticket requirements and keeps changes scoped to the requested files/behavior." : "The implementation keeps changes scoped to the requested behavior.",
    changedFilesSummary ? `\nChanged files:\n${changedFilesSummary}` : "",
    "",
    "## Test plan",
    `- [${testsSummaryChecked ? "x" : " "}] ${testsSummary}`,
    "- [ ] Manual: review the changed behavior against the ticket acceptance criteria.",
    "",
    `Fixes ${issueIdentifier}`,
    "",
    `Generated with AI-Implement · harness: Claude Code · model: ${context.data.model ?? "unknown"} · provider: ${context.data.provider ?? "anthropic"}`,
  ].join("\n");
}

function buildUnapprovedSection(summary: ReviewSummary | undefined, draft: boolean): string | null {
  if (!summary) return null;
  const passRows = summary.passes
    .map((p) => {
      const cost = p.costUsd != null ? `$${p.costUsd.toFixed(2)}` : "—";
      const review = p.reviewApproved == null ? "not run" : p.reviewApproved ? "approved" : "rejected";
      return `| ${p.iteration} | ${p.implementOutcome} | ${p.implementTurns ?? "?"} | ${cost} | ${review} |`;
    })
    .join("\n");
  return [
    "## ⚠️ Automated review did not approve",
    "",
    `This PR was opened ${draft ? "as a draft" : "for human review"} because the AI-Implement review loop ended without approval (reason: \`${summary.terminationReason}\` after ${summary.iterations} iteration(s)).`,
    "",
    "**Reviewer's final feedback:**",
    "",
    ...summary.finalFeedback.split("\n").map((l) => `> ${l}`),
    "",
    "**Run stats:**",
    "",
    "| Pass | Implement outcome | Turns | Cost | Review |",
    "|---|---|---|---|---|",
    passRows,
    ...(summary.postMortem ? ["", "<details><summary><strong>Post-mortem</strong></summary>", "", summary.postMortem, "", "</details>"] : []),
    "",
    "_Preflight and verify hooks were skipped for this unapproved run._",
  ].join("\n");
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * True when HEAD has at least one commit not yet reachable from baseBranch.
 * Used to detect Case A: the agent committed its own changes, leaving a clean
 * working tree but commits ahead of the base branch.
 */
function hasCommitsAheadOfBase(workspaceDir: string, baseBranch: string, githubToken: string): boolean {
  const result = spawnSync("git", ["rev-list", "--count", `${baseBranch}..HEAD`], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    // Fail closed: returning false here ("no commits ahead") would let a grouping-parent
    // run take the Case-B no-op path and finalize the issue, silently discarding the agent's
    // committed work. Every other guard in this file throws on git failure — match that.
    const stderr = (result.stderr?.toString() ?? "").replaceAll(githubToken, "***");
    throw new Error(`git rev-list ${baseBranch}..HEAD failed (exit ${result.status ?? "null"}): ${stderr}`);
  }
  const n = parseInt(result.stdout.toString().trim(), 10);
  return !isNaN(n) && n > 0;
}

/**
 * Returns the list of files changed in baseBranch..HEAD (excluding deletions via
 * --diff-filter=d, consistent with the staged-diff sensitive-file guard). Used in
 * Case A to run the security guard against the agent's own committed changes.
 */
function getCommittedDiffFiles(workspaceDir: string, baseBranch: string, githubToken: string): string[] {
  const result = spawnSync(
    "git",
    ["diff", "--diff-filter=d", `${baseBranch}..HEAD`, "--name-only"],
    { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    const stderr = (result.stderr?.toString() ?? "").replaceAll(githubToken, "***");
    throw new Error(`git diff ${baseBranch}..HEAD failed (exit ${result.status ?? "null"}): ${stderr}`);
  }
  return result.stdout.toString().split("\n").map((f) => f.trim()).filter(Boolean);
}

/**
 * Summarize the committed changes for the PR body. When baseBranch is provided
 * (Case A: agent committed), uses the full range diff to capture all agent commits.
 * Otherwise (standard path: single orchestrator commit), uses git show HEAD.
 */
function summarizeCommittedChanges(workspaceDir: string, githubToken: string, baseBranch?: string): string {
  const args = baseBranch
    ? ["diff", "--name-status", `${baseBranch}..HEAD`]
    : ["show", "--name-status", "--format=", "HEAD"];
  const result = spawnSync("git", args, {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const stderr = (result.stderr?.toString() ?? "").replaceAll(githubToken, "***");
    throw new Error(`git ${args[0]} failed (exit ${result.status ?? "null"}): ${stderr}`);
  }

  return formatGitNameStatusSummary(result.stdout.toString());
}

function runGit(
  workspaceDir: string,
  args: string[],
  githubToken: string,
  label: string,
): void {
  const result = spawnSync("git", args, {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const stderr = (result.stderr?.toString() ?? "").replaceAll(githubToken, "***");
    throw new Error(`${label} failed (exit ${result.status ?? "null"}): ${stderr}`);
  }
}

function hasWorkingTreeChanges(workspaceDir: string, githubToken: string): boolean {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const stderr = (result.stderr?.toString() ?? "").replaceAll(githubToken, "***");
    throw new Error(`git status failed (exit ${result.status ?? "null"}): ${stderr}`);
  }
  return result.stdout.toString().trim().length > 0;
}

function resolveCommitSha(workspaceDir: string): string | null {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  return result.stdout.toString().trim() || null;
}

function resolveRemoteBranchSha(
  workspaceDir: string,
  remote: string,
  branchName: string,
  githubToken: string,
): string | null {
  const remoteRef = `refs/heads/${branchName}`;
  let lastError = "";
  for (let attempt = 1; attempt <= LS_REMOTE_MAX_ATTEMPTS; attempt++) {
    const result = spawnSync("git", ["ls-remote", remote, remoteRef], {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0) {
      const line = result.stdout
        .toString()
        .trim()
        .split("\n")
        .find((entry) => entry.endsWith(`\t${remoteRef}`));
      if (!line) return null;
      return line.split("\t")[0] || null;
    }

    lastError = (result.stderr?.toString() ?? "").replaceAll(githubToken, "***");
    if (attempt < LS_REMOTE_MAX_ATTEMPTS) {
      sleepSync(LS_REMOTE_RETRY_DELAYS_MS[attempt - 1] ?? 1000);
    }
  }
  throw new Error(`git ls-remote failed after ${LS_REMOTE_MAX_ATTEMPTS} attempts: ${lastError}`);
}

function sleepSync(ms: number): void {
  if (process.env.NODE_ENV === "test") return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
