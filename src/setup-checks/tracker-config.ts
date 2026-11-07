/** Checks of each project's tracker: the `tracker` group. Each judges the facts its provider reads once per run (`fetchSetupFacts`). */

import { LINEAR_LABELS, reusableLabel } from "../providers/linear.js";
import { STATUS_VALUES } from "../providers/jira-fields.js";
import type { JiraMappingSetupFacts } from "../providers/types.js";
import type { LinearSetupFacts } from "../providers/types.js";
import type { SetupCheck, SetupCheckContext, SetupCheckOutcome } from "./index.js";

type MintedLinearFacts = Extract<LinearSetupFacts, { token: "minted" }>;

const NO_LINEAR_PROJECT: SetupCheckOutcome[] = [{ state: "not-applicable", detail: "No project uses Linear" }];

/** The keys of the projects whose tracker is `providerId`. For Linear, each is its team's key. */
function projectsOn(ctx: SetupCheckContext, providerId: string): string[] {
  return Object.entries(ctx.mappings()).filter(([, mapping]) => mapping.ticketingProvider === providerId).map(([key]) => key);
}

/** Judges Linear's facts once its token is minted, or says why they cannot be read. */
async function judgeLinear(
  ctx: SetupCheckContext,
  judge: (facts: MintedLinearFacts, projects: string[]) => SetupCheckOutcome[],
): Promise<SetupCheckOutcome[]> {
  const projects = projectsOn(ctx, "linear");
  if (projects.length === 0) return NO_LINEAR_PROJECT;
  const facts = await ctx.trackerSetupFacts("linear");
  if (facts === null || facts.kind !== "linear") return [{ state: "cannot-verify", detail: "The Linear provider reads no setup facts", fix: "Check the team's labels and states by hand." }];
  if (facts.token === "refused") {
    return [{ state: "cannot-verify", detail: "Linear gave the app no token, so this cannot be read", fix: "Clear tracker.linear.credentials first." }];
  }
  return judge(facts, projects);
}

/** One outcome per project, `cannot-verify` where the app cannot see the project's team. */
function perVisibleTeam(facts: MintedLinearFacts, projects: string[], judge: (team: string) => SetupCheckOutcome): SetupCheckOutcome[] {
  return projects.map((team): SetupCheckOutcome => ({
    ...(team in facts.teams
      ? judge(team)
      : { state: "cannot-verify", detail: `The app cannot see team ${team}, so this cannot be read`, fix: "Clear tracker.linear.team-access first." }),
    project: team,
  }));
}

/** Labels named `name` ignoring case, at workspace level or in `team`. */
function labelsInScope(facts: MintedLinearFacts, name: string, team: string) {
  return facts.labels[name].filter((label) => label.teamKey === null || label.teamKey === team);
}

const jiraWrites: Record<string, string> = {
  Ready: "poll bucket pickup", Planning: "markPlanningStarted", "Awaiting Approval": "markPlanComplete",
  "Plan Approved": "markPlanComplete and clearWorkingState", Implementing: "markImplementing",
  "PR Ready": "markPrReady", Merged: "markMerged", "Planning Failed": "markPlanningFailed", "Implementation Failed": "markImplementationFailed",
};
const jiraFix = "Check JIRA_TOKEN and JIRA_SITE_URL, and JIRA_EMAIL for Basic auth or JIRA_CLOUD_ID for OAuth; use Basic auth with an API token for a long-lived setup. Restart after changing variables and check that the orchestrator can reach Jira.";
const blocked = (check: string): SetupCheckOutcome => ({ state: "cannot-verify", detail: "Required facts could not be read", fix: `Clear ${check} first.` });

