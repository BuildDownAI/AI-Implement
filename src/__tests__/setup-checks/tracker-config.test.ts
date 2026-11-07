import { describe, expect, it, vi } from "vitest";
import type { LinearSetupFacts } from "../../providers/types.js";
import type { SetupCheckContext, SetupCheckId, SetupCheckOutcome } from "../../setup-checks/index.js";
import { TRACKER_CONFIG_CHECKS } from "../../setup-checks/tracker-config.js";
import { makeMapping, makeProvider } from "../helpers/builders.js";
import { makeLinearSetupFacts, makeSetupCheckContext } from "../helpers/fixtures/setup-checks.js";

async function run(id: SetupCheckId, overrides: Partial<SetupCheckContext> = {}): Promise<SetupCheckOutcome[]> {
  const check = TRACKER_CONFIG_CHECKS.find((c) => c.id === id);
  if (!check) throw new Error(`no check ${id}`);
  const outcomes = await check.run(makeSetupCheckContext(overrides));
  if (id.startsWith("tracker.jira.") || id === "tracker.filesystem.directory") {
    for (const outcome of outcomes) expect(`${outcome.detail} ${outcome.fix}`).not.toMatch(/docs\//);
    if (!id.endsWith(".credentials") && outcomes.some((o) => o.state !== "not-applicable" || o.project)) {
      expect(outcomes.map((o) => o.project)).toEqual(Object.entries(makeSetupCheckContext(overrides).mappings())
        .filter(([, m]) => m.ticketingProvider === (id.startsWith("tracker.jira.") ? "jira" : "filesystem"))
        .map(([key]) => key));
    }
  }
  return outcomes;
}

/** One Linear project per key, each its team's key, reading `facts`. */
function onLinear(facts: LinearSetupFacts | null, ...keys: string[]): Partial<SetupCheckContext> {
  return {
    mappings: () => Object.fromEntries((keys.length > 0 ? keys : ["ENG"]).map((key) => [key, makeMapping()])),
    trackerSetupFacts: async () => facts,
  };
}

const REFUSED: LinearSetupFacts = { kind: "linear", token: "refused", status: 401, error: "Linear token mint failed (401): invalid_client" };

const LINEAR_IDS: SetupCheckId[] = [
  "tracker.linear.credentials",
  "tracker.linear.team-access",
  "tracker.linear.pickup-label",
  "tracker.linear.lifecycle-labels",
  "tracker.linear.workflow-states",
];

describe("every Linear check", () => {
  it.each(LINEAR_IDS)("does not apply when no project uses Linear (%s)", async (id) => {
    const outcomes = await run(id, { mappings: () => ({ OPS: makeMapping({ ticketingProvider: "jira" }) }) });
    expect(outcomes).toEqual([{ state: "not-applicable", detail: "No project uses Linear" }]);
  });

  it.each(LINEAR_IDS.filter((id) => id !== "tracker.linear.credentials"))(
    "cannot verify, and points at the credentials check, when Linear gives the app no token (%s)",
    async (id) => {
      expect(await run(id, onLinear(REFUSED))).toEqual([
        { state: "cannot-verify", detail: "Linear gave the app no token, so this cannot be read", fix: "Clear tracker.linear.credentials first." },
      ]);
    },
  );

  it.each(LINEAR_IDS)("cannot verify when the Linear provider reads no setup facts (%s)", async (id) => {
    expect(await run(id, onLinear(null))).toMatchObject([{ state: "cannot-verify", detail: "The Linear provider reads no setup facts" }]);
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
        detail: "The jira provider has no setup checks, so the tracker setup of OPS is not checked",
        fix: "Check the tracker's credentials, labels and states by hand.",
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
        { project: "ENGG", state: "cannot-verify", detail: "The app cannot see team ENGG, so this cannot be read", fix: "Clear tracker.linear.team-access first." },
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
  it("passes when each lifecycle label is missing or has its exact name", async () => {
    const facts = makeLinearSetupFacts({ found: [{ name: "AI-Working", teamKey: "ENG" }, { name: "Plan-Complete", teamKey: null }] });
    expect(await run("tracker.linear.lifecycle-labels", onLinear(facts))).toEqual([
      { project: "ENG", state: "pass", detail: "Each lifecycle label has its exact name, or is created at first use" },
    ]);
  });

  it("warns about the label the orchestrator would reuse: the team's own, even beside an exact workspace label", async () => {
    const facts = makeLinearSetupFacts({ found: [{ name: "ai-working", teamKey: "ENG" }, { name: "AI-Working", teamKey: null }, { name: "plan-complete", teamKey: null }] });
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
    const facts = makeLinearSetupFacts({ teams: { ENG: ["started", "completed"], OPS: ["started", "completed"] }, found: [{ name: "ai-planning", teamKey: "OPS" }] });
    const outcomes = await run("tracker.linear.lifecycle-labels", onLinear(facts, "ENG", "OPS"));
    expect(outcomes).toMatchObject([{ project: "ENG", state: "pass" }, { project: "OPS", state: "warn" }]);
  });

  it("judges Ready for Review as it judges the other lifecycle labels", async () => {
    const facts = makeLinearSetupFacts({ found: [{ name: "Ready for review", teamKey: null }] });
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

describe("Jira setup", () => {
  const options = ["Ready", "Planning", "Awaiting Approval", "Plan Approved", "Implementing", "PR Ready", "Merged", "Planning Failed", "Implementation Failed"];
  const writes = ["poll bucket pickup", "markPlanningStarted", "markPlanComplete", "clearWorkingState", "markImplementing", "markPrReady", "markMerged", "markPlanningFailed", "markImplementationFailed"];
  const row = () => ({ fields: { statusFieldId: "s", repoFieldId: "r", profilesFieldId: null, baseBranchFieldId: null }, ambiguousOptional: [] as string[], statusOptions: options, repoOptions: ["repo"], repoFieldValue: "repo", autoApprovePlans: false, queryOk: true });
  function context(rows = { A: row() }, credentials = { ok: true } as { ok: boolean; status?: number | null }, oauth = false): Partial<SetupCheckContext> {
    return { mappings: () => Object.fromEntries(Object.keys(rows).map((k) => [k, makeMapping({ ticketingProvider: "jira" })])), trackerSetupFacts: async () => ({ kind: "jira", oauth, credentials, mappings: rows }) };
  }
  const ids = ["credentials", "fields", "field-cache", "status-options", "repo-option", "query"] as const;
  async function check(id: typeof ids[number], ctx = context()) {
    const outcomes = await run(`tracker.jira.${id}`, ctx);
    for (const o of outcomes) expect(`${o.detail} ${o.fix}`).not.toMatch(/docs\//);
    return outcomes;
  }
  it.each(options)("names missing option %s and its operation", async (option) => {
    const r = row(); r.statusOptions = options.filter((v) => v !== option);
    expect(await check("status-options", context({ A: r }))).toMatchObject([{ project: "A", state: "fail", detail: expect.stringContaining(writes[options.indexOf(option)]), fix: expect.stringContaining(option) }]);
  });
  it.each(ids.filter((id) => id !== "credentials"))("gates %s on credentials", async (id) => {
    expect(await check(id, context(undefined, { ok: false, status: 401 }))).toMatchObject([{ project: "A", state: "cannot-verify", fix: expect.stringContaining("tracker.jira.credentials") }]);
  });
  it("judges credentials", async () => {
    expect(await check("credentials", context(undefined, { ok: false, status: 403 }))).toMatchObject([{ state: "fail", detail: expect.stringContaining("403") }]);
    expect(await check("credentials", context(undefined, { ok: false, status: null }))).toMatchObject([{ state: "cannot-verify" }]);
    expect(await check("credentials", context(undefined, { ok: true }, true))).toMatchObject([{ state: "warn", fix: expect.stringContaining("JIRA_EMAIL") }]);
  });
  it.each(["AI-Implement Status", "AI-Implement Repo"].flatMap((name) =>
    ["not found", "Multiple"].map((fault) => ({ name, fault })),
  ))("judges $fault $name and isolates the mapping", async ({ name, fault }) => {
    const bad = { ...row(), fields: undefined, fieldError: `${fault}: ${name}` };
    const ctx = context({ A: bad, B: row() } as unknown as { A: ReturnType<typeof row> });
    expect(await check("fields", ctx)).toMatchObject([
      { project: "A", state: "fail", detail: expect.stringContaining(name),
        fix: expect.stringMatching(/Create or rename.*statusFieldOverride or repoFieldOverride.*ID/) },
      { project: "B", state: "pass" },
    ]);
    for (const id of ["status-options", "repo-option", "query"] as const) expect(await check(id, ctx)).toMatchObject([{ project: "A", state: "cannot-verify", fix: expect.stringContaining("tracker.jira.fields") }, { project: "B", state: "pass" }]);
  });
  it.each([
    ["AI-Implement Profiles", "profilesFieldOverride"],
    ["AI-Implement Base Branch", "baseBranchFieldOverride"],
  ])("names the remediation for ambiguous %s", async (name, override) => {
    const [outcome] = await check("fields", context({ A: { ...row(), ambiguousOptional: [name] } }));
    expect(outcome).toMatchObject({ project: "A", state: "warn", detail: expect.stringContaining(name),
      fix: expect.stringContaining(override) });
    expect(outcome.detail).toContain("feature stays off");
    expect(outcome.fix).toMatch(/Rename.*field's ID/);
  });
  it("judges feature ambiguity, cache drift, non-selects, query and repo failures", async () => {
    const r = { ...row(), ambiguousOptional: ["AI-Implement Profiles"], cachedFields: { ...row().fields, statusFieldId: "old" }, statusNotSelect: true, repoNotSelect: true, queryOk: false, queryError: "HTTP 400 bad JQL" };
    const ctx = context({ A: r });
    expect(await check("field-cache", ctx)).toMatchObject([{ project: "A", state: "warn",
      detail: expect.stringContaining("Fresh field IDs differ"), fix: "Restart the orchestrator so the poll uses the current fields." }]);
    expect(await check("status-options", ctx)).toMatchObject([{ project: "A", state: "fail",
      detail: "AI-Implement Status is not a select field", fix: "Create a select field and set statusFieldOverride to its ID." }]);
    expect(await check("repo-option", ctx)).toMatchObject([{ project: "A", state: "not-applicable", detail: "The repo field is a text field" }]);
    expect(await check("query", ctx)).toMatchObject([{ project: "A", state: "fail",
      detail: "Jira refused the bucket query: HTTP 400 bad JQL", fix: "Correct the mapping's JQL." }]);
    expect(await check("repo-option", context({ A: { ...row(), repoOptions: [] } }))).toMatchObject([{ state: "fail", fix: expect.stringContaining("repoFieldValue") }]);
    expect(await check("status-options", context({ A: { ...row(), autoApprovePlans: true, statusOptions: options.filter((v) => v !== "Awaiting Approval") } }))).toMatchObject([{ state: "pass" }]);
  });
});

it("judges every directory fault and names a fix without documentation paths", async () => {
  for (const error of [undefined, "does not exist", "is not a directory", "is not writable"]) {
    const outcomes = await run("tracker.filesystem.directory", {
      mappings: () => ({ LOCAL: makeMapping({ ticketingProvider: "filesystem" }) }),
      trackerSetupFacts: async () => ({ kind: "filesystem", directories: { LOCAL: { directory: "/tickets", error } } }),
    });
    expect(outcomes).toMatchObject([{ project: "LOCAL", state: error ? "fail" : "pass" }]);
    for (const o of outcomes) expect(`${o.detail} ${o.fix}`).not.toMatch(/docs\//);
    if (error) expect(outcomes[0].fix).toContain("permissions");
  }
});

it("reports Jira ready when the provider supplies setup facts", async () => {
  expect(await run("tracker.provider", {
    mappings: () => ({ J: makeMapping({ ticketingProvider: "jira" }) }),
    trackerProvider: async () => makeProvider({ id: "jira", fetchSetupFacts: async () => ({ kind: "jira", oauth: false, credentials: { ok: true }, mappings: {} }) }),
  })).toMatchObject([{ state: "pass", detail: expect.stringContaining("jira provider is ready") }]);
});

it("cannot verify unreadable Jira facts and names the prerequisite", async () => {
  const mapping = { fields: { statusFieldId: "s", repoFieldId: "r", profilesFieldId: null, baseBranchFieldId: null }, ambiguousOptional: [], repoFieldValue: "repo", autoApprovePlans: false };
  for (const [id, extra] of [
    ["fields", { fieldReadFailed: true, fieldError: "HTTP 403" }],
    ["status-options", { statusError: "HTTP 403" }],
    ["repo-option", { repoError: "HTTP 403" }],
    ["query", { queryError: "network error", queryUnreachable: true }],
  ] as const) {
    const outcomes = await run(`tracker.jira.${id}`, {
      mappings: () => ({ J: makeMapping({ ticketingProvider: "jira" }) }),
      trackerSetupFacts: async () => ({ kind: "jira", oauth: false, credentials: { ok: true }, mappings: { J: { ...mapping, ...extra } } }),
    });
    expect(outcomes).toMatchObject([{ project: "J", state: "cannot-verify", fix: expect.stringContaining("Clear tracker.jira.") }]);
    for (const o of outcomes) expect(`${o.detail} ${o.fix}`).not.toMatch(/docs\//);
  }
});


describe("new tracker checks without mappings", () => {
  it.each([
    "tracker.jira.credentials", "tracker.jira.fields", "tracker.jira.field-cache",
    "tracker.jira.status-options", "tracker.jira.repo-option", "tracker.jira.query",
    "tracker.filesystem.directory",
  ] as const)("%s is not applicable and reads no facts", async (id) => {
    const trackerSetupFacts = vi.fn(async () => null);
    expect(await run(id, { mappings: () => ({}), trackerSetupFacts })).toEqual([
      { state: "not-applicable", detail: id.startsWith("tracker.jira.") ? "No project uses Jira" : "No project uses Filesystem" },
    ]);
    expect(trackerSetupFacts).not.toHaveBeenCalled();
  });
});
