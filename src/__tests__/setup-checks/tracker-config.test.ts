import { describe, expect, it, vi } from "vitest";
import type { RepoMapping } from "../../config.js";
import { LINEAR_LABELS } from "../../providers/linear.js";
import { STATUS_VALUES } from "../../providers/jira-fields.js";
import type { JiraProjectSetupFacts, JiraSetupFacts, LinearSetupFacts } from "../../providers/types.js";
import type { SetupCheckContext, SetupCheckId, SetupCheckOutcome } from "../../setup-checks/index.js";
import { TRACKER_CONFIG_CHECKS } from "../../setup-checks/tracker-config.js";
import { makeMapping, makeProvider } from "../helpers/builders.js";
import { makeLinearSetupFacts, makeSetupCheckContext } from "../helpers/fixtures/setup-checks.js";

async function run(id: SetupCheckId, overrides: Partial<SetupCheckContext> = {}): Promise<SetupCheckOutcome[]> {
  const check = TRACKER_CONFIG_CHECKS.find((c) => c.id === id);
  if (!check) throw new Error(`no check ${id}`);
  return check.run(makeSetupCheckContext(overrides));
}

/** One Linear project per key, each its team's key, reading `facts`. */
function onLinear(facts: LinearSetupFacts | null, ...keys: string[]): Partial<SetupCheckContext> {
  return {
    mappings: () => Object.fromEntries((keys.length > 0 ? keys : ["ENG"]).map((key) => [key, makeMapping()])),
    trackerSetupFacts: async () => facts,
  };
}

type ResolvedJiraProject = Extract<JiraProjectSetupFacts, { fields: "resolved" }>;

const REFUSED: LinearSetupFacts = { kind: "linear", token: "refused", status: 401, error: "Linear token mint failed (401): invalid_client" };

const LINEAR_IDS: SetupCheckId[] = [
  "tracker.linear.credentials",
  "tracker.linear.team-access",
  "tracker.linear.pickup-label",
  "tracker.linear.lifecycle-labels",
  "tracker.linear.workflow-states",
];

describe("every Linear check", () => {
  it.each(LINEAR_IDS)("leaves it to the credentials check to say no project uses Linear (%s)", async (id) => {
    const outcomes = await run(id, { mappings: () => ({ OPS: makeMapping({ ticketingProvider: "jira" }) }) });
    expect(outcomes).toEqual(id === "tracker.linear.credentials" ? [{ state: "not-applicable", detail: "No project uses Linear" }] : []);
  });

  // A fault every Linear project shares is each project's own row, so each project's marker shows it.
  it.each(LINEAR_IDS.filter((id) => id !== "tracker.linear.credentials"))(
    "cannot verify for each project, and points at the credentials check, when Linear gives the app no token (%s)",
    async (id) => {
      const refused = { state: "cannot-verify", detail: "Linear gave the app no token, so the team's setup cannot be read", fix: "More information is needed. Address the tracker.linear.credentials check first.", waitsOnCheck: "tracker.linear.credentials" };
      expect(await run(id, onLinear(REFUSED, "ENG", "OPS"))).toEqual([{ ...refused, project: "ENG" }, { ...refused, project: "OPS" }]);
    },
  );

  it.each(LINEAR_IDS.filter((id) => id !== "tracker.linear.credentials"))(
    "cannot verify for each project, and points at tracker.provider, when the facts cannot be read (%s)",
    async (id) => {
      const rows = await run(id, { ...onLinear(null, "ENG", "OPS"), trackerSetupFacts: async () => { throw new Error("LINEAR_CLIENT_ID is not set"); } });
      expect(rows).toEqual(["ENG", "OPS"].map((project) => ({
        project,
        state: "cannot-verify",
        detail: "The linear setup facts could not be read: LINEAR_CLIENT_ID is not set",
        fix: "More information is needed. Address the tracker.provider check first.",
        waitsOnCheck: "tracker.provider",
      })));
    },
  );

  it.each(LINEAR_IDS)("cannot verify when the Linear provider reads no setup facts (%s)", async (id) => {
    const rows = await run(id, onLinear(null, "ENG", "OPS"));
    expect(rows).toMatchObject(id === "tracker.linear.credentials" ? [{ state: "cannot-verify", detail: "The Linear provider reads no setup facts" }] : ["ENG", "OPS"].map((project) => ({ project, state: "cannot-verify", detail: "The Linear provider reads no setup facts" })));
  });

  it("leaves a Jira project's rows out when Linear's facts cannot be read", async () => {
    const rows = await run("tracker.linear.team-access", {
      mappings: () => ({ ENG: makeMapping(), OPS: makeMapping({ ticketingProvider: "jira" }) }),
      trackerSetupFacts: async () => { throw new Error("LINEAR_CLIENT_ID is not set"); },
    });
    expect(rows.map((row) => row.project)).toEqual(["ENG"]);
  });
});