function judgeJiraRow(id: string, row: JiraMappingSetupFacts): SetupCheckOutcome {
  if (id === "fields") {
    if (row.fieldReadFailed) return { state: "cannot-verify", detail: row.fieldError ?? "The field list could not be read", fix: "Clear tracker.jira.credentials first; allow the account to list Jira fields." };
    if (row.fieldError) return { state: "fail", detail: row.fieldError, fix: "Create or rename AI-Implement Status and AI-Implement Repo, or set statusFieldOverride or repoFieldOverride to the field's ID." };
    if (row.ambiguousOptional.length) return { state: "warn", detail: `${row.ambiguousOptional.join(", ")} resolves to several fields; the feature stays off`, fix: "Rename the fields or set profilesFieldOverride or baseBranchFieldOverride to the field's ID." };
    return { state: "pass", detail: "Required fields resolve" };
  }
  if (!row.fields) return blocked("tracker.jira.fields");
  if (id === "field-cache") {
    const drift = row.cachedFields && [...new Set([...Object.keys(row.fields), ...Object.keys(row.cachedFields)])].some((key) => row.fields![key as keyof typeof row.fields] !== row.cachedFields![key as keyof typeof row.cachedFields]);
    return drift ? { state: "warn", detail: "Fresh field IDs differ from the IDs cached by this process", fix: "Restart the orchestrator so the poll uses the current fields." } : { state: "pass", detail: "No cached field IDs differ from the fresh resolution" };
  }
  if (id === "status-options") {
    if (row.statusNotSelect) return { state: "fail", detail: "AI-Implement Status is not a select field", fix: "Create a select field and set statusFieldOverride to its ID." };
    if (row.statusError || !row.statusOptions) return { state: "cannot-verify", detail: row.statusError ?? "Status options could not be read", fix: "Clear tracker.jira.fields first; allow the account to read field contexts and options." };
    const missing = Object.values(STATUS_VALUES).filter((v) => !(v === "Awaiting Approval" && row.autoApprovePlans) && !row.statusOptions!.includes(v));
    return missing.length ? { state: "fail", detail: missing.map((v) => `${v} is missing, breaking ${jiraWrites[v]}`).join("; "), fix: `Add these options to AI-Implement Status, spelled exactly: ${missing.join(", ")}.` } : { state: "pass", detail: "Every status option used by this mapping exists" };
  }
  if (id === "repo-option") {
    if (row.repoNotSelect) return { state: "not-applicable", detail: "The repo field is a text field" };
    if (row.repoError || !row.repoOptions) return { state: "cannot-verify", detail: row.repoError ?? "Repo options could not be read", fix: "Clear tracker.jira.fields first; allow the account to read field contexts and options." };
    return row.repoOptions.includes(row.repoFieldValue) ? { state: "pass", detail: "The repo option matches the mapping" } : { state: "fail", detail: `The repo field has no option equal to ${row.repoFieldValue}`, fix: `Add the option ${row.repoFieldValue}, spelled exactly, or correct the mapping's repoFieldValue.` };
  }
  if (row.queryUnreachable) return { state: "cannot-verify", detail: row.queryError ?? "Jira could not be reached for the bucket query", fix: "Clear tracker.jira.credentials first and check Jira connectivity." };
  return row.queryOk ? { state: "pass", detail: "The poll's bucket query succeeds" } : { state: "fail", detail: `Jira refused the bucket query: ${row.queryError}`, fix: "Correct the mapping's JQL." };
}

