import { describe, expect, it, vi } from "vitest";
import { clearTokenCache } from "../../github-app-auth.js";
import { __clearWorkflowProbeCacheForTests } from "../../workflow-probe.js";
import { GITHUB_CONFIG_CHECKS } from "../../setup-checks/github-config.js";
import { runSetupChecks, summarizeSetupChecks } from "../../setup-checks/index.js";
import { WorkflowProbeTransientError, type WorkflowCapabilities } from "../../workflow-probe.js";
import { makeMapping } from "../helpers/builders.js";
import { makeSetupCheckContext } from "../helpers/fixtures/setup-checks.js";

const modern: WorkflowCapabilities = {
  contract: "envelope", supportsRunPublicationToken: true, supportsAttemptCorrelation: true,
  supportsPrivateRunConfig: true, supportsStageAgentConfig: true,
  hasStageAgentConfigMarker: true, hasStageAgentLaunchContextMarker: true,
};
const fix = "Sync workflows on this project (admin row action or MCP trigger_workflow_sync) and merge its PR";
const check = GITHUB_CONFIG_CHECKS[0];

describe("workflow generation", () => {
  it.each([
    ["missing file", { contract: "legacy", missing: true }, "fail", "404"],
    ["legacy", { contract: "legacy" }, "fail", "run_config"],
    ["publication", { supportsRunPublicationToken: false }, "warn", "run_publication_token"],
    ["attempt", { supportsAttemptCorrelation: false }, "warn", "run_attempt_token"],
    ["private", { supportsPrivateRunConfig: false }, "warn", "private-run-config-v1"],
    ["stage config", { hasStageAgentConfigMarker: false }, "warn", "stage-agent-config-v1"],
    ["launch context", { hasStageAgentLaunchContextMarker: false }, "warn", "stage-agent-launch-context-v1"],
    ["no execution policy", { supportsExecutionPolicy: false }, "pass", "All required"],
  ] as const)("%s", async (_, patch, state, detail) => {
    const rows = await check.run(makeSetupCheckContext({
      mappings: () => ({ ENG: makeMapping({ defaultBranch: "main", workflowFile: "claude-implement-2.yml" }) }),
      workflowCapabilities: async () => ({ ...modern, ...patch }),
    }));
    expect(rows[0]).toMatchObject({ project: "ENG", state, detail: expect.stringContaining(detail) });
    expect(rows[0].detail).toContain("claude-implement-2.yml@main");
    expect(rows[0].fix).toBe(state === "pass" ? undefined : fix);
  });

  it.each(["github-actions", "fly-machines"] as const)("judges retired workflows before legacy (%s)", async (executionMode) => {
    const rows = await check.run(makeSetupCheckContext({
      mappings: () => ({ ENG: makeMapping({ executionMode }) }),
      workflowCapabilities: async () => ({ ...modern, contract: "legacy" }),
      defaultBranchFileExists: async () => true,
    }));
    expect(rows[0]).toMatchObject({ state: executionMode === "github-actions" ? "fail" : "warn", fix });
    expect(rows[0].detail).toContain("retired_workflow_present");
  });

  describe.each(["github-actions", "fly-machines"] as const)("%s state precedence", (executionMode) => {
    it.each([
      ["missing implementation", { contract: "legacy", missing: true }, modern, "implement.yml@main: 404"],
      ["legacy implementation", { contract: "legacy" }, modern, "implement.yml@main: missing run_config"],
      ["missing planning", modern, { contract: "legacy", missing: true }, "plan.yml@main: 404"],
      ["legacy planning", modern, { contract: "legacy" }, "plan.yml@main: missing run_config"],
      ["implementation before planning", { contract: "legacy", missing: true }, { contract: "legacy" }, "implement.yml@main: 404"],
    ] as const)("%s", async (_, implementation, planning, finding) => {
      const rows = await check.run(makeSetupCheckContext({
        mappings: () => ({ ENG: makeMapping({ executionMode, defaultBranch: "main", workflowFile: "implement.yml", planningWorkflowFile: "plan.yml", planningEnabled: true }) }),
        workflowCapabilities: async (_mapping, file) => ({ ...modern, ...(file === "implement.yml" ? implementation : planning) }),
      }));
      expect(rows[0]).toMatchObject({ state: executionMode === "github-actions" ? "fail" : "warn", fix });
      expect(rows[0].detail?.split(". ").slice(1).join(". ")).toBe(finding + (finding.endsWith("404") ? " (missing file)" : " (legacy)"));
    });

    it("reports token warnings before marker warnings", async () => {
      const rows = await check.run(makeSetupCheckContext({
        mappings: () => ({ ENG: makeMapping({ executionMode }) }),
        workflowCapabilities: async () => ({ ...modern, supportsRunPublicationToken: false, supportsPrivateRunConfig: false }),
      }));
      expect(rows[0]).toMatchObject({ state: "warn", fix });
      expect(rows[0].detail).toContain("missing run_publication_token");
      expect(rows[0].detail).not.toContain("private-run-config-v1");
    });
  });

  it("never probes disabled planning and fails enabled legacy planning", async () => {
    const reader = vi.fn(async (_mapping, file: string) => ({ ...modern, contract: file === "plan.yml" ? "legacy" as const : "envelope" as const }));
    const mapping = makeMapping({ planningEnabled: false, planningWorkflowFile: "plan.yml" });
    const ctx = makeSetupCheckContext({ mappings: () => ({ ENG: mapping }), workflowCapabilities: reader });
    expect((await check.run(ctx))[0].state).toBe("pass");
    expect(reader).toHaveBeenCalledTimes(1);
    mapping.planningEnabled = true;
    expect((await check.run(ctx))[0]).toMatchObject({ state: "fail", detail: expect.stringContaining("plan.yml@") });
  });

  it.each(["capabilities", "retired"] as const)("reports failed %s reads per project before generation findings", async (failure) => {
    const ctx = makeSetupCheckContext({
      mappings: () => ({ BAD: makeMapping({ repo: "bad" }), GOOD: makeMapping({ repo: "good" }) }),
      workflowCapabilities: async (mapping) => {
        if (mapping.repo === "bad" && failure === "capabilities") throw new WorkflowProbeTransientError("failed");
        return mapping.repo === "bad" ? { ...modern, contract: "legacy" } : modern;
      },
      defaultBranchFileExists: async (mapping) => {
        if (mapping.repo === "bad" && failure === "retired") throw new Error("403");
        return mapping.repo === "bad";
      },
    });
    const run = await runSetupChecks(ctx, GITHUB_CONFIG_CHECKS);
    expect(run.results.map(({ project, state }) => [project, state])).toEqual([["BAD", "cannot-verify"], ["GOOD", "pass"]]);
    expect(summarizeSetupChecks(run)?.rows[0]).toEqual({
      id: "github.workflow-generation", title: "Workflow template generation", project: "BAD", state: "cannot-verify",
    });
  });

  it("does no reads without mappings", async () => {
    const reader = vi.fn();
    await check.run(makeSetupCheckContext({ workflowCapabilities: reader, defaultBranchFileExists: reader }));
    expect(reader).not.toHaveBeenCalled();
  });

  it("matches the issue's fleet expectations with explicit representative configurations", async () => {
    // These are representative inputs, not an authenticated historical export.
    // The issue supplies states only; actual 2026-11-07 mappings/blobs are still needed.
    const fleet = {
      AII: { mapping: makeMapping({ executionMode: "fly-machines", planningEnabled: true }), implementation: modern, planning: modern },
      CON: { mapping: makeMapping({ executionMode: "github-actions", planningEnabled: true }), implementation: modern, planning: modern },
      TEST: { mapping: makeMapping({ executionMode: "github-actions", planningEnabled: false }), implementation: modern, planning: null },
      SAN: { mapping: makeMapping({ executionMode: "fly-machines", planningEnabled: false }), implementation: { ...modern, contract: "legacy" as const }, planning: null },
      KGB: { mapping: makeMapping({ executionMode: "fly-machines", planningEnabled: true }), implementation: { ...modern, supportsPrivateRunConfig: false }, planning: modern },
      DOC: { mapping: makeMapping({ executionMode: "github-actions", planningEnabled: true }), implementation: { ...modern, supportsRunPublicationToken: false }, planning: modern },
      KGA: { mapping: makeMapping({ executionMode: "fly-machines", planningEnabled: false }), implementation: { ...modern, hasStageAgentConfigMarker: false }, planning: null },
      BDS: { mapping: makeMapping({ executionMode: "github-actions", planningEnabled: true }), implementation: modern, planning: { ...modern, hasStageAgentLaunchContextMarker: false } },
    };
    const rows = await check.run(makeSetupCheckContext({
      mappings: () => Object.fromEntries(Object.entries(fleet).map(([project, entry]) => [project, entry.mapping])),
      workflowCapabilities: async (mapping, file) => {
        const entry = Object.values(fleet).find((entry) => entry.mapping === mapping)!;
        const capabilities = file === mapping.workflowFile ? entry.implementation : entry.planning;
        if (!capabilities) throw new Error("Disabled planning must not be probed");
        return capabilities;
      },
    }));
    expect(rows.map(({ project, state }) => [project, state])).toEqual([
      ["AII", "pass"], ["CON", "pass"], ["TEST", "pass"], ["SAN", "warn"],
      ["KGB", "warn"], ["DOC", "warn"], ["KGA", "warn"], ["BDS", "warn"],
    ]);
    for (const row of rows) if (row.state === "warn") expect(row.fix).toBe(fix);
  });
});

