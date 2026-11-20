import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFetch, hangUntilAborted, stubAbortTimeout } from "./helpers/fake-fetch.js";
import { testDb } from "./helpers/test-db.js";

const CONSOLE = "https://console.stardog.run";
const EDGE = "https://edge.stardog.run";
const ENDPOINT = "https://endpoint.stardog.run";
const RUN_ENDPOINT = "https://tenant.stardog.run/kg";
const TOKEN = "SENTINEL-run-api-token-0123456789";
const PASS = "SENTINEL-console-pass-0123456789";
const BEARER = "SENTINEL-edge-bearer-0123456789";

async function fixture() {
  const db = await testDb({ modules: { kg: () => import("../kg-graph-source.js"), client: () => import("../stardog-client.js") } });
  db.modules.kg.setStardogValues({
    db: "builddown-kg",
    runConsole: CONSOLE,
    runEndpoint: RUN_ENDPOINT,
    namespace: "https://kg.example/",
    graphName: "builddown-kg",
    token: TOKEN,
  });
  return db;
}

function routes(overrides: Parameters<typeof fakeFetch>[0] = {}) {
  return fakeFetch({
    [`GET /api/cli/endpoints`]: { json: [{ name: "kg", target: "tenant/kg", address: RUN_ENDPOINT }] },
    [`POST /api/token`]: { json: { pass: PASS, edgeUrl: EDGE } },
    [`POST /edge/token`]: { json: { token: BEARER, endpoint: ENDPOINT } },
    [`POST /builddown-kg/query`]: {
      json: { results: { bindings: [{ count: { type: "literal", value: "1234" } }] } },
    },
    ...overrides,
  });
}