describe("tracker.provider", () => {
  it("does not apply when no project is configured", async () => {
    expect(await run("tracker.provider")).toEqual([{ state: "not-applicable", detail: "No project is configured" }]);
  });

  it("reports one row per tracker in use: ready, without setup checks, or unbuildable", async () => {
    const outcomes = await run("tracker.provider", {
      mappings: () => ({
        ENG: makeMapping(),
        WEB: makeMapping(),
        OPS: makeMapping({ ticketingProvider: "jira" }),
        LOC: makeMapping({ ticketingProvider: "filesystem" }),
      }),
      trackerProvider: async (id) => {
        if (id === "linear") return makeProvider({ fetchSetupFacts: async () => makeLinearSetupFacts() });
        if (id === "jira") return makeProvider({ id: "jira" });
        throw new Error("Filesystem tickets require local runner mode (RUNNER_MODE=local)");
      },
    });
    expect(outcomes).toEqual([
      { state: "pass", detail: "The linear provider is ready for ENG, WEB" },
      {
        state: "cannot-verify",
        detail: "The jira provider has no setup checks, so the ticketing system setup of OPS is not checked",
        fix: "Check the ticketing system's credentials, labels and states by hand.",
      },
      {
        state: "fail",
        detail: "The filesystem provider cannot be built (Filesystem tickets require local runner mode (RUNNER_MODE=local)), so every poll skips LOC",
        fix: "Correct the configuration the error names, then restart the orchestrator.",
      },
    ]);
  });
});

describe("tracker.linear.credentials", () => {
  it("passes once Linear gives the app a token", async () => {
    expect(await run("tracker.linear.credentials", onLinear(makeLinearSetupFacts()))).toEqual([{ state: "pass", detail: "Linear gave the app a token" }]);
  });

  it("fails with Linear's status when it refuses the credentials", async () => {
    expect(await run("tracker.linear.credentials", onLinear(REFUSED))).toEqual([
      {
        state: "fail",
        detail: "Linear refused the app's credentials with HTTP 401",
        fix: "Check LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET against the app's client credentials in Linear, and that client credentials tokens are enabled on the app.",
      },
    ]);
  });

  it("cannot verify when Linear could not be reached at all", async () => {
    const unreachable: LinearSetupFacts = { kind: "linear", token: "refused", status: null, error: "fetch failed" };
    expect(await run("tracker.linear.credentials", onLinear(unreachable))).toEqual([
      { state: "cannot-verify", detail: "Linear could not be reached: fetch failed", fix: "Check that the orchestrator can reach api.linear.app." },
    ]);
  });
});

describe("tracker.linear.team-access", () => {
  it("passes each team the app can see, and fails each it cannot, per project", async () => {
    const outcomes = await run("tracker.linear.team-access", onLinear(makeLinearSetupFacts(), "ENG", "ENGG"));
    expect(outcomes).toEqual([
      { project: "ENG", state: "pass", detail: "The app can see team ENG" },
      {
        project: "ENGG",
        state: "fail",
        detail: "The app cannot see a team with key ENGG, so the poll never finds its issues",
        fix: "Either the project's key is not the Linear team's key, or the app has no access to the team. Correct the key, or give the app the team on its application details page in Linear.",
      },
    ]);
  });
});

describe("the per-team Linear checks", () => {
  it.each(["tracker.linear.pickup-label", "tracker.linear.lifecycle-labels", "tracker.linear.workflow-states"] as const)(
    "cannot verify a project whose team the app cannot see (%s)",
    async (id) => {
      expect(await run(id, onLinear(makeLinearSetupFacts(), "ENGG"))).toEqual([
        { project: "ENGG", state: "cannot-verify", detail: "The app cannot see team ENGG, so its setup cannot be read", fix: "More information is needed. Address the tracker.linear.team-access check first.", waitsOnCheck: "tracker.linear.team-access" },
      ]);
    },
  );
});

describe("tracker.linear.pickup-label", () => {
  it.each([
    ["at workspace level", null],
    ["in the project's team", "ENG"],
  ])("passes when a label with the exact name exists %s", async (_case, teamKey) => {
    const facts = makeLinearSetupFacts({ found: [{ name: "AI-Implement", teamKey }] });
    expect(await run("tracker.linear.pickup-label", onLinear(facts))).toEqual([{ project: "ENG", state: "pass", detail: "The label AI-Implement exists" }]);
  });

  it("judges the pickup label the poll reads, not the default", async () => {
    const facts = makeLinearSetupFacts({ pickupLabel: "AI Implement - New", found: [{ name: "AI Implement - New", teamKey: null }, { name: "AI-Implement", teamKey: null }] });
    expect(await run("tracker.linear.pickup-label", onLinear(facts))).toEqual([{ project: "ENG", state: "pass", detail: "The label AI Implement - New exists" }]);
  });

  it("warns when the label exists only in a different case", async () => {
    const facts = makeLinearSetupFacts({ found: [{ name: "ai-implement", teamKey: "ENG" }] });
    expect(await run("tracker.linear.pickup-label", onLinear(facts))).toEqual([
      {
        project: "ENG",
        state: "warn",
        detail: "Only ai-implement exists, which differs from AI-Implement in case, so the poll does not match it",
        fix: "Rename the label to exactly AI-Implement, or set the pickup label on /admin#settings to match it.",
      },
    ]);
  });

  it.each([
    ["no such label exists", []],
    ["the only one belongs to another team", [{ name: "AI-Implement", teamKey: "OPS" }]],
  ])("fails when %s", async (_case, found) => {
    // OPS is mapped too: the read asks only for the mapped teams, so another team's label means a mapped team.
    const facts = makeLinearSetupFacts({ teams: { ENG: ["started", "completed"], OPS: ["started", "completed"] }, found });
    const outcomes = await run("tracker.linear.pickup-label", onLinear(facts, "ENG", "OPS"));
    expect(outcomes.find((o) => o.project === "ENG")).toEqual({
      project: "ENG",
      state: "fail",
      detail: "No label named AI-Implement exists at workspace level or in this team, so the poll never picks up its issues",
      fix: "Create a label named exactly AI-Implement in Linear, at workspace level or in this team, or correct the pickup label on /admin#settings.",
    });
  });
});

