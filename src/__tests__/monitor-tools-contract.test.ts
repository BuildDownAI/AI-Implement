// Real-route recordings copied by Control-Plane. Regenerate deliberately with:
// UPDATE_CONTRACT_FIXTURES=1 npx vitest run src/__tests__/monitor-tools-contract.test.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type * as DedupModule from "../dedup.js";
import { GetFleetReportArgsSchema, GetTenantHealthArgsSchema } from "../restate/tools.js";
import { testDb } from "./helpers/test-db.js";
import { checkExchange, recordExchange, type Exchange } from "./contract-recorder.js";

import { makeStageAgentDefaults, makeStageAgentProfile } from "./helpers/builders.js";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
let dedup: typeof DedupModule;

beforeEach(async () => {
  ({ modules: { dedup } } = await testDb({ modules: { dedup: () => import("../dedup.js") } }));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("KG_SOURCE_REPO", "");
  vi.stubEnv("KG_EMBEDDINGS_DEGRADED", "");
  vi.stubEnv("RUNNER_MODE", "default");
  const { setRestateStatus } = await import("../restate/status.js");
  setRestateStatus({ sidecar: { state: "ready" }, registration: { state: "registered" } });
  const { sidecarHealth } = await import("../kg-provider.js");
  Object.assign(sidecarHealth, { reachable: true, toolsListed: true, lastError: null, checkedAt: NOW });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function payload(recorded: Exchange) {
  expect(recorded.response.status).toBe(200);
  expect(recorded.response.body.isError).toBeFalsy();
  return JSON.parse(recorded.response.body.content[0].text);
}

describe("recorded get_tenant_health exchanges", () => {
  it.each(["healthy", "degraded", "stage-agents"])("%s", async (scenario) => {
    vi.stubEnv("KG_EMBEDDINGS_DEGRADED", scenario === "degraded" ? "1" : "");
    if (scenario === "stage-agents") {
      const store = await import("../agent-config-store.js");
      store.saveAccountProfileRevision(makeStageAgentProfile());
      store.setOrchestratorDefaults(makeStageAgentDefaults());
      store.setProjectConfigured("AII", true);
      dedup.getDb().prepare("INSERT INTO mappings (team_key, owner, repo, workflow_file, default_branch) VALUES (?, 'acme', 'widgets', 'claude.yml', 'main')").run("BDS");
      dedup.getDb().prepare("INSERT INTO mappings (team_key, owner, repo, workflow_file, default_branch) VALUES (?, 'acme', 'widgets', 'claude.yml', 'main')").run("AII");
    }
    const { SetupChecks, SETUP_CHECKS_KEY } = await import("../restate/setup-checks.js");
    const get = vi.fn(async () => null);
    const recorded = await recordExchange("get_tenant_health", { args: {} }, {
      objectClient: (definition, key) => {
        expect(definition).toBe(SetupChecks);
        expect(key).toBe(SETUP_CHECKS_KEY);
        return { get };
      },
    });
    expect(get).toHaveBeenCalledOnce();
    expect(payload(recorded).kgDegraded).toBe(scenario === "degraded");
    checkExchange("get_tenant_health", scenario, recorded);
  });
});

function seedFleet() {
  const insert = dedup.getDb().prepare(`INSERT INTO dispatch_log
    (issue_id, issue_identifier, repo, dispatched_at, phase, status)
    VALUES (?, ?, 'acme/widgets', ?, 'implementation', ?)`);
  // No pass/cost measurements: preserve nulls rather than inventing zeroes.
  for (const [age, status] of [[2, "completed"], [14, "failed"], [31, "completed"]] as const) {
    insert.run(`issue-${age}`, `AII-${age}`, NOW - age * DAY, status);
  }
}

describe("recorded get_fleet_report exchanges", () => {
  it.each([
    { scenario: "default-days", args: {}, jobs: 2 },
    { scenario: "seven-days", args: { days: 7 }, jobs: 1 },
  ])("$scenario", async ({ scenario, args, jobs }) => {
    seedFleet();
    const recorded = await recordExchange("get_fleet_report", { args });
    expect(payload(recorded).byRepo).toEqual([{
      repo: "acme/widgets", jobs, issues: jobs, completed: 1, failed: jobs - 1,
      merged: 0, avgPasses: null, costUsd: null,
    }]);
    checkExchange("get_fleet_report", scenario, recorded);
  });

  it("invalid-args", async () => {
    const recorded = await recordExchange("get_fleet_report", { args: { days: "7" } });
    expect(recorded.response.body.isError).toBe(true);
    expect(recorded.response.body.content[0].text).toContain("400");
    checkExchange("get_fleet_report", "invalid-args", recorded);
  });
});

for (const [tool, schema] of [
  ["get_tenant_health", GetTenantHealthArgsSchema],
  ["get_fleet_report", GetFleetReportArgsSchema],
] as const) {
  describe(`${tool} args.schema.json`, () => {
    it("matches the handler's zod input", () => {
      const dir = new URL(`../../docs/contracts/${tool}/`, import.meta.url);
      const file = new URL("args.schema.json", dir);
      const text = `${JSON.stringify(z.toJSONSchema(schema), null, 2)}\n`;
      if (process.env.UPDATE_CONTRACT_FIXTURES === "1") {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, text);
        return;
      }
      const hint = "Regenerate with UPDATE_CONTRACT_FIXTURES=1 npx vitest run src/__tests__/monitor-tools-contract.test.ts, and tell the control plane: it copies these files.";
      if (!existsSync(file)) throw new Error(`${tool}/args.schema.json is missing. ${hint}`);
      expect(readFileSync(file, "utf8"), hint).toBe(text);
    });
  });
}
