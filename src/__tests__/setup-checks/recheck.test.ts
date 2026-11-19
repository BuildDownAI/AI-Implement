import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "../../github-errors.js";
import type { SetupCheckId, SetupCheckResult, SetupCheckRun } from "../../setup-checks/index.js";
import {
  checksNeedingAttention,
  gitHubAppErrorChecks,
  pointAtSetupChecks,
  recheckKey,
  recheckSetupCheck,
  recheckSetupChecks,
  referenceRepoChecks,
  rememberRecheck,
  runnerFailureChecks,
  setSetupCheckRecheckSender,
  trackerSetupChecksSentence,
  type SetupCheckRecheck,
} from "../../setup-checks/recheck.js";

afterEach(() => setSetupCheckRecheckSender(null));

// The one way code outside src/restate/ asks for a recheck (AII-1546).
describe("a runtime failure's recheck request", () => {
  it("goes to the sender startServer sets, and to nothing before then", async () => {
    const send = vi.fn(async () => true);
    recheckSetupCheck({ id: "github.installation", project: "ENG", cause: "dispatch-404" });
    setSetupCheckRecheckSender(send);
    recheckSetupCheck({ id: "github.installation", project: "ENG", cause: "dispatch-404" });
    expect(send.mock.calls).toEqual([[{ id: "github.installation", project: "ENG", cause: "dispatch-404" }]]);
  });

  it("never throws for a send that fails, and says which check it could not ask for", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setSetupCheckRecheckSender(async () => { throw new Error("ingress down"); });
    expect(() => recheckSetupCheck({ id: "github.permissions", project: "ENG" })).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("github.permissions"), expect.any(Error)));
  });

  it("from a log line's pointer, asks for each check it names and points at the Setup page, or adds nothing for no check", () => {
    const send = vi.fn(async () => true);
    setSetupCheckRecheckSender(send);
    const ids = ["github.installation", "github.permissions"] as const;
    const pointer = pointAtSetupChecks({ ids, project: "ENG", cause: "dispatch-404" });
    for (const id of ids) expect(pointer).toContain(id);
    expect(pointer).toContain("/admin#setup");
    expect(send.mock.calls).toEqual(ids.map((id) => [{ id, project: "ENG", cause: "dispatch-404" }]));
    expect(pointAtSetupChecks({ ids: ["runner.project-backend"], project: "ENG", cause: "launch-refused" })).toContain("runner.project-backend");
    send.mockClear();
    expect(pointAtSetupChecks({ ids: [], project: "ENG", cause: "launch-refused" })).toBe("");
    expect(send).not.toHaveBeenCalled();
  });

  it("asks for each check without a project when the failure has none, a null one included, so the recheck covers every project's rows", () => {
    const send = vi.fn(async (_request: SetupCheckRecheck) => true);
    setSetupCheckRecheckSender(send);
    recheckSetupChecks({ ids: ["github.installation"], project: null, cause: "token-vending" });
    pointAtSetupChecks({ ids: ["github.installation"], project: null, cause: "token-vending" });
    expect(send.mock.calls.map(([request]) => request.project)).toEqual([undefined, undefined]);
  });

  it("in a tracker comment, name each check as code and point at the Setup page, or add nothing for no check", () => {
    const one = trackerSetupChecksSentence(["tracker.jira.status-options"]);
    expect(one).toContain("`tracker.jira.status-options`");
    expect(one).toContain("/admin#setup");
    const two = trackerSetupChecksSentence(["tracker.jira.credentials", "tracker.jira.fields"]);
    for (const id of ["tracker.jira.credentials", "tracker.jira.fields"]) expect(two).toContain(`\`${id}\``);
    expect(trackerSetupChecksSentence([])).toBe("");
  });

  it.each([
    ["refused App credentials", { status: 401, path: "/app/installations/1/access_tokens" }, ["github.app-identity", "github.clock"]],
    ["an App not installed on the owner", { status: 404, path: "/orgs/acme/installation" }, ["github.installation"]],
    ["a repository the App cannot see", { status: 404, path: "/repos/acme/widgets" }, ["github.installation"]],
    ["a missing permission", { status: 403, path: "/repos/acme/widgets/contents/x" }, ["github.permissions"]],
    ["a GitHub error no setup fault explains", { status: 502, path: "/repos/acme/widgets" }, []],
    ["an error from anywhere else", null, []],
  ] as const)("name the checks behind %s", (_name, github, ids) => {
    const err = github ? new GitHubApiError(github) : new Error("socket hang up");
    expect(gitHubAppErrorChecks(err)).toEqual(ids);
  });
});