describe("tracker.linear.lifecycle-labels", () => {
  const exactLabels = Object.values(LINEAR_LABELS).map(({ name }) => ({ name, teamKey: null }));
  const missingDetail = (names: string) => `${names} do not exist. The orchestrator creates them at the team's first dispatch, which needs the app to be allowed to create team labels.`;
  const missingFix = (names: string, team = "ENG") => `Create ${names} in team ${team}, or check that the app can create labels in the team.`;

  it.each([["Plan-Complete"], ["AI-Planning", "Plan-Complete"]])("cannot verify missing labels %j", async (...missing) => {
    const names = missing.join(", ");
    const facts = makeLinearSetupFacts({ found: exactLabels.filter(({ name }) => !missing.includes(name)) });
    expect(await run("tracker.linear.lifecycle-labels", onLinear(facts))).toEqual([
      { project: "ENG", state: "cannot-verify", detail: missingDetail(names), fix: missingFix(names) },
    ]);
  });

  it("combines missing labels with case warnings and both fixes", async () => {
    const facts = makeLinearSetupFacts({ found: [...exactLabels.filter(({ name }) => name !== "Plan-Complete" && name !== "AI-Working"), { name: "ai-working", teamKey: "ENG" }] });
    expect(await run("tracker.linear.lifecycle-labels", onLinear(facts))).toEqual([
      {
        project: "ENG", state: "warn",
        detail: "ai-working is used for AI-Working. The orchestrator applies a label in a different case, but the poll and the label removal look for the exact name. " + missingDetail("Plan-Complete"),
        fix: "Rename each label to the exact name shown. " + missingFix("Plan-Complete"),
      },
    ]);
  });

  it("reports a label belonging only to another team as missing, separately per team", async () => {
    const facts = makeLinearSetupFacts({ teams: { ENG: [], OPS: [] }, found: [...exactLabels.filter(({ name }) => name !== "Plan-Complete"), { name: "Plan-Complete", teamKey: "OPS" }] });
    expect(await run("tracker.linear.lifecycle-labels", onLinear(facts, "ENG", "OPS"))).toEqual([
      { project: "ENG", state: "cannot-verify", detail: missingDetail("Plan-Complete"), fix: missingFix("Plan-Complete") },
      { project: "OPS", state: "pass", detail: "Each lifecycle label exists" },
    ]);
  });

  it("passes when each lifecycle label has its exact name", async () => {
    const facts = makeLinearSetupFacts({ found: [...exactLabels, { name: "AI-Working", teamKey: "ENG" }, { name: "Plan-Complete", teamKey: null }] });
    expect(await run("tracker.linear.lifecycle-labels", onLinear(facts))).toEqual([
      { project: "ENG", state: "pass", detail: "Each lifecycle label exists" },
    ]);
  });

  it("warns about the label the orchestrator would reuse: the team's own, even beside an exact workspace label", async () => {
    const facts = makeLinearSetupFacts({ found: [...exactLabels.filter(({ name }) => name !== "AI-Working" && name !== "Plan-Complete"), { name: "ai-working", teamKey: "ENG" }, { name: "AI-Working", teamKey: null }, { name: "plan-complete", teamKey: null }] });
    expect(await run("tracker.linear.lifecycle-labels", onLinear(facts))).toEqual([
      {
        project: "ENG",
        state: "warn",
        detail: "plan-complete is used for Plan-Complete. ai-working is used for AI-Working. The orchestrator applies a label in a different case, but the poll and the label removal look for the exact name.",
        fix: "Rename each label to the exact name shown.",
      },
    ]);
  });

  it("ignores a wrongly cased label in another team", async () => {
    const facts = makeLinearSetupFacts({ teams: { ENG: ["started", "completed"], OPS: ["started", "completed"] }, found: [...exactLabels, { name: "ai-planning", teamKey: "OPS" }] });
    const outcomes = await run("tracker.linear.lifecycle-labels", onLinear(facts, "ENG", "OPS"));
    expect(outcomes).toMatchObject([{ project: "ENG", state: "pass" }, { project: "OPS", state: "warn" }]);
  });

  it("judges Ready for Review as it judges the other lifecycle labels", async () => {
    const facts = makeLinearSetupFacts({ found: [...exactLabels.filter(({ name }) => name !== "Ready for Review"), { name: "Ready for review", teamKey: null }] });
    expect(await run("tracker.linear.lifecycle-labels", onLinear(facts))).toEqual([
      {
        project: "ENG",
        state: "warn",
        detail: "Ready for review is used for Ready for Review. The orchestrator applies a label in a different case, but the poll and the label removal look for the exact name.",
        fix: "Rename each label to the exact name shown.",
      },
    ]);
  });
});

