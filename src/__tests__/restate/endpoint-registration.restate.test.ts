// Restate scenario for the AII-721 drain check: `queryNonCompletedInvocations()`
// (src/restate/endpoint.ts) against a real pinned 1.7.10 admin API. Nothing under
// src/restate/ or docs/restate-*.md queried invocations by deployment before this issue —
// the exact route (`POST /query`), the header that selects JSON over Arrow IPC, and
// whether persistent Virtual Object state leaks into the count were all unknowns the unit
// tier (src/__tests__/restate-endpoint.test.ts) can only fake. This file is where those
// unknowns get proven against the real server; the META0004/zero/nonzero/unknown decision
// tree in register() itself stays a unit test.
//
// Run with `npm run test:restate` (Docker required); excluded from `npm test`.
import { randomUUID } from "node:crypto";
import * as restate from "@restatedev/restate-sdk";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryNonCompletedInvocations } from "../../restate/endpoint.js";
import { operatorObject } from "../../restate/operator-object.js";
import { VARIANTS, callObject, startVariants, stopAll } from "./harness.js";

// An exclusive handler held on an awakeable leaves a second handler on the same key
// queued before dispatch. In pinned Restate 1.7.10 the first has only
// last_attempt_deployment_id; the second has neither deployment ID yet.
const drainProbe = restate.object({
  name: "DrainProbeTest",
  handlers: {
    block: async (ctx: restate.ObjectContext): Promise<void> => {
      await ctx.awakeable<never>().promise;
    },
    follow: async (_ctx: restate.ObjectContext): Promise<string> => "followed",
  },
});

interface InvocationRow {
  status: string;
  pinned_deployment_id?: string;
  last_attempt_deployment_id?: string;
}

async function waitForInvocation(
  adminBaseUrl: string,
  key: string,
  handler: "block" | "follow",
  status: "running" | "pending",
): Promise<InvocationRow> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${adminBaseUrl}/query`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        query: `SELECT status, pinned_deployment_id, last_attempt_deployment_id FROM sys_invocation WHERE target_service_name = 'DrainProbeTest' AND target_service_key = '${key}' AND target_handler_name = '${handler}'`,
      }),
    });
    if (!response.ok) throw new Error(`POST /query failed: HTTP ${response.status}`);
    const body = (await response.json()) as { rows: InvocationRow[] };
    const row = body.rows.find((candidate) =>
      candidate.status === status && (handler === "follow" || !!candidate.last_attempt_deployment_id));
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`DrainProbeTest/${key}/${handler} did not reach ${status}`);
}

interface DeploymentsResponse {
  deployments: Array<{ id: string; uri?: string }>;
}

/**
 * `register()` (src/restate/endpoint.ts) already knows its own endpoint's URI — it built
 * the deployment. A test has no equivalent: `RestateTestEnvironment.start()` registers the
 * endpoint at a container-network address it picks itself (`serviceEndpointAccess`), so the
 * only way to learn the exact string `sys_deployment.endpoint` holds is to ask the admin API
 * that registered it, the same way an operator inspecting a live server would.
 */
async function registeredDeploymentUri(adminBaseUrl: string): Promise<string> {
  const response = await fetch(`${adminBaseUrl}/deployments`);
  if (!response.ok) throw new Error(`GET /deployments failed: HTTP ${response.status}`);
  const body = (await response.json()) as DeploymentsResponse;
  const uri = body.deployments[0]?.uri;
  if (!uri) throw new Error(`no HTTP deployment registered: ${JSON.stringify(body)}`);
  return uri;
}

describe("queryNonCompletedInvocations against a real pinned 1.7.10 admin API (AII-721)", () => {
  let environments: Map<string, RestateTestEnvironment>;

  beforeAll(async () => {
    environments = await startVariants([operatorObject, drainProbe]);
  }, 60_000);

  afterAll(async () => {
    await stopAll(environments);
  });

  // Runs first, deliberately: it is the only scenario in this file that asserts zero
  // invocations before anything else in the shared environment has run.
  it.each(VARIANTS.map(([label]) => label))(
    "resolves 0 when nothing has ever been invoked on the deployment (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const uri = await registeredDeploymentUri(env.adminAPIBaseUrl());

      const count = await queryNonCompletedInvocations(fetch, env.adminAPIBaseUrl(), uri);

      expect(count).toBe(0);
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "persistent Virtual Object state alone is not a non-completed invocation (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const uri = await registeredDeploymentUri(env.adminAPIBaseUrl());

      // issue() runs to completion and returns — durable state (email/sub/provider/family)
      // is left behind in the object, but no invocation stays running against it.
      await callObject(env.baseUrl(), "Operator", randomUUID(), "issue", {
        email: "ada@eudoxus.ai",
        sub: "google|1",
        provider: "google",
        hash: randomUUID(),
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      });

      const count = await queryNonCompletedInvocations(fetch, env.adminAPIBaseUrl(), uri);

      expect(count).toBe(0);
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "a suspended running invocation and a queued exclusive invocation both block drain (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const uri = await registeredDeploymentUri(env.adminAPIBaseUrl());
      const key = randomUUID();

      // The first call never settles; wait for a real engine status instead of a fixed
      // sleep, then assert the observed deployment identity before checking the count.
      void callObject(env.baseUrl(), "DrainProbeTest", key, "block", {}).catch(() => {});
      const running = await waitForInvocation(env.adminAPIBaseUrl(), key, "block", "running");
      expect(running.pinned_deployment_id).toBeUndefined();
      expect(running.last_attempt_deployment_id).toBeTruthy();
      expect(await queryNonCompletedInvocations(fetch, env.adminAPIBaseUrl(), uri)).toBe(1);

      void callObject(env.baseUrl(), "DrainProbeTest", key, "follow", {}).catch(() => {});
      const queued = await waitForInvocation(env.adminAPIBaseUrl(), key, "follow", "pending");
      expect(queued.pinned_deployment_id).toBeUndefined();
      expect(queued.last_attempt_deployment_id).toBeUndefined();
      expect(await queryNonCompletedInvocations(fetch, env.adminAPIBaseUrl(), uri)).toBe(2);
      expect(await queryNonCompletedInvocations(fetch, env.adminAPIBaseUrl(), "http://127.0.0.1:1")).toBe(0);
    },
  );
});
