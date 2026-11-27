import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testDir } from "./helpers/test-dir.js";
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

  it("keeps an explicit package target while settings and credentials rotate", async () => {
    const { modules } = await fixture();
    const target = { db: "builddown-kg", graphName: "original-graph" };
    const dir = testDir("stardog-target");
    writeFileSync(join(dir, "kit.yaml"), "data: []");
    const fake = routes({ "POST /voicebox/kits/import": { json: { kit_id: "kit-1", publish_id: "pub-1" } } });
    const client = modules.client.createStardogClient({ fetchImpl: fake.fetch });
    modules.kg.setStardogValues({ db: "other-db", graphName: "other-graph", token: "rotated-token" });
    const handle = await client.startImport(dir, ["kit.yaml"], target);
    expect(handle).toEqual({ kitId: "kit-1", publishId: "pub-1" });
    expect(fake.calls.at(-1)!.url.searchParams.get("database")).toBe(target.db);
    expect(fake.calls.at(-1)!.headers.get("x-voicebox-auth")).toBe("Bearer rotated-token");
    modules.kg.setStardogValues({ db: "third-db", graphName: "third-graph", token: "next-token" });
    expect(await client.countTriples(target)).toBe(1234);
    const query = fake.calls.at(-1)!;
    expect(query.path).toBe("/builddown-kg/query");
    expect(new URLSearchParams(query.body).get("default-graph-uri")).toBe("tag:stardog:kit:alias:original_graph");
    expect(fake.calls.filter(c => c.path === "/api/token").at(-1)!.headers.get("authorization")).toBe("Bearer next-token");
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


describe("Stardog import client", () => {
  it("sends only listed files with folder-prefixed multipart names to the stored platform", async () => {
    const { modules } = await fixture();
    modules.kg.setStardogValues({ runPlatform: "https://import.stardog.run" });
    const dir = join(testDir("stardog"), "dispatch-123");
    mkdirSync(join(dir, "data"), { recursive: true });
    for (const file of ["kit.yaml", "package.json", "data/issues.nt", "data/old.nt"]) writeFileSync(join(dir, file), file);
    const fake = routes({ "POST /voicebox/kits/import": { json: { kit_id: "kit-1", publish_id: "pub-1", database: "builddown-kg" } } });
    expect(await modules.client.createStardogClient({ fetchImpl: fake.fetch }).startImport(dir, ["kit.yaml", "data/issues.nt"], { db: "builddown-kg", graphName: "builddown-kg" }))
      .toEqual({ kitId: "kit-1", publishId: "pub-1" });
    const call = fake.calls.at(-1)!;
    expect(call.url.origin).toBe("https://import.stardog.run");
    expect(Object.fromEntries(call.url.searchParams)).toEqual({ replace: "true", endpoint: ENDPOINT, database: "builddown-kg" });
    expect(call.headers.get("authorization")).toBe(`Bearer ${BEARER}`);
    expect(call.headers.get("x-voicebox-auth")).toBe(`Bearer ${TOKEN}`);
    expect(call.body).toContain('name="files"; filename="dispatch-123/kit.yaml"');
    expect(call.body).toContain('filename="dispatch-123/data/issues.nt"');
    expect(call.body).not.toContain("package.json");
    expect(call.body).not.toContain("old.nt");
  });

  it("accepts Stardog identifiers and percent-encodes each events path segment", async () => {
    const { modules } = await fixture();
    const dir = testDir("stardog-identifiers");
    writeFileSync(join(dir, "kit.yaml"), "data: []");
    const path = "/voicebox/kits/builddown-kg%3A0.2.0/publish/a1b2%2Fc3.d4%40x%2By/events";
    const fake = routes({
      "POST /voicebox/kits/import": { json: { kit_id: "builddown-kg:0.2.0", publish_id: "a1b2/c3.d4@x+y" } },
      [`GET ${path}`]: { text: 'data: {"type":"done"}\n\n' },
    });
    const client = modules.client.createStardogClient({ fetchImpl: fake.fetch });
    const handle = await client.startImport(dir, ["kit.yaml"], { db: "builddown-kg", graphName: "builddown-kg" });
    expect(handle).toEqual({ kitId: "builddown-kg:0.2.0", publishId: "a1b2/c3.d4@x+y" });
    expect(await client.readEvents(handle.kitId, handle.publishId, { maxMs: 1000 })).toBe("done");
    expect(fake.calls.at(-1)!.path).toBe(path);
  });

  it("accepts identifiers at the 256-character limit", async () => {
    const { modules } = await fixture();
    const dir = testDir("stardog-identifiers");
    writeFileSync(join(dir, "kit.yaml"), "data: []");
    const id = "a".repeat(256);
    const fake = routes({ "POST /voicebox/kits/import": { json: { kit_id: id, publish_id: id } } });
    expect(await modules.client.createStardogClient({ fetchImpl: fake.fetch }).startImport(dir, ["kit.yaml"], { db: "builddown-kg", graphName: "builddown-kg" }))
      .toEqual({ kitId: id, publishId: id });
  });

  describe.each(["kit_id", "publish_id"] as const)("unsafe %s", field => {
    it.each([
      ["newline", "bad\nid", "control or whitespace character"],
      ["space", "bad id", "control or whitespace character"],
      ["tab", "bad\tid", "control or whitespace character"],
      ["NUL", "bad\u0000id", "control or whitespace character"],
      ["DEL", "bad\u007fid", "control or whitespace character"],
      ["C1 control", "bad\u0085id", "control or whitespace character"],
      ["Unicode whitespace", "bad\u2003id", "control or whitespace character"],
      ["too long", "a".repeat(257), "too long"],
      ["API token", `prefix-${TOKEN}-suffix`, "contains a credential"],
      ["bearer", `prefix-${BEARER}-suffix`, "contains a credential"],
    ])("rejects %s without exposing the value", async (_label, value, reason) => {
      const { modules } = await fixture();
      const dir = testDir("stardog-identifiers");
      writeFileSync(join(dir, "kit.yaml"), "data: []");
      const fake = routes({ "POST /voicebox/kits/import": { json: { kit_id: "kit-1", publish_id: "pub-1", [field]: value } } });
      const result = modules.client.createStardogClient({ fetchImpl: fake.fetch }).startImport(dir, ["kit.yaml"], { db: "builddown-kg", graphName: "builddown-kg" });
      await expect(result).rejects.toThrow(`Stardog Run import returned an invalid ${field}: ${reason}`);
      const error = await result.catch((err: Error) => err);
      expect(error).toBeInstanceOf(Error);
      for (const secret of [value, TOKEN, BEARER]) expect((error as Error).message).not.toContain(secret);
    });

    it.each(["", null, 123])("rejects a missing or non-string identifier (%s)", async value => {
      const { modules } = await fixture();
      const dir = testDir("stardog-identifiers");
      writeFileSync(join(dir, "kit.yaml"), "data: []");
      const fake = routes({ "POST /voicebox/kits/import": { json: { kit_id: "kit-1", publish_id: "pub-1", [field]: value } } });
      await expect(modules.client.createStardogClient({ fetchImpl: fake.fetch }).startImport(dir, ["kit.yaml"], { db: "builddown-kg", graphName: "builddown-kg" }))
        .rejects.toThrow(field);
    });
  });

  it.each(["done", "failed"])("parses chunked replayed SSE ending in %s and redacts failures", async type => {
    const { modules } = await fixture();
    const payload = `data: {"type":"progress"}\r\n\r\ndata: ${JSON.stringify({ type, error: `bad ${TOKEN} ${BEARER} Authorization: Bearer secret` })}\r\n\r\n`;
    const fake = routes({ "GET /voicebox/kits/kit-1/publish/pub-1/events": () => new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < payload.length; i += 7) controller.enqueue(new TextEncoder().encode(payload.slice(i, i + 7)));
      controller.close();
    } })) });
    const log = vi.spyOn(console, "log");
    const client = modules.client.createStardogClient({ fetchImpl: fake.fetch });
    const result = await client.readEvents("kit-1", "pub-1", { maxMs: 1000 });
    expect(result).toEqual(type === "done" ? "done" : { failed: "bad [redacted] [redacted] [redacted]" });
    for (const secret of [TOKEN, BEARER, "Authorization", "Bearer secret"]) {
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    }
  });

  it("returns null on EOF without a terminal event", async () => {
    const { modules } = await fixture();
    const fake = routes({ "GET /voicebox/kits/k/publish/p/events": { text: 'data: {"type":"progress"}\n\n' } });
    expect(await modules.client.createStardogClient({ fetchImpl: fake.fetch }).readEvents("k", "p", { maxMs: 1000 })).toBeNull();
  });

  it("bounds a stalled stream and cancels its reader", async () => {
    const { modules } = await fixture();
    const cancelled = vi.fn();
    const fake = routes({ "GET /voicebox/kits/k/publish/p/events": () => new Response(new ReadableStream({ cancel: cancelled })) });
    vi.useFakeTimers();
    try {
      const pending = modules.client.createStardogClient({ fetchImpl: fake.fetch }).readEvents("k", "p", { maxMs: 240_000 });
      // Advance virtual time; no test waits on wall-clock time.
      await vi.advanceTimersByTimeAsync(240_000);
      expect(await pending).toBeNull();
      expect(cancelled).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("does not expose credentials or headers from a broken event stream", async () => {
    const { modules } = await fixture();
    const fake = routes({ "GET /voicebox/kits/k/publish/p/events": () => new Response(new ReadableStream({ start(controller) {
      controller.error(new Error(`X-Voicebox-Auth: Bearer ${TOKEN}`));
    } })) });
    await expect(modules.client.createStardogClient({ fetchImpl: fake.fetch }).readEvents("k", "p", { maxMs: 1000 }))
      .rejects.toThrow("Stardog Run events stream failed");
  });

  it("does not expose an upstream echoed credential in an import error", async () => {
    const { modules } = await fixture();
    const dir = testDir("stardog");
    writeFileSync(join(dir, "kit.yaml"), "data: []");
    const fake = routes({ "POST /voicebox/kits/import": { status: 500, text: `Authorization: Bearer ${TOKEN}` } });
    await expect(modules.client.createStardogClient({ fetchImpl: fake.fetch }).startImport(dir, ["kit.yaml"], { db: "builddown-kg", graphName: "builddown-kg" }))
      .rejects.toThrow("Stardog Run import answered HTTP 500");
  });
});
