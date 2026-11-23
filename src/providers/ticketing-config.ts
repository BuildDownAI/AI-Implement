import type { ProviderId } from "./types.js";
import { isAbsolute, normalize } from "node:path";

export interface FilesystemMappingConfig {
  kind: "filesystem";
  /** Absolute directory on the local orchestrator host containing Markdown tickets. */
  directory: string;
}

export interface LinearMappingConfig {
  kind: "linear";
}

export interface JiraMappingConfig {
  kind: "jira";
  /** Scope JQL clause; orchestrator wraps with the AI-Implement Status filter. */
  jql: string;
  /**
   * Option value of the AI-Implement Repo field that this mapping matches, or null to match the
   * mapping's own owner/repo. Read it through resolveRepoFieldValue, never directly.
   */
  repoFieldValue: string | null;
  /** Optional explicit customfield_NNNNN override for the status field. */
  statusFieldOverride?: string | null;
  /** Optional explicit customfield_NNNNN override for the repo field. */
  repoFieldOverride?: string | null;
  /** Optional explicit customfield_NNNNN override for the profiles field. */
  profilesFieldOverride?: string | null;
  /** Optional explicit customfield_NNNNN override for the base branch field. */
  baseBranchFieldOverride?: string | null;
}

export type TicketingMappingConfig = LinearMappingConfig | JiraMappingConfig | FilesystemMappingConfig;

export const DEFAULT_TICKETING_CONFIG: LinearMappingConfig = { kind: "linear" };

/**
 * Normalizes a `*FieldOverride` value or the repoFieldValue from untrusted JSON:
 * anything not a non-blank string becomes null, and a non-blank string is trimmed.
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

/** A ticketing configuration key that one setting holds. */
export type TicketingConfigKey = "jql" | "repoFieldValue" | "directory";

/** A ticketing configuration refused, naming the key at fault when one is, so a save can name that setting. */
export class TicketingConfigError extends Error {
  constructor(message: string, readonly key?: TicketingConfigKey) {
    super(message);
  }
}

/**
 * Validates that the parsed JSON is a valid TicketingMappingConfig matching
 * the expected provider. Throws a TicketingConfigError on mismatch.
 * `subject` names a key in a refusal: its path in the stored data unless the caller names it otherwise.
 */
export function validateTicketingConfig(
  provider: ProviderId,
  value: unknown,
  subject: (key: TicketingConfigKey) => string = (key) => `ticketingConfig.${key}`,
): TicketingMappingConfig {
  if (value === null || value === undefined) {
    if (provider === "linear") return DEFAULT_TICKETING_CONFIG;
    throw new TicketingConfigError(`ticketingConfig is required for provider "${provider}"`);
  }
  if (typeof value !== "object") {
    throw new TicketingConfigError(`ticketingConfig must be an object, got ${typeof value}`);
  }
  const obj = value as Record<string, unknown>;
  if (obj.kind !== provider) {
    throw new TicketingConfigError(`ticketingConfig.kind ("${obj.kind}") must match ticketingProvider ("${provider}")`);
  }
  if (provider === "linear") return { kind: "linear" };
  if (provider === "filesystem") {
    if (typeof obj.directory !== "string" || !obj.directory.trim() ||
        !isAbsolute(obj.directory.trim()) || obj.directory.includes("\0")) {
      throw new TicketingConfigError(`${subject("directory")} must be an absolute path on the orchestrator's host.`, "directory");
    }
    return { kind: "filesystem", directory: normalize(obj.directory.trim()) };
  }
  if (provider === "jira") {
    if (typeof obj.jql !== "string" || obj.jql.trim() === "") {
      throw new TicketingConfigError(`${subject("jql")} is required for Jira.`, "jql");
    }
    return {
      kind: "jira",
      jql: obj.jql,
      repoFieldValue: normalizeFieldOverride(obj.repoFieldValue),
      statusFieldOverride: normalizeFieldOverride(obj.statusFieldOverride),
      repoFieldOverride: normalizeFieldOverride(obj.repoFieldOverride),
      profilesFieldOverride: normalizeFieldOverride(obj.profilesFieldOverride),
      baseBranchFieldOverride: normalizeFieldOverride(obj.baseBranchFieldOverride),
    };
  }
  throw new TicketingConfigError(`Unknown provider for ticketingConfig: ${provider}`);
}

/**
 * The AI-Implement Repo field value a mapping matches issues on: its stored repoFieldValue,
 * or its owner/repo when none is stored. Takes the mapping's shape rather than RepoMapping,
 * since config.ts imports this module.
 */
export function resolveRepoFieldValue(mapping: { owner: string; repo: string; ticketingConfig: TicketingMappingConfig }): string {
  const cfg = mapping.ticketingConfig;
  return cfg.kind === "jira" && cfg.repoFieldValue !== null ? cfg.repoFieldValue : `${mapping.owner}/${mapping.repo}`;
}