describe("tracker.linear.workflow-states", () => {
  it("passes a team with a started and a completed state", async () => {
    expect(await run("tracker.linear.workflow-states", onLinear(makeLinearSetupFacts()))).toEqual([
      { project: "ENG", state: "pass", detail: "Team ENG has a started and a completed state" },
    ]);
  });

  it.each([
    [["completed"], "Team ENG has no started state, so moving its issues into progress fails", "Add a started state to the team's workflow in Linear."],
    [["started"], "Team ENG has no completed state, so moving its issues to done fails", "Add a completed state to the team's workflow in Linear."],
    [[], "Team ENG has no started or completed state, so moving its issues into progress or to done fails", "Add a started and a completed state to the team's workflow in Linear."],
  ])("fails a team whose states are %j", async (types, detail, fix) => {
    const facts = makeLinearSetupFacts({ teams: { ENG: types } });
    expect(await run("tracker.linear.workflow-states", onLinear(facts))).toEqual([{ project: "ENG", state: "fail", detail, fix }]);
  });
});

/**
 * A Jira project as the store reads one back. Plans wait for approval unless asked, so every status option counts.
 * A null Repo Field Value is a project saved without one, which matches its owner/repo.
 */
function jiraProject(overrides: { repoFieldValue?: string | null; owner?: string; repo?: string; autoApprovePlans?: boolean } = {}): RepoMapping {
  return makeMapping({
    ...(overrides.owner ? { owner: overrides.owner } : {}),
    ...(overrides.repo ? { repo: overrides.repo } : {}),
    ticketingProvider: "jira",
    ticketingConfig: {
      kind: "jira",
      jql: "project = OPS",
      repoFieldValue: overrides.repoFieldValue === undefined ? "acme/ops" : overrides.repoFieldValue,
      statusFieldOverride: null,
      repoFieldOverride: null,
      profilesFieldOverride: null,
      baseBranchFieldOverride: null,
    },
    autoApprovePlans: overrides.autoApprovePlans ?? false,
  });
}

/** One project's facts once every read succeeded: both fields found, every status option there, the repo option there, the JQL accepted. */
function resolvedProject(overrides: Partial<ResolvedJiraProject> = {}): JiraProjectSetupFacts {
  return {
    fields: "resolved",
    ids: { statusFieldId: "customfield_1", repoFieldId: "customfield_2", profilesFieldId: null, baseBranchFieldId: null },
    cachedIds: null,
    ambiguousOptional: [],
    statusOptions: { read: "options", values: Object.values(STATUS_VALUES) },
    repoOptions: { read: "options", values: ["acme/ops"] },
    jql: { accepted: true },
    ...overrides,
  };
}

/** Jira facts with the credentials accepted, for these projects' facts. */
function acceptedJira(projects: Record<string, JiraProjectSetupFacts> = { OPS: resolvedProject() }, oauth = false): JiraSetupFacts {
  return { kind: "jira", credentials: "accepted", oauth, projects };
}

/** Jira projects keyed by their mapping, reading `facts`. */
function onJira(facts: JiraSetupFacts | null, mappings: Record<string, RepoMapping> = { OPS: jiraProject() }): Partial<SetupCheckContext> {
  return { mappings: () => mappings, trackerSetupFacts: async () => facts };
}

const REFUSED_JIRA: JiraSetupFacts = { kind: "jira", credentials: "refused", status: 401, error: "Client must be authenticated to access this resource." };
const OPTIONS_PERMISSION = "Reading a field's options needs the Jira account to hold the Administer Jira global permission. Grant it, or compare the options with this project's settings by hand.";

const JIRA_IDS: SetupCheckId[] = [
  "tracker.jira.credentials",
  "tracker.jira.fields",
  "tracker.jira.field-cache",
  "tracker.jira.status-options",
  "tracker.jira.repo-option",
  "tracker.jira.jql",
];
const PER_RESOLVED_PROJECT_IDS = JIRA_IDS.filter((id) => id !== "tracker.jira.credentials" && id !== "tracker.jira.fields");

