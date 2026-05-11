import type {
  AIImplementSnapshot,
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

  /**
   * For verbs that don't carry scopeKey explicitly (markPlanComplete,
   * markPlanningFailed, markPrReady, markImplementationFailed,
   * clearWorkingState), look up the right scopeKey from the issue's
   * repo field. Single-Jira-mapping deployments short-circuit; multi-mapping
   * matches against the issue's repo field value.
   *
   * Note: When multiple Jira mappings exist, this uses the FIRST mapping's
   * field overrides (statusFieldOverride/repoFieldOverride) to resolve the
   * repo field ID for ALL mappings. This works because the field cache is
   * keyed on (cacheScope, statusOverride, repoOverride) and two mappings on
   * the same Jira cloud almost always share overrides. If two Jira mappings
   * deliberately set different repoFieldOverride values, the lookup will use
   * the first mapping's resolved field ID and could misidentify the scope.
   *
   * This is acceptable for Phase 2 (single Jira instance, single repo-field
   * setup); revisit if/when we support divergent field-override setups across
   * mappings on the same Jira instance.
   */
  private async scopeKeyForIssue(issueId: string): Promise<string> {
    const mappings = this.getMappings();
    const jiraEntries = Object.entries(mappings).filter(
      ([, m]) => m.ticketingConfig.kind === "jira",
    );
    if (jiraEntries.length === 0) {
      throw new Error("No Jira mapping configured");
    }
    if (jiraEntries.length === 1) return jiraEntries[0][0];
    const repoFieldId = (await this.fields(jiraEntries[0][0])).repoFieldId;
    const issue = await this.client.getIssue(issueId, [repoFieldId]);
    const repoValue = (issue.fields[repoFieldId] as { value?: string } | null)?.value ?? "";
    const match = jiraEntries.find(
      ([, m]) => m.ticketingConfig.kind === "jira" && m.ticketingConfig.repoFieldValue === repoValue,
    );
    if (!match) {
      throw new Error(`No Jira mapping matched repoFieldValue=${repoValue} for issue ${issueId}`);
    }
    return match[0];
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
        fieldIds.statusFieldId,
        fieldIds.repoFieldId,
      ];

      // Reference the status field by its resolved customfield id, not a hardcoded
      // display name. Jira instances often name the field differently than
      // "AI-Implement Status" (e.g. "ai-implement-status" or "AI-Implement-Status"),
      // and JQL's quoted-name lookup requires an exact match.
      const bucketJql = `(${cfg.jql}) AND ${fieldIds.statusFieldId} in (Ready, "Plan Approved")`;
      const bucketIssues = await this.client.searchJql(bucketJql, fieldsToFetch);

      for (const raw of bucketIssues) {
        const repoOption = raw.fields[fieldIds.repoFieldId] as { value?: string } | null;
        const actualRepo = repoOption?.value ?? "";
        if (actualRepo !== cfg.repoFieldValue) {
          const mismatchKey = `${scopeKey}::${raw.key}`;
          if (!this.notifiedMismatches.has(mismatchKey)) {
            this.notifiedMismatches.add(mismatchKey);
            this.onRepoFieldMismatch(scopeKey, raw.key, actualRepo);
          }
          continue;
        }
        const statusOption = raw.fields[fieldIds.statusFieldId] as { value?: string } | null;
        const statusValue = statusOption?.value ?? "";
        const ticket = this.toTicketIssue(raw, scopeKey, fieldIds);
        if (statusValue === "Ready") needsPlanning.push(ticket);
        else if (statusValue === "Plan Approved") readyForImplementation.push(ticket);
        // else: orchestrator picked it up between query and our processing; skip.
      }

      const capacityJql = `(${cfg.jql}) AND ${fieldIds.statusFieldId} in (Planning, Implementing)`;
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
  async markPlanComplete(issueId: string): Promise<void> {
    const scopeKey = await this.scopeKeyForIssue(issueId);
    await this.setStatus(issueId, scopeKey, STATUS_VALUES.APPROVED);
  }
  async markPlanningFailed(issueId: string, reason: string): Promise<void> {
    const scopeKey = await this.scopeKeyForIssue(issueId);
    await this.setStatus(issueId, scopeKey, STATUS_VALUES.PLANNING_FAILED);
    await this.postComment(issueId, `⚠️ Planning failed: ${reason}`);
  }
  async markImplementing(issueId: string, scopeKey: string): Promise<void> {
    await this.setStatus(issueId, scopeKey, STATUS_VALUES.IMPLEMENTING);
  }
  async markPrReady(issueId: string, prUrl: string): Promise<void> {
    const scopeKey = await this.scopeKeyForIssue(issueId);
    await this.setStatus(issueId, scopeKey, STATUS_VALUES.PR_READY);
    await this.postComment(issueId, `🚀 PR ready for review: ${prUrl}`);
  }
  async markImplementationFailed(issueId: string, reason: string): Promise<void> {
    const scopeKey = await this.scopeKeyForIssue(issueId);
    await this.setStatus(issueId, scopeKey, STATUS_VALUES.IMPLEMENTATION_FAILED);
    await this.postComment(issueId, `⚠️ Implementation failed: ${reason}`);
  }
  async clearWorkingState(issueId: string): Promise<void> {
    const scopeKey = await this.scopeKeyForIssue(issueId);
    await this.setStatus(issueId, scopeKey, STATUS_VALUES.APPROVED);
  }
  async postComment(issueId: string, body: string): Promise<void> {
    await this.client.addComment(issueId, adfParagraph(body));
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
