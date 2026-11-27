/** Trusted repository selection and SDK-free callers for Claude review starts. */
import { getMappings } from "./config.js";
import { resolveDeployTarget, type SelfDeployTarget } from "./deploy-availability.js";
import { getDeployPolicy } from "./deploy-policy.js";
import type { OpenPullRequest } from "./github.js";

export interface ClaudeReviewStartInput { ref: string; allowDraft: boolean }
export type ClaudeReviewStartResult = "started" | "same" | "skipped" | "failed";
export type ClaudeReviewStartSender = (key: string, input: ClaudeReviewStartInput, opts?: { idempotencyKey?: string }) => Promise<unknown>;
export interface ClaudeReviewStartCaller {
  send: ClaudeReviewStartSender;
}

export function claudeReviewRepositories(selfDeploy?: SelfDeployTarget) {
  const target = resolveDeployTarget(selfDeploy ?? null, getDeployPolicy());
  if (target) return [{ owner: target.owner, repo: target.repo, ref: target.branch }];
  return [...new Map(Object.values(getMappings()).map(({ owner, repo }) =>
    [`${owner}/${repo}`, { owner, repo, ref: "main" }] as const)).values()];
}

export interface ClaudeReviewRepairInput {
  repositories: { repository: string; ref: string; pulls: { number: number; headSha: string }[] }[];
}

/** Build one repair snapshot using the poll's shared PR lists. */
export async function buildClaudeReviewRepairInput(
  selfDeploy: SelfDeployTarget | undefined,
  listRepoPulls: (owner: string, repo: string) => Promise<OpenPullRequest[]>,
): Promise<ClaudeReviewRepairInput> {
  const repositories: ClaudeReviewRepairInput["repositories"] = [];
  for (const { owner, repo, ref } of claudeReviewRepositories(selfDeploy)) {
    const repository = `${owner}/${repo}`;
    try {
      const pulls = await listRepoPulls(owner, repo);
      repositories.push({ repository, ref, pulls: pulls.filter(p => !p.draft)
        .map(({ number, headSha }) => ({ number, headSha })) });
    } catch { console.warn(`[claude-review-repair] ${repository}: list failed`); }
  }
  return { repositories };
}
