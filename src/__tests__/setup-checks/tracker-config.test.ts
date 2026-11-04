import { describe, expect, it } from "vitest";
import type { LinearSetupFacts } from "../../providers/types.js";
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

const REFUSED: LinearSetupFacts = { kind: "linear", token: "refused", status: 401, error: "Linear token mint failed (401): invalid_client" };

const LINEAR_IDS: SetupCheckId[] = [
  "tracker.linear.credentials",
  "tracker.linear.team-access",
  "tracker.linear.pickup-label",
  "tracker.linear.lifecycle-labels",
  "tracker.linear.ready-for-review",
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
});

describe("tracker.linear.ready-for-review", () => {
  it("passes when the label exists with its exact name", async () => {
    expect(await run("tracker.linear.ready-for-review", onLinear(makeLinearSetupFacts()))).toEqual([{ state: "pass", detail: "The label Ready for Review exists" }]);
  });

  it("warns when the label exists only in a different case", async () => {
    const facts = makeLinearSetupFacts({ found: [{ name: "AI-Implement", teamKey: null }, { name: "Ready for review", teamKey: null }] });
    expect(await run("tracker.linear.ready-for-review", onLinear(facts))).toEqual([
      {
        state: "warn",
        detail: "Only Ready for review exists, which differs from Ready for Review in case. A finished run applies it, but the poll and the merge step look for the exact name.",
        fix: "Rename the label to exactly Ready for Review.",
      },
    ]);
  });

  it("cannot verify when no such label exists, since only creating it would show whether the app may", async () => {
    const facts = makeLinearSetupFacts({ found: [{ name: "AI-Implement", teamKey: null }] });
    expect(await run("tracker.linear.ready-for-review", onLinear(facts))).toEqual([
      {
        state: "cannot-verify",
        detail: "No Ready for Review label exists. The first finished run creates it at workspace level, which needs a workspace admin, and only that write would show whether the app is one.",
        fix: "Create a workspace label named exactly Ready for Review in Linear.",
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
