// Both vitest configs collect this file, so the guard below checks the scrub each config loads.
import { describe, expect, it } from "vitest";
import { BASE_ENV_ALLOWLIST, isAllowedEnvName, scrubAmbientEnv, type EnvAllowlist } from "./ambient-env.js";

describe("the environment a test sees", () => {
  it("holds no variable outside the base allowlist", () => {
    const outside = Object.keys(process.env).filter((name) => !isAllowedEnvName(BASE_ENV_ALLOWLIST, name));
    expect(
      outside,
      "Reached a test past the scrub. If a test really needs one, add it to BASE_ENV_ALLOWLIST in " +
        "src/__tests__/setup/ambient-env.ts with its reason; otherwise set it inside that test.",
    ).toEqual([]);
  });

  it("holds every pinned value, whatever the machine set", () => {
    for (const [name, { value }] of Object.entries(BASE_ENV_ALLOWLIST.pinned)) {
      expect(process.env[name], name).toBe(value);
    }
  });
});

describe("scrubAmbientEnv", () => {
  const allowlist: EnvAllowlist = {
    names: { KEPT: "kept by name" },
    prefixes: { KEPT_PREFIX_: "kept by prefix" },
    pinned: { PINNED: { value: "fixed", reason: "pinned" } },
  };

  it("deletes every variable the allowlist does not cover, and keeps the ones it does", () => {
    const env: NodeJS.ProcessEnv = { KEPT: "a", KEPT_PREFIX_ONE: "b", RUN_TOKEN: "secret", FLY_IMAGE_REF: "x" };
    scrubAmbientEnv(allowlist, env);
    expect(env).toEqual({ KEPT: "a", KEPT_PREFIX_ONE: "b", PINNED: "fixed" });
  });

  it("overwrites a pinned variable the machine set to something else", () => {
    const env: NodeJS.ProcessEnv = { PINNED: "machine value" };
    scrubAmbientEnv(allowlist, env);
    expect(env.PINNED).toBe("fixed");
  });
});

describe("allowlist entries", () => {
  it("each entry in BASE_ENV_ALLOWLIST states its reason", () => {
    const reasons = [
      ...Object.values(BASE_ENV_ALLOWLIST.names),
      ...Object.values(BASE_ENV_ALLOWLIST.prefixes),
      ...Object.values(BASE_ENV_ALLOWLIST.pinned).map((pin) => pin.reason),
    ];
    for (const reason of reasons) expect(reason.trim()).not.toBe("");
  });
});
