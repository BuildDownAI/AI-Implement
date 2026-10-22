import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveIdentityKeys, restateBindAddress, register, queryNonCompletedInvocations, RESTATE_SERVICES } from "../restate/endpoint.js";
import { createProductionReviewFixServices } from "../restate/review-fix-production.js";
import { makeRegistry } from "./helpers/builders.js";
import { fakeFetch, hangUntilAborted, type Reply } from "./helpers/fake-fetch.js";

// AII-727: a static pin, unit-tier only. Dropping either service from RESTATE_SERVICES
// passes every other test in this file (they all fake the admin API), and a real container
// only catches it in endpoint.restate.test.ts — this is the fast, no-Docker half of that
// same regression.
describe("RESTATE_SERVICES", () => {
  it("names exactly Operator, orchestratorTools, RunnerBackend, ChatGptPlanAccount and AccessBinding", () => {
    expect(RESTATE_SERVICES.map((service) => service.name)).toEqual(["Operator", "orchestratorTools", "RunnerBackend", "ChatGptPlanAccount", "AccessBinding"]);
  });
});

describe("production review-fix services", () => {
  it("composes both durable services beside the operator and tool endpoint", () => {
    const services = createProductionReviewFixServices({ githubAppId: "test", githubAppPrivateKey: "test",
      runnerCallbackBaseUrl: null, runnerTokenSecret: null, sessionImage: "ghcr.io/x/runner:latest", runnerImageExplicit: false },
      makeRegistry());
    expect([...RESTATE_SERVICES, ...services].map((service) => service.name)).toEqual([
      "Operator", "orchestratorTools", "RunnerBackend", "ChatGptPlanAccount", "AccessBinding", "ReviewFixPR", "ReviewFixAttempt",
    ]);
  });
});

describe("restateBindAddress", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to loopback host and port 9080 when unset", () => {
    vi.stubEnv("RESTATE_ENDPOINT_HOST", "");
    vi.stubEnv("RESTATE_ENDPOINT_PORT", "");
    expect(restateBindAddress()).toEqual({ host: "127.0.0.1", port: 9080 });
  });

  it("honors an explicit host and port", () => {
    vi.stubEnv("RESTATE_ENDPOINT_HOST", "0.0.0.0");
    vi.stubEnv("RESTATE_ENDPOINT_PORT", "9999");
    expect(restateBindAddress()).toEqual({ host: "0.0.0.0", port: 9999 });
  });

  it("honors an explicit port of 0 (let the OS pick a free port)", () => {
    vi.stubEnv("RESTATE_ENDPOINT_PORT", "0");
    expect(restateBindAddress().port).toBe(0);
  });

  it("falls back to the default port for a non-numeric override", () => {
    vi.stubEnv("RESTATE_ENDPOINT_PORT", "abc");
    expect(restateBindAddress().port).toBe(9080);
  });
});

// ---------------------------------------------------------------------------
// register()
// ---------------------------------------------------------------------------

const META0004: Reply = { status: 409, json: { restate_code: "META0004", message: "conflict" } };

/** The admin API's deployments endpoint, answering each registration call in order. */
function deployments(...replies: Reply[]) {
  return fakeFetch({ "POST /deployments": replies });
}

/**
 * vitest's fake timers do not intercept Node's AbortSignal.timeout — verified empirically,
 * it schedules through an internal timer rather than the patchable global setTimeout — so
 * this bounds the wait by stubbing AbortSignal.timeout's own implementation instead of the
 * clock. Asserts the exact ms value production code passes, then fires the abort on the next
 * microtask so the test does not block on real wall-clock time.
 */
function stubAbortTimeout(expectedMs: number): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    expect(ms).toBe(expectedMs);
    const controller = new AbortController();
    queueMicrotask(() => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")));
    return controller.signal;
  });
}

