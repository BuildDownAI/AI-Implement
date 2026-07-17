import { spawnSync } from "node:child_process";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { formatGitNameStatusSummary } from "../step-utils.js";
import { span } from "../timing.js";
import { findSensitiveFiles, SensitiveFilesError } from "../sensitive-files.js";

const LS_REMOTE_MAX_ATTEMPTS = 3;
const LS_REMOTE_RETRY_DELAYS_MS = [250, 1000];

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
}

interface PushOutputs extends Record<string, unknown> {
  prUrl: string | null;
  prNumber: number | null;
  branchPushed: boolean;
  commitSha: string | null;
}

export const pushStep: StepModule<PushInputs, PushOutputs> = {
  async run(
    context: PipelineContext,
    inputs: PushInputs,
    _reporter: StepReporter,
  ): Promise<PushOutputs> {
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
    if (!hasWorkingTreeChanges(workspaceDir, githubToken)) {
      throw new Error("Nothing to commit: Claude left no file changes in the working tree");
    }
    runGit(workspaceDir, ["config", "user.name", "ai-implement[bot]"], githubToken, "git config user.name");
    runGit(
      workspaceDir,
      ["config", "user.email", "ai-implement[bot]@users.noreply.github.com"],
      githubToken,
      "git config user.email",
    );
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
    const sensitiveHits = findSensitiveFiles(stagedFiles);
    if (sensitiveHits.length > 0) {
      throw new SensitiveFilesError(sensitiveHits);
    }
    runGit(workspaceDir, ["commit", "-m", buildCommitMessage(issueIdentifier, issueTitle)], githubToken, "git commit");
    const commitSha = resolveCommitSha(workspaceDir);
    const changedFilesSummary = summarizeCommittedChanges(workspaceDir, githubToken);
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

    // Span covers the POST and the 422 list-open-PRs fallback so re-runs (which
    // hit 422 and pay an extra round-trip) are timed in full, not just the POST.
    const pr = await span("pr-create", async () =>
      createOrFindPullRequest({ repoOwner, repoRepo, githubToken, prTitle, branchName, baseBranch, prBody }),
    );
    return { prUrl: pr.url, prNumber: pr.number, branchPushed: true, commitSha };
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
}

/** Create the PR, tolerating 422 (already exists) by finding the open PR. */
async function createOrFindPullRequest(
  { repoOwner, repoRepo, githubToken, prTitle, branchName, baseBranch, prBody }: CreatePrInputs,
): Promise<{ url: string; number: number }> {
  const prRes = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoRepo}/pulls`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: prTitle,
        head: branchName,
        base: baseBranch,
        body: prBody,
      }),
    },
  );

  if (prRes.ok) {
    const pr = (await prRes.json()) as { html_url?: unknown; number?: unknown };
    if (typeof pr.html_url !== "string" || typeof pr.number !== "number") {
      throw new Error("Unexpected PR creation response shape from GitHub API");
    }
    return { url: pr.html_url, number: pr.number };
  }

  if (prRes.status === 422) {
    // PR already open — find it
    const listRes = await fetch(
      `https://api.github.com/repos/${repoOwner}/${repoRepo}/pulls?head=${repoOwner}:${branchName}&state=open`,
      { headers: { Authorization: `Bearer ${githubToken}` } },
    );
    if (!listRes.ok) {
      const listBody = await listRes.text().catch(() => "");
      throw new Error(
        `PR already exists (422) but listing open PRs failed with HTTP ${listRes.status}: ${listBody}`,
      );
    }
    const prs = (await listRes.json()) as Array<{ html_url?: unknown; number?: unknown }>;
    if (prs.length > 0) {
      const existing = prs[0];
      if (typeof existing.html_url === "string" && typeof existing.number === "number") {
        return { url: existing.html_url, number: existing.number };
      }
    }
    throw new Error(
      `PR already exists (422) but no open PR found for branch ${branchName}`,
    );
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
  const testsSummary =
    stringValue(inputs.testsSummary) ??
    stringValue(preflightOutputs.summary) ??
    "Automated verification was run by the AI-Implement pipeline before opening this PR.";

  return [
    "## Summary",
    implementationSummary,
    "",
    "## Approach",
    `Implements ${issueIdentifier}: ${title}.`,
    description ? "The implementation follows the ticket requirements and keeps changes scoped to the requested files/behavior." : "The implementation keeps changes scoped to the requested behavior.",
    changedFilesSummary ? `\nChanged files:\n${changedFilesSummary}` : "",
    "",
    "## Test plan",
    `- [x] ${testsSummary}`,
    "- [ ] Manual: review the changed behavior against the ticket acceptance criteria.",
    "",
    `Fixes ${issueIdentifier}`,
    "",
    `Generated with AI-Implement · harness: Claude Code · model: ${context.data.model ?? "unknown"} · provider: ${context.data.provider ?? "anthropic"}`,
  ].join("\n");
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function summarizeCommittedChanges(workspaceDir: string, githubToken: string): string {
  const result = spawnSync("git", ["show", "--name-status", "--format=", "HEAD"], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const stderr = (result.stderr?.toString() ?? "").replaceAll(githubToken, "***");
    throw new Error(`git show failed (exit ${result.status ?? "null"}): ${stderr}`);
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