describe("every Jira check", () => {
  it.each(JIRA_IDS)("reads nothing, and leaves it to the credentials check to say, when no project uses Jira (%s)", async (id) => {
    const trackerSetupFacts = vi.fn(async () => null);
    expect(await run(id, { mappings: () => ({ ENG: makeMapping() }), trackerSetupFacts }))
      .toEqual(id === "tracker.jira.credentials" ? [{ state: "not-applicable", detail: "No project uses Jira" }] : []);
    expect(trackerSetupFacts).not.toHaveBeenCalled();
  });

  const TWO_JIRA = { OPS: jiraProject(), SUP: jiraProject() };

  it.each(JIRA_IDS.filter((id) => id !== "tracker.jira.credentials"))(
    "cannot verify for each project, and points at the credentials check, when Jira does not accept the credentials (%s)",
    async (id) => {
      const refused = { state: "cannot-verify", detail: "Jira did not accept the credentials, so the project's setup cannot be read", fix: "More information is needed. Address the tracker.jira.credentials check first.", waitsOnCheck: "tracker.jira.credentials" };
      expect(await run(id, onJira(REFUSED_JIRA, TWO_JIRA))).toEqual([{ ...refused, project: "OPS" }, { ...refused, project: "SUP" }]);
    },
  );

  it.each(JIRA_IDS.filter((id) => id !== "tracker.jira.credentials"))(
    "cannot verify for each project, and points at tracker.provider, when the facts cannot be read (%s)",
    async (id) => {
      const rows = await run(id, { ...onJira(null, TWO_JIRA), trackerSetupFacts: async () => { throw new Error("JIRA_SITE_URL is not set"); } });
      expect(rows).toEqual(["OPS", "SUP"].map((project) => ({
        project,
        state: "cannot-verify",
        detail: "The jira setup facts could not be read: JIRA_SITE_URL is not set",
        fix: "More information is needed. Address the tracker.provider check first.",
        waitsOnCheck: "tracker.provider",
      })));
    },
  );

  it.each(JIRA_IDS)("cannot verify when the Jira provider reads no setup facts (%s)", async (id) => {
    const rows = await run(id, onJira(null, TWO_JIRA));
    expect(rows).toMatchObject(id === "tracker.jira.credentials" ? [{ state: "cannot-verify", detail: "The Jira provider reads no setup facts" }] : ["OPS", "SUP"].map((project) => ({ project, state: "cannot-verify", detail: "The Jira provider reads no setup facts" })));
  });

  // The credentials check is orchestrator-wide, so its one row is the check runner's; the per-project checks answer for each project.
  it("lets a failed read reach the check runner from the credentials check, which reports its error", async () => {
    await expect(run("tracker.jira.credentials", { mappings: () => ({ OPS: jiraProject() }), trackerSetupFacts: async () => { throw new Error("Jira read failed"); } }))
      .rejects.toThrow("Jira read failed");
  });

  it.each(PER_RESOLVED_PROJECT_IDS)(
    "cannot verify a project whose fields cannot be found, and still judges another project (%s)",
    async (id) => {
      const facts = acceptedJira({ OPS: { fields: "unresolved", field: "AI-Implement Status", fault: "missing" }, WEB: resolvedProject() });
      const outcomes = await run(id, onJira(facts, { OPS: jiraProject(), WEB: jiraProject() }));
      expect(outcomes).toEqual([
        { project: "OPS", state: "cannot-verify", detail: "This project's Jira fields cannot be found, so the rest of its setup cannot be read", fix: "More information is needed. Address the tracker.jira.fields check first.", waitsOnCheck: "tracker.jira.fields" },
        expect.objectContaining({ project: "WEB", state: "pass" }),
      ]);
    },
  );
});

describe("tracker.provider for Jira", () => {
  it("reports the Jira provider ready once it reads setup facts", async () => {
    expect(await run("tracker.provider", {
      mappings: () => ({ OPS: jiraProject() }),
      trackerProvider: async () => makeProvider({ id: "jira", fetchSetupFacts: async () => acceptedJira({}) }),
    })).toEqual([{ state: "pass", detail: "The jira provider is ready for OPS" }]);
  });
});

describe("tracker.jira.credentials", () => {
  it("passes once Jira accepts the credentials", async () => {
    expect(await run("tracker.jira.credentials", onJira(acceptedJira()))).toEqual([{ state: "pass", detail: "Jira accepted the credentials" }]);
  });

  it("fails with Jira's status when it refuses them", async () => {
    expect(await run("tracker.jira.credentials", onJira(REFUSED_JIRA))).toEqual([
      {
        state: "fail",
        detail: "Jira refused the credentials with HTTP 401",
        fix: "Check JIRA_TOKEN, and JIRA_EMAIL in Basic mode or JIRA_CLOUD_ID in OAuth mode, then restart the orchestrator, which reads them only at boot.",
      },
    ]);
  });

  it("cannot verify when Jira could not be reached at all", async () => {
    const unreachable: JiraSetupFacts = { kind: "jira", credentials: "refused", status: null, error: "fetch failed" };
    expect(await run("tracker.jira.credentials", onJira(unreachable))).toEqual([
      { state: "cannot-verify", detail: "Jira could not be reached: fetch failed", fix: "Check that the orchestrator can reach JIRA_SITE_URL, or api.atlassian.com in OAuth mode." },
    ]);
  });

  it("fails OAuth mode, whose short-lived access token is never refreshed", async () => {
    expect(await run("tracker.jira.credentials", onJira(acceptedJira(undefined, true)))).toEqual([
      {
        state: "fail",
        detail: "Jira accepted the OAuth access token, but it is short-lived and the orchestrator never refreshes it, so every Jira call fails once it expires",
        fix: "Use Basic mode: set JIRA_EMAIL to the account's address and JIRA_TOKEN to an API token, then restart the orchestrator.",
      },
    ]);
  });
});

