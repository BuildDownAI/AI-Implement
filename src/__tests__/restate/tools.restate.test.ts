// Docker-backed round-trip coverage for the orchestratorTools service (src/restate/tools.ts,
// AII-710) — a real Restate server (via testcontainers) journals the ingress body and
// delivers it to our in-process endpoint, proving the role assertion and the discovery
// metadata work through the real wire, not just against the unit-level fakes in
// tools.test.ts. Shape mirrors src/__tests__/restate/harness.restate.test.ts exactly.
//
// Run with `npm run test:restate` (Docker required); excluded from `npm test`.
import * as restate from "@restatedev/restate-sdk";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { orchestratorTools, tool, type ToolResponse } from "../../restate/tools.js";
import * as dedup from "../../dedup.js";
import { initLogTable } from "../../log.js";
import { initMappingsTable, getMappings } from "../../config.js";
import { initSettingsTable } from "../../runner-mode.js";
import { setKgMemoryProvider } from "../../kg-provider.js";
import { VARIANTS, callService, startVariants, stopAll } from "./harness.js";

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

// A fourth service, deliberately built WITHOUT tool() — tool() converts every handler throw
// into a completed isError result specifically so a /mcp call is never held open by Restate's
// own retry loop (its own doc comment), which means none of the six real write tools ever let
// Restate retry an invocation. Demonstrating the retry+idempotency-key primitive those writes
// now carry a key for (AII-713) needs a raw handler that lets a throw reach the SDK instead.
let idempotentAttempts = 0;
const idempotentTools = restate.service({
  name: "idempotentTools",
  handlers: {
    throws_once_then_succeeds: async (): Promise<{ attempt: number }> => {
      idempotentAttempts += 1;
      if (idempotentAttempts === 1) {
        throw new Error("transient failure on the first attempt");
      }
      return { attempt: idempotentAttempts };
    },
  },
});

// A fifth service, built WITH tool() (unlike idempotentTools above), whose handler increments
// one module counter inside ctx.run and a second outside it. This is the observable proof
// behind AII-717's rule (docs/restate.md § "Every side effect in a handler goes inside
// ctx.run..."): under the alwaysReplay container variant the server forces a replay at the
// handler's one durable step, so code before that step (outsideCounter) runs again on the
// replay while the step itself (insideCounter, journaled by ctx.run) is recovered from the
// journal and not re-executed. Only run against the "alwaysReplay" environment — disableRetries
// gives no replay to observe.
let replayInsideCounter = 0;
let replayOutsideCounter = 0;
const replayCounterTool = tool(
  {
    description: "increments a counter inside ctx.run and one outside, for the alwaysReplay regression test",
    input: z.object({}),
    role: "user",
  },
  async (ctx): Promise<ToolResponse> => {
    replayOutsideCounter += 1;
    await ctx.run("increment-inside", () => {
      replayInsideCounter += 1;
      return replayInsideCounter;
    });
    return { content: [{ type: "text", text: "done" }] };
  },
);

const replayCounterTools = restate.service({
  name: "replayCounterTools",
  handlers: { increment: replayCounterTool },
});

interface ToolCallResult {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}

const SYSTEM = { kind: "system", email: null, role: "admin" } as const;

