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
    if (typeof obj.repoFieldValue !== "string" || obj.repoFieldValue.trim() === "") {
      throw new Error("Jira ticketingConfig requires a non-empty repoFieldValue string");
    }
    return {
      kind: "jira",
      jql: obj.jql,
      repoFieldValue: obj.repoFieldValue,
      statusFieldOverride: typeof obj.statusFieldOverride === "string" ? obj.statusFieldOverride : null,
      repoFieldOverride: typeof obj.repoFieldOverride === "string" ? obj.repoFieldOverride : null,
    };
  }
  throw new Error(`Unknown provider for ticketingConfig: ${provider}`);
}
