import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { withRequestErrorBoundary } from "../http-server.js";
import type { RestateStatus } from "../restate/status.js";
import { buildHealthBody, ORCHESTRATOR_INSTANCE_ID, readOrchestratorHealth, type HealthBodyReaders } from "../health-body.js";
import { fakeFetch, hangUntilAborted, stubAbortTimeout } from "./helpers/fake-fetch.js";

const SETUP_CHECKS = { checkedAt: 321, failingCore: 2, failingOnAdminPath: ["admin.path"] };
const RESTATE = { sidecar: { state: "ready" }, registration: { state: "registered" } };

function readers(): HealthBodyReaders {
  return {
    sourceCommit: () => "abc123",
    pollStats: () => ({ pollCount: 42, lastPollStartedAt: new Date(1000), lastPollFinishedAt: new Date(2000) }),
    kgDegraded: () => true,
    sidecarHealthFields: () => ({ kgUnavailable: true, sidecar: { reachable: false, toolsListed: false, lastError: "probe failed", checkedAt: 123 } }),
    restateStatus: () => ({ sidecar: { state: "exited", code: 1, signal: null }, registration: { state: "unreachable" } }),
    deployHealth: () => ({ held: true, startedAt: 456 }),
    setupChecks: async () => SETUP_CHECKS,
  };
}

describe("public health body", () => {
  const states: [RestateStatus["sidecar"], RestateStatus["registration"]["state"], string][] = [
    [{ state: "ready" }, "registered", "ok"],
    [{ state: "starting" }, "not-attempted", "unavailable"],
    [{ state: "timeout" }, "not-attempted", "unavailable"],
    [{ state: "ready" }, "not-attempted", "unavailable"],
    [{ state: "ready" }, "declined-conflict", "unavailable"],
    [{ state: "ready" }, "unreachable", "unavailable"],
    ...(["registered", "not-attempted", "declined-conflict", "unreachable"] as const).map(
      (registration): [RestateStatus["sidecar"], RestateStatus["registration"]["state"], string] =>
        [{ state: "exited", code: 1, signal: null }, registration, "unavailable"],
    ),
    [{ state: "missing-binary" }, "not-attempted", "unavailable"],
  ];

  it.each(states)("reports %j / %s as %s from one snapshot", async (sidecar, registration, status) => {
    const read = readers();
    const snapshot: RestateStatus = { sidecar, registration: { state: registration } };
    read.restateStatus = vi.fn(() => snapshot);
    const body = await buildHealthBody(read);
    expect(body.status).toBe(status);
    expect(body.restate).toBe(snapshot);
    expect(read.restateStatus).toHaveBeenCalledOnce();
  });

  it("lets the request boundary finish a failed health build without sending 200", async () => {
    const read = readers();
    read.setupChecks = () => { throw new Error("setup checks unavailable"); };
    const res = {
      headersSent: false, writeHead: vi.fn(), end: vi.fn(), destroy: vi.fn(),
    } as unknown as http.ServerResponse;
    const log = vi.fn();
    const listener = withRequestErrorBoundary((_req, response) => {
      return buildHealthBody(read).then((body) => {
        const json = JSON.stringify(body);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(json);
      });
    }, log);

    listener({} as http.IncomingMessage, res);
    expect(res.writeHead).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(res.end).toHaveBeenCalledOnce());
    expect(res.writeHead).toHaveBeenCalledExactlyOnceWith(500, { "Content-Type": "application/json" });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: "Internal server error" }));
    expect(res.destroy).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
  });

  it("preserves every legacy field and adds the setup checks' field and this process's identifier", async () => {
    expect(await buildHealthBody(readers())).toEqual({
      status: "unavailable", sourceCommit: "abc123", instanceId: ORCHESTRATOR_INSTANCE_ID, polls: 42, kgDegraded: true,
      kgUnavailable: true, sidecar: { reachable: false, toolsListed: false, lastError: "probe failed", checkedAt: 123 },
      restate: { sidecar: { state: "exited", code: 1, signal: null }, registration: { state: "unreachable" } },
      deploy: { held: true, startedAt: 456 }, lastPollStartedAt: new Date(1000).toISOString(), lastPollFinishedAt: new Date(2000).toISOString(),
      setupChecks: SETUP_CHECKS,
    });
    const read = readers();
    read.sourceCommit = () => null;
    read.pollStats = () => ({ pollCount: 0, lastPollStartedAt: null, lastPollFinishedAt: null });
    read.sidecarHealthFields = () => ({});
    expect(await buildHealthBody(read)).toMatchObject({ sourceCommit: null, polls: 0, lastPollStartedAt: null, lastPollFinishedAt: null });
    expect(await buildHealthBody(read)).not.toHaveProperty("sidecar");
  });
});

