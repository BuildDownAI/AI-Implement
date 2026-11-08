import { describe, it, expect, vi } from "vitest";
import { adoptProjects, type AdoptionDeps } from "../agent-config-adoption.js";
import { DEFAULT_MODEL } from "../pipeline/default-model.js";
import type { RepoMapping } from "../config.js";
import { fakeFetch } from "./helpers/fake-fetch.js";
import { getDefaultBranchFileText } from "../github.js";
import { testDb } from "./helpers/test-db.js";

function fixture(files: Record<string, string | null> = {}) {
  const write = vi.fn();
  const deps: AdoptionDeps = {
    getDefaults: () => ({ config: { version: 1, mode: "configured", stages: { planning: { model: DEFAULT_MODEL }, implementation: { model: DEFAULT_MODEL }, review: { model: DEFAULT_MODEL } } } }),
    getMappings: () => ({ A: { owner: "owner", repo: "repo", workflowFile: "implement.yml", executionMode: "fly-machines" } as RepoMapping }),
    getProject: () => null,
    fingerprint: () => "fingerprint",
    runnerMode: () => "default",
    readFile: vi.fn(async (_mapping, path) => files[path] ?? null),
    inspectReadiness: vi.fn<AdoptionDeps["inspectReadiness"]>(async () => ({ status: "ready", profiles: [] })),
    write,
  };
  return { deps, write };
}
const run = (deps: AdoptionDeps, dryRun = false) => adoptProjects(deps, { dryRun });

