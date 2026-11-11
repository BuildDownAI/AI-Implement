/** Checks of each project's tracker: the `tracker` group. Each judges the facts its provider reads once per run (`fetchSetupFacts`). */

import { LINEAR_LABELS, reusableLabel } from "../providers/linear.js";
import {
  BASE_BRANCH_FIELD_NAME,
  PROFILES_FIELD_NAME,
  REPO_FIELD_NAME,
  STATUS_FIELD_NAME,
  STATUS_VALUES,
  type ResolvedFieldIds,
} from "../providers/jira-fields.js";
import type { JiraFieldOptions, JiraProjectSetupFacts, JiraSetupFacts, LinearSetupFacts } from "../providers/types.js";
import type { SetupCheck, SetupCheckContext, SetupCheckOutcome } from "./index.js";

type MintedLinearFacts = Extract<LinearSetupFacts, { token: "minted" }>;
type AcceptedJiraFacts = Extract<JiraSetupFacts, { credentials: "accepted" }>;
type ResolvedJiraProject = Extract<JiraProjectSetupFacts, { fields: "resolved" }>;

const NO_LINEAR_PROJECT: SetupCheckOutcome[] = [{ state: "not-applicable", detail: "No project uses Linear" }];
const NO_JIRA_PROJECT: SetupCheckOutcome[] = [{ state: "not-applicable", detail: "No project uses Jira" }];

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

/** Judges Jira's facts once Jira accepts the credentials, or says why they cannot be read. */
async function judgeJira(
  ctx: SetupCheckContext,
  judge: (facts: AcceptedJiraFacts, projects: string[]) => SetupCheckOutcome[],
): Promise<SetupCheckOutcome[]> {
  const projects = projectsOn(ctx, "jira");
  if (projects.length === 0) return NO_JIRA_PROJECT;
  const facts = await ctx.trackerSetupFacts("jira");
  if (facts === null || facts.kind !== "jira") return [{ state: "cannot-verify", detail: "The Jira provider reads no setup facts", fix: "Check the projects' fields and JQL by hand." }];
  if (facts.credentials === "refused") {
    return [{ state: "cannot-verify", detail: "Jira did not accept the credentials, so this cannot be read", fix: "Clear tracker.jira.credentials first." }];
  }
  return judge(facts, projects);
}

/** One outcome per project, `cannot-verify` where the project's fields cannot be found. */
function perResolvedProject(
  facts: AcceptedJiraFacts,
  projects: string[],
  judge: (project: ResolvedJiraProject, key: string) => SetupCheckOutcome,
): SetupCheckOutcome[] {
  return projects.map((key): SetupCheckOutcome => {
    const project = facts.projects[key];
    return {
      ...(project?.fields === "resolved"
        ? judge(project, key)
        : { state: "cannot-verify", detail: "This project's Jira fields cannot be found, so this cannot be read", fix: "Clear tracker.jira.fields first." }),
      project: key,
    };
  });
}

/** Each Jira field's setting on a project's ticketing settings, as the admin UI labels it. */
const FIELD_SETTING: Record<string, string> = {
  [STATUS_FIELD_NAME]: "Status Field",
  [REPO_FIELD_NAME]: "Repo Field",
  [PROFILES_FIELD_NAME]: "Profiles Field",
  [BASE_BRANCH_FIELD_NAME]: "Base Branch Field",
};

/** What each optional field feeds, which stays off while its name matches several fields. */
const OPTIONAL_FEATURE: Record<string, string> = {
  [PROFILES_FIELD_NAME]: "issue profiles",
  [BASE_BRANCH_FIELD_NAME]: "per-issue base branches",
};

/** What stops working while the status field lacks each option. */
const MISSING_STATUS_OPTION: Record<string, string> = {
  [STATUS_VALUES.READY]: "no issue can be queued for the orchestrator, and a stopped planning run cannot return its issue to the queue",
  [STATUS_VALUES.PLANNING]: "the issue does not show that planning started",
  [STATUS_VALUES.AWAITING_APPROVAL]: "a finished plan cannot be recorded, so its run fails",
  [STATUS_VALUES.APPROVED]: "a plan cannot be approved, and a stopped implementation run cannot return its issue to the queue",
  [STATUS_VALUES.IMPLEMENTING]: "the issue does not show that implementation started",
  [STATUS_VALUES.PR_READY]: "the issue does not show its pull request, and the pull request comment is not posted",
  [STATUS_VALUES.MERGED]: "a merged pull request never completes its issue",
  [STATUS_VALUES.PLANNING_FAILED]: "a failed plan is not reported on the issue, and a planning run the orchestrator gives up on is not set aside for a person",
  [STATUS_VALUES.IMPLEMENTATION_FAILED]: "a failed implementation is not reported on the issue, and an implementation run the orchestrator gives up on is not set aside for a person",
};

