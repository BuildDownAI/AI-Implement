import { resolveModuleImport, type ImportModuleOptions } from "../resolve-module.js";

export type ReviewerFindingSeverity = "blocking" | "medium" | "minor";

export interface ReviewerFinding {
  severity: ReviewerFindingSeverity;
  body: string;
  path?: string;
  line?: number;
}

export interface ReviewerVerdict {
  approved: boolean;
  findings: ReviewerFinding[];
}

/**
 * JSON-schema-shaped descriptor for the object a reviewer must return. Passed
 * as the `jsonSchema` option to the LLM invocation; the step validates the
 * response against it.
 */
export type ReviewerOutputSchema = Record<string, unknown>;

/** Everything a reviewer needs to build its prompt for one review pass. */
export interface ReviewerPromptInput {
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string;
  prNumber: string;
  diff: string;
  /** Formatted findings from previous passes, for follow-up review context. */
  previousFindings: string;
}

/**
 * A reviewer supplies what differs between reviewers; the post-push-review
 * step keeps ownership of invocation, retry, verdict parsing, the findings
 * ledger, and reporting (ADR 021).
 *
 * Deliberately has no `gates` field: gating a merge is a project setting on
 * the mapping, not something a reviewer definition can grant itself.
 */
export interface ReviewerDefinition {
  /** Stable id. Matches the id in a project's reviewer selection. */
  id: string;
  /** Builds the reviewer's prompt for one review pass. */
  buildPrompt(input: ReviewerPromptInput): string;
  /** JSON shape the reviewer must return. The step validates against it. */
  outputSchema: ReviewerOutputSchema;
  /** Model override for this reviewer. Undefined uses the run's review model. */
  model?: string;
  /** Turn cap for this reviewer. Undefined uses retryPolicy.reviewMaxTurns. */
  maxTurns?: number;
}

/**
 * Built-in reviewers, keyed by id. Empty until a later issue registers the
 * default reviewer(s) — this issue only creates the type and the resolution
 * path.
 */
const BUILT_IN_REVIEWERS: Record<string, ReviewerDefinition> = {};

export interface ResolveReviewerOptions extends ImportModuleOptions {
  /** Injectable built-in registry for testing. Defaults to the module's built-in registry. */
  builtins?: Record<string, ReviewerDefinition>;
}

/**
 * Resolves a reviewer by id: a `custom/reviewers/<id>.ts` (or .js/.mjs)
 * default export takes precedence over the built-in of the same id,
 * mirroring createDefaultRunner's step resolution exactly — same
 * resolveModuleImport, same two custom roots, same extension order.
 *
 * A custom module that exists but has no default export is not an override:
 * resolveModuleImport already warns and treats it as absent, so this falls
 * back to the built-in rather than dropping the reviewer silently.
 *
 * Returns undefined for an id with no built-in and no custom override,
 * logging once so a caller does not need to.
 */
export async function resolveReviewer(
  id: string,
  options?: ResolveReviewerOptions,
): Promise<ReviewerDefinition | undefined> {
  const custom = await resolveModuleImport<ReviewerDefinition>(`reviewers/${id}`, options);
  const builtins = options?.builtins ?? BUILT_IN_REVIEWERS;
  const builtin = Object.hasOwn(builtins, id) ? builtins[id] : undefined;
  const resolved = custom ?? builtin;
  if (!resolved) {
    console.warn(`resolveReviewer: no reviewer registered for id "${id}"`);
    return undefined;
  }
  return resolved;
}