it.each(["valid", "directory", "invalid-base64", "invalid-json", "invalid-implementation", "invalid-planning"])("default readers are read-only and isolate %s file responses", async (response) => {
  clearTokenCache();
  __clearWorkflowProbeCacheForTests();
  const { generateKeyPairSync } = await import("node:crypto");
  const { fakeFetch } = await import("../helpers/fake-fetch.js");
  const { createSetupCheckContext } = await import("../../setup-checks/index.js");
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const yaml = ["  run_config:", "  run_publication_token:", "  run_attempt_token:",
    "# ai-implement-capability: private-run-config-v1", "# ai-implement-capability: stage-agent-config-v1",
    "# ai-implement-capability: stage-agent-launch-context-v1"].join("\n");
  const blob = { type: "file", encoding: "base64", content: Buffer.from(yaml).toString("base64") };
  const fake = fakeFetch({
    "GET /orgs/setup-generation-test/installation": { json: { id: 1716 } },
    "POST /app/installations/1716/access_tokens": { json: { token: "test-token", expires_at: new Date(Date.now() + 3600000).toISOString() } },
    "GET /repos/setup-generation-test/repo/contents/.github/workflows/implement.yml": { json: response === "invalid-implementation" ? { ...blob, content: "!!!" } : blob },
    "GET /repos/setup-generation-test/repo/contents/.github/workflows/plan.yml": { json: response === "invalid-planning" ? { ...blob, content: "!!!" } : blob },
    "GET /repos/setup-generation-test/repo/contents/.github/workflows/comment-trigger.yml": ["valid", "invalid-implementation", "invalid-planning"].includes(response) ? { status: 404 }
      : response === "directory" ? { json: [] }
      : response === "invalid-json" ? { text: "not json" }
      : { json: { type: "file", encoding: "base64", content: "!!!" } },
    "GET /repos/setup-generation-test/good/contents/.github/workflows/implement.yml": { json: blob },
    "GET /repos/setup-generation-test/good/contents/.github/workflows/comment-trigger.yml": { status: 404 },
    "GET /repos/setup-generation-test/good/contents/.github/workflows/claude-kg-refresh.yml": { status: 404 },
    "GET /repos/setup-generation-test/repo/contents/.github/workflows/claude-kg-refresh.yml": { status: 404 },
  }).install();
  const ctx = createSetupCheckContext({
    env: { GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: key },
    restateStatus: () => ({ sidecar: { state: "ready" }, registration: { state: "registered" } }),
    mappings: () => ({ ENG: makeMapping({ owner: "setup-generation-test", repo: "repo", defaultBranch: "release/main", workflowFile: "implement.yml", planningWorkflowFile: "plan.yml", planningEnabled: true }), GOOD: makeMapping({ owner: "setup-generation-test", repo: "good", defaultBranch: "release/main", workflowFile: "implement.yml" }) }),
  });
  expect((await check.run(ctx)).map(({ project, state }) => [project, state])).toEqual([["ENG", response === "valid" ? "pass" : "cannot-verify"], ["GOOD", "pass"]]);
  expect(fake.calls.filter((call) => call.method !== "GET").map((call) => call.path)).toEqual(["/app/installations/1716/access_tokens"]);
  const reads = fake.calls.filter((call) => call.path.includes("/contents/"));
  expect(reads).toHaveLength(7);
  expect(reads.every((call) => call.url.searchParams.get("ref") === "release/main")).toBe(true);
  const failed = createSetupCheckContext({
    env: {}, restateStatus: ctx.restateStatus,
    mappings: () => ({ ENG: makeMapping({ owner: "unconfigured-owner" }) }),
  });
  expect((await check.run(failed))[0].state).toBe("cannot-verify");
});
