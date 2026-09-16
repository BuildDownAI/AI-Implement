import { afterEach, describe, expect, it, vi } from "vitest";
import { restateBindAddress, register } from "../restate/endpoint.js";

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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("register", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("posts the endpoint URI to POST /deployments without force", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(201, { id: "dp_1" }));
    const result = await register({
      adminBaseUrl: "http://127.0.0.1:9070",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getInFlightJobs: () => [],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:9070/deployments");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ uri: "http://127.0.0.1:9080" });
    expect(result).toEqual({ outcome: "registered-no-force" });
  });

  it("an already-registered endpoint (200, unchanged) is success — no second call", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: "dp_1" }));
    const result = await register({
      adminBaseUrl: "http://127.0.0.1:9070",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getInFlightJobs: () => [],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ outcome: "registered-no-force" });
  });

  it("META0004 conflict with zero in-flight jobs retries with force:true and succeeds", async () => {
    const fetchImpl = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(409, { restate_code: "META0004", message: "conflict" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "dp_1" }));

    const result = await register({
      adminBaseUrl: "http://127.0.0.1:9070",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getInFlightJobs: () => [],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, secondInit] = fetchImpl.mock.calls[1];
    expect(JSON.parse(secondInit.body as string)).toEqual({ uri: "http://127.0.0.1:9080", force: true });
    expect(result).toEqual({ outcome: "registered-drained-force" });
  });

  it("META0004 conflict with in-flight jobs declines force — no second call", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(409, { restate_code: "META0004", message: "conflict" }));

    const result = await register({
      adminBaseUrl: "http://127.0.0.1:9070",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getInFlightJobs: () => [{ id: 1 } as never],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("declined-conflict");
  });

  it("a non-META0004 error does not retry with force", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { message: "internal error" }));

    const result = await register({
      adminBaseUrl: "http://127.0.0.1:9070",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getInFlightJobs: () => [],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("unreachable");
  });

  it("an unreachable admin API logs one warning and returns unreachable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9070");
    });

    const result = await register({
      adminBaseUrl: "http://127.0.0.1:9070",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getInFlightJobs: () => [],
    });

    expect(result.outcome).toBe("unreachable");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain("unreachable");
  });
});