describe("register", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("posts the endpoint URI to POST /deployments without force", async () => {
    const fake = deployments({ status: 201, json: { id: "dp_1" } });
    const result = await register({
      adminBaseUrl: "http://127.0.0.1:9070",
      fetchImpl: fake.fetch,
    });

    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call.url.href).toBe("http://127.0.0.1:9070/deployments");
    expect(call.method).toBe("POST");
    expect(JSON.parse(call.body)).toEqual({ uri: "http://127.0.0.1:9080" });
    expect(result).toEqual({ outcome: "registered-no-force" });
  });

  it("an existing URI (200) is re-discovered with force after a zero drain count", async () => {
    const fake = deployments({ json: { id: "dp_1" } }, { json: { id: "dp_1" } });
    const result = await register({
      adminBaseUrl: "http://127.0.0.1:9070",
      fetchImpl: fake.fetch,
      queryNonCompletedInvocations: async () => 0,
    });

    expect(fake.calls).toHaveLength(2);
    expect(JSON.parse(fake.calls[1].body)).toEqual({ uri: "http://127.0.0.1:9080", force: true });
    expect(result).toEqual({ outcome: "registered-drained-force" });
  });

  it("an existing URI (200) with active work declines force", async () => {
    const fake = deployments({ json: { id: "dp_1" } });
    const result = await register({
      adminBaseUrl: "http://127.0.0.1:9070",
      fetchImpl: fake.fetch,
      queryNonCompletedInvocations: async () => 1,
    });

    expect(fake.calls).toHaveLength(1);
    expect(result.outcome).toBe("declined-conflict");
  });

  it("META0004 conflict with zero non-completed invocations on the old deployment retries with force:true and succeeds", async () => {
    const fake = deployments(META0004, { json: { id: "dp_1" } });

    const result = await register({
      adminBaseUrl: "http://127.0.0.1:9070",
      fetchImpl: fake.fetch,
      queryNonCompletedInvocations: async () => 0,
    });

    expect(fake.calls).toHaveLength(2);
    expect(JSON.parse(fake.calls[1].body)).toEqual({ uri: "http://127.0.0.1:9080", force: true });
    expect(result).toEqual({ outcome: "registered-drained-force" });
  });

  it("META0004 conflict with a nonzero non-completed-invocation count declines force — no second call", async () => {
    const fake = deployments(META0004);

    const result = await register({
      adminBaseUrl: "http://127.0.0.1:9070",
      fetchImpl: fake.fetch,
      queryNonCompletedInvocations: async () => 3,
    });

    expect(fake.calls).toHaveLength(1);
    expect(result.outcome).toBe("declined-conflict");
  });

  it("META0004 conflict with an unknown non-completed-invocation count (null) declines force, fail-closed — no second call", async () => {
    const fake = deployments(META0004);

    const result = await register({
      adminBaseUrl: "http://127.0.0.1:9070",
      fetchImpl: fake.fetch,
      queryNonCompletedInvocations: async () => null,
    });

    expect(fake.calls).toHaveLength(1);
    expect(result.outcome).toBe("declined-conflict");
  });

  it("META0004 conflict with a throwing invocation-count query declines force, fail-closed — no second call", async () => {
    const fake = deployments(META0004);

    const result = await register({
      adminBaseUrl: "http://127.0.0.1:9070",
      fetchImpl: fake.fetch,
      queryNonCompletedInvocations: async () => {
        throw new Error("admin API unreachable mid-query");
      },
    });

    expect(fake.calls).toHaveLength(1);
    expect(result.outcome).toBe("declined-conflict");
  });

  it("a non-META0004 error does not retry with force", async () => {
    const fake = deployments({ status: 500, json: { message: "internal error" } });

    const result = await register({
      adminBaseUrl: "http://127.0.0.1:9070",
      fetchImpl: fake.fetch,
    });

    expect(fake.calls).toHaveLength(1);
    expect(result.outcome).toBe("unreachable");
  });

  it("bounds the no-force registration call at 10s — a never-resolving fetch degrades to unreachable once the bound fires (AII-728)", async () => {
    const timeoutSpy = stubAbortTimeout(10_000);
    try {
      const result = await register({
        adminBaseUrl: "http://127.0.0.1:9070",
        fetchImpl: deployments(hangUntilAborted).fetch,
      });
      expect(result.outcome).toBe("unreachable");
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("bounds the forced retry at 10s — a never-resolving fetch on the retry after a META0004 conflict degrades to unreachable (AII-728)", async () => {
    const timeoutSpy = stubAbortTimeout(10_000);
    try {
      const fake = deployments(META0004, hangUntilAborted);
      const result = await register({
        adminBaseUrl: "http://127.0.0.1:9070",
        fetchImpl: fake.fetch,
        queryNonCompletedInvocations: async () => 0,
      });
      expect(result.outcome).toBe("unreachable");
      // The request that hung is the forced retry.
      expect(JSON.parse(fake.calls[1].body)).toMatchObject({ force: true });
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("an unreachable admin API logs one warning and returns unreachable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = deployments(() => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9070");
    });

    const result = await register({
      adminBaseUrl: "http://127.0.0.1:9070",
      fetchImpl: fake.fetch,
    });

    expect(result.outcome).toBe("unreachable");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain("unreachable");
  });
});

