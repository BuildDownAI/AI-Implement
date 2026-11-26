/** Trusted repository selection and SDK-free callers for Claude review starts. */
import { getMappings } from "./config.js";
import { resolveDeployTarget, type SelfDeployTarget } from "./deploy-availability.js";
import { getDeployPolicy } from "./deploy-policy.js";
import type { OpenPullRequest } from "./github.js";

export interface ClaudeReviewStartInput { ref: string; allowDraft: boolean }
export type ClaudeReviewStartResult = "started" | "same" | "skipped" | "failed";
export type ClaudeReviewStartSender = (key: string, input: ClaudeReviewStartInput, opts?: { idempotencyKey?: string }) => Promise<unknown>;
export interface ClaudeReviewStartCaller {
  canStartWork(): boolean;
  send: ClaudeReviewStartSender;
}

export function claudeReviewRepositories(selfDeploy?: SelfDeployTarget) {
  const target = resolveDeployTarget(selfDeploy ?? null, getDeployPolicy());
  if (target) return [{ owner: target.owner, repo: target.repo, ref: target.branch }];
  return [...new Map(Object.values(getMappings()).map(({ owner, repo }) =>
    [`${owner}/${repo}`, { owner, repo, ref: "main" }] as const)).values()];
}

/** Only settled successes are cached locally; durable ownership remains in the object. */
export function createClaudeReviewPoll() {
  const settled = new Map<string, string>();
  return async (deps: {
    selfDeploy?: SelfDeployTarget;
    canStartWork(): boolean;
    listRepoPulls(owner: string, repo: string): Promise<OpenPullRequest[]>;
    call(key: string, input: ClaudeReviewStartInput): Promise<ClaudeReviewStartResult>;
  }): Promise<void> => {
    if (!deps.canStartWork()) return;
    for (const { owner, repo, ref } of claudeReviewRepositories(deps.selfDeploy)) {
      const repository = `${owner}/${repo}`;
      try {
        const pulls = await deps.listRepoPulls(owner, repo);
        for (const pull of pulls) {
          if (!deps.canStartWork()) return;
          const key = `${repository}#${pull.number}`;
          if (pull.draft || settled.get(key) === pull.headSha) continue;
          try {
            const result = await deps.call(key, { ref, allowDraft: false });
            if (result === "started" || result === "same") settled.set(key, pull.headSha);
          } catch { console.warn(`[claude-review-start] ${key}: call failed`); }
        }
      } catch { console.warn(`[claude-review-start] ${repository}: list failed`); }
    }
  };
}