describe("ORCHESTRATOR_INSTANCE_ID", () => {
  it("is a new random identifier each time the module loads, as in each orchestrator process", async () => {
    const first = (await import("../health-body.js")).ORCHESTRATOR_INSTANCE_ID;
    vi.resetModules();
    const second = (await import("../health-body.js")).ORCHESTRATOR_INSTANCE_ID;

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).toMatch(/^[0-9a-f]{8}-/);
    expect(second).not.toBe(first);
  });
});

describe("readOrchestratorHealth", () => {
  it.each([
    ["https://o.example.com", "https://o.example.com/"],
    ["https://o.example.com/", "https://o.example.com/"],
    ["https://o.example.com/orchestrator", "https://o.example.com/orchestrator/"],
  ])("asks GET / under the base URL %s, as a run joins its callback paths", async (baseUrl, asked) => {
    const fake = fakeFetch({ "GET /": { json: { restate: RESTATE } }, "GET /orchestrator/": { json: { restate: RESTATE } } });

    await readOrchestratorHealth(baseUrl, fake.fetch);

    expect(fake.calls.map((c) => `${c.method} ${c.url.href}`)).toEqual([`GET ${asked}`]);
  });

  it.each([200, 503])("reads a body carrying restate as the health body with its instance identifier, whatever its status (%i)", async (status) => {
    const fake = fakeFetch({ "GET /": { status, json: { status: status === 200 ? "ok" : "unavailable", instanceId: "an-instance", restate: RESTATE } } });

    expect(await readOrchestratorHealth("https://o.example.com", fake.fetch)).toEqual({ outcome: "health-body", status, restate: RESTATE, instanceId: "an-instance" });
  });

  it.each([
    ["the orchestrator's answer to a path it does not serve", { status: 404, json: { error: "Not found" } }, 404],
    ["a proxy's error page", { status: 502, text: "<html>Bad Gateway</html>" }, 502],
    ["a body whose restate is null", { json: { restate: null } }, 200],
  ])("reads %s as another response", async (_case, reply, status) => {
    const fake = fakeFetch({ "GET /": reply });

    expect(await readOrchestratorHealth("https://o.example.com", fake.fetch)).toEqual({ outcome: "other-response", status });
  });

  it("names a failed request's cause, which fetch keeps behind its bare message", async () => {
    const fake = fakeFetch({
      "GET /": () => {
        throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND typo.example.invalid") });
      },
    });

    expect(await readOrchestratorHealth("https://o.example.com", fake.fetch)).toEqual({
      outcome: "no-response",
      timedOut: false,
      error: "fetch failed: getaddrinfo ENOTFOUND typo.example.invalid",
    });
  });

  it("names a failure with no cause by its own message", async () => {
    const fake = fakeFetch({
      "GET /": () => {
        throw new TypeError("Failed to parse URL from not a url");
      },
    });

    expect(await readOrchestratorHealth("https://o.example.com", fake.fetch)).toMatchObject({ outcome: "no-response", timedOut: false, error: "Failed to parse URL from not a url" });
  });

  it("gives up after five seconds when nothing answers, and says it timed out", async () => {
    stubAbortTimeout(5_000);
    const fake = fakeFetch({ "GET /": hangUntilAborted });

    expect(await readOrchestratorHealth("https://o.example.com", fake.fetch)).toMatchObject({ outcome: "no-response", timedOut: true });
  });
});
