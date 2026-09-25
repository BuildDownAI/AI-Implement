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
import { VARIANTS, callObject, callService, startVariants, stopAll } from "./harness.js";

// A durable, never-resolved awakeable: the invocation that calls this suspends and stays
// pending for the life of the test, giving the drain check a real non-completed invocation
// to find. Mirrors harness.restate.test.ts's own never-resolved-promise probe, but with no
// `.orTimeout` — this one is meant to stay suspended, not time out.
const hangingTool = restate.service({
  name: "hangingTool",
  handlers: {
    hang: async (ctx: restate.Context): Promise<void> => {
      await ctx.awakeable<never>().promise;
    },
  },
});

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
    environments = await startVariants([operatorObject, hangingTool]);
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
    "a suspended invocation pinned to the deployment counts as non-completed (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const uri = await registeredDeploymentUri(env.adminAPIBaseUrl());

      // Fire-and-forget: the ingress call blocks on the handler's response, and the
      // handler never returns one (its awakeable never resolves), so this promise is left
      // dangling on purpose. The invocation itself is admitted, journaled, and suspended
      // well before the container is torn down in afterAll.
      void callService(env.baseUrl(), "hangingTool", "hang", {}).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      const count = await queryNonCompletedInvocations(fetch, env.adminAPIBaseUrl(), uri);

      expect(count).toBeGreaterThan(0);
    },
  );
});
