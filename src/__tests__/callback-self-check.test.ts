import { describe, it, expect, vi } from "vitest";
import { checkRunnerCallbackReachable } from "../callback-self-check.js";

type FetchImpl = Parameters<typeof checkRunnerCallbackReachable>[0]["fetchImpl"];

const okFetch: FetchImpl = async () => ({ ok: true, status: 200 });

describe("checkRunnerCallbackReachable", () => {
  it("skips when no baseUrl is configured", async () => {
    const result = await checkRunnerCallbackReachable({
      baseUrl: null,
      runnerMode: "fly",
      fetchImpl: okFetch,
    });
    expect(result).toEqual({ status: "skipped", reason: "not configured" });
  });

  it("skips when runner mode is local", async () => {
    const fetchImpl = vi.fn(okFetch);
    const result = await checkRunnerCallbackReachable({
      baseUrl: "http://host.docker.internal:8080",
      runnerMode: "local",
      fetchImpl,
    });
    expect(result.status).toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips when the URL points at host.docker.internal (not resolvable from the host)", async () => {
    const fetchImpl = vi.fn(okFetch);
    const result = await checkRunnerCallbackReachable({
      baseUrl: "http://host.docker.internal:8080",
      runnerMode: "default",
      fetchImpl,
    });
    expect(result.status).toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches the health route and reports ok on a 2xx response", async () => {
    const fetchImpl = vi.fn(okFetch);
    const result = await checkRunnerCallbackReachable({
      baseUrl: "https://orchestrator.example.com",
      runnerMode: "fly",
      fetchImpl,
    });
    expect(result).toEqual({ status: "ok", httpStatus: 200 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://orchestrator.example.com/",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("does not double up the slash when baseUrl has a trailing slash", async () => {
    const fetchImpl = vi.fn(okFetch);
    await checkRunnerCallbackReachable({
      baseUrl: "https://orchestrator.example.com/",
      runnerMode: "fly",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://orchestrator.example.com/",
      expect.anything(),
    );
  });

  it("reports unreachable on a non-2xx response", async () => {
    const result = await checkRunnerCallbackReachable({
      baseUrl: "https://orchestrator.example.com",
      runnerMode: "fly",
      fetchImpl: async () => ({ ok: false, status: 502 }),
    });
    expect(result).toEqual({ status: "unreachable", error: "HTTP 502" });
  });

  it("reports unreachable when the fetch throws (DNS failure, connection refused)", async () => {
    const result = await checkRunnerCallbackReachable({
      baseUrl: "https://typo.example.invalid",
      runnerMode: "fly",
      fetchImpl: async () => {
        throw new Error("getaddrinfo ENOTFOUND typo.example.invalid");
      },
    });
    expect(result.status).toBe("unreachable");
    expect(result.status === "unreachable" && result.error).toContain("ENOTFOUND");
  });

  it("aborts and reports unreachable when the fetch exceeds the timeout", async () => {
    const hangingFetch: FetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("The operation was aborted")),
        );
      });
    const result = await checkRunnerCallbackReachable({
      baseUrl: "https://orchestrator.example.com",
      runnerMode: "fly",
      fetchImpl: hangingFetch,
      timeoutMs: 20,
    });
    expect(result.status).toBe("unreachable");
  });
});
