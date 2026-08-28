import type { ProviderId } from "./types.js";

export interface LinearMappingConfig {
  kind: "linear";
}

export interface JiraMappingConfig {
  kind: "jira";
  /** Scope JQL clause; orchestrator wraps with the AI-Implement Status filter. */
  jql: string;
  /**
   * Option value of the AI-Implement Repo field that this mapping matches.
   * NULL means derive it from the mapping's own `owner`/`repo` as "owner/repo",
   * which is the convention almost every instance follows. Set it only when the
   * repo field's options carry some other label. Read through
   * {@link resolveRepoFieldValue} rather than directly, so the derived case works.
   */
  repoFieldValue: string | null;
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
    return {
      kind: "jira",
      jql: obj.jql,
      // Absent or blank means "derive from owner/repo" - see resolveRepoFieldValue.
      repoFieldValue:
        typeof obj.repoFieldValue === "string" && obj.repoFieldValue.trim() !== ""
          ? obj.repoFieldValue.trim()
          : null,
      statusFieldOverride: typeof obj.statusFieldOverride === "string" ? obj.statusFieldOverride : null,
      repoFieldOverride: typeof obj.repoFieldOverride === "string" ? obj.repoFieldOverride : null,
      profilesFieldOverride: typeof obj.profilesFieldOverride === "string" ? obj.profilesFieldOverride : null,
    };
  }
  throw new Error(`Unknown provider for ticketingConfig: ${provider}`);
}

/**
 * The AI-Implement Repo field value this mapping matches issues on.
 *
 * Resolved at read time rather than stored, so the GitHub repo is entered once
 * (as owner/repo) and never duplicated into the ticketing config. An explicit
 * `repoFieldValue` still wins, for instances whose repo field options are
 * labelled with something other than "owner/repo".
 *
 * Takes the structural shape rather than importing RepoMapping, which would
 * close a cycle with config.ts.
 */
export function resolveRepoFieldValue(mapping: {
  owner: string;
  repo: string;
  ticketingConfig: TicketingMappingConfig;
}): string {
  const cfg = mapping.ticketingConfig;
  if (cfg.kind === "jira") {
    const explicit = cfg.repoFieldValue?.trim();
    if (explicit) return explicit;
  }
  return `${mapping.owner}/${mapping.repo}`;
}
