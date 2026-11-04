/** Checks of each project's tracker: the `tracker` group. Each judges the facts its provider reads once per run (`fetchSetupFacts`). */

import { LINEAR_LABELS, reusableLabel } from "../providers/linear.js";
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
  if (facts === null) return [{ state: "cannot-verify", detail: "The Linear provider reads no setup facts", fix: "Check the team's labels and states by hand." }];
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
      if (facts === null) return [{ state: "cannot-verify", detail: "The Linear provider reads no setup facts", fix: "Check the app's credentials by hand." }];
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
      const lifecycle = [LINEAR_LABELS.planning, LINEAR_LABELS.planComplete, LINEAR_LABELS.working];
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
    id: "tracker.linear.ready-for-review",
    title: "Linear Ready for Review label",
    group: "tracker",
    tier: "core",
    onAdminPath: false,
    run: (ctx) => judgeLinear(ctx, (facts) => {
      const name = LINEAR_LABELS.readyForReview;
      const found = facts.labels[name];
      if (found.some((label) => label.name === name)) return [{ state: "pass", detail: `The label ${name} exists` }];
      if (found.length > 0) {
        return [{
          state: "warn",
          detail: `Only ${found.map((label) => label.name).join(" and ")} exists, which differs from ${name} in case. A finished run applies it, but the poll and the merge step look for the exact name.`,
          fix: `Rename the label to exactly ${name}.`,
        }];
      }
      return [{
        state: "cannot-verify",
        detail: `No ${name} label exists. The first finished run creates it at workspace level, which needs a workspace admin, and only that write would show whether the app is one.`,
        fix: `Create a workspace label named exactly ${name} in Linear.`,
      }];
    }),
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