describe("the checks behind a failure the runner reported", () => {
  it.each([
    ["GIT_AUTH", false, ["github.permissions"]],
    ["CHECKS_PERMISSION_DENIED", false, ["github.permissions"]],
    ["PROVIDER_AUTH", false, ["model.credentials-adopted"]],
    ["PROVIDER_AUTH", true, []],
    ["GIT_AUTH", true, ["github.permissions"]],
    ["PROVIDER_OVERLOADED", false, []],
    [undefined, false, []],
  ] as const)("for %s, with a managed credential %s, are %j", (code, managedCredential, ids) => {
    expect(runnerFailureChecks(code, { managedCredential })).toEqual(ids);
  });

  it("for reference repositories that missed the run, are github.reference-repos once when any cause is one the check reads", () => {
    expect(referenceRepoChecks([{ cause: "clone-error" }, { cause: "no-auth" }, { cause: "ref-not-found" }])).toEqual(["github.reference-repos"]);
    for (const cause of ["no-auth", "ref-not-found", "token-error"] as const) expect(referenceRepoChecks([{ cause }])).toEqual(["github.reference-repos"]);
    expect(referenceRepoChecks([{ cause: "clone-error" }, { cause: "path-invalid" }, {}])).toEqual([]);
  });
});

describe("the checks a stored run shows needing attention", () => {
  const row = (id: SetupCheckId, state: SetupCheckResult["state"], project?: string): SetupCheckResult =>
    ({ id, title: "", group: "github", tier: "core", onAdminPath: false, state, ...(project ? { project } : {}) });
  const ids: SetupCheckId[] = ["github.installation", "github.workflow-default-branch", "github.app-identity"];

  it("are the project's own rows of a per-project check and any row of an orchestrator-wide one, that fail, cannot verify or warn", () => {
    const run: SetupCheckRun = { checkedAt: 0, results: [
      row("github.installation", "fail", "ENG"),
      row("github.workflow-default-branch", "fail", "OPS"),
      row("github.app-identity", "warn"),
    ] };
    expect(checksNeedingAttention(run, ids, "ENG")).toEqual(["github.installation", "github.app-identity"]);
  });

  it("leave out a passing row, and are none with no stored run", () => {
    const run: SetupCheckRun = { checkedAt: 0, results: [row("github.installation", "pass", "ENG"), row("github.app-identity", "not-applicable")] };
    expect(checksNeedingAttention(run, ids, "ENG")).toEqual([]);
    expect(checksNeedingAttention(null, ids, "ENG")).toEqual([]);
  });
});

describe("a recheck's hold bookkeeping", () => {
  const HOUR = 60 * 60_000;

  it("keeps each project's recheck time apart, and the check's own for rows with no project", () => {
    expect(new Set([
      recheckKey({ checks: ["tracker.linear.team-access"], projects: ["ENG"] }),
      recheckKey({ checks: ["tracker.linear.team-access"], projects: ["OPS"] }),
      recheckKey({ checks: ["tracker.linear.team-access"] }),
    ]).size).toBe(3);
  });

  it("keeps only the recheck times within the hour, and adds the new one", () => {
    expect(rememberRecheck({ old: 0, recent: 1 }, "new", HOUR)).toEqual({ recent: 1, new: HOUR });
  });
});
