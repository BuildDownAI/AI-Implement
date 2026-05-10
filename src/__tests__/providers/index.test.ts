import { describe, it, expect, afterEach } from "vitest";
import { resolveProvider, providerConfigFromEnv } from "../../providers/index.js";
import { UnknownProviderError } from "../../providers/types.js";

describe("resolveProvider", () => {
  it("returns LinearProvider for id 'linear'", async () => {
    const p = await resolveProvider("linear", { linearApiKey: "k" });
    expect(p.id).toBe("linear");
  });

  it("throws UnknownProviderError for unrecognized id", async () => {
    await expect(resolveProvider("unknown-prov" as never, {})).rejects.toThrow(UnknownProviderError);
  });
});

describe("providerConfigFromEnv", () => {
  const originalEnv = process.env.LINEAR_API_KEY;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = originalEnv;
  });

  it("reads LINEAR_API_KEY from env", () => {
    process.env.LINEAR_API_KEY = "test-key";
    expect(providerConfigFromEnv().linearApiKey).toBe("test-key");
  });

  it("returns undefined when LINEAR_API_KEY is unset", () => {
    delete process.env.LINEAR_API_KEY;
    expect(providerConfigFromEnv().linearApiKey).toBeUndefined();
  });
});