const JIRA_CHECKS: SetupCheck[] = ["credentials", "fields", "field-cache", "status-options", "repo-option", "query"].map((id): SetupCheck => ({
  id: `tracker.jira.${id}` as SetupCheck["id"], title: `Jira ${id}`, group: "tracker", tier: "core", onAdminPath: false,
  run: async (ctx) => {
    const projects = projectsOn(ctx, "jira");
    if (!projects.length) return [{ state: "not-applicable", detail: "No project uses Jira" }];
    const facts = await ctx.trackerSetupFacts("jira").catch(() => null);
    if (id === "credentials") {
      if (facts?.kind !== "jira") return [blocked("tracker.provider")];
      if (!facts.credentials.ok) return [{ state: facts.credentials.status == null ? "cannot-verify" : "fail", detail: `Jira credentials check: ${facts.credentials.status == null ? facts.credentials.error : `HTTP ${facts.credentials.status}`}`, fix: jiraFix }];
      return [{ state: facts.oauth ? "warn" : "pass", detail: facts.oauth ? "OAuth access tokens are never refreshed" : "Jira accepted the Basic auth credentials", ...(facts.oauth ? { fix: jiraFix } : {}) }];
    }
    return projects.map((project) => ({ project, ...(facts?.kind !== "jira" ? blocked("tracker.provider") : !facts.credentials.ok ? blocked("tracker.jira.credentials") : !facts.mappings[project] ? blocked("tracker.provider") : judgeJiraRow(id, facts.mappings[project])) }));
  },
}));

const FILESYSTEM_CHECK: SetupCheck = {
  id: "tracker.filesystem.directory", title: "Filesystem directory", group: "tracker", tier: "mode", onAdminPath: false,
  run: async (ctx) => {
    const projects = projectsOn(ctx, "filesystem");
    if (!projects.length) return [{ state: "not-applicable", detail: "No project uses Filesystem" }];
    const facts = await ctx.trackerSetupFacts("filesystem").catch(() => null);
    return projects.map((project) => {
      const row = facts?.kind === "filesystem" ? facts.directories[project] : undefined;
      return { project, ...(!row ? blocked("tracker.provider") : row.error ? { state: "fail" as const, detail: `${row.directory} ${row.error}`, fix: "Create the directory or fix its permissions; the orchestrator needs to write .state/ and the completed/ and failed/ archives into it." } : { state: "pass" as const, detail: `${row.directory} is a writable directory` }) };
    });
  },
};

