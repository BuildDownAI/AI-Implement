import type {
  AIImplementSnapshot,
  FeatureNodeRollUp,
  IssueLifecycleState,
  ProviderConfig,
  TicketIssue,
  TicketingProvider,
} from "./types.js";
import { MissingProviderConfigError } from "./types.js";
import { JiraApiError, JiraClient } from "./jira-client.js";
import {
  adfParagraph,
  getCachedFieldIds,
  STATUS_VALUES,
  type ResolvedFieldIds,
} from "./jira-fields.js";
import type { RepoMapping } from "../config.js";

function adfToPlainText(adf: unknown): string {
  const out: string[] = [];
  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (typeof n.text === "string") {
      out.push(n.text);
      return;
    }
    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child);
      const t = n.type;
      if (t === "paragraph" || t === "heading" || t === "listItem") {
        out.push("\n");
      }
    }
  }
  walk(adf);
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

function jqlFieldRef(fieldId: string): string {
  const match = /^customfield_(\d+)$/.exec(fieldId);
  return match ? `cf[${match[1]}]` : fieldId;
}

/**
 * Read the repo-field value regardless of how the custom field is typed in
 * Jira. Single-select option fields serialize as { value: string }; plain
 * text (short-text) fields serialize as a bare string. Both are legitimate
 * ways to hold the repo identifier, so support either rather than assuming
 * an option field (which silently reads "" for text fields and drops the
 * issue as a mismatch).
 */
function readRepoFieldValue(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object" && typeof (raw as { value?: unknown }).value === "string") {
    return (raw as { value: string }).value;
  }
  return "";
}

/** Shape of a single entry in an issue's `issuelinks` field. A `Blocks` link with
 *  an `inwardIssue` means "this issue is blocked by inwardIssue". */
interface JiraIssueLink {
  type?: { name?: string };
  inwardIssue?: { key?: string; fields?: { status?: { statusCategory?: { key?: string } } } };
  outwardIssue?: { key?: string; fields?: { status?: { statusCategory?: { key?: string } } } };
}

/**
 * True when the issue has an open "Blocks" link pointing inward (it is blocked by an
 * issue whose status category is not terminal). Mirrors the Linear provider's
 * inverse-relation "blocks" skip. A blocker in the `done` category never blocks.
 *
 * NOTE: the link type is matched on the default name "Blocks". A Jira instance that
 * renames this link type will fail open here (the issue dispatches as if unblocked).
 * Making the name per-mapping configurable is the follow-up if that becomes a need.
 */
function isBlockedByIncomplete(issuelinks: unknown): boolean {
  if (!Array.isArray(issuelinks)) return false;
  return (issuelinks as JiraIssueLink[]).some(
    (l) =>
      l.type?.name === "Blocks" &&
      l.inwardIssue != null &&
      l.inwardIssue.fields?.status?.statusCategory?.key !== "done",
  );
}

export interface JiraProviderConstructor {
  client: JiraClient;
  /** Per-instance cache scope label; typically the cloud ID. */
  cacheScope: string;
  /** User-facing site URL for issueUrl(); e.g. https://yourorg.atlassian.net */
  siteUrl: string;
  /** Called on every operation so admin-UI mapping edits take effect without restart. */
  getMappings: () => Record<string, RepoMapping>;
  /** Optional callback invoked when an issue's repo field doesn't match its mapping's expected value. */
  onRepoFieldMismatch?: (mappingId: string, issueKey: string, actual: string) => void;
}

export class JiraProvider implements TicketingProvider {
  readonly id = "jira";
  private readonly client: JiraClient;
  private readonly cacheScope: string;
  private readonly siteUrl: string;
  private readonly getMappings: () => Record<string, RepoMapping>;
  private readonly onRepoFieldMismatch: NonNullable<JiraProviderConstructor["onRepoFieldMismatch"]>;
  private readonly notifiedMismatches = new Set<string>();

  constructor(c: JiraProviderConstructor) {
    this.client = c.client;
    this.cacheScope = c.cacheScope;
    this.siteUrl = c.siteUrl;
    this.getMappings = c.getMappings;
    this.onRepoFieldMismatch = c.onRepoFieldMismatch ?? (() => {});
  }

  private async fields(scopeKey: string): Promise<ResolvedFieldIds> {
    const m = this.getMappings()[scopeKey];
    if (!m || m.ticketingConfig.kind !== "jira") {
      throw new Error(`No Jira mapping found for scopeKey=${scopeKey}`);
    }
    return getCachedFieldIds(this.cacheScope, this.client, {
      statusOverride: m.ticketingConfig.statusFieldOverride ?? null,
      repoOverride: m.ticketingConfig.repoFieldOverride ?? null,
    });
  }

