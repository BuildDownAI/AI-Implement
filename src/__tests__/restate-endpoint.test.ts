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

/**
 * A fetchImpl that never settles unless its request's AbortSignal fires — the only way a
 * fixture can prove a fetch is actually bounded by `signal` rather than merely accepting an
 * ignored option (AII-728). Rejects with the signal's abort reason once the signal fires.
 */
function hangingFetch(): typeof fetch {
  return vi.fn((_url: unknown, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // no signal given: hangs forever, same as before AII-728
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as unknown as typeof fetch;
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

  it("bounds the no-force registration call at 10s — a never-resolving fetch degrades to unreachable once the bound fires (AII-728)", async () => {
    const timeoutSpy = stubAbortTimeout(10_000);
    try {
      const result = await register({
        adminBaseUrl: "http://127.0.0.1:9070",
        fetchImpl: hangingFetch(),
        getInFlightJobs: () => [],
      });
      expect(result.outcome).toBe("unreachable");
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("bounds the forced retry at 10s — a never-resolving fetch on the retry after a META0004 conflict degrades to unreachable (AII-728)", async () => {
    const timeoutSpy = stubAbortTimeout(10_000);
    try {
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.force) return hangingFetch()(url, init);
        return jsonResponse(409, { restate_code: "META0004", message: "conflict" });
      });
      const result = await register({
        adminBaseUrl: "http://127.0.0.1:9070",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        getInFlightJobs: () => [],
      });
      expect(result.outcome).toBe("unreachable");
    } finally {
      timeoutSpy.mockRestore();
    }
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
