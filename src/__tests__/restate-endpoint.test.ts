import { afterEach, describe, expect, it, vi } from "vitest";
import { restateBindAddress } from "../restate/endpoint.js";

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