  private async setStatus(issueId: string, scopeKey: string, value: string): Promise<void> {
    const ids = await this.fields(scopeKey);
    await this.client.setField(issueId, ids.statusFieldId, { value });
  }

  async fetchAIImplementSnapshot(): Promise<AIImplementSnapshot> {
    const mappings = this.getMappings();
    const jiraEntries = Object.entries(mappings).filter(
      ([, m]) => m.ticketingConfig.kind === "jira",
    );

    const needsPlanning: TicketIssue[] = [];
    const readyForImplementation: TicketIssue[] = [];
    const inProgressCountsByScope: Record<string, number> = {};

    for (const [scopeKey, m] of jiraEntries) {
      if (m.ticketingConfig.kind !== "jira") continue;
      const cfg = m.ticketingConfig;
      const fieldIds = await this.fields(scopeKey);
      const fieldsToFetch = [
        "summary",
        "description",
        "issuelinks",
        fieldIds.statusFieldId,
        fieldIds.repoFieldId,
      ];

      // Reference the status field by its resolved customfield id, not a hardcoded
      // display name. Jira instances often name the field differently than
      // "AI-Implement Status" (e.g. "ai-implement-status" or "AI-Implement-Status"),
      // and JQL's quoted-name lookup requires an exact match. REST uses
      // customfield_N ids; JQL on some instances requires cf[N], so transform
      // before interpolating.
      const statusJqlField = jqlFieldRef(fieldIds.statusFieldId);
      const bucketJql = `(${cfg.jql}) AND ${statusJqlField} in (Ready, "Plan Approved")`;
      const bucketIssues = await this.client.searchJql(bucketJql, fieldsToFetch);

      for (const raw of bucketIssues) {
        const actualRepo = readRepoFieldValue(raw.fields[fieldIds.repoFieldId]);
        if (actualRepo !== cfg.repoFieldValue) {
          const mismatchKey = `${scopeKey}::${raw.key}`;
          if (!this.notifiedMismatches.has(mismatchKey)) {
            this.notifiedMismatches.add(mismatchKey);
            this.onRepoFieldMismatch(scopeKey, raw.key, actualRepo);
          }
          continue;
        }
        if (isBlockedByIncomplete(raw.fields.issuelinks)) {
          console.log(`[jira] Skipping ${raw.key}: blocked by an incomplete issue`);
          continue;
        }
        const statusOption = raw.fields[fieldIds.statusFieldId] as { value?: string } | null;
        const statusValue = statusOption?.value ?? "";
        const ticket = this.toTicketIssue(raw, scopeKey, fieldIds);
        if (statusValue === "Ready") needsPlanning.push(ticket);
        else if (statusValue === "Plan Approved") readyForImplementation.push(ticket);
        // else: orchestrator picked it up between query and our processing; skip.
      }

      const capacityJql = `(${cfg.jql}) AND ${statusJqlField} in (Planning, Implementing)`;
      const capacityIssues = await this.client.searchJql(capacityJql, ["summary"]);
      inProgressCountsByScope[scopeKey] = capacityIssues.length;
    }

    return { needsPlanning, readyForImplementation, inProgressCountsByScope };
  }

  private toTicketIssue(
    raw: import("./jira-client.js").JiraIssue,
    scopeKey: string,
    fieldIds: ResolvedFieldIds,
  ): TicketIssue {
    const description = raw.fields.description;
    const descText =
      typeof description === "string"
        ? description
        : description
          ? adfToPlainText(description)
          : null;
    const statusOption = raw.fields[fieldIds.statusFieldId] as { value?: string } | null;
    return {
      id: raw.id,
      identifier: raw.key,
      title: (raw.fields.summary as string) ?? "",
      description: descText,
      scopeKey,
      nativeStatus: statusOption?.value ?? "",
    };
  }
  async fetchFeatureNodeRollUps(): Promise<FeatureNodeRollUp[]> {
    // Feature-branch grouping (and thus roll-up) is Linear-only for now.
    return [];
  }

