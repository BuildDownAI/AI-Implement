import { afterEach, describe, expect, it, vi } from "vitest";
import { RunSignalSender, progressOnFirstStep } from "../pipeline/run-signal.js";
import type { Step } from "../pipeline/types.js";

const STEP = { id: "clone", status: "completed" } as unknown as Step;

function fetchReturning(...statuses: Array<number | Error>) {
  const queue = [...statuses];
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (next instanceof Error) throw next;
    return new Response("{}", { status: next });
  });
}

describe("RunSignalSender", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts {} to /runner/progress with the bearer token", async () => {
    const fetchMock = fetchReturning(200);
    const sender = new RunSignalSender("http://orch/", "tok", { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(await sender.signal("progress")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://orch/runner/progress");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init?.body as string)).toEqual({});
  });

  it("retries 503 then succeeds", async () => {
    const fetchMock = fetchReturning(503, 200);
    const sender = new RunSignalSender("http://orch", "tok", { fetchImpl: fetchMock as unknown as typeof fetch, retryDelaysMs: [0] });
    expect(await sender.signal("progress")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns false after exhausting retries on persistent 5xx", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = fetchReturning(503);
    const sender = new RunSignalSender("http://orch", "tok", { fetchImpl: fetchMock as unknown as typeof fetch, retryDelaysMs: [0, 0, 0] });
    expect(await sender.signal("progress")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("returns false on 401 with no retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = fetchReturning(401);
    const sender = new RunSignalSender("http://orch", "tok", { fetchImpl: fetchMock as unknown as typeof fetch, retryDelaysMs: [0, 0] });
    expect(await sender.signal("progress")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns false and does not throw when fetch rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = fetchReturning(new Error("network down"));
    const sender = new RunSignalSender("http://orch", "tok", { fetchImpl: fetchMock as unknown as typeof fetch, retryDelaysMs: [0] });
    expect(await sender.signal("progress")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("progressOnFirstStep", () => {
  it("stops after the first success", async () => {
    const signal = vi.fn(async () => true);
    const reporter = progressOnFirstStep({ signal } as unknown as RunSignalSender);
    await reporter.report(STEP);
    await reporter.report(STEP);
    await reporter.report(STEP);
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith("progress");
  });

  it("tries again after a failure", async () => {
    const signal = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const reporter = progressOnFirstStep({ signal } as unknown as RunSignalSender);
    await reporter.report(STEP);
    await reporter.report(STEP);
    await reporter.report(STEP);
    expect(signal).toHaveBeenCalledTimes(2);
  });
});
