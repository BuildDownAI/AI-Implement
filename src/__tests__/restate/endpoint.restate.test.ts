// Real-endpoint, real-registration coverage for src/restate/endpoint.ts (AII-727). Every
// other Restate-tier test in this repo boots its container through
// RestateTestEnvironment.start() (src/__tests__/restate/harness.ts), which auto-registers
// its OWN internal endpoint — proving the harness, not this file's own
// startRestateEndpoint()/register(). This file manages a RestateContainer directly so it
// can call those two functions itself, against a real server 1.7.10 admin API.
//
// Container-to-host reachability (the acceptance bar asks this be documented, since the
// planning notes flagged it as unverified by reading the SDK alone): this process's own SDK
// endpoint stays bound to the production default, 127.0.0.1 (restateBindAddress(),
// unmodified — ADR 023's loopback-only rule is never relaxed for this test). The container
// reaches it via TestContainers.exposeHostPorts(), the same "testcontainers"
// service-endpoint-access mode RestateTestEnvironment.start() itself offers
// (@restatedev/restate-sdk-testcontainers's restate_test_environment.ts, DEFAULT_START_OPTIONS
// aside — that default is "docker-host", but the "testcontainers" branch is the same library
// code, just the other of the two options it ships): it starts a small proxy container and
// tunnels host.testcontainers.internal:<port>, as seen from any container in this test run,
// back to 127.0.0.1:<port> on the host — so the loopback bind itself never has to change.
//
// One wrinkle is specific to calling register() directly rather than going through the
// harness: restateBindAddress() supplies both this process's bind address and, inside
// register(), the registered `uri` — one value serving two different purposes here (the
// interface this process listens on, and the address the container must be told to dial).
// tunnelingFetch below rewrites that one substring in the outgoing request body, from the
// real bind address to the tunnel address — the `fetchImpl` seam register() already exposes
// for testing. It changes no code in src/restate/endpoint.ts.
//
// Run with `npm run test:restate` (Docker required); excluded from `npm test`.
import * as http2 from "node:http2";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { createEndpointHandler } from "@restatedev/restate-sdk/node";
import { RestateContainer } from "@restatedev/restate-sdk-testcontainers";
import { TestContainers } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RESTATE_SERVICES, register, restateBindAddress, startRestateEndpoint } from "../../restate/endpoint.js";
import { operatorObject } from "../../restate/operator-object.js";
import * as dedup from "../../dedup.js";
import { initSettingsTable } from "../../runner-mode.js";
import { RESTATE_IMAGE_VERSION, callObject, callService } from "./harness.js";

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Mirrors @restatedev/restate-sdk-testcontainers's own PartitionsReadyWaitStrategy, without
 * pulling in its apache-arrow dependency: a non-2xx response or a connection error just
 * means "not ready yet," not a fatal error. RestateContainer's default wait strategy
 * (Wait.forListeningPorts()) only proves the TCP ports are open, not that the admin API's
 * partitions are queryable yet — register() needs the latter.
 */
async function waitForPartitionsReady(adminBaseUrl: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${adminBaseUrl}/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "SELECT count(1) FROM sys_invocation" }),
      });
      if (response.ok) return;
    } catch {
      // Admin API not accepting connections yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Restate admin API partitions not ready after ${timeoutMs}ms`);
}

/**
 * Rewrites the one literal `realHostPort` substring in an outgoing request body to
 * `tunnelHostPort` — see the file header for why register()'s own `uri` and this process's
 * bind address can't independently vary through env vars alone. Applies to every call
 * register() makes (the /deployments POST and, on a conflict, the internal /query POST for
 * queryNonCompletedInvocations), since both embed the same literal host:port text.
 */
function tunnelingFetch(realHostPort: string, tunnelHostPort: string): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init && typeof init.body === "string" && init.body.includes(realHostPort)) {
      init = { ...init, body: init.body.split(realHostPort).join(tunnelHostPort) };
    }
    return fetch(input, init);
  }) as typeof fetch;
}

describe("startRestateEndpoint() / register() against a real server 1.7.10 (AII-727)", () => {
  let server: http2.Http2Server;
  let port: number;
  let bindHost: string;
  let started: Awaited<ReturnType<RestateContainer["start"]>>;
  let adminBaseUrl: string;
  let ingressBaseUrl: string;
  let registerFetch: typeof fetch;

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

    await TestContainers.exposeHostPorts(port);
    registerFetch = tunnelingFetch(`${bindHost}:${port}`, `host.testcontainers.internal:${port}`);

    const container = new RestateContainer(RESTATE_IMAGE_VERSION).withExposedPorts(8080, 9070);
    started = await container.start();
    adminBaseUrl = `http://${started.getHost()}:${started.getMappedPort(9070)}`;
    ingressBaseUrl = `http://${started.getHost()}:${started.getMappedPort(8080)}`;
    await waitForPartitionsReady(adminBaseUrl);
  }, 120_000);

  afterAll(async () => {
    await started?.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
  });

  it(
    "registers the real endpoint (no-force), stays success on an unchanged re-registration, and both bound services answer through the container ingress",
    async () => {
      const first = await register({ adminBaseUrl, fetchImpl: registerFetch });
      expect(first).toEqual({ outcome: "registered-no-force" });

      // An unchanged re-registration at the same URI is still success — no second call needed
      // to prove it, the real admin API just answers 200 again.
      const again = await register({ adminBaseUrl, fetchImpl: registerFetch });
      expect(again).toEqual({ outcome: "registered-no-force" });

      // Operator (the Virtual Object) answers through the container's real ingress.
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
      // above — fails, since the dropped service is simply absent from the container.
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
      // Establish (or re-confirm) the full-service-set deployment as current, independent of
      // whatever the previous test left behind.
      await register({ adminBaseUrl, fetchImpl: registerFetch });

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
      // Give the exclusive invocation a moment to be admitted and start sleeping before the
      // swap below, so it is genuinely non-completed by the time register() queries for it.
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      // Swap this process's own SDK endpoint for a changed service set at the same URI —
      // mirrors harness.ts's replaceEndpoint(), inlined here since there is no
      // RestateTestEnvironment to attach it to in this file.
      server.close();
      server = http2.createServer(createEndpointHandler({ services: [operatorObject] }));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, bindHost, resolve);
      });

      const declined = await register({ adminBaseUrl, fetchImpl: registerFetch });
      expect(declined.outcome).toBe("declined-conflict");

      // Let the in-flight invocation complete — the old deployment now has zero
      // non-completed invocations pinned to it.
      await inFlight;

      const forced = await register({ adminBaseUrl, fetchImpl: registerFetch });
      expect(forced).toEqual({ outcome: "registered-drained-force" });
    },
    45_000,
  );
});