export const TRACKER_CONFIG_CHECKS: readonly SetupCheck[] = [
  ...JIRA_CHECKS,
  FILESYSTEM_CHECK,
  {
    id: "tracker.provider",
    title: "Tracker providers",
    group: "tracker",
    tier: "core",
    onAdminPath: false,
    run: async (ctx) => {
      const byProvider = new Map<string, string[]>();
      for (const [key, mapping] of Object.entries(ctx.mappings())) {
        byProvider.set(mapping.ticketingProvider, [...(byProvider.get(mapping.ticketingProvider) ?? []), key]);
      }
      if (byProvider.size === 0) return [{ state: "not-applicable", detail: "No project is configured" }];
      return Promise.all([...byProvider].map(async ([id, projects]): Promise<SetupCheckOutcome> => {
        const names = projects.join(", ");
        try {
          const provider = await ctx.trackerProvider(id);
          if (provider.fetchSetupFacts) return { state: "pass", detail: `The ${id} provider is ready for ${names}` };
          return {
            state: "cannot-verify",
            detail: `The ${id} provider has no setup checks, so the tracker setup of ${names} is not checked`,
            fix: "Check the tracker's credentials, labels and states by hand.",
          };
        } catch (err) {
          return {
            state: "fail",
            detail: `The ${id} provider cannot be built (${err instanceof Error ? err.message : String(err)}), so every poll skips ${names}`,
            fix: "Correct the configuration the error names, then restart the orchestrator.",
          };
        }
      }));
    },
  },
  {
    id: "tracker.linear.credentials",
    title: "Linear credentials",
    group: "tracker",
    tier: "core",
    onAdminPath: false,
    run: async (ctx) => {
      if (projectsOn(ctx, "linear").length === 0) return NO_LINEAR_PROJECT;
      const facts = await ctx.trackerSetupFacts("linear");
      if (facts === null || facts.kind !== "linear") return [{ state: "cannot-verify", detail: "The Linear provider reads no setup facts", fix: "Check the app's credentials by hand." }];
      if (facts.token === "minted") return [{ state: "pass", detail: "Linear gave the app a token" }];
      if (facts.status === null) {
        return [{ state: "cannot-verify", detail: `Linear could not be reached: ${facts.error}`, fix: "Check that the orchestrator can reach api.linear.app." }];
      }
      return [{
        state: "fail",
        detail: `Linear refused the app's credentials with HTTP ${facts.status}`,
        fix: "Check LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET against the app's client credentials in Linear, and that client credentials tokens are enabled on the app.",
      }];
    },
  },
  {
    id: "tracker.linear.team-access",
    title: "Linear team access",
    group: "tracker",
    tier: "core",
    onAdminPath: false,
    run: (ctx) => judgeLinear(ctx, (facts, projects) => projects.map((team): SetupCheckOutcome => (team in facts.teams
      ? { project: team, state: "pass", detail: `The app can see team ${team}` }
      : {
          project: team,
          state: "fail",
          detail: `The app cannot see a team with key ${team}, so the poll never finds its issues`,
          fix: "Either the project's key is not the Linear team's key, or the app has no access to the team. Correct the key, or give the app the team on its application details page in Linear.",
        }))),
  },
  {
    id: "tracker.linear.pickup-label",
    title: "Linear pickup label",
    group: "tracker",
    tier: "core",
    onAdminPath: false,
    run: (ctx) => judgeLinear(ctx, (facts, projects) => perVisibleTeam(facts, projects, (team) => {
      const pickup = facts.pickupLabel;
      const found = labelsInScope(facts, pickup, team);
      if (found.some((label) => label.name === pickup)) return { state: "pass", detail: `The label ${pickup} exists` };
      if (found.length > 0) {
        return {
          state: "warn",
          detail: `Only ${found.map((label) => label.name).join(" and ")} exists, which differs from ${pickup} in case, so the poll does not match it`,
          fix: `Rename the label to exactly ${pickup}, or set the pickup label on /admin#settings to match it.`,
        };
      }
      return {
        state: "fail",
        detail: `No label named ${pickup} exists at workspace level or in this team, so the poll never picks up its issues`,
        fix: `Create a label named exactly ${pickup} in Linear, at workspace level or in this team, or correct the pickup label on /admin#settings.`,
      };
    })),
  },
  {
    id: "tracker.linear.lifecycle-labels",
    title: "Linear lifecycle labels",
    group: "tracker",
    tier: "core",
    onAdminPath: false,
    run: (ctx) => judgeLinear(ctx, (facts, projects) => perVisibleTeam(facts, projects, (team) => {
      const lifecycle = Object.values(LINEAR_LABELS).map((label) => label.name);
      const wrongCase = lifecycle.flatMap((name) => {
        const reused = reusableLabel(facts.labels[name], (label) => label.teamKey, team);
        return reused && reused.name !== name ? [`${reused.name} is used for ${name}`] : [];
      });
      if (wrongCase.length === 0) return { state: "pass", detail: "Each lifecycle label has its exact name, or is created at first use" };
      return {
        state: "warn",
        detail: `${wrongCase.join(". ")}. The orchestrator applies a label in a different case, but the poll and the label removal look for the exact name.`,
        fix: "Rename each label to the exact name shown.",
      };
    })),
  },
  {
    id: "tracker.linear.workflow-states",
    title: "Linear workflow states",
    group: "tracker",
    tier: "core",
    onAdminPath: false,
    run: (ctx) => judgeLinear(ctx, (facts, projects) => perVisibleTeam(facts, projects, (team) => {
      const missing = ["started", "completed"].filter((type) => !facts.teams[team].includes(type));
      if (missing.length === 0) return { state: "pass", detail: `Team ${team} has a started and a completed state` };
      return {
        state: "fail",
        detail: `Team ${team} has no ${missing.join(" or ")} state, so moving its issues ${missing.map((type) => (type === "started" ? "into progress" : "to done")).join(" or ")} fails`,
        fix: `Add a ${missing.join(" and a ")} state to the team's workflow in Linear.`,
      };
    })),
  },
];
