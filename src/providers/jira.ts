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
import { classifyByChildren, ancestorChain, type ChildState } from "./jira-hierarchy.js";

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

function readStatusValue(fields: Record<string, unknown>, statusFieldId: string): string {
  return (fields[statusFieldId] as { value?: string } | null)?.value ?? "";
}

function readParentKey(fields: Record<string, unknown>): string | null {
  return (fields.parent as { key?: string } | null)?.key ?? null;
}

/**
 * Read the Epic Link custom field as the epic's key. Classic Jira serializes Epic
 * Link as a bare string (the epic key); some shapes nest it under { key }. Returns
 * null when the field is unconfigured or empty.
 */
function readEpicLinkKey(fields: Record<string, unknown>, epicLinkFieldId: string | undefined): string | null {
  if (!epicLinkFieldId) return null;
  const v = fields[epicLinkFieldId];
  if (typeof v === "string") return v.trim() || null;
  if (v && typeof v === "object" && typeof (v as { key?: unknown }).key === "string") {
    return (v as { key: string }).key;
  }
  return null;
}

/**
 * The key of an issue's feature-branch parent: the native `parent` field when present,
 * else the Epic Link field (classic Epic→Story hierarchy). Unifying the two here is what
 * lets Epic-Link children be *attributed* to their epic for gating and chain-building —
 * not merely discovered by the childrenJql OR-clause and then dropped.
 */
function effectiveParentKey(fields: Record<string, unknown>, fieldIds: ResolvedFieldIds): string | null {
  return readParentKey(fields) ?? readEpicLinkKey(fields, fieldIds.epicLinkFieldId);
}

function isTerminalStatus(fields: Record<string, unknown>): boolean {
  return ((fields.status as { statusCategory?: { key?: string } } | null)?.statusCategory?.key) === "done";
}

