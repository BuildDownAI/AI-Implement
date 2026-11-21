// Restate scenarios for registration helpers in src/restate/endpoint.ts against a real
// 1.7.10 admin API. The first block covers the AII-721 drain check:
// `queryNonCompletedInvocations()` — the exact route (`POST /query`), the header that
// selects JSON over Arrow IPC, and whether persistent Virtual Object state leaks into the
// count were all unknowns the unit tier (src/__tests__/restate-endpoint.test.ts) can only
// fake; the META0004/zero/nonzero/unknown decision tree in register() itself stays a unit
// test. The last block covers AII-2046's runner deployment registration and removal:
// one-attempt success, META0003 unreachable, forced idempotent deletion, and other
// refusals including non-JSON bodies.
//
// Run with `npm run test:restate` (binary runtime, no Docker); excluded from `npm test`.
import { randomUUID } from "node:crypto";
import * as http2 from "node:http2";
import * as net from "node:net";
import * as restate from "@restatedev/restate-sdk";
import { createEndpointHandler } from "@restatedev/restate-sdk/node";
import type { RestateEnvironment } from "./harness.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryNonCompletedInvocations, registerRunnerDeployment, removeDeployment } from "../../restate/endpoint.js";
import { operatorObject } from "../../restate/operator-object.js";
import { fakeFetch } from "../helpers/fake-fetch.js";
import { startBinaryEnvironment } from "./binary-environment.js";
import { VARIANTS, callObject, eventually, queryInvocations, startVariants, stopAll } from "./harness.js";

// An exclusive handler held on an awakeable leaves a second handler on the same key
// queued before dispatch. In a direct pinned Restate 1.7.10 probe, the first had
// last_attempt_deployment_id while the second had neither deployment ID yet; the
// runtime variants below assert the safety outcome rather than that incidental shape.
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
  statuses: readonly ("running" | "suspended" | "pending")[],
): Promise<InvocationRow> {
  const where = `target_service_name = 'DrainProbeTest' AND target_service_key = '${key}' AND target_handler_name = '${handler}'`;
  const rows = await eventually(
    async () => (await queryInvocations(adminBaseUrl, where)) as unknown as InvocationRow[],
    (found) => found.some((candidate) => statuses.includes(candidate.status as "running" | "suspended" | "pending")),
    { label: `DrainProbeTest/${key}/${handler} to reach ${statuses.join(" or ")}` },
  );
  return rows.find((candidate) => statuses.includes(candidate.status as "running" | "suspended" | "pending"))!;
}

interface DeploymentsResponse {
  deployments: Array<{ id: string; uri?: string }>;
}

