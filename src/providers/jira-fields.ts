import type { JiraClient } from "./jira-client.js";

export const STATUS_FIELD_NAME = "AI-Implement Status";
export const REPO_FIELD_NAME = "AI-Implement Repo";

export interface ResolvedFieldIds {
  statusFieldId: string;
  repoFieldId: string;
}

interface OverrideOptions {
  statusOverride: string | null;
  repoOverride: string | null;
}

interface ListFieldsClient {
  listFields(): Promise<Array<{ id: string; name: string; custom: boolean }>>;
}

export async function resolveCustomFieldIds(
  client: ListFieldsClient,
  overrides: OverrideOptions,
): Promise<ResolvedFieldIds> {
  if (overrides.statusOverride && overrides.repoOverride) {
    return {
      statusFieldId: overrides.statusOverride,
      repoFieldId: overrides.repoOverride,
    };
  }

  const fields = await client.listFields();
  const lookup = (name: string): string => {
    const matches = fields.filter((f) => f.name === name);
    if (matches.length === 0) {
      throw new Error(`Custom field "${name}" not found in Jira instance`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple custom fields named "${name}" — set explicit ID override`);
    }
    return matches[0].id;
  };

  return {
    statusFieldId: overrides.statusOverride ?? lookup(STATUS_FIELD_NAME),
    repoFieldId: overrides.repoOverride ?? lookup(REPO_FIELD_NAME),
  };
}

const cache = new Map<string, ResolvedFieldIds>();

export async function getCachedFieldIds(
  cacheKey: string,
  client: JiraClient,
  overrides: OverrideOptions,
): Promise<ResolvedFieldIds> {
  // Override values must participate in the key — changing them on a live mapping otherwise serves stale IDs.
  const fullKey = `${cacheKey}::${overrides.statusOverride ?? ""}::${overrides.repoOverride ?? ""}`;
  const existing = cache.get(fullKey);
  if (existing) return existing;
  const ids = await resolveCustomFieldIds(client, overrides);
  cache.set(fullKey, ids);
  return ids;
}

export function clearFieldCache(): void {
  cache.clear();
}

export const STATUS_VALUES = {
  READY: "Ready",
  PLANNING: "Planning",
  /** Reserved for a future approval-gating phase; never written by Phase 2's verbs. */
  AWAITING_APPROVAL: "Awaiting Approval",
  APPROVED: "Plan Approved",
  IMPLEMENTING: "Implementing",
  PR_READY: "PR Ready",
  PLANNING_FAILED: "Planning Failed",
  IMPLEMENTATION_FAILED: "Implementation Failed",
} as const;

export type StatusValue = (typeof STATUS_VALUES)[keyof typeof STATUS_VALUES];

/** Build a minimal ADF document for a single paragraph. */
export function adfParagraph(text: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: [{
      type: "paragraph",
      content: [{ type: "text", text }],
    }],
  };
}

/** ADF for a paragraph with a hyperlink. */
export function adfWithLink(prefix: string, label: string, url: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: [{
      type: "paragraph",
      content: [
        { type: "text", text: prefix },
        {
          type: "text",
          text: label,
          marks: [{ type: "link", attrs: { href: url } }],
        },
      ],
    }],
  };
}
