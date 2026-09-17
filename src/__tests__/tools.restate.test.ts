// Docker-backed round-trip coverage for the orchestratorTools service (src/restate/tools.ts,
// AII-710) — a real Restate server (via testcontainers) journals the ingress body and
// delivers it to our in-process endpoint, proving the role assertion and the discovery
// metadata work through the real wire, not just against the unit-level fakes in
// tools.test.ts. Shape mirrors src/__tests__/restate-harness.restate.test.ts exactly.
//
// Run with `npm run test:restate` (Docker required); excluded from `npm test`.
import * as restate from "@restatedev/restate-sdk";
import { RestateContainer, RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { orchestratorTools, tool, type ToolResponse } from "../restate/tools.js";
import * as dedup from "../dedup.js";
import { initLogTable } from "../log.js";
import { initMappingsTable } from "../config.js";
import { initSettingsTable } from "../runner-mode.js";
import { setKgMemoryProvider } from "../kg-provider.js";

// A second service, built with tool(), whose only handler throws — proves the wrapper's
// try/catch (not just get_tenant_health's own well-behaved body) turns a thrown error into
// an isError result instead of letting Restate retry a hung handler forever.
const alwaysThrows = tool(
  { description: "always throws, for the isError-not-retried regression test", input: z.object({}), role: "user" },
  async (): Promise<ToolResponse> => {
    throw new Error("boom");
  },
);

const failingTools = restate.service({
  name: "failingTools",
  handlers: { always_throws: alwaysThrows },
});

// A third service whose handler awaits ctx.sleep() — a real durable timer that can force
// the current attempt to suspend. Proves the wrapper's try/catch does not intercept
// Restate's own suspension signal (thrown internally while unwinding a suspending await)
// and convert it into a false isError result; the SDK must be left to suspend and resume
// the invocation on its own.
const sleepThenSucceed = tool(
  {
    description: "sleeps via ctx.sleep, then succeeds — regression test for the wrapper not swallowing suspension",
    input: z.object({}),
    role: "user",
  },
  async (ctx): Promise<ToolResponse> => {
    await ctx.sleep(50);
    return { content: [{ type: "text", text: "done" }] };
  },
);

const suspendingTools = restate.service({
  name: "suspendingTools",
  handlers: { sleep_then_succeed: sleepThenSucceed },
});

// Pinned to match the image cached by .github/workflows/unit-tests.yml's restate-tests job.
const RESTATE_IMAGE_VERSION = "1.7.10";

// Same two variants restate-harness.restate.test.ts proves the endpoint boots under.
const VARIANTS = [
  ["alwaysReplay", (container: RestateContainer) => container.alwaysReplay()],
  ["disableRetries", (container: RestateContainer) => container.disableRetries()],
] satisfies Array<[string, (container: RestateContainer) => RestateContainer]>;

interface IngressResult {
  status: number;
  body: { content?: Array<{ type: string; text: string }>; isError?: boolean } | undefined;
}

async function callIngress(
  baseUrl: string,
  handler: string,
  payload: unknown,
  service = "orchestratorTools",
): Promise<IngressResult> {
  const response = await fetch(`${baseUrl}/${service}/${handler}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

const SYSTEM = { kind: "system", email: null, role: "admin" } as const;

describe("orchestratorTools (Restate)", () => {
  const environments = new Map<string, RestateTestEnvironment>();

  beforeAll(async () => {
    // get_tenant_health reads comment_gapfill_queue via dedup.getDb(); DEDUP_DB_PATH is
    // ":memory:" in vitest.restate.config.ts, so this just needs the schema created once.
    dedup.getDb();
    // getInFlightJobs (src/log.ts) reads dispatch_log, which getDb() does not create.
    initLogTable();
    // get_tenant_health also reads `mappings` (getMappings) and `settings` (getRunnerMode).
    initMappingsTable();
    initSettingsTable();
    // One fixture mapping for list_projects, with a non-empty extra_env the handler must drop.
    dedup.getDb().prepare(
      "INSERT INTO mappings (team_key, owner, repo, workflow_file, default_branch, extra_env) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("BDS", "BuildDownAI", "skills", "claude.yml", "testing", JSON.stringify({ SUPER_SECRET: "leak-me" }));
    setKgMemoryProvider(null);

    const started = await Promise.all(
      VARIANTS.map(async ([label, configure]) => {
        const env = await RestateTestEnvironment.start({
          services: [orchestratorTools, failingTools, suspendingTools],
          container: () => configure(new RestateContainer(RESTATE_IMAGE_VERSION)),
        });
        return [label, env] as const;
      }),
    );
    for (const [label, env] of started) {
      environments.set(label, env);
    }
  }, 60_000);

  afterAll(async () => {
    await Promise.all([...environments.values()].map((env) => env.stop()));
  });

  it.each(VARIANTS.map(([label]) => label))(
    "a direct ingress call with an admin caller returns the health payload (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);

      const { status, body } = await callIngress(env.baseUrl(), "get_tenant_health", {
        caller: { kind: "system", email: null, role: "admin" },
        args: {},
      });

      expect(status).toBe(200);
      const text = body?.content?.[0]?.text;
      expect(text).toBeTruthy();
      const health = JSON.parse(text as string) as Record<string, unknown>;
      expect(health).toHaveProperty("runnerMode");
      expect(health).toHaveProperty("inFlightJobCount");
      expect(health).toHaveProperty("pendingGapfillCount");
      expect(health).toHaveProperty("projectCount");
      expect(health).toHaveProperty("kgDegraded");
      expect(health).toHaveProperty("kgRefreshPreflight");
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "the same call with caller.role: null is refused inside the wrapper (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);

      const { status, body } = await callIngress(env.baseUrl(), "get_tenant_health", {
        caller: { kind: "human", email: "user@example.com", role: null },
        args: {},
      });

      expect(status).toBe(200);
      expect(body?.isError).toBe(true);
      expect(body?.content?.[0]?.text).toBe("forbidden: get_tenant_health requires the user role");
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "the admin API lists get_tenant_health with mcp.type: tool and mcp.role: user (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);

      // Deployment metadata only appears after the handler has been invoked at least
      // once against this environment (noted in restate-harness.restate.test.ts too).
      await callIngress(env.baseUrl(), "get_tenant_health", {
        caller: { kind: "system", email: null, role: "admin" },
        args: {},
      });

      const response = await fetch(`${env.adminAPIBaseUrl()}/services/orchestratorTools`);
      expect(response.ok).toBe(true);
      const metadata = (await response.json()) as {
        handlers: Array<{ name: string; metadata?: Record<string, string> }>;
      };
      const handler = metadata.handlers.find((h) => h.name === "get_tenant_health");
      expect(handler?.metadata?.["mcp.type"]).toBe("tool");
      expect(handler?.metadata?.["mcp.role"]).toBe("user");
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "a throwing handler answers 200 with isError: true instead of retrying (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);

      const { status, body } = await callIngress(
        env.baseUrl(),
        "always_throws",
        { caller: { kind: "system", email: null, role: "admin" }, args: {} },
        "failingTools",
      );

      expect(status).toBe(200);
      expect(body?.isError).toBe(true);
      expect(body?.content?.[0]?.text).toBe("always_throws failed: boom");
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "a handler that suspends via ctx.sleep() still completes successfully, not as isError (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);

      const { status, body } = await callIngress(
        env.baseUrl(),
        "sleep_then_succeed",
        { caller: { kind: "system", email: null, role: "admin" }, args: {} },
        "suspendingTools",
      );

      expect(status).toBe(200);
      expect(body?.isError).toBeFalsy();
      expect(body?.content?.[0]?.text).toBe("done");
    },
  );
  // ---- AII-711: the migrated read handlers through the real ingress.
  it.each(VARIANTS.map(([label]) => label))(
    "get_runner_mode returns { mode, source } (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const { status, body } = await callIngress(env.baseUrl(), "get_runner_mode", { caller: SYSTEM, args: {} });
      expect(status).toBe(200);
      expect(body?.isError).toBeUndefined();
      expect(Object.keys(JSON.parse(body?.content?.[0]?.text as string)).sort()).toEqual(["mode", "source"]);
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "list_projects returns the fixture mapping without extraEnv (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const { status, body } = await callIngress(env.baseUrl(), "list_projects", { caller: SYSTEM, args: {} });
      expect(status).toBe(200);
      const text = body?.content?.[0]?.text as string;
      const rows = JSON.parse(text) as Array<{ teamKey: string; repo: string }>;
      expect(rows.map((r) => r.teamKey)).toEqual(["BDS"]);
      expect(rows[0].repo).toBe("BuildDownAI/skills");
      expect(text).not.toContain("extraEnv");
      expect(text).not.toContain("leak-me");
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "get_issue_dispatch_status returns the dispatch shape for a valid identifier and lets zod refuse a non-string one (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const ok = await callIngress(env.baseUrl(), "get_issue_dispatch_status", { caller: SYSTEM, args: { identifier: "AII-1" } });
      expect(ok.status).toBe(200);
      const shape = JSON.parse(ok.body?.content?.[0]?.text as string) as Record<string, unknown>;
      expect(Object.keys(shape).sort()).toEqual(["dedupEntry", "identifier", "inDedupWindow", "inFlight", "mergeVerdict", "recentDispatches"]);
      expect(shape.inFlight).toBe(false);
      // zod rejects a number before the handler body runs: the ingress answers 4xx.
      const bad = await callIngress(env.baseUrl(), "get_issue_dispatch_status", { caller: SYSTEM, args: { identifier: 5 } });
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect(bad.status).toBeLessThan(500);
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "kg_hybrid_search with no provider answers isError with the pre-migration wording (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const { status, body } = await callIngress(env.baseUrl(), "kg_hybrid_search", { caller: SYSTEM, args: { query: "x" } });
      expect(status).toBe(200);
      expect(body?.isError).toBe(true);
      expect(body?.content?.[0]?.text).toBe("no memory provider is configured");
    },
  );

});