/**
 * `register()` (src/restate/endpoint.ts) already knows its own endpoint's URI — it built
 * the deployment. A test has no equivalent: `startVariants()` registers the
 * endpoint at an address it picks itself (`serviceEndpointAccess`), so the
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

describe("queryNonCompletedInvocations against a real 1.7.10 admin API (AII-721)", () => {
  let environments: Map<string, RestateEnvironment>;

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
      // sleep, then check the count while the engine still holds the invocation. An
      // invocation blocked on an awakeable can already have moved from "running" to
      // "suspended" by the time this first observes it — both are active, non-completed
      // states that must block drain, so either is an acceptable stopping point here.
      void callObject(env.baseUrl(), "DrainProbeTest", key, "block", {}).catch(() => {});
      await waitForInvocation(env.adminAPIBaseUrl(), key, "block", ["running", "suspended"]);
      expect(await queryNonCompletedInvocations(fetch, env.adminAPIBaseUrl(), uri)).toBe(1);

      void callObject(env.baseUrl(), "DrainProbeTest", key, "follow", {}).catch(() => {});
      await waitForInvocation(env.adminAPIBaseUrl(), key, "follow", ["pending"]);
      expect(await queryNonCompletedInvocations(fetch, env.adminAPIBaseUrl(), uri)).toBe(2);
      expect(await queryNonCompletedInvocations(fetch, env.adminAPIBaseUrl(), "http://127.0.0.1:1")).toBe(0);
    },
  );
});

// A delayed one-way send has not started: status `scheduled`, no journal, no pinned
// deployment. It must not hold a deploy (a delayed send can wait for hours). Own
// environment: the describe above leaves a suspended invocation behind on purpose.
describe("queryNonCompletedInvocations ignores a scheduled call that has not started", () => {
  let environments: Map<string, RestateEnvironment>;

  beforeAll(async () => {
    environments = await startVariants([drainProbe]);
  }, 60_000);

  afterAll(async () => {
    await stopAll(environments);
  });

  async function sendDelayed(baseUrl: string, adminBaseUrl: string, key: string): Promise<void> {
    const response = await fetch(`${baseUrl}/DrainProbeTest/${key}/follow/send?delay=10m`, { // restate-test-allow: ingress delayed one-way send
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error(`delayed send failed: HTTP ${response.status}`);
    const rows = await eventually(
      () => queryInvocations(adminBaseUrl, `target_service_name = 'DrainProbeTest' AND target_service_key = '${key}'`),
      (found) => found.length > 0,
      { label: "the delayed send row in sys_invocation" },
    );
    expect(rows[0].status).toBe("scheduled");
  }

  it.each(VARIANTS.map(([label]) => label))("a lone scheduled call counts 0 (%s)", async (label) => {
    const env = environments.get(label);
    if (!env) throw new Error(`environment "${label}" did not start`);
    const uri = await registeredDeploymentUri(env.adminAPIBaseUrl());
    await sendDelayed(env.baseUrl(), env.adminAPIBaseUrl(), randomUUID());

    expect(await queryNonCompletedInvocations(fetch, env.adminAPIBaseUrl(), uri)).toBe(0);
  });

  it.each(VARIANTS.map(([label]) => label))(
    "a scheduled call beside a suspended invocation counts only the suspended one (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const uri = await registeredDeploymentUri(env.adminAPIBaseUrl());
      await sendDelayed(env.baseUrl(), env.adminAPIBaseUrl(), randomUUID());
      const key = randomUUID();
      void callObject(env.baseUrl(), "DrainProbeTest", key, "block", {}).catch(() => {});
      await waitForInvocation(env.adminAPIBaseUrl(), key, "block", ["running", "suspended"]);

      expect(await queryNonCompletedInvocations(fetch, env.adminAPIBaseUrl(), uri)).toBe(1);
    },
  );
});

// A runner endpoint on its own port, outside the shared harness: `registerRunnerDeployment()`
// and `removeDeployment()` register and remove a deployment the caller built, not the harness's
// own endpoint. Restate holds HTTP/2 sessions open, so the test mirrors binary-environment.ts's
// session cleanup rather than leaving teardown waiting on one.
const runnerDeploymentProbe = restate.service({
  name: "RunnerDeploymentProbe",
  handlers: { ping: async (_ctx: restate.Context) => "pong" },
});

interface AdminDeployment {
  id: string;
  uri?: string;
  services: Array<{ name: string }>;
}

async function adminDeployments(adminBaseUrl: string): Promise<AdminDeployment[]> {
  const response = await fetch(`${adminBaseUrl}/deployments`);
  if (!response.ok) throw new Error(`GET /deployments failed: HTTP ${response.status}`);
  return ((await response.json()) as { deployments: AdminDeployment[] }).deployments;
}

async function unusedLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

describe("runner deployment registration and removal against a real 1.7.10 admin API", () => {
  let env: RestateEnvironment;
  let runnerEndpoint: http2.Http2Server;
  let runnerEndpointSessions: Set<http2.ServerHttp2Session>;
  let runnerEndpointPort: number;
  let deploymentId: string;

  beforeAll(async () => {
    env = await startBinaryEnvironment({ services: [drainProbe] });
    runnerEndpoint = http2.createServer(createEndpointHandler({ services: [runnerDeploymentProbe] }));
    runnerEndpointSessions = new Set();
    runnerEndpoint.on("session", (session) => {
      runnerEndpointSessions.add(session);
      session.once("close", () => runnerEndpointSessions.delete(session));
    });
    await new Promise<void>((resolve, reject) => {
      runnerEndpoint.once("error", reject);
      runnerEndpoint.listen(0, "127.0.0.1", resolve);
    });
    runnerEndpointPort = (runnerEndpoint.address() as net.AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    if (runnerEndpoint) {
      await new Promise<void>((resolve) => {
        runnerEndpoint.close(() => resolve());
        for (const session of runnerEndpointSessions) session.destroy();
      });
    }
    await env?.stop();
  });

  it("registers a listening runner endpoint in one attempt and exposes its service", async () => {
    let posts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST" && new URL(request.url).pathname === "/deployments") posts++;
      return fetch(input, init);
    };
    const uri = `http://127.0.0.1:${runnerEndpointPort}`;

    const result = await registerRunnerDeployment(uri, { adminBaseUrl: env.adminAPIBaseUrl(), fetchImpl });

    expect(result).toEqual({ ok: true, deploymentId: expect.stringMatching(/^dp_/) });
    if (!result.ok) throw new Error("registration unexpectedly failed");
    deploymentId = result.deploymentId;
    expect(posts).toBe(1);

    const deployment = (await adminDeployments(env.adminAPIBaseUrl())).find((entry) => entry.id === deploymentId);
    expect(deployment?.uri?.replace(/\/+$/, "")).toBe(uri);
    expect(deployment?.services.map((service) => service.name)).toContain(runnerDeploymentProbe.name);

    const response = await fetch(`${env.adminAPIBaseUrl()}/services/${runnerDeploymentProbe.name}`);
    expect(response.ok).toBe(true);
    expect((await response.json()) as { deployment_id: string }).toMatchObject({ deployment_id: deploymentId });
  });

  it("classifies a port with no listener as unreachable after one attempt and registers nothing", async () => {
    const before = (await adminDeployments(env.adminAPIBaseUrl())).map((entry) => entry.id).sort();
    const port = await unusedLoopbackPort();
    let posts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST" && new URL(request.url).pathname === "/deployments") posts++;
      return fetch(input, init);
    };

    const result = await registerRunnerDeployment(`http://127.0.0.1:${port}`, {
      adminBaseUrl: env.adminAPIBaseUrl(),
      fetchImpl,
    });

    expect(result).toEqual({ ok: false, reason: "unreachable" });
    expect(posts).toBe(1);
    expect((await adminDeployments(env.adminAPIBaseUrl())).map((entry) => entry.id).sort()).toEqual(before);
  });

  it("forces removal and treats a second removal's 404 as success", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      calls.push({ method: request.method, url: request.url });
      return fetch(input, init);
    };

    await removeDeployment(deploymentId, { adminBaseUrl: env.adminAPIBaseUrl(), fetchImpl });
    expect(calls[0]).toEqual({
      method: "DELETE",
      url: `${env.adminAPIBaseUrl()}/deployments/${deploymentId}?force=true`,
    });
    expect((await adminDeployments(env.adminAPIBaseUrl())).some((entry) => entry.id === deploymentId)).toBe(false);

    await expect(
      removeDeployment(deploymentId, { adminBaseUrl: env.adminAPIBaseUrl(), fetchImpl }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1].url).searchParams.get("force")).toBe("true");
  });

  it("rejects other refusals with their status, including a non-JSON response", async () => {
    const fake = fakeFetch({
      "POST /deployments": [
        { status: 500, json: { message: "internal error" } },
        { status: 403, text: "denied" },
      ],
      "DELETE /deployments/dp_other": { status: 501, text: "not implemented" },
    });
    const deps = { adminBaseUrl: "http://admin.test", fetchImpl: fake.fetch };

    await expect(registerRunnerDeployment("http://127.0.0.1:1", deps)).resolves.toEqual({
      ok: false,
      reason: "rejected",
      status: 500,
    });
    await expect(registerRunnerDeployment("http://127.0.0.1:2", deps)).resolves.toEqual({
      ok: false,
      reason: "rejected",
      status: 403,
    });
    await expect(removeDeployment("dp_other", deps)).rejects.toThrow("HTTP 501");
  });
});