function sameFieldIds(a: ResolvedFieldIds, b: ResolvedFieldIds): boolean {
  return (["statusFieldId", "repoFieldId", "profilesFieldId", "baseBranchFieldId", "epicLinkFieldId"] as const).every((key) => a[key] === b[key]);
}

/** A field's options that could not be read, so whatever the check would judge is unknown. Jira shows them only to a Jira administrator, which the poll's account never needs to be. */
function unreadOptions(options: Extract<JiraFieldOptions, { read: "failed" }>, field: string): SetupCheckOutcome {
  return {
    state: "cannot-verify",
    detail: `Jira did not return the ${field}'s options: ${options.failure.error}`,
    fix: "Reading a field's options needs the Jira account to hold the Administer Jira global permission. Grant it, or compare the options with this project's settings by hand.",
  };
}

export const TRACKER_CONFIG_CHECKS: readonly SetupCheck[] = [
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
  {
    id: "tracker.jira.credentials",
    title: "Jira credentials",
    group: "tracker",
    tier: "core",
    onAdminPath: false,
    run: async (ctx) => {
      if (projectsOn(ctx, "jira").length === 0) return NO_JIRA_PROJECT;
      const facts = await ctx.trackerSetupFacts("jira");
      if (facts === null || facts.kind !== "jira") return [{ state: "cannot-verify", detail: "The Jira provider reads no setup facts", fix: "Check the credentials by hand." }];
      if (facts.credentials === "refused") {
        if (facts.status === null) {
          return [{
            state: "cannot-verify",
            detail: `Jira could not be reached: ${facts.error}`,
            fix: "Check that the orchestrator can reach JIRA_SITE_URL, or api.atlassian.com in OAuth mode.",
          }];
        }
        return [{
          state: "fail",
          detail: `Jira refused the credentials with HTTP ${facts.status}`,
          fix: "Check JIRA_TOKEN, and JIRA_EMAIL in Basic mode or JIRA_CLOUD_ID in OAuth mode, then restart the orchestrator, which reads them only at boot.",
        }];
      }
      if (facts.oauth) {
        return [{
          state: "fail",
          detail: "Jira accepted the OAuth access token, but it is short-lived and the orchestrator never refreshes it, so every Jira call fails once it expires",
          fix: "Use Basic mode: set JIRA_EMAIL to the account's address and JIRA_TOKEN to an API token, then restart the orchestrator.",
        }];
      }
      return [{ state: "pass", detail: "Jira accepted the credentials" }];
    },
  },
  {
    id: "tracker.jira.fields",
    title: "Jira fields",
    group: "tracker",
    tier: "core",
    onAdminPath: false,
    run: (ctx) => judgeJira(ctx, (facts, projects) => projects.map((key): SetupCheckOutcome => {
      const project = facts.projects[key];
      if (project.fields === "unreadable") {
        return {
          project: key,
          state: "cannot-verify",
          detail: `Jira did not list its fields: ${project.failure.error}`,
          fix: "Check that the Jira account can list fields, then run the checks again.",
        };
      }
      if (project.fields === "unresolved") {
        return {
          project: key,
          state: "fail",
          detail: project.fault === "missing"
            ? `No field named ${project.field} exists in Jira, so every Jira project sits out the poll`
            : `Several fields are named ${project.field} in Jira, so every Jira project sits out the poll`,
          fix: project.fault === "missing"
            ? `Create a field named exactly ${project.field} in Jira, or pick the field to use as the project's ${FIELD_SETTING[project.field]} on /admin#projects.`
            : `Rename the extra fields in Jira, or pick the one to use as the project's ${FIELD_SETTING[project.field]} on /admin#projects.`,
        };
      }
      if (project.ambiguousOptional.length > 0) {
        const names = project.ambiguousOptional;
        return {
          project: key,
          state: "warn",
          detail: `Several fields are named ${names.join(" and ")} in Jira, so this project reads no ${names.map((name) => OPTIONAL_FEATURE[name]).join(" or ")}`,
          fix: `Rename the extra fields in Jira, or pick the one to use as the project's ${names.map((name) => FIELD_SETTING[name]).join(" and ")} on /admin#projects.`,
        };
      }
      return { project: key, state: "pass", detail: "Jira has the fields this project uses" };
    })),
  },
  {
    id: "tracker.jira.field-cache",
    title: "Jira field cache",
    group: "tracker",
    tier: "core",
    onAdminPath: false,
    run: (ctx) => judgeJira(ctx, (facts, projects) => perResolvedProject(facts, projects, (project) => {
      if (project.cachedIds === null || sameFieldIds(project.ids, project.cachedIds)) {
        return { state: "pass", detail: "The poll uses this project's current field IDs" };
      }
      return {
        state: "warn",
        detail: "The poll still uses field IDs it read before this project's fields changed in Jira",
        fix: "Restart the orchestrator so the poll reads the current fields.",
      };
    })),
  },
  {
    id: "tracker.jira.status-options",
    title: "Jira status options",
    group: "tracker",
    tier: "core",
    onAdminPath: false,
    run: (ctx) => judgeJira(ctx, (facts, projects) => perResolvedProject(facts, projects, (project, key) => {
      const options = project.statusOptions;
      if (options.read === "failed") return unreadOptions(options, "status field");
      if (options.read === "not-select") {
        return {
          state: "fail",
          detail: "The project's status field is not a select field, so the orchestrator cannot set an issue's status",
          fix: `Create a single-select field named exactly ${STATUS_FIELD_NAME} in Jira, or pick one as the project's Status Field on /admin#projects.`,
        };
      }
      const autoApprove = ctx.mappings()[key].autoApprovePlans ?? false;
      const missing = Object.values(STATUS_VALUES).filter((value) =>
        !(value === STATUS_VALUES.AWAITING_APPROVAL && autoApprove) && !options.values.includes(value));
      if (missing.length === 0) return { state: "pass", detail: "The status field has every option this project uses" };
      return {
        state: "fail",
        detail: `The status field is missing ${missing.join(", ")}. ${missing.map((value) => `Without ${value}, ${MISSING_STATUS_OPTION[value]}.`).join(" ")}`,
        fix: `Add ${missing.join(", ")} to the status field's options in Jira, spelled exactly.`,
      };
    })),
  },
  {
    id: "tracker.jira.repo-option",
    title: "Jira repo option",
    group: "tracker",
    tier: "core",
    onAdminPath: false,
    run: (ctx) => judgeJira(ctx, (facts, projects) => perResolvedProject(facts, projects, (project, key) => {
      const options = project.repoOptions;
      if (options.read === "failed") return unreadOptions(options, "repo field");
      if (options.read === "not-select") return { state: "not-applicable", detail: "The repo field is a text field, so it has no options to check" };
      const config = ctx.mappings()[key].ticketingConfig;
      const value = config.kind === "jira" ? config.repoFieldValue : "";
      if (options.values.includes(value)) return { state: "pass", detail: `The repo field has the option ${value}` };
      return {
        state: "fail",
        detail: `The repo field has no ${value} option, so the poll finds none of this project's issues`,
        fix: `Add ${value} to the repo field's options in Jira, spelled exactly, or correct the project's Repo Field Value on /admin#projects.`,
      };
    })),
  },
  {
    id: "tracker.jira.jql",
    title: "Jira JQL",
    group: "tracker",
    tier: "core",
    onAdminPath: false,
    run: (ctx) => judgeJira(ctx, (facts, projects) => perResolvedProject(facts, projects, (project) => {
      if (project.jql.accepted) return { state: "pass", detail: "Jira runs the project's JQL as the poll runs it" };
      const { status, error } = project.jql.failure;
      if (status === null) {
        return {
          state: "cannot-verify",
          detail: `Jira could not be reached to run the project's JQL: ${error}`,
          fix: "Check that the orchestrator can reach Jira, then run the checks again.",
        };
      }
      return {
        state: "fail",
        detail: `Jira refused the project's JQL as the poll runs it, with HTTP ${status}: ${error}`,
        fix: "Correct the project's JQL on /admin#projects. The poll adds its own status filter, so the JQL needs none.",
      };
    })),
  },
  {
    id: "tracker.filesystem.directory",
    title: "Filesystem ticket directory",
    group: "tracker",
    tier: "mode",
    onAdminPath: false,
    run: async (ctx) => {
      const projects = projectsOn(ctx, "filesystem");
      if (projects.length === 0) return [{ state: "not-applicable", detail: "No project uses Filesystem" }];
      const facts = await ctx.trackerSetupFacts("filesystem");
      if (facts === null || facts.kind !== "filesystem") {
        return [{ state: "cannot-verify", detail: "The Filesystem provider reads no setup facts", fix: "Check each project's ticket directory by hand." }];
      }
      return projects.map((key): SetupCheckOutcome => {
        const { directory, fault } = facts.directories[key];
        if (fault === "missing") {
          return {
            project: key,
            state: "fail",
            detail: `${directory} does not exist or is not a directory, so the poll finds no tickets for this project`,
            fix: "Create the directory, or correct the project's Ticket Directory on /admin#projects.",
          };
        }
        if (fault === "not-writable") {
          return {
            project: key,
            state: "fail",
            detail: `The orchestrator cannot create files in ${directory}, so it cannot record ticket state or archive finished tickets`,
            fix: "Give the orchestrator's user write and search permission on the directory.",
          };
        }
        return { project: key, state: "pass", detail: `${directory} is a directory the orchestrator can write to` };
      });
    },
  },
];
