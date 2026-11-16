// CON-137 consumes these exchanges. Regenerate with UPDATE_CONTRACT_FIXTURES=1.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { SetProjectAgentModeArgsSchema } from "../restate/tools.js";
import { testDb } from "./helpers/test-db.js";
import { makeStageAgentDefaults, makeStageAgentProfile } from "./helpers/builders.js";
import { checkExchange, recordExchange } from "./contract-recorder.js";

let store: typeof import("../agent-config-store.js");
beforeEach(async () => {
  const loaded = await testDb({ modules: {
    store: () => import("../agent-config-store.js"),
    dedup: () => import("../dedup.js"),
  } });
  store = loaded.modules.store;
  loaded.modules.dedup.getDb().prepare(
    "INSERT INTO mappings (team_key, owner, repo, workflow_file, default_branch, extra_env) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("BDS", "owner", "repo", "implement.yml", "main", "{}");
});
afterEach(() => vi.unstubAllEnvs());

it("records the strict argument schema", () => {
  const dir = new URL("../../docs/contracts/set_project_agent_mode/", import.meta.url);
  const file = new URL("args.schema.json", dir);
  const text = `${JSON.stringify(z.toJSONSchema(SetProjectAgentModeArgsSchema), null, 2)}\n`;
  if (process.env.UPDATE_CONTRACT_FIXTURES === "1") {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text);
  }
  expect(readFileSync(file, "utf8")).toBe(text);
});

it.each(["set-configured", "resolution-failed", "read-scope-refused"])("records %s through the real route", async (scenario) => {
  store.setProjectConfigured("BDS", false);
  store.setOrchestratorDefaults({ version: 1, mode: "legacy" });
  if (scenario === "set-configured") {
    store.saveAccountProfileRevision(makeStageAgentProfile());
    store.setOrchestratorDefaults(makeStageAgentDefaults());
  }
  const recorded = await recordExchange("set_project_agent_mode", {
    args: { teamKey: "BDS", mode: "configured" },
  }, { scope: scenario === "read-scope-refused" ? "orchestrator:read" : "orchestrator:projects" });
  expect(recorded.response.status).toBe(200);
  if (scenario === "set-configured") {
    expect(recorded.response.body.isError).toBeFalsy();
    expect(JSON.parse(recorded.response.body.content[0].text)).toEqual({ teamKey: "BDS", agentMode: "configured" });
  } else {
    expect(recorded.response.body.isError).toBe(true);
    expect(recorded.response.body.content[0].text).toBe(scenario === "resolution-failed"
      ? "resolution-failed" : "forbidden: set_project_agent_mode requires the admin role");
  }
  checkExchange("set_project_agent_mode", scenario, recorded);
});