describe("tracker.jira.fields", () => {
  it("passes a project whose fields Jira has", async () => {
    expect(await run("tracker.jira.fields", onJira(acceptedJira()))).toEqual([{ project: "OPS", state: "pass", detail: "Jira has the fields this project uses" }]);
  });

  it.each([
    ["AI-Implement Status", "missing", "Status Field",
      "No field named AI-Implement Status exists in Jira, so every Jira project sits out the poll",
      "Create a field named exactly AI-Implement Status in Jira, or pick the field to use as the project's Status Field on /admin#projects."],
    ["AI-Implement Repo", "duplicate", "Repo Field",
      "Several fields are named AI-Implement Repo in Jira, so every Jira project sits out the poll",
      "Rename the extra fields in Jira, or pick the one to use as the project's Repo Field on /admin#projects."],
  ] as const)("fails %s %s, naming the project's %s setting", async (field, fault, _setting, detail, fix) => {
    const facts = acceptedJira({ OPS: { fields: "unresolved", field, fault } });
    expect(await run("tracker.jira.fields", onJira(facts))).toEqual([{ project: "OPS", state: "fail", detail, fix }]);
  });

  it("cannot verify when Jira does not list its fields", async () => {
    const facts = acceptedJira({ OPS: { fields: "unreadable", failure: { status: 403, error: "forbidden" } } });
    expect(await run("tracker.jira.fields", onJira(facts))).toEqual([
      { project: "OPS", state: "cannot-verify", detail: "Jira did not list its fields: forbidden", fix: "Check that the Jira account can list fields, then run the checks again." },
    ]);
  });

  it("warns of each optional field named twice, with the feature it leaves off and its setting", async () => {
    const facts = acceptedJira({ OPS: resolvedProject({ ambiguousOptional: ["AI-Implement Profiles", "AI-Implement Base Branch"] }) });
    expect(await run("tracker.jira.fields", onJira(facts))).toEqual([
      {
        project: "OPS",
        state: "warn",
        detail: "Several fields are named AI-Implement Profiles and AI-Implement Base Branch in Jira, so this project reads no issue profiles or per-issue base branches",
        fix: "Rename the extra fields in Jira, or pick the one to use as the project's Profiles Field and Base Branch Field on /admin#projects.",
      },
    ]);
  });
});

describe("tracker.jira.field-cache", () => {
  it.each([
    ["before the poll has cached any", null],
    ["when the cache matches", { statusFieldId: "customfield_1", repoFieldId: "customfield_2", profilesFieldId: null, baseBranchFieldId: null }],
  ])("passes %s", async (_when, cachedIds) => {
    const facts = acceptedJira({ OPS: resolvedProject({ cachedIds }) });
    expect(await run("tracker.jira.field-cache", onJira(facts))).toEqual([{ project: "OPS", state: "pass", detail: "The poll uses this project's current field IDs" }]);
  });

  it.each(["statusFieldId", "repoFieldId", "profilesFieldId", "baseBranchFieldId", "epicLinkFieldId"] as const)(
    "warns when the poll cached a different %s",
    async (key) => {
      const ids = { statusFieldId: "customfield_1", repoFieldId: "customfield_2", profilesFieldId: null, baseBranchFieldId: null };
      const facts = acceptedJira({ OPS: resolvedProject({ ids, cachedIds: { ...ids, [key]: "customfield_9" } }) });
      expect(await run("tracker.jira.field-cache", onJira(facts))).toEqual([
        { project: "OPS", state: "warn", detail: "The poll still uses field IDs it read before this project's fields changed in Jira", fix: "Restart the orchestrator so the poll reads the current fields." },
      ]);
    },
  );
});