describe("project adoption", () => {
  it("aborts before touching projects without configured defaults", async () => {
    const { deps, write } = fixture();
    deps.getDefaults = () => null;
    deps.getMappings = vi.fn();
    await expect(run(deps)).rejects.toThrow("run adopt-env first");
    expect(deps.getMappings).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
  it.each(["configured", "legacy"] as const)("preserves explicit %s rows", async mode => {
    const { deps, write } = fixture();
    deps.getProject = () => ({ config: { version: 1, mode } });
    expect((await run(deps))[0].outcome).toBe(mode === "configured" ? "already configured" : "opted out");
    expect(deps.readFile).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
  it("carries review only and checks the candidate", async () => {
    const { deps, write } = fixture({ ".ai-implement/config.yml": "models:\n  review: review-model" });
    const [result] = await run(deps);
    expect(result.stages.review).toEqual({ model: "review-model", source: ".ai-implement/config.yml" });
    const candidate = { version: 1, mode: "configured", stages: { review: { model: "review-model" } } };
    expect(write).toHaveBeenCalledWith("A", candidate, "fingerprint");
    expect(deps.inspectReadiness).toHaveBeenCalledWith(expect.objectContaining({ backend: "fly-machines" }), candidate);
  });
  it.each([false, true])("preserves legacy fallbacks when configured defaults differ (dryRun=%s)", async dryRun => {
    const { deps, write } = fixture({ ".ai-implement/config.yml": "models:\n  review: review-model" });
    deps.getDefaults = () => ({ config: { version: 1, mode: "configured", stages: {
      planning: { model: "configured-planner" }, implementation: { model: "configured-implementer" }, review: { model: "configured-reviewer" },
    } } });
    const [result] = await run(deps, dryRun);
    expect(result.stages).toEqual({
      planning: { model: DEFAULT_MODEL, source: "DEFAULT_MODEL" },
      implementation: { model: DEFAULT_MODEL, source: "DEFAULT_MODEL" },
      review: { model: "review-model", source: ".ai-implement/config.yml" },
    });
    const candidate = { version: 1, mode: "configured", stages: {
      planning: { model: DEFAULT_MODEL }, implementation: { model: DEFAULT_MODEL }, review: { model: "review-model" },
    } };
    expect(deps.inspectReadiness).toHaveBeenCalledWith(expect.anything(), candidate);
    if (dryRun) expect(write).not.toHaveBeenCalled();
    else expect(write).toHaveBeenCalledWith("A", candidate, "fingerprint");
  });
  it.each(["fly", "local", "gha", "shadow"] as const)("preserves observable mapping models on %s", async mode => {
    const { deps, write } = fixture({
      ".ai-implement/config.yml": "models:\n  review: reviewer\n  implement: implementer",
      "WORKFLOW.md": "---\nmodel: workflow\n---",
      "PLANNING.md": "---\nmodel: planner\n---",
    });
    const mapping = deps.getMappings().A;
    deps.getMappings = () => ({ A: { ...mapping, extraEnv: { CLAUDE_MODEL: " mapping-model " } } });
    deps.runnerMode = () => mode;
    const [result] = await run(deps);
    expect(result.stages.implementation).toEqual({ model: "implementer", source: ".ai-implement/config.yml" });
    expect(result.stages.review).toEqual({ model: "reviewer", source: ".ai-implement/config.yml" });
    const usesMapping = mode === "fly" || mode === "local";
    expect(result.stages.planning).toEqual({ model: usesMapping ? "mapping-model" : "planner", source: usesMapping ? "mapping.extraEnv.CLAUDE_MODEL" : "PLANNING.md" });
    expect(deps.inspectReadiness).toHaveBeenCalledWith(expect.anything(), write.mock.calls[0][1]);
  });
  it.each(["fly", "local", "gha"] as const)("uses mapping before workflow only on container backends (%s)", async mode => {
    const { deps, write } = fixture({ "WORKFLOW.md": "---\nmodel: workflow\n---" });
    const mapping = deps.getMappings().A;
    deps.getMappings = () => ({ A: { ...mapping, extraEnv: { CLAUDE_MODEL: "mapping-model" } } });
    deps.runnerMode = () => mode;
    const [result] = await run(deps);
    for (const stage of ["implementation", "review"] as const) {
      expect(result.stages[stage]).toEqual({ model: mode === "gha" ? "workflow" : "mapping-model", source: mode === "gha" ? "WORKFLOW.md" : "mapping.extraEnv.CLAUDE_MODEL" });
      expect(write.mock.calls[0][1].stages[stage].model).toBe(result.stages[stage].model);
    }
  });
  it.each([false, true])("refuses shadow model conflicts without readiness or writes (dryRun=%s)", async dryRun => {
    const { deps, write } = fixture({ ".ai-implement/config.yml": "models:\n  review: reviewer" });
    const mapping = deps.getMappings().A;
    deps.getMappings = () => ({ A: { ...mapping, extraEnv: { CLAUDE_MODEL: "mapping-model" } } });
    deps.runnerMode = () => "shadow";
    const [result] = await run(deps, dryRun);
    expect(result.outcome).toContain("model_conflict: implementation");
    expect(result.outcome).toContain("github-actions=");
    expect(result.outcome).toContain("fly-machines=mapping-model (mapping.extraEnv.CLAUDE_MODEL)");
    expect(write).not.toHaveBeenCalled();
    expect(deps.inspectReadiness).not.toHaveBeenCalled();
  });
  it("omits repository overrides that already match configured defaults", async () => {
    const { deps, write } = fixture({ "PLANNING.md": `---\nmodel: ${DEFAULT_MODEL}\n---` });
    expect((await run(deps))[0].stages.planning).toEqual({ model: DEFAULT_MODEL, source: "PLANNING.md" });
    expect(write.mock.calls[0][1].stages).toEqual({});
  });
  it("refreshes defaults inside each project's guarded window after an earlier inspection changes them", async () => {
    const { deps, write } = fixture();
    const initialDefaults = deps.getDefaults()!;
    let defaults = initialDefaults;
    const mapping = deps.getMappings().A;
    deps.getMappings = () => ({ A: mapping, B: mapping });
    deps.getDefaults = () => defaults;
    deps.fingerprint = () => JSON.stringify(defaults);
    const { StaleStageInputsError } = await import("../agent-config-store.js");
    deps.inspectReadiness = vi.fn<AdoptionDeps["inspectReadiness"]>(async request => {
      await Promise.resolve();
      if (request.projectKey === "A") {
        defaults = { config: { version: 1, mode: "configured", stages: {
          planning: { model: "new-planner" }, implementation: { model: "new-implementer" }, review: { model: "new-reviewer" },
        } } };
      }
      return { status: "ready", profiles: [] };
    });
    write.mockImplementation((_key, _candidate, expectedInputs) => {
      if (expectedInputs !== deps.fingerprint(_key)) throw new StaleStageInputsError();
    });
    const results = await run(deps);
    expect(results.map(result => result.outcome)).toEqual(["inputs_changed", "adopted"]);
    const carried = { planning: { model: DEFAULT_MODEL }, implementation: { model: DEFAULT_MODEL }, review: { model: DEFAULT_MODEL } };
    expect(write).toHaveBeenLastCalledWith("B", { version: 1, mode: "configured", stages: carried }, JSON.stringify(defaults));
    expect(deps.inspectReadiness).toHaveBeenLastCalledWith(expect.objectContaining({ projectKey: "B" }), expect.objectContaining({ stages: carried }));
  });
  it("reads default-branch files through the GitHub reader", async () => {
    const github = fakeFetch({
      "GET /repos/owner/repo/contents/.ai-implement/config.yml": { json: { type: "file", encoding: "base64", content: Buffer.from("models:\n  review: repo-review").toString("base64") } },
      "GET /repos/owner/repo/contents/WORKFLOW.md": { status: 404 },
      "GET /repos/owner/repo/contents/PLANNING.md": { status: 404 },
    });
    github.install();
    const { deps } = fixture();
    deps.readFile = (mapping, path) => getDefaultBranchFileText("test-token", mapping.owner, mapping.repo, path);
    expect((await run(deps))[0].stages.review).toEqual({ model: "repo-review", source: ".ai-implement/config.yml" });
    expect(github.calls.every(call => !call.url.search)).toBe(true);
  });
  it("uses workflow fallback and independent planning front matter", async () => {
    const { deps, write } = fixture({ "WORKFLOW.md": "---\nmodel: workflow\n---", "PLANNING.md": "---\nmodel: planner\n---", ".ai-implement/config.yml": "models:\n  review: reviewer\n  implement: 42" });
    const [result] = await run(deps);
    expect(result.stages.planning).toEqual({ model: "planner", source: "PLANNING.md" });
    expect(result.stages.implementation.source).toBe("WORKFLOW.md");
    expect(write.mock.calls[0][1].stages).toEqual({ planning: { model: "planner" }, implementation: { model: "workflow" }, review: { model: "reviewer" } });
  });
  it.each([null, "[malformed", "models: []"])("preserves DEFAULT_MODEL without redundant overrides for %s", async config => {
    const { deps, write } = fixture({ ".ai-implement/config.yml": config });
    expect((await run(deps))[0].stages.review.model).toBe(DEFAULT_MODEL);
    expect(write.mock.calls[0][1].stages).toEqual({});
  });
  it("drops all carryover when a repository read fails", async () => {
    const { deps, write } = fixture();
    deps.readFile = async (_mapping, path) => { if (path === "PLANNING.md") throw Error("private detail"); return "---\nmodel: other\n---"; };
    const [result] = await run(deps);
    expect(result.modelNotCarried).toBe(true);
    expect(result.outcome).toBe("adopted");
    expect(write.mock.calls[0][1].stages).toEqual({});
  });
  it.each([false, true])("refuses failed readiness (throws=%s)", async throws => {
    const { deps, write } = fixture();
    deps.inspectReadiness = async () => { if (throws) throw Error("private detail"); return { status: "not-ready", code: "credential_unavailable" }; };
    expect((await run(deps))[0].outcome).toBe(throws ? "readiness_unavailable" : "credential_unavailable");
    expect(write).not.toHaveBeenCalled();
  });
  it("reports a guarded-write conflict without replacing an opt-out", async () => {
    const { deps } = fixture();
    const { StaleStageInputsError } = await import("../agent-config-store.js");
    deps.write = () => { throw new StaleStageInputsError(); };
    expect((await run(deps))[0].outcome).toBe("inputs_changed");
  });
  it.each([
    ["default", "github-actions", "github-actions"],
    ["default", "fly-machines", "fly-machines"],
    ["shadow", "fly-machines", "github-actions"],
    ["local", "github-actions", "local-docker"],
  ] as const)("checks planning readiness on %s / %s", async (mode, executionMode, planningBackend) => {
    const { deps, write } = fixture();
    deps.runnerMode = () => mode;
    deps.getMappings = () => ({ A: { owner: "owner", repo: "repo", workflowFile: "implement.yml", planningEnabled: true, planningWorkflowFile: "plan.yml", executionMode } as RepoMapping });
    deps.inspectReadiness = vi.fn<AdoptionDeps["inspectReadiness"]>(async request =>
      request.workflowFile === "plan.yml" ? { status: "not-ready", code: "runner_incompatible" } : { status: "ready", profiles: [] });
    expect((await run(deps))[0].outcome).toBe("runner_incompatible");
    expect(deps.inspectReadiness).toHaveBeenLastCalledWith(expect.objectContaining({ backend: planningBackend, workflowFile: "plan.yml" }), expect.anything());
    expect(write).not.toHaveBeenCalled();
  });
  it("checks both shadow backends", async () => {
    const { deps, write } = fixture();
    deps.runnerMode = () => "shadow";
    deps.inspectReadiness = vi.fn<AdoptionDeps["inspectReadiness"]>(async request => request.backend === "fly-machines" ? { status: "not-ready", code: "runner_incompatible" } : { status: "ready", profiles: [] });
    expect((await run(deps))[0].outcome).toBe("runner_incompatible");
    expect(deps.inspectReadiness).toHaveBeenCalledTimes(2);
    expect(write).not.toHaveBeenCalled();
  });
  it("dry-run makes zero database writes; adoption changes only project config and is idempotent", async () => {
    const { modules: { store, db } } = await testDb({ modules: { store: () => import("../agent-config-store.js"), db: () => import("../dedup.js") } });
    store.saveAccountProfileRevision({ profileId: "active", identity: "Active", revision: 1, agent: "claude", provider: "anthropic", authMode: "anthropic-api-key" });
    const stage = { agent: "claude" as const, provider: "anthropic" as const, model: DEFAULT_MODEL, accountProfileId: "active", invocationTimeoutMs: 60000 };
    store.setOrchestratorDefaults({ version: 1, mode: "configured", stages: { planning: stage, implementation: stage, review: stage } });
    const { deps } = fixture();
    Object.assign(deps, { getDefaults: store.getOrchestratorDefaults, getProject: store.getProjectStageConfig, fingerprint: store.readStageInputsFingerprint, write: (key: string, candidate: Parameters<typeof store.setProjectStageConfig>[1], fingerprint: string) => store.setProjectStageConfig(key, candidate, "test", fingerprint) });
    const changes = () => (db.getDb().prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    store.saveAccountProfileRevision({ profileId: "disabled", identity: "Disabled", revision: 1, agent: "claude", provider: "anthropic", authMode: "anthropic-api-key" });
    store.retireAccountProfile("disabled");
    const profiles = db.getDb().prepare("SELECT * FROM model_account_profile_revisions").all();
    const before = changes();
    expect((await run(deps, true))[0].outcome).toBe("would adopt");
    expect(changes()).toBe(before);
    expect((await run(deps))[0].outcome).toBe("adopted");
    expect((await run(deps))[0].outcome).toBe("already configured");
    expect(db.getDb().prepare("SELECT * FROM model_account_profile_revisions").all()).toEqual(profiles);
    expect(store.resolveCandidateProjectStageConfig("another-project", { version: 1, mode: "configured" }).resolution.mode).toBe("configured");
    expect(() => store.resolveCandidateProjectStageConfig("another-project", { version: 1, mode: "configured", stages: { review: { accountProfileId: "disabled" } } })).toThrow();
    expect(store.getProjectStageConfig("A")?.config).toEqual({ version: 1, mode: "configured", stages: {} });
    // A concurrent operator opt-out wins over the inspected candidate.
    deps.getMappings = () => ({ B: Object.values(fixture().deps.getMappings())[0] });
    deps.inspectReadiness = async () => {
      store.setProjectStageConfig("B", { version: 1, mode: "legacy" });
      return { status: "ready", profiles: [] };
    };
    const freshAdoption = await import("../agent-config-adoption.js");
    expect((await freshAdoption.adoptProjects(deps, { dryRun: false }))[0].outcome).toBe("inputs_changed");
    expect(store.getProjectStageConfig("B")?.config.mode).toBe("legacy");
  });
});
