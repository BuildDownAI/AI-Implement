// Real-endpoint, real-registration coverage for src/restate/endpoint.ts (AII-727). Every
// other Restate-tier test in this repo boots its server through startVariants()
// (src/__tests__/restate/harness.ts), which auto-registers its OWN internal endpoint —
// proving the harness, not this file's own startRestateEndpoint()/register(). This file
// starts a `restate-server` binary whose only registered service is a probe, then calls
// those two functions itself against the server's admin API (AII-1195: the block formerly
// ran in a container behind a tunnelling fetch).
//
// The server and this process's SDK endpoint are both on the host, so the production
// loopback bind (127.0.0.1, restateBindAddress() unmodified — ADR 023) is also the address
// the server dials, and register() needs no fetch rewriting.
//
// Run with `npm run test:restate`; excluded from `npm test`.
import * as http2 from "node:http2";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import * as restate from "@restatedev/restate-sdk";
import { createEndpointHandler } from "@restatedev/restate-sdk/node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RESTATE_SERVICES, queryNonCompletedInvocations, register, restateBindAddress, startRestateEndpoint } from "../../restate/endpoint.js";
import { orchestratorTools } from "../../restate/tools.js";
import * as dedup from "../../dedup.js";
import { initSettingsTable } from "../../runner-mode.js";
import { startBinaryEnvironment, type BinaryEnvironment } from "./binary-environment.js";
import { callObject, callService, eventually } from "./harness.js";

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const probe = restate.service({
  name: "registrationProbe",
  handlers: { ping: async (_ctx: restate.Context) => "pong" },
});