describe("tracker.jira.status-options", () => {
  it("passes a status field with every option the project uses", async () => {
    expect(await run("tracker.jira.status-options", onJira(acceptedJira()))).toEqual([
      { project: "OPS", state: "pass", detail: "The status field has every option this project uses" },
    ]);
  });

  it("fails a missing option, saying what stops working and listing it to add", async () => {
    const facts = acceptedJira({ OPS: resolvedProject({ statusOptions: { read: "options", values: Object.values(STATUS_VALUES).filter((value) => value !== "Merged") } }) });
    expect(await run("tracker.jira.status-options", onJira(facts))).toEqual([
      {
        project: "OPS",
        state: "fail",
        detail: "The status field is missing Merged. Without Merged, a merged pull request never completes its issue.",
        fix: "Add Merged to the status field's options in Jira, spelled exactly.",
      },
    ]);
  });

  it.each(Object.values(STATUS_VALUES))("names what stops working without %s", async (option) => {
    const facts = acceptedJira({ OPS: resolvedProject({ statusOptions: { read: "options", values: Object.values(STATUS_VALUES).filter((value) => value !== option) } }) });
    const [outcome] = await run("tracker.jira.status-options", onJira(facts));
    expect(outcome.detail).toMatch(new RegExp(`^The status field is missing ${option}\\. Without ${option}, \\S.*\\.$`));
  });

  it("lists every missing option, in the order the orchestrator uses them", async () => {
    const facts = acceptedJira({ OPS: resolvedProject({ statusOptions: { read: "options", values: ["Planning", "Plan Approved"] } }) });
    const [outcome] = await run("tracker.jira.status-options", onJira(facts));
    expect(outcome.fix).toBe("Add Ready, Awaiting Approval, Implementing, PR Ready, Merged, Planning Failed, Implementation Failed to the status field's options in Jira, spelled exactly.");
  });

  it("does not ask for Awaiting Approval from a project that approves its plans automatically", async () => {
    const facts = acceptedJira({ OPS: resolvedProject({ statusOptions: { read: "options", values: Object.values(STATUS_VALUES).filter((value) => value !== "Awaiting Approval") } }) });
    expect(await run("tracker.jira.status-options", onJira(facts, { OPS: jiraProject({ autoApprovePlans: true }) }))).toMatchObject([{ state: "pass" }]);
    expect(await run("tracker.jira.status-options", onJira(facts, { OPS: jiraProject({ autoApprovePlans: false }) }))).toMatchObject([{ state: "fail" }]);
  });

  it("fails a status field that is not a select field", async () => {
    const facts = acceptedJira({ OPS: resolvedProject({ statusOptions: { read: "not-select" } }) });
    expect(await run("tracker.jira.status-options", onJira(facts))).toEqual([
      {
        project: "OPS",
        state: "fail",
        detail: "The project's status field is not a select field, so the orchestrator cannot set an issue's status",
        fix: "Create a single-select field named exactly AI-Implement Status in Jira, or pick one as the project's Status Field on /admin#projects.",
      },
    ]);
  });

  it("cannot verify options Jira does not return, naming the permission reading them needs", async () => {
    const facts = acceptedJira({ OPS: resolvedProject({ statusOptions: { read: "failed", failure: { status: 403, error: "forbidden" } } }) });
    expect(await run("tracker.jira.status-options", onJira(facts))).toEqual([
      { project: "OPS", state: "cannot-verify", detail: "Jira did not return the status field's options: forbidden", fix: OPTIONS_PERMISSION },
    ]);
  });
});

describe("tracker.jira.repo-option", () => {
  it("passes a repo field with the project's Repo Field Value", async () => {
    expect(await run("tracker.jira.repo-option", onJira(acceptedJira()))).toEqual([{ project: "OPS", state: "pass", detail: "The repo field has the option acme/ops" }]);
  });

  it("fails a repo field without it", async () => {
    expect(await run("tracker.jira.repo-option", onJira(acceptedJira(), { OPS: jiraProject({ repoFieldValue: "acme/web" }) }))).toEqual([
      {
        project: "OPS",
        state: "fail",
        detail: "The repo field has no acme/web option, so the poll finds none of this project's issues",
        fix: "Add acme/web to the repo field's options in Jira, spelled exactly, or correct the project's Repo Field Value on /admin#projects. A blank Repo Field Value matches the project's repository, test-org/test-repo.",
      },
    ]);
  });

  it("passes a project saved without a Repo Field Value when its repository is an option", async () => {
    expect(await run("tracker.jira.repo-option", onJira(acceptedJira(), { OPS: jiraProject({ repoFieldValue: null, owner: "acme", repo: "ops" }) }))).toEqual([
      { project: "OPS", state: "pass", detail: "The repo field has the option acme/ops, the project's repository" },
    ]);
  });

  it("fails a project saved without a Repo Field Value when its repository is not an option", async () => {
    expect(await run("tracker.jira.repo-option", onJira(acceptedJira(), { OPS: jiraProject({ repoFieldValue: null, owner: "acme", repo: "web" }) }))).toEqual([
      {
        project: "OPS",
        state: "fail",
        detail: "The repo field has no acme/web option, the project's repository, so the poll finds none of this project's issues",
        fix: "Add acme/web to the repo field's options in Jira, spelled exactly. A blank Repo Field Value matches the project's repository, so if the options name repositories another way, set the project's Repo Field Value on /admin#projects to the option for this repository.",
      },
    ]);
  });

  it("does not apply to a text repo field", async () => {
    const facts = acceptedJira({ OPS: resolvedProject({ repoOptions: { read: "not-select" } }) });
    expect(await run("tracker.jira.repo-option", onJira(facts))).toEqual([
      { project: "OPS", state: "not-applicable", detail: "The repo field is a text field, so it has no options to check" },
    ]);
  });

  it("cannot verify options Jira does not return, naming the permission reading them needs", async () => {
    const facts = acceptedJira({ OPS: resolvedProject({ repoOptions: { read: "failed", failure: { status: 403, error: "forbidden" } } }) });
    expect(await run("tracker.jira.repo-option", onJira(facts))).toEqual([
      { project: "OPS", state: "cannot-verify", detail: "Jira did not return the repo field's options: forbidden", fix: OPTIONS_PERMISSION },
    ]);
  });
});

