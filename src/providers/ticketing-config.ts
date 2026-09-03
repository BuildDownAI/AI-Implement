import type { ProviderId } from "./types.js";

export interface LinearMappingConfig {
  kind: "linear";
}

export interface JiraMappingConfig {
  kind: "jira";
  /** Scope JQL clause; orchestrator wraps with the AI-Implement Status filter. */
  jql: string;
  /** Option value of the AI-Implement Repo field that this mapping matches (e.g. "owner/repo"). */
  repoFieldValue: string;
  /** Optional explicit customfield_NNNNN override for the status field. */
  statusFieldOverride?: string | null;
  /** Optional explicit customfield_NNNNN override for the repo field. */
  repoFieldOverride?: string | null;
  /** Optional explicit customfield_NNNNN override for the profiles field. */
  profilesFieldOverride?: string | null;
}

export type TicketingMappingConfig = LinearMappingConfig | JiraMappingConfig;

export const DEFAULT_TICKETING_CONFIG: LinearMappingConfig = { kind: "linear" };

/**
 * Normalizes a `*FieldOverride` value from untrusted JSON: anything that is not a
 * non-blank string becomes null, and a non-blank string is trimmed.
 *
 * Without this, a blank-but-present override survives validation and is then read
 * as a literal Jira field id by resolveCustomFieldIds (src/providers/jira-fields.ts):
 * - `""` is not nullish, so `overrides.statusOverride ?? lookup(STATUS_FIELD_NAME)`
 *   yields `""` instead of falling back to discovery by name; profilesFieldId's
 *   `=== null` guard is likewise skipped.
 * - `"   "` is truthy, so the all-overrides-set short-circuit returns early and
 *   listFields() is never called at all.
 * Both leave the provider querying an empty or whitespace field id.
 *
 * The admin UI already normalizes with `|| null` at both call sites, so this closes
 * the API path and puts the rule at the validation boundary rather than in two
 * callers that have to remember it.
 */
function normalizeFieldOverride(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Validates that the parsed JSON is a valid TicketingMappingConfig matching
 * the expected provider. Throws on mismatch.
 */
export function validateTicketingConfig(provider: ProviderId, value: unknown): TicketingMappingConfig {
  if (value === null || value === undefined) {
    if (provider === "linear") return DEFAULT_TICKETING_CONFIG;
    throw new Error(`ticketingConfig is required for provider "${provider}"`);
  }
  if (typeof value !== "object") {
    throw new Error(`ticketingConfig must be an object, got ${typeof value}`);
  }
  const obj = value as Record<string, unknown>;
  if (obj.kind !== provider) {
    throw new Error(`ticketingConfig.kind ("${obj.kind}") must match ticketingProvider ("${provider}")`);
  }
  if (provider === "linear") return { kind: "linear" };
  if (provider === "jira") {
    if (typeof obj.jql !== "string" || obj.jql.trim() === "") {
      throw new Error("Jira ticketingConfig requires a non-empty jql string");
    }
    if (typeof obj.repoFieldValue !== "string" || obj.repoFieldValue.trim() === "") {
      throw new Error("Jira ticketingConfig requires a non-empty repoFieldValue string");
    }
    return {
      kind: "jira",
      jql: obj.jql,
      repoFieldValue: obj.repoFieldValue,
      statusFieldOverride: normalizeFieldOverride(obj.statusFieldOverride),
      repoFieldOverride: normalizeFieldOverride(obj.repoFieldOverride),
      profilesFieldOverride: normalizeFieldOverride(obj.profilesFieldOverride),
    };
  }
  throw new Error(`Unknown provider for ticketingConfig: ${provider}`);
}