describe("startRestateEndpoint() / register() against a real server 1.7.10 (AII-727)", () => {
  let server: http2.Http2Server;
  let port: number;
  let bindHost: string;
  let env: BinaryEnvironment;
  let adminBaseUrl: string;
  let ingressBaseUrl: string;
  let changedServer: http2.Http2Server;
  let changedPort: number;
  let changedHandler = createEndpointHandler({ services: RESTATE_SERVICES });

  beforeAll(async () => {
    dedup.getDb();
    initSettingsTable();

    // Port 0: the OS assigns a free one, read back below — this suite's own endpoint must
    // not collide with another test file's, since each runs in its own worker but could
    // still share a host port range.
    vi.stubEnv("RESTATE_ENDPOINT_PORT", "0");
    server = await startRestateEndpoint(RESTATE_SERVICES);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected the endpoint to bind a TCP port");
    }
    port = address.port;
    // restateBindAddress() is re-read inside register() itself to build the registered
    // `uri` — the initial "0" stub (needed only so the OS would assign a free port above)
    // would otherwise still be in effect there and register() would advertise port 0.
    vi.stubEnv("RESTATE_ENDPOINT_PORT", String(port));
    bindHost = restateBindAddress().host;

    // A second endpoint has a swappable handler on one live HTTP/2 server.
    changedServer = http2.createServer((request, response) => changedHandler(request, response));
    await new Promise<void>((resolve) => changedServer.listen(0, bindHost, resolve));
    const changedAddress = changedServer.address();
    if (changedAddress === null || typeof changedAddress === "string") throw new Error("expected second TCP port");
    changedPort = changedAddress.port;

    env = await startBinaryEnvironment({ services: [probe] });
    adminBaseUrl = env.adminAPIBaseUrl();
    ingressBaseUrl = env.baseUrl();
  }, 120_000);

  afterAll(async () => {
    await env?.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => changedServer.close(() => resolve()));
    vi.unstubAllEnvs();
  });

  it(
    "registers the real endpoint, safely re-discovers the same URI, and both bound services answer through the ingress",
    async () => {
      const first = await register({ adminBaseUrl });
      expect(first).toEqual({ outcome: "registered-no-force" });

      // The pinned server answers 200 for the existing URI without re-discovery;
      // register() checks zero active invocations before forcing discovery.
      const again = await register({ adminBaseUrl });
      expect(again).toEqual({ outcome: "registered-drained-force" });

      // Operator (the Virtual Object) answers through the real ingress.
      const key = randomUUID();
      const hash = sha256(randomUUID());
      await callObject(ingressBaseUrl, "Operator", key, "issue", {
        email: "ada@eudoxus.ai",
        sub: "google|1",
        provider: "google",
        hash,
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      });
      const refreshed = await callObject<{ status: string }>(ingressBaseUrl, "Operator", key, "refresh", {
        presentedHash: hash,
      });
      expect(refreshed.status).toBe("ok");

      // orchestratorTools (the service) answers through the same real ingress. If a future
      // edit drops either service from RESTATE_SERVICES, this call — or the Operator calls
      // above — fails, since the dropped service is simply absent from the server.
      const runnerMode = await callService<{ content?: Array<{ text: string }>; isError?: boolean }>(
        ingressBaseUrl,
        "orchestratorTools",
        "get_runner_mode",
        { caller: { kind: "system", email: null, role: "admin" }, args: {} },
      );
      expect(runnerMode.isError).toBeFalsy();
      expect(JSON.parse(runnerMode.content?.[0]?.text ?? "{}")).toHaveProperty("mode");
    },
    60_000,
  );

  it(
    "a changed service set at the same URI is declined while a non-completed invocation is pinned to the old deployment, then force-registers once it drains",
    async () => {
      // Register the swappable endpoint on its own URI. This leaves the first
      // test's production endpoint intact while making the second endpoint the
      // current deployment for both services.
      vi.stubEnv("RESTATE_ENDPOINT_PORT", String(changedPort));
      expect(await register({ adminBaseUrl })).toEqual({ outcome: "registered-no-force" });

      // A genuinely in-flight, non-completed invocation against that deployment — held open
      // by the refresh test seam (AII-727, src/restate/operator-object.ts's sleepMs), not a
      // fake — so queryNonCompletedInvocations() has something real to count.
      const key = randomUUID();
      const hash = sha256(randomUUID());
      await callObject(ingressBaseUrl, "Operator", key, "issue", {
        email: "ada@eudoxus.ai",
        sub: "google|2",
        provider: "google",
        hash,
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      });
      const sleepMs = 8_000;
      const inFlight = callObject(ingressBaseUrl, "Operator", key, "refresh", { presentedHash: hash, sleepMs });
      // Attach this immediately so an assertion failure during registration cannot
      // turn the still-pending request into an unhandled rejection during cleanup.
      void inFlight.catch(() => undefined);
      // Observe the actual non-completed invocation before swapping endpoints;
      // a fixed sleep can race Restate's admission on a busy CI host.
      const oldUri = `http://${bindHost}:${changedPort}`;
      await eventually(
        () => queryNonCompletedInvocations(fetch, adminBaseUrl, oldUri),
        (count) => count !== null && count > 0,
        { label: `a non-completed invocation at ${oldUri}` },
      );
      expect(await queryNonCompletedInvocations(fetch, adminBaseUrl, oldUri)).toBeGreaterThan(0);

      // Change the live endpoint's discovery manifest at the same URI. Restate's
      // duplicate-URI 200 does not rediscover it; register() must check drain
      // and force after the active Operator invocation finishes.
      changedHandler = createEndpointHandler({ services: [orchestratorTools] });

      const declined = await register({ adminBaseUrl });
      expect(declined.outcome).toBe("declined-conflict");

      // Let the in-flight invocation complete — the old deployment now has zero
      // non-completed invocations pinned to it.
      await inFlight;

      const forced = await register({ adminBaseUrl });
      expect(forced).toEqual({ outcome: "registered-drained-force" });
      const deployments = await (await fetch(`${adminBaseUrl}/deployments`)).json() as {
        deployments: Array<{ uri: string; services: Array<{ name: string }> }>;
      };
      const current = deployments.deployments.find((deployment) => deployment.uri === `${oldUri}/`);
      expect(current?.services.map((service) => service.name)).toEqual(["orchestratorTools"]);
    },
    45_000,
  );
});

// Request identity (AII-976): spawns a real server given the private key, with the endpoint
// given the public one.
describe("request identity (AII-976)", () => {
  const echo = restate.service({
    name: "identityEcho",
    handlers: { ping: async (_ctx: restate.Context, input: { value: string }) => ({ echoed: input.value }) },
  });
  let env: BinaryEnvironment;
  beforeAll(async () => {
    env = await startBinaryEnvironment({ services: [echo], requestIdentity: true });
  }, 60_000);
  afterAll(async () => {
    if (env) await env.stop();
  });

  it("rejects an unsigned direct request to the endpoint, while an ingress call succeeds", async () => {
    expect(env.identityKey()).toMatch(/^publickeyv1_/);
    const client = http2.connect(`http://127.0.0.1:${env.endpointPort()}`);
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = client.request({ ":method": "GET", ":path": "/discover", accept: "application/vnd.restate.endpointmanifest.v3+json" });
        req.on("response", (headers) => resolve(Number(headers[":status"])));
        req.on("error", reject);
        req.resume();
        req.end();
      });
      expect(status).toBe(401);
    } finally {
      client.close();
    }
    // The server signs its own calls: an ingress call reaches a handler through the endpoint.
    expect(await callService(env.baseUrl(), "identityEcho", "ping", { value: "x" })).toEqual({ echoed: "x" });
  });
});
