import crypto from "node:crypto";
import type { RepoMapping } from "./config.js";
import type { TicketingProvider } from "./providers/types.js";
import { mintRunToken, IMPLEMENTATION_TTL_SECONDS } from "./runner-tokens.js";
import { dispatchWorkflow, providerDispatchFields } from "./github.js";

export interface GapFillTriggerBody {
  issueKey?: unknown;
  prNumber?: unknown;
}

export interface HandleGapFillTriggerInput {
  authorization: string | undefined;
  body: GapFillTriggerBody;
  triggerSecret: string | null;
  runnerCallbackBaseUrl: string | null;
  runnerTokenSecret: string | null;
  getMappings: () => Record<string, RepoMapping>;
  resolveProvider: (mapping: RepoMapping) => Promise<TicketingProvider>;
  getInstallationToken: (owner: string) => Promise<string>;
  dispatchWorkflow?: typeof dispatchWorkflow;
}

export interface HandleGapFillTriggerOutput {
  status: number;
  body: Record<string, unknown>;
}

function bad(status: number, error: string, extra: Record<string, unknown> = {}): HandleGapFillTriggerOutput {
  return { status, body: { error, ...extra } };
}

/**
 * Handles an authenticated POST from a target repo's comment-trigger workflow.
 *
 * Flow:
 *   1. Authenticate via shared bearer secret (GAP_FILL_TRIGGER_SECRET).
 *   2. Validate body has issueKey + prNumber.
 *   3. Iterate all configured mappings, calling each provider's findByKey to
 *      find which mapping owns this issue (first match wins).
 *   4. Mint a gap-analysis run token (if runner-callback env is configured).
 *   5. Dispatch comment-trigger.yml in the owning mapping's repo.
 */
export async function handleGapFillTrigger(
  input: HandleGapFillTriggerInput,
): Promise<HandleGapFillTriggerOutput> {
  if (!input.triggerSecret) {
    return bad(501, "Gap fill trigger not configured");
  }

  const auth = input.authorization?.match(/^Bearer\s+(.+)$/);
  if (!auth) return bad(401, "unauthorized");
  // Constant-time compare to avoid timing oracles on the shared secret.
  const provided = Buffer.from(auth[1]);
  const expected = Buffer.from(input.triggerSecret);
  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    return bad(401, "unauthorized");
  }

  const issueKey = typeof input.body.issueKey === "string" ? input.body.issueKey : "";
  const prNumber = typeof input.body.prNumber === "number" ? input.body.prNumber : 0;
  if (!issueKey || !Number.isInteger(prNumber) || prNumber <= 0) {
    return bad(400, "issueKey and positive integer prNumber required");
  }

  // Find which mapping owns this issue by trying each provider's findByKey.
  let owningScopeKey: string | null = null;
  let owningMapping: RepoMapping | null = null;
  let owningIssueId: string | null = null;
  for (const [scopeKey, mapping] of Object.entries(input.getMappings())) {
    try {
      const provider = await input.resolveProvider(mapping);
      const found = await provider.findByKey(issueKey);
      if (found) {
        owningScopeKey = scopeKey;
        owningMapping = mapping;
        owningIssueId = found.id;
        break;
      }
    } catch (err) {
      console.warn(`[trigger/gap-fill] findByKey(${issueKey}) on mapping ${scopeKey} threw:`, err);
    }
  }
  if (!owningScopeKey || !owningMapping || !owningIssueId) {
    return bad(404, "mapping_not_found");
  }
  if (owningMapping.paused) {
    return bad(423, "project_paused", { teamKey: owningScopeKey });
  }

  let runnerCallbackUrl = "";
  let runToken = "";
  let runProgressToken = "";
  if (input.runnerCallbackBaseUrl && input.runnerTokenSecret) {
    // Gap-fill dispatches run the implementation workflow and can take as
    // long as the initial implementation, even though they report back as
    // gap-analysis so ticket status does not regress.
    const minted = mintRunToken({
      issueId: owningIssueId,
      mappingTeamKey: owningScopeKey,
      phase: "gap-analysis",
      audience: "result",
      ttlSeconds: IMPLEMENTATION_TTL_SECONDS,
      secret: input.runnerTokenSecret,
    });
    const progressMinted = mintRunToken({
      issueId: owningIssueId,
      mappingTeamKey: owningScopeKey,
      phase: "gap-analysis",
      audience: "progress",
      dispatchId: minted.dispatchId,
      ttlSeconds: IMPLEMENTATION_TTL_SECONDS,
      secret: input.runnerTokenSecret,
    });
    runnerCallbackUrl = input.runnerCallbackBaseUrl;
    runToken = minted.token;
    runProgressToken = progressMinted.token;
  }

  const ghToken = await input.getInstallationToken(owningMapping.owner);
  // Dispatch the mapping's own implementation workflow (typically
  // claude-implement.yml) directly with pr_number set. The implementation
  // workflow's prompt has a "Gap-fill instructions" section that activates
  // when PR_NUMBER is set.
  //
  // We used to dispatch comment-trigger.yml here, but that workflow's
  // job-level `if:` requires github.event.issue.pull_request to be non-null —
  // on workflow_dispatch the issue context is empty, so the whole job was
  // silently skipped. The workflow_dispatch inputs and post-results step in
  // comment-trigger.yml are now unreachable from this path; they remain in
  // the file as inert code to keep the diff small.
  const dispatch = input.dispatchWorkflow ?? dispatchWorkflow;
  const dispatchRes = await dispatch(ghToken, owningMapping, {
    issue_id: owningIssueId,
    issue_identifier: issueKey,
    issue_title: "(gap-fill triggered from PR comment)",
    issue_description: "(gap-fill triggered from PR comment)",
    pr_number: String(prNumber),
    runner_phase: "gap-analysis",
    ...providerDispatchFields(owningMapping),
    runner_callback_url: runnerCallbackUrl,
    run_token: runToken,
    run_progress_token: runProgressToken,
  });

  if (!dispatchRes.success) {
    return bad(502, "dispatch_failed", {
      detail: dispatchRes.error,
      dispatchStatus: dispatchRes.status,
    });
  }

  return { status: 200, body: { ok: true, dispatched: true } };
}