describe("tracker.jira.jql", () => {
  it("passes JQL Jira runs as the poll runs it", async () => {
    expect(await run("tracker.jira.jql", onJira(acceptedJira()))).toEqual([{ project: "OPS", state: "pass", detail: "Jira runs the project's JQL as the poll runs it" }]);
  });

  it("fails JQL Jira refuses, with its status and error", async () => {
    const facts = acceptedJira({ OPS: resolvedProject({ jql: { accepted: false, failure: { status: 400, error: "Error in the JQL Query" } } }) });
    expect(await run("tracker.jira.jql", onJira(facts))).toEqual([
      {
        project: "OPS",
        state: "fail",
        detail: "Jira refused the project's JQL as the poll runs it, with HTTP 400: Error in the JQL Query",
        fix: "Correct the project's JQL on /admin#projects. The poll adds its own status filter, so the JQL needs none.",
      },
    ]);
  });

  it("cannot verify when Jira could not be reached to run it", async () => {
    const facts = acceptedJira({ OPS: resolvedProject({ jql: { accepted: false, failure: { status: null, error: "fetch failed" } } }) });
    expect(await run("tracker.jira.jql", onJira(facts))).toEqual([
      { project: "OPS", state: "cannot-verify", detail: "Jira could not be reached to run the project's JQL: fetch failed", fix: "Check that the orchestrator can reach Jira, then run the checks again." },
    ]);
  });
});

describe("tracker.filesystem.directory", () => {
  const onFilesystem = (fault: "missing" | "not-writable" | null): Partial<SetupCheckContext> => ({
    mappings: () => ({ LOCAL: makeMapping({ ticketingProvider: "filesystem", ticketingConfig: { kind: "filesystem", directory: "/tickets" } }) }),
    trackerSetupFacts: async () => ({ kind: "filesystem", directories: { LOCAL: { directory: "/tickets", fault } } }),
  });

  // A Linear or Jira project's own run would otherwise carry a row about Filesystem, stamped as that project's.
  it("answers nothing, and reads nothing, when no project uses Filesystem", async () => {
    const trackerSetupFacts = vi.fn(async () => null);
    expect(await run("tracker.filesystem.directory", { mappings: () => ({ ENG: makeMapping() }), trackerSetupFacts })).toEqual([]);
    expect(trackerSetupFacts).not.toHaveBeenCalled();
  });

  it("passes a directory the orchestrator can write to", async () => {
    expect(await run("tracker.filesystem.directory", onFilesystem(null))).toEqual([
      { project: "LOCAL", state: "pass", detail: "/tickets is a directory the orchestrator can write to" },
    ]);
  });

  it("fails a directory that does not exist", async () => {
    expect(await run("tracker.filesystem.directory", onFilesystem("missing"))).toEqual([
      {
        project: "LOCAL",
        state: "fail",
        detail: "/tickets does not exist or is not a directory, so the poll finds no tickets for this project",
        fix: "Create the directory, or correct the project's Ticket Directory on /admin#projects.",
      },
    ]);
  });

  it("fails a directory the orchestrator cannot create files in", async () => {
    expect(await run("tracker.filesystem.directory", onFilesystem("not-writable"))).toEqual([
      {
        project: "LOCAL",
        state: "fail",
        detail: "The orchestrator cannot create files in /tickets, so it cannot record ticket state or archive finished tickets",
        fix: "Give the orchestrator's user write and search permission on the directory.",
      },
    ]);
  });

  it("cannot verify, as the project's own row, when the Filesystem provider reads no setup facts", async () => {
    expect(await run("tracker.filesystem.directory", { ...onFilesystem(null), trackerSetupFacts: async () => null })).toMatchObject([
      { project: "LOCAL", state: "cannot-verify", detail: "The Filesystem provider reads no setup facts" },
    ]);
  });

  it("cannot verify, as the project's own row pointing at tracker.provider, when the facts cannot be read", async () => {
    const rows = await run("tracker.filesystem.directory", { ...onFilesystem(null), trackerSetupFacts: async () => { throw new Error("the provider broke"); } });
    expect(rows).toEqual([{ project: "LOCAL", state: "cannot-verify", detail: "The filesystem setup facts could not be read: the provider broke", fix: "More information is needed. Address the tracker.provider check first.", waitsOnCheck: "tracker.provider" }]);
  });
});
