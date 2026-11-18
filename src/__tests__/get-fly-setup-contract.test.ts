import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { GetFlySetupArgsSchema } from "../restate/tools.js";
import { testDb } from "./helpers/test-db.js";
import { recordExchange, checkExchange } from "./contract-recorder.js";
const dir = new URL("../../docs/contracts/get_fly_setup/", import.meta.url);
beforeEach(async () => { await testDb(); vi.stubEnv("FLY_SESSIONS_TOKEN", "test-token"); });
afterEach(() => vi.unstubAllEnvs());
it.each(["reachable", "not-configured", "fly-refused", "read-scope-refused"])("records %s", async (scenario) => {
  const settings = await import("../orchestrator-settings.js");
  await settings.refreshRunnerBackendCache({ readFlyMachines: async () => ({ app: "sessions", region: null }) });
  if (scenario === "not-configured") vi.stubEnv("FLY_SESSIONS_TOKEN", "");
  const recorded = await recordExchange("get_fly_setup", { args: {} }, {
    scope: scenario === "read-scope-refused" ? "orchestrator:read" : "orchestrator:secrets",
    routes: { "GET /v1/apps/sessions/secrets": scenario === "fly-refused" ? { status: 401 } : { json: { secrets: [{ name: "GLOBAL_TOKEN", created_at: "2026-11-16T00:00:00Z", digest: "omitted" }] } } },
  });
  expect(recorded.response.body.isError ?? false).toBe(scenario === "read-scope-refused");
  checkExchange("get_fly_setup", scenario, recorded);
});
it("records the argument schema", () => {
  const text = `${JSON.stringify(z.toJSONSchema(GetFlySetupArgsSchema), null, 2)}\n`;
  if (process.env.UPDATE_CONTRACT_FIXTURES === "1") { mkdirSync(dir, { recursive: true }); writeFileSync(new URL("args.schema.json", dir), text); }
  expect(readFileSync(new URL("args.schema.json", dir), "utf8")).toBe(text);
});