// ---------------------------------------------------------------------------
// queryNonCompletedInvocations() — the drain check's own HTTP/parsing contract
// ---------------------------------------------------------------------------

/** The admin API's introspection endpoint, answering one query. */
function introspection(reply: Reply) {
  return fakeFetch({ "POST /query": [reply] });
}

describe("queryNonCompletedInvocations", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts a SQL query to POST /query with an Accept: application/json header, and resolves the row's count", async () => {
    const fake = introspection({ json: { rows: [{ count: 2 }] } });

    const result = await queryNonCompletedInvocations(fake.fetch, "http://127.0.0.1:9070", "http://127.0.0.1:9080");

    expect(result).toBe(2);
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call.url.href).toBe("http://127.0.0.1:9070/query");
    expect(call.method).toBe("POST");
    expect(call.headers.get("accept")).toBe("application/json");
    const body = JSON.parse(call.body) as { query: string };
    expect(body.query).toContain("http://127.0.0.1:9080");
    expect(body.query).toContain("status != 'completed'");
    // A scheduled call has not started: no journal, no pinned deployment (AII-1031).
    expect(body.query).toContain("status != 'scheduled'");
    expect(body.query).toContain("last_attempt_deployment_id");
    expect(body.query).toContain("target_service_name IN (SELECT name FROM sys_service");
  });

  it("resolves 0 when the query returns no matching deployment (nothing registered yet at that URI)", async () => {
    const fake = introspection({ json: { rows: [{ count: 0 }] } });
    const result = await queryNonCompletedInvocations(fake.fetch, "http://127.0.0.1:9070", "http://127.0.0.1:9080");
    expect(result).toBe(0);
  });

  it("resolves null (unknown) on a non-2xx response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = introspection({ status: 500, json: { message: "internal error" } });
    const result = await queryNonCompletedInvocations(fake.fetch, "http://127.0.0.1:9070", "http://127.0.0.1:9080");
    expect(result).toBeNull();
  });

  it("resolves null (unknown) on an unrecognized response shape — no rows array", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = introspection({ json: { data: [] } });
    const result = await queryNonCompletedInvocations(fake.fetch, "http://127.0.0.1:9070", "http://127.0.0.1:9080");
    expect(result).toBeNull();
  });

  it("resolves null (unknown) when the count column isn't a number", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = introspection({ json: { rows: [{ count: "2" }] } });
    const result = await queryNonCompletedInvocations(fake.fetch, "http://127.0.0.1:9070", "http://127.0.0.1:9080");
    expect(result).toBeNull();
  });

  it("resolves null (unknown) when fetch itself throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = introspection(() => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9070");
    });
    const result = await queryNonCompletedInvocations(fake.fetch, "http://127.0.0.1:9070", "http://127.0.0.1:9080");
    expect(result).toBeNull();
  });
});

describe("resolveIdentityKeys", () => {
  it("prefers the sidecar key, then RESTATE_IDENTITY_KEY", () => {
    expect(resolveIdentityKeys("publickeyv1_a", { RESTATE_IDENTITY_KEY: "publickeyv1_b" })).toEqual(["publickeyv1_a"]);
    expect(resolveIdentityKeys(undefined, { RESTATE_IDENTITY_KEY: "publickeyv1_b" })).toEqual(["publickeyv1_b"]);
  });

  it("warns once and returns undefined with neither", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveIdentityKeys(undefined, {})).toBeUndefined();
    resolveIdentityKeys(undefined, {});
    expect(err.mock.calls.length).toBeLessThanOrEqual(1);
    err.mockRestore();
  });
});