describe("orchestratorTools (Restate)", () => {
  let environments: Map<string, RestateTestEnvironment>;

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

    environments = await startVariants([orchestratorTools, failingTools, suspendingTools, idempotentTools, replayCounterTools]);
  }, 60_000);

  afterAll(async () => {
    await stopAll(environments);
  });

  it.each(VARIANTS.map(([label]) => label))(
    "a direct ingress call with an admin caller returns the health payload (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);

      const body = await callService<ToolCallResult>(env.baseUrl(), "orchestratorTools", "get_tenant_health", {
        caller: { kind: "system", email: null, role: "admin" },
        args: {},
      });

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

      const body = await callService<ToolCallResult>(env.baseUrl(), "orchestratorTools", "get_tenant_health", {
        caller: { kind: "human", email: "user@example.com", role: null },
        args: {},
      });

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
      // once against this environment (noted in harness.restate.test.ts too).
      await callService(env.baseUrl(), "orchestratorTools", "get_tenant_health", {
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

      const body = await callService<ToolCallResult>(env.baseUrl(), "failingTools", "always_throws", {
        caller: { kind: "system", email: null, role: "admin" },
        args: {},
      });

      expect(body?.isError).toBe(true);
      expect(body?.content?.[0]?.text).toBe("always_throws failed: boom");
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "a handler that suspends via ctx.sleep() still completes successfully, not as isError (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);

      const body = await callService<ToolCallResult>(env.baseUrl(), "suspendingTools", "sleep_then_succeed", {
        caller: { kind: "system", email: null, role: "admin" },
        args: {},
      });

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
      const body = await callService<ToolCallResult>(env.baseUrl(), "orchestratorTools", "get_runner_mode", {
        caller: SYSTEM,
        args: {},
      });
      expect(body?.isError).toBeUndefined();
      expect(Object.keys(JSON.parse(body?.content?.[0]?.text as string)).sort()).toEqual(["mode", "source"]);
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "list_projects returns the fixture mapping without extraEnv (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const body = await callService<ToolCallResult>(env.baseUrl(), "orchestratorTools", "list_projects", {
        caller: SYSTEM,
        args: {},
      });
      const text = body?.content?.[0]?.text as string;
      const rows = JSON.parse(text) as Array<{ teamKey: string; repo: string }>;
      expect(rows.map((r) => r.teamKey)).toEqual(["BDS"]);
      expect(rows[0].repo).toBe("BuildDownAI/skills");
      expect(text).not.toContain("extraEnv");
      expect(text).not.toContain("leak-me");
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "get_project_binding resolves the fixture mapping by repo with the live pickup label, and omits extraEnv (AII-715) (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      dedup.getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('linear_pickup_label', ?)").run("AI-Implement-Restate");

      const body = await callService<ToolCallResult>(env.baseUrl(), "orchestratorTools", "get_project_binding", {
        caller: SYSTEM,
        args: { repo: "BuildDownAI/skills" },
      });

      const text = body?.content?.[0]?.text as string;
      const binding = JSON.parse(text) as Record<string, unknown>;
      expect(binding.team).toBe("BDS");
      expect(binding.repo).toBe("BuildDownAI/skills");
      expect(binding.pickupLabel).toBe("AI-Implement-Restate");
      expect(text).not.toContain("extraEnv");
      expect(text).not.toContain("leak-me");
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "get_issue_dispatch_status returns the dispatch shape for a valid identifier and lets zod refuse a non-string one (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const ok = await callService<ToolCallResult>(env.baseUrl(), "orchestratorTools", "get_issue_dispatch_status", {
        caller: SYSTEM,
        args: { identifier: "AII-1" },
      });
      const shape = JSON.parse(ok?.content?.[0]?.text as string) as Record<string, unknown>;
      expect(Object.keys(shape).sort()).toEqual([
        "dedupEntry",
        "identifier",
        "inDedupWindow",
        "inFlight",
        "mergeVerdict",
        "recentDispatches",
      ]);
      expect(shape.inFlight).toBe(false);

      // zod rejects a number before the handler body runs: the ingress answers 4xx, which
      // callService surfaces as a thrown error carrying the status.
      await expect(
        callService(env.baseUrl(), "orchestratorTools", "get_issue_dispatch_status", {
          caller: SYSTEM,
          args: { identifier: 5 },
        }),
      ).rejects.toThrow(/orchestratorTools\/get_issue_dispatch_status failed: 4\d\d/);
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "kg_hybrid_search with no provider answers isError with the pre-migration wording (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const body = await callService<ToolCallResult>(env.baseUrl(), "orchestratorTools", "kg_hybrid_search", {
        caller: SYSTEM,
        args: { query: "x" },
      });
      expect(body?.isError).toBe(true);
      expect(body?.content?.[0]?.text).toBe("no memory provider is configured");
    },
  );

  // ---- AII-713: the six writes, migrated off WRITE_TOOLS in src/mcp.ts onto this same
  // service. Business-logic parity (each action's own status codes and validation) is unit
  // tested in tools.test.ts against a mocked src/admin.ts; what's real-ingress-only here is
  // discovery metadata, the forbidden path over the wire, and Restate's own idempotency-key
  // and retry mechanics.
  it.each(VARIANTS.map(([label]) => label))(
    "the admin API lists pause_project with mcp.type: tool and mcp.role: admin (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      await callService(env.baseUrl(), "orchestratorTools", "pause_project", {
        caller: SYSTEM,
        args: { teamKey: "no-such-team", paused: true },
      });
      const response = await fetch(`${env.adminAPIBaseUrl()}/services/orchestratorTools`);
      expect(response.ok).toBe(true);
      const metadata = (await response.json()) as {
        handlers: Array<{ name: string; metadata?: Record<string, string> }>;
      };
      const handler = metadata.handlers.find((h) => h.name === "pause_project");
      expect(handler?.metadata?.["mcp.type"]).toBe("tool");
      expect(handler?.metadata?.["mcp.role"]).toBe("admin");
    },
  );

  // AII-717: the retry policy that keeps a dead attempt from ever being re-delivered
  // (tool()'s ToolOptions.retryPolicy, threaded to restate.handlers.handler) has to actually
  // reach the deployed handler's config, not just exist in our source. The per-handler admin
  // route (`GET /services/{service}/handlers/{handler}`, restate-server 1.7.10) is the
  // deployment record for one handler; its handler list uses snake_case keys for every
  // multi-word field observed elsewhere in this suite (`input_json_schema`,
  // `output_json_schema` above), so `retry_policy`/`max_attempts`/`on_max_attempts` is the
  // pinned path here, consistent with that convention. restate-server 1.7.10 reports
  // on_max_attempts as "Kill" (capitalised enum), so the comparison below is case-insensitive.
  it.each(VARIANTS.map(([label]) => label))(
    "the admin API's per-handler record for pause_project carries retryPolicy: { maxAttempts: 1, onMaxAttempts: \"kill\" } (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      // Deployment metadata only appears once the handler has been invoked at least once
      // against this environment (same precondition as the mcp.type/mcp.role check above).
      await callService(env.baseUrl(), "orchestratorTools", "pause_project", {
        caller: SYSTEM,
        args: { teamKey: "no-such-team", paused: true },
      });
      const response = await fetch(`${env.adminAPIBaseUrl()}/services/orchestratorTools/handlers/pause_project`);
      expect(response.ok).toBe(true);
      const handler = (await response.json()) as Record<string, unknown>;
      const retryPolicy = (handler.retry_policy ?? handler.retryPolicy) as Record<string, unknown> | undefined;
      expect(retryPolicy, `no retry_policy/retryPolicy field on the handler record: ${JSON.stringify(handler)}`).toBeDefined();
      expect(retryPolicy?.max_attempts ?? retryPolicy?.maxAttempts).toBe(1);
      expect(String(retryPolicy?.on_max_attempts ?? retryPolicy?.onMaxAttempts).toLowerCase()).toBe("kill");
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "trigger_kg_refresh's discovered schema declares dryRun/acceptNewBaseline booleans, and add_project's reviewers array matches the pre-migration shape (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      // Deployment metadata only appears once each handler has been invoked at least once.
      await callService(env.baseUrl(), "orchestratorTools", "trigger_kg_refresh", { caller: SYSTEM, args: {} });
      await callService(env.baseUrl(), "orchestratorTools", "add_project", { caller: SYSTEM, args: {} });

      const response = await fetch(`${env.adminAPIBaseUrl()}/services/orchestratorTools`);
      const metadata = (await response.json()) as {
        handlers: Array<{ name: string; input_json_schema?: { properties?: { args?: { properties?: Record<string, unknown> } } } }>;
      };

      const kgRefreshArgs = metadata.handlers.find((h) => h.name === "trigger_kg_refresh")?.input_json_schema?.properties?.args
        ?.properties as Record<string, { type?: string }> | undefined;
      expect(kgRefreshArgs?.dryRun?.type).toBe("boolean");
      expect(kgRefreshArgs?.acceptNewBaseline?.type).toBe("boolean");

      const addProjectArgs = metadata.handlers.find((h) => h.name === "add_project")?.input_json_schema?.properties?.args?.properties;
      // AII-720: reviewers is now `.nullable()`, so zod's JSON schema wraps the array
      // variant in `anyOf` alongside `{ type: "null" }` instead of exposing `items` directly.
      const reviewers = addProjectArgs?.reviewers as
        | { anyOf?: Array<{ type?: string; items?: { required?: string[]; properties?: Record<string, unknown> } }> }
        | undefined;
      expect(reviewers?.anyOf).toContainEqual(expect.objectContaining({ type: "null" }));
      const reviewersArrayVariant = reviewers?.anyOf?.find((v) => v.items !== undefined);
      expect(reviewersArrayVariant?.items?.required).toEqual(["id", "gates"]);
      expect(reviewersArrayVariant?.items?.properties?.maxTurns).toMatchObject({ type: "integer", minimum: 1, maximum: 200 });
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "add_project with reviewers: null and maxTurns: null reaches upsertMappingAction instead of the ingress's 4xx (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);

      const body = await callService<ToolCallResult>(env.baseUrl(), "orchestratorTools", "add_project", {
        caller: SYSTEM,
        args: {
          teamKey: `NULLTEST-${label}`,
          owner: "BuildDownAI",
          repo: "null-reset-fixture",
          defaultBranch: "main",
          reviewers: null,
          maxTurns: null,
        },
      });

      const result = JSON.parse(body?.content?.[0]?.text as string) as { status: number; body: Record<string, unknown> };
      expect(result.status).toBe(202);
      expect(result.body.reviewers).toBeNull();
      expect(result.body.maxTurns).toBeNull();
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "a user caller is refused a write tool over the real ingress and never runs the action (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const body = await callService<ToolCallResult>(env.baseUrl(), "orchestratorTools", "clear_dispatch_dedup", {
        caller: { kind: "human", email: "user@example.com", role: "user" },
        args: { issueId: "some-issue" },
      });
      expect(body?.isError).toBe(true);
      expect(body?.content?.[0]?.text).toBe("forbidden: clear_dispatch_dedup requires the admin role");
    },
  );

  it("alwaysReplay: ctx.run runs its closure once while the code outside it re-executes on replay (AII-717)", async () => {
    const env = environments.get("alwaysReplay");
    if (!env) throw new Error('environment "alwaysReplay" did not start');
    replayInsideCounter = 0;
    replayOutsideCounter = 0;

    await callService(env.baseUrl(), "replayCounterTools", "increment", { caller: SYSTEM, args: {} });

    // insideCounter is journaled by ctx.run: recovered from the journal on every replay after
    // the first, never re-run. outsideCounter runs again on each replay the alwaysReplay
    // container forces at the handler's one durable step — this is the same mechanism that
    // would double-run a bare admin action call outside ctx.run after a real crash (AII-717's
    // concrete failure: a replayed clear_dispatch_dedup deleting a dedup row the first poll
    // had just written).
    expect(replayInsideCounter).toBe(1);
    expect(replayOutsideCounter).toBeGreaterThan(1);
  });

  it("pause_project: a second ingress call with the same idempotency key attaches to the first result instead of running pauseProjectAction again", async () => {
    const env = environments.get("alwaysReplay");
    if (!env) throw new Error('environment "alwaysReplay" did not start');
    const key = "pause-project-dedup-test";

    const first = await callService<ToolCallResult>(
      env.baseUrl(),
      "orchestratorTools",
      "pause_project",
      { caller: SYSTEM, args: { teamKey: "BDS", paused: true } },
      { "idempotency-key": key },
    );
    expect(JSON.parse(first.content?.[0]?.text as string)).toEqual({ status: 200, body: { updated: true, paused: true } });

    // Same key, opposite `paused` value — if this ran pauseProjectAction again the mapping
    // would flip back to false; instead Restate returns the first call's cached result and
    // the second `args` are never seen by the handler.
    const second = await callService<ToolCallResult>(
      env.baseUrl(),
      "orchestratorTools",
      "pause_project",
      { caller: SYSTEM, args: { teamKey: "BDS", paused: false } },
      { "idempotency-key": key },
    );
    expect(JSON.parse(second.content?.[0]?.text as string)).toEqual({ status: 200, body: { updated: true, paused: true } });

    expect(getMappings().BDS?.paused).toBe(true);
  });

  // Runs only against alwaysReplay: the disableRetries variant is built to fail a throwing
  // handler immediately (its own docstring above), so it cannot demonstrate a retry
  // succeeding — see idempotentTools' comment for why this bypasses tool() to prove it.
  it(
    "throws_once_then_succeeds: Restate retries the raw handler until it succeeds, then a second call with the same idempotency key doesn't run it a third time",
    async () => {
      const env = environments.get("alwaysReplay");
      if (!env) throw new Error('environment "alwaysReplay" did not start');
      const key = "throws-once-dedup-test";

      const first = await callService<{ attempt: number }>(
        env.baseUrl(),
        "idempotentTools",
        "throws_once_then_succeeds",
        {},
        { "idempotency-key": key },
      );
      expect(first).toEqual({ attempt: 2 });
      expect(idempotentAttempts).toBe(2);

      const second = await callService<{ attempt: number }>(
        env.baseUrl(),
        "idempotentTools",
        "throws_once_then_succeeds",
        {},
        { "idempotency-key": key },
      );
      expect(second).toEqual({ attempt: 2 });
      expect(idempotentAttempts).toBe(2);
    },
    30_000,
  );
});