  async fetchLifecycleStates(issueIds: string[]): Promise<Map<string, IssueLifecycleState>> {
    if (issueIds.length === 0) return new Map();
    // Use JQL `id in (...)` to fetch the relevant issues. Jira accepts numeric
    // IDs and keys here; we have IDs from our dispatched table.
    const jql = `id in (${issueIds.map((id) => JSON.stringify(id)).join(",")})`;
    const issues = await this.client.searchJql(jql, ["resolution", "status"]);
    const result = new Map<string, IssueLifecycleState>();
    for (const issue of issues) {
      const status = issue.fields.status as { statusCategory?: { key?: string } } | null;
      const resolution = issue.fields.resolution as { name?: string } | null;
      let lifecycle: IssueLifecycleState;
      if (resolution && status?.statusCategory?.key === "done") {
        const resName = (resolution.name ?? "").toLowerCase();
        if (resName.includes("won't") || resName.includes("cancel") || resName === "duplicate") {
          lifecycle = "cancelled";
        } else {
          lifecycle = "completed";
        }
      } else {
        lifecycle = "active";
      }
      result.set(issue.id, lifecycle);
    }
    return result;
  }
  async markPlanningStarted(issueId: string, scopeKey: string): Promise<void> {
    await this.setStatus(issueId, scopeKey, STATUS_VALUES.PLANNING);
  }
  async markPlanComplete(issueId: string, scopeKey: string): Promise<void> {
    await this.setStatus(issueId, scopeKey, STATUS_VALUES.APPROVED);
  }
  async markPlanningFailed(issueId: string, scopeKey: string, reason: string): Promise<void> {
    await this.setStatus(issueId, scopeKey, STATUS_VALUES.PLANNING_FAILED);
    await this.postComment(issueId, `⚠️ Planning failed: ${reason}`);
  }
  async markImplementing(issueId: string, scopeKey: string): Promise<void> {
    await this.setStatus(issueId, scopeKey, STATUS_VALUES.IMPLEMENTING);
  }
  async markPrReady(issueId: string, scopeKey: string, prUrl: string): Promise<void> {
    await this.setStatus(issueId, scopeKey, STATUS_VALUES.PR_READY);
    await this.postComment(issueId, `🚀 PR ready for review: ${prUrl}`);
  }
  async markImplementationFailed(issueId: string, scopeKey: string, reason: string): Promise<void> {
    await this.setStatus(issueId, scopeKey, STATUS_VALUES.IMPLEMENTATION_FAILED);
    await this.postComment(issueId, `⚠️ Implementation failed: ${reason}`);
  }
  async clearWorkingState(issueId: string, scopeKey: string): Promise<void> {
    await this.setStatus(issueId, scopeKey, STATUS_VALUES.APPROVED);
  }
  async markMerged(issueId: string, scopeKey: string): Promise<void> {
    await this.setStatus(issueId, scopeKey, STATUS_VALUES.MERGED);
  }
  async postComment(issueId: string, body: string): Promise<void> {
    await this.client.addComment(issueId, adfParagraph(body));
  }

  async fetchPlanningContext(_issueId: string): Promise<string> {
    // Jira planning-context extraction is not implemented yet; the
    // implementation run proceeds without it (best-effort context).
    return "";
  }

  issueUrl(issue: TicketIssue): string {
    return `${this.siteUrl}/browse/${issue.identifier}`;
  }

  async findByKey(key: string): Promise<TicketIssue | null> {
    let issue;
    try {
      issue = await this.client.getIssue(key, ["summary", "description", "status"]);
    } catch (err) {
      if (err instanceof JiraApiError && err.status === 404) return null;
      throw err;
    }
    // scopeKey is intentionally "" — the verb's use case (admin UI lookup)
    // doesn't need scopeKey accuracy.
    return {
      id: issue.id,
      identifier: issue.key,
      title: (issue.fields.summary as string) ?? "",
      description: typeof issue.fields.description === "string" ? issue.fields.description : null,
      scopeKey: "",
      nativeStatus: ((issue.fields.status as { name?: string } | null)?.name) ?? "",
    };
  }
}

/** Factory function that wires a JiraProvider from ProviderConfig + getMappings. */
export function createJiraProviderFromConfig(
  config: ProviderConfig,
  getMappings: () => Record<string, RepoMapping>,
): JiraProvider {
  if (!config.jiraToken || !config.jiraCloudId || !config.jiraSiteUrl) {
    throw new MissingProviderConfigError("jira", "jiraToken/jiraCloudId/jiraSiteUrl");
  }
  const client = new JiraClient({ token: config.jiraToken, cloudId: config.jiraCloudId });
  return new JiraProvider({
    client,
    cacheScope: config.jiraCloudId,
    siteUrl: config.jiraSiteUrl,
    getMappings,
    onRepoFieldMismatch: (mappingId, issueKey, actualRepo) => {
      console.warn(
        `[jira] Issue ${issueKey} (mapping ${mappingId}) has repo field "${actualRepo}", which does not match the mapping's repoFieldValue — dropping from this poll.`,
      );
    },
  });
}