beforeEach(() => vi.stubEnv("RUNNER_TOKEN_SECRET", "stardog-client-test-key"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Stardog client", () => {
  it("signs in through the console and edge and counts triples", async () => {
    const { modules } = await fixture();
    const fake = routes().install();
    const count = await modules.client.createStardogClient().countTriples();
    expect(count).toBe(1234);
    expect(fake.calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual([
      `GET /api/cli/endpoints`, `POST /api/token`, `POST /builddown-kg/query`, `POST /edge/token`,
    ]);
    // The console body names the endpoint target; the edge carries the pass; the query
    // carries the edge bearer, the Accept header and the dataset.
    const byPath = (path: string) => fake.calls.find((c) => c.path === path)!;
    expect(JSON.parse(byPath("/api/token").body)).toEqual({ ns: "tenant", name: "kg" });
    expect(byPath("/api/cli/endpoints").headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(byPath("/api/token").headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(byPath("/edge/token").headers.get("authorization")).toBe(`Bearer ${PASS}`);
    expect(byPath("/builddown-kg/query").headers.get("authorization")).toBe(`Bearer ${BEARER}`);
    expect(byPath("/builddown-kg/query").headers.get("accept")).toBe("application/sparql-results+json");
    const query = new URLSearchParams(byPath("/builddown-kg/query").body);
    expect(query.get("default-graph-uri")).toBe("tag:stardog:kit:alias:builddown_kg");
    expect(query.get("query")).toContain("COUNT(*)");
  });

  it("reads the stored values on every call, so a changed endpoint is used next time", async () => {
    const { modules } = await fixture();
    const fake = routes({ [`POST /api/token`]: [
      { json: { pass: PASS, edgeUrl: EDGE } },
      { json: { pass: PASS, edgeUrl: EDGE } },
      { json: { token: BEARER, endpoint: "https://other.stardog.run" } },
    ], [`POST /edge/token`]: [
      { json: { token: BEARER, endpoint: ENDPOINT } },
      { json: { token: BEARER, endpoint: "https://other.stardog.run" } },
    ], [`POST /other-db/query`]: { json: { results: { bindings: [{ count: { value: "2" } }] } } } }).install();
    await modules.client.createStardogClient().countTriples();
    modules.kg.setStardogValues({ db: "other-db" });
    expect(await modules.client.createStardogClient().countTriples()).toBe(2);
    expect(fake.calls.at(-1)?.path).toBe("/other-db/query");
  });

  it("accepts a direct token reply without an edge exchange", async () => {
    const { modules } = await fixture();
    const fake = fakeFetch({
      [`GET /api/cli/endpoints`]: { json: [{ name: "kg", target: "tenant/kg", address: RUN_ENDPOINT }] },
      [`POST /api/token`]: { json: { token: BEARER, endpoint: ENDPOINT } },
      [`POST /builddown-kg/query`]: { json: { results: { bindings: [{ count: { value: "0" } }] } } },
    }).install();
    expect(await modules.client.createStardogClient().countTriples()).toBe(0);
    expect(fake.calls.map((c) => c.path)).toEqual(["/api/cli/endpoints", "/api/token", "/builddown-kg/query"]);
  });

  it("never logs a token and its errors never hold a credential or a header", async () => {
    const { modules } = await fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fakeFetch({
      [`GET /api/cli/endpoints`]: { json: [{ name: "kg", target: "tenant/kg", address: RUN_ENDPOINT }] },
      [`POST /api/token`]: { status: 401, text: `${TOKEN} ${PASS}` },
    }).install();
    let thrown: unknown;
    try {
      await modules.client.createStardogClient().countTriples();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    for (const secret of [TOKEN, PASS, BEARER, "Bearer", "authorization"]) {
      expect(message).not.toContain(secret);
    }
    const logged = [...log.mock.calls, ...error.mock.calls, ...warn.mock.calls].map((args) => JSON.stringify(args)).join("\n");
    for (const secret of [TOKEN, PASS, BEARER]) expect(logged).not.toContain(secret);
    // Positive control: the sanitized failure still names the step that failed.
    expect(message).toContain("/api/token");
  });

  it("shares one 30 s deadline across all four requests of an attempt", async () => {
    const { modules } = await fixture();
    const deadline = vi.spyOn(AbortSignal, "timeout");
    const fake = routes().install();
    expect(await modules.client.createStardogClient().countTriples()).toBe(1234);
    expect(fake.calls).toHaveLength(4);
    // One deadline for the attempt, at the per-try limit, not a fresh 30 s per request.
    expect(deadline).toHaveBeenCalledOnce();
    expect(deadline).toHaveBeenCalledWith(30_000);
    const signals = new Set(fake.calls.map((c) => c.signal));
    expect(signals.size).toBe(1);
    expect([...signals][0]).toBeDefined();
  });

  it("times out an attempt at the shared deadline with a sanitized error", async () => {
    const { modules } = await fixture();
    // One AbortSignal.timeout for the attempt; a second, or a different duration, fails the test.
    stubAbortTimeout(30_000);
    const fake = routes({
      [`GET /api/cli/endpoints`]: hangUntilAborted,
      [`POST /api/token`]: hangUntilAborted,
      [`POST /edge/token`]: hangUntilAborted,
      [`POST /builddown-kg/query`]: hangUntilAborted,
    }).install();
    await expect(modules.client.createStardogClient().countTriples()).rejects.toThrow(/timed out after 30000 ms/);
    expect(fake.calls).toHaveLength(1);
  });

  it("bounds a stalled response body by the same deadline", async () => {
    const { modules } = await fixture();
    stubAbortTimeout(30_000);
    const stalled = () => new Response(new ReadableStream({ start: () => {} }), { status: 200, headers: { "content-type": "application/json" } });
    fakeFetch({
      [`GET /api/cli/endpoints`]: () => stalled(),
      [`POST /api/token`]: { json: { pass: PASS, edgeUrl: EDGE } },
      [`POST /edge/token`]: { json: { token: BEARER, endpoint: ENDPOINT } },
      [`POST /builddown-kg/query`]: { json: { results: { bindings: [{ count: { value: "1" } }] } } },
    }).install();
    await expect(modules.client.createStardogClient().countTriples()).rejects.toThrow(/\/api\/cli\/endpoints timed out after 30000 ms/);
  });

  it("refuses a non-HTTPS console before any request", async () => {
    const { modules } = await fixture();
    modules.kg.setStardogValues({ runConsole: "http://console.example" });
    const fake = routes().install();
    await expect(modules.client.createStardogClient().countTriples()).rejects.toThrow(/HTTPS/);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses to start without a stored token", async () => {
    const { modules } = await fixture();
    modules.kg.setStardogValues({ token: "" });
    const fake = routes().install();
    await expect(modules.client.createStardogClient().countTriples()).rejects.toThrow(/token is not set/);
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects an invalid count payload", async () => {
    const { modules } = await fixture();
    fakeFetch({
      [`GET /api/cli/endpoints`]: { json: [{ name: "kg", target: "tenant/kg", address: RUN_ENDPOINT }] },
      [`POST /api/token`]: { json: { pass: PASS, edgeUrl: EDGE } },
      [`POST /edge/token`]: { json: { token: BEARER, endpoint: ENDPOINT } },
      [`POST /builddown-kg/query`]: { json: { results: { bindings: [] } } },
    }).install();
    await expect(modules.client.createStardogClient().countTriples()).rejects.toThrow(/invalid count/);
  });
});