function parseMultiSelectValues(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<unknown>)
    .map((item) => {
      if (item && typeof item === "object" && typeof (item as { value?: unknown }).value === "string") {
        return (item as { value: string }).value.trim();
      }
      return "";
    })
    .filter((v) => v.length > 0);
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

  private childrenJql(parentKeys: string[], fieldIds: ResolvedFieldIds): string {
    const list = parentKeys.map((k) => JSON.stringify(k)).join(",");
    const base = `parent in (${list})`;
    if (!fieldIds.epicLinkFieldId) return base;
    return `(${base} OR ${jqlFieldRef(fieldIds.epicLinkFieldId)} in (${list}))`;
  }

  private async fields(scopeKey: string): Promise<ResolvedFieldIds> {
    const m = this.getMappings()[scopeKey];
    if (!m || m.ticketingConfig.kind !== "jira") {
      throw new Error(`No Jira mapping found for scopeKey=${scopeKey}`);
    }
    return getCachedFieldIds(this.cacheScope, this.client, {
      statusOverride: m.ticketingConfig.statusFieldOverride ?? null,
      repoOverride: m.ticketingConfig.repoFieldOverride ?? null,
      profilesOverride: m.ticketingConfig.profilesFieldOverride ?? null,
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
        "parent",
        fieldIds.statusFieldId,
        fieldIds.repoFieldId,
        ...(fieldIds.epicLinkFieldId ? [fieldIds.epicLinkFieldId] : []),
        ...(fieldIds.profilesFieldId ? [fieldIds.profilesFieldId] : []),
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

      // Filter pass: drop repo-mismatches and blocked issues (unchanged behavior).
      const candidates = bucketIssues.filter((raw) => {
        const actualRepo = readRepoFieldValue(raw.fields[fieldIds.repoFieldId]);
        if (actualRepo !== cfg.repoFieldValue) {
          const mismatchKey = `${scopeKey}::${raw.key}`;
          if (!this.notifiedMismatches.has(mismatchKey)) {
            this.notifiedMismatches.add(mismatchKey);
            this.onRepoFieldMismatch(scopeKey, raw.key, actualRepo);
          }
          return false;
        }
        if (isBlockedByIncomplete(raw.fields.issuelinks)) {
          console.log(`[jira] Skipping ${raw.key}: blocked by an incomplete issue`);
          return false;
        }
        return true;
      });

      // Feature-branch enrichment: classify each candidate (leaf / feature-node / waiting)
      // and compute its featureBranchChain. Fails open to plain leaves on any error.
      const chains = await this.enrichFeatureBranches(candidates, cfg.repoFieldValue, fieldIds);

      for (const raw of candidates) {
        const info = chains.get(raw.key);
        if (info?.skip) continue; // feature-node-blocked or waiting-parent
        const statusValue = readStatusValue(raw.fields, fieldIds.statusFieldId);
        const ticket = this.toTicketIssue(raw, scopeKey, fieldIds);
        const parentKey = effectiveParentKey(raw.fields, fieldIds);
        if (parentKey) ticket.parentRef = { identifier: parentKey };
        if (info?.chain && info.chain.length > 0) ticket.featureBranchChain = info.chain;
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
    const profiles = fieldIds.profilesFieldId
      ? parseMultiSelectValues(raw.fields[fieldIds.profilesFieldId])
      : [];
    return {
      id: raw.id,
      identifier: raw.key,
      title: (raw.fields.summary as string) ?? "",
      description: descText,
      scopeKey,
      nativeStatus: statusOption?.value ?? "",
      ...(profiles.length > 0 ? { profiles } : {}),
    };
  }
  /**
   * Resolve feature-branch grouping for a poll's candidates: one batched children
   * query (`parent in (...)`, plus an Epic Link OR-clause when that field is configured)
   * classifies each as leaf / feature-node / waiting, and a bounded ancestor walk
   * (`key in (...)` per level, depth ≤ 5) builds the cascading chain. Returns a map
   * key → { skip, chain }. Mixed failure modes: the gating children query fails CLOSED
   * (all candidates deferred this poll) to avoid dispatching a feature-node parent before
   * its children finish; the branch-targeting ancestor walk fails OPEN (chains default to
   * base). Children are attributed to their parent via the native `parent` field or, in
   * classic projects, the Epic Link field.
   */
  private async enrichFeatureBranches(
    candidates: import("./jira-client.js").JiraIssue[],
    repoFieldValue: string,
    fieldIds: ResolvedFieldIds,
  ): Promise<Map<string, { skip: boolean; chain?: string[] }>> {
    const out = new Map<string, { skip: boolean; chain?: string[] }>();
    if (candidates.length === 0) return out;

    const designated = (fields: Record<string, unknown>): boolean =>
      readStatusValue(fields, fieldIds.statusFieldId) !== "" &&
      readRepoFieldValue(fields[fieldIds.repoFieldId]) === repoFieldValue;

    const childFields = [
      fieldIds.statusFieldId,
      fieldIds.repoFieldId,
      "status",
      "parent",
      ...(fieldIds.epicLinkFieldId ? [fieldIds.epicLinkFieldId] : []),
    ];

    // 1. Children of all candidates, one query. This is the GATING-critical step — without
    //    it a leaf is indistinguishable from a feature-node parent — so unlike the rest of
    //    enrichment it fails CLOSED: on error every candidate is deferred (skipped this poll,
    //    retried next) rather than dispatched, so a feature-node parent never implements its
    //    closing work onto base before its children finish. We can't tell leaves from parents
    //    once the query has failed, so all candidates are deferred. Children are attributed to
    //    their parent via effectiveParentKey, so Epic-Link children (no native `parent`) are
    //    bucketed under their epic instead of dropped.
    const childrenByParent = new Map<string, ChildState[]>();
    try {
      const children = await this.client.searchJql(
        this.childrenJql(candidates.map((c) => c.key), fieldIds),
        childFields,
      );
      for (const ch of children) {
        const parentKey = effectiveParentKey(ch.fields, fieldIds);
        if (!parentKey) continue;
        const list = childrenByParent.get(parentKey) ?? [];
        list.push({ designated: designated(ch.fields), terminal: isTerminalStatus(ch.fields) });
        childrenByParent.set(parentKey, list);
      }
    } catch (err) {
      console.warn(
        "[jira] children query failed; deferring candidates this poll (fail closed to avoid premature feature-node dispatch):",
        err,
      );
      for (const cand of candidates) out.set(cand.key, { skip: true });
      return out;
    }

    // 2. Ancestor walk: BFS up the (effective) parent chain, batched per level, depth ≤ 5.
    //    Branch-targeting only — NOT gating — so it fails OPEN: on error, chains default to the
    //    base branch (no chain) and candidates still dispatch.
    const ancestorParent = new Map<string, string | null>();
    const ancestorDesignated = new Map<string, boolean>();
    try {
      let level = Array.from(
        new Set(candidates.map((c) => effectiveParentKey(c.fields, fieldIds)).filter((k): k is string => !!k)),
      );
      for (let depth = 0; depth < 5 && level.length > 0; depth++) {
        const toFetch = level.filter((k) => !ancestorParent.has(k));
        if (toFetch.length === 0) break;
        const rows = await this.client.searchJql(
          `key in (${toFetch.map((k) => JSON.stringify(k)).join(",")})`,
          ["parent", fieldIds.statusFieldId, fieldIds.repoFieldId, ...(fieldIds.epicLinkFieldId ? [fieldIds.epicLinkFieldId] : [])],
        );
        const next: string[] = [];
        for (const row of rows) {
          const p = effectiveParentKey(row.fields, fieldIds);
          ancestorParent.set(row.key, p);
          ancestorDesignated.set(row.key, designated(row.fields));
          if (p && ancestorDesignated.get(row.key)) next.push(p);
        }
        level = Array.from(new Set(next));
      }
    } catch (err) {
      console.warn("[jira] ancestor walk failed; feature-branch chains default to the base branch:", err);
    }

    // 3. Per-candidate classification + chain.
    for (const cand of candidates) {
      const cls = classifyByChildren(childrenByParent.get(cand.key) ?? []);
      if (cls.kind === "waiting-parent" || cls.kind === "feature-node-blocked") {
        out.set(cand.key, { skip: true });
        console.log(`[jira] Skipping ${cand.key}: feature-node parent not ready (${cls.kind})`);
        continue;
      }
      const ancestors = ancestorChain(
        effectiveParentKey(cand.fields, fieldIds),
        (k) => ancestorParent.get(k) ?? null,
        (k) => ancestorDesignated.get(k) ?? false,
      );
      const chain = cls.kind === "feature-node-ready" ? [...ancestors, cand.key] : ancestors;
      out.set(cand.key, { skip: false, chain });
    }
    return out;
  }

  async fetchFeatureNodeRollUps(): Promise<FeatureNodeRollUp[]> {
    const mappings = this.getMappings();
    const jiraEntries = Object.entries(mappings).filter(([, m]) => m.ticketingConfig.kind === "jira");
    const rollUps: FeatureNodeRollUp[] = [];

    for (const [scopeKey, m] of jiraEntries) {
      if (m.ticketingConfig.kind !== "jira") continue;
      const cfg = m.ticketingConfig;
      const fieldIds = await this.fields(scopeKey);
      const designated = (fields: Record<string, unknown>): boolean =>
        readStatusValue(fields, fieldIds.statusFieldId) !== "" &&
        readRepoFieldValue(fields[fieldIds.repoFieldId]) === cfg.repoFieldValue;

      const epicLinkFields = fieldIds.epicLinkFieldId ? [fieldIds.epicLinkFieldId] : [];

      // Recently-completed candidates, 14-day lookback. Completion is either the
      // native Done status category (human moved the issue) or the AI-Implement
      // Status custom field set to "Merged" (the orchestrator's done-on-merge
      // path, which never transitions native status) — without the OR, the
      // roll-up cascade would stall waiting for a manual status move.
      const completed = (
        await this.client.searchJql(
          `(${cfg.jql}) AND (statusCategory = Done OR ${jqlFieldRef(fieldIds.statusFieldId)} = ${JSON.stringify(STATUS_VALUES.MERGED)}) AND updated >= -14d`,
          ["parent", fieldIds.statusFieldId, fieldIds.repoFieldId, ...epicLinkFields],
        )
      ).filter((raw) => designated(raw.fields));
      if (completed.length === 0) continue;

      // Which completed issues are feature nodes (≥1 designated child)? Children are
      // attributed to their parent via effectiveParentKey so Epic-Link children count.
      const children = await this.client.searchJql(
        this.childrenJql(completed.map((c) => c.key), fieldIds),
        [fieldIds.statusFieldId, fieldIds.repoFieldId, "parent", ...epicLinkFields],
      );
      const designatedChildParents = new Set<string>();
      for (const ch of children) {
        const pk = effectiveParentKey(ch.fields, fieldIds);
        if (pk && designated(ch.fields)) designatedChildParents.add(pk);
      }
      const featureNodes = completed.filter((c) => designatedChildParents.has(c.key));
      if (featureNodes.length === 0) continue;

      // Is each feature node's parent itself designated (→ auto-merge) or not (→ human PR)?
      const parentKeys = Array.from(
        new Set(featureNodes.map((c) => effectiveParentKey(c.fields, fieldIds)).filter((k): k is string => !!k)),
      );
      const designatedParents = new Set<string>();
      if (parentKeys.length > 0) {
        const parents = await this.client.searchJql(
          `key in (${parentKeys.map((k) => JSON.stringify(k)).join(",")})`,
          [fieldIds.statusFieldId, fieldIds.repoFieldId],
        );
        for (const p of parents) if (designated(p.fields)) designatedParents.add(p.key);
      }

      for (const node of featureNodes) {
        const parentKey = effectiveParentKey(node.fields, fieldIds);
        rollUps.push({
          issueId: node.id,
          identifier: node.key,
          scopeKey,
          parentIdentifier: parentKey && designatedParents.has(parentKey) ? parentKey : null,
        });
      }
    }
    return rollUps;
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
