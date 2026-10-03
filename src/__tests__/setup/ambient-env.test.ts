import { describe, expect, it } from "vitest";
import {
  BASE_ENV_ALLOWLIST,
  RESTATE_ENV_ALLOWLIST,
  extendEnvAllowlist,
  isAllowedEnvName,
  scrubAmbientEnv,
  type EnvAllowlist,
} from "./ambient-env.js";

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

describe("extendEnvAllowlist", () => {
  it("keeps every base entry and adds the tier's own", () => {
    expect(isAllowedEnvName(RESTATE_ENV_ALLOWLIST, "PATH")).toBe(true);
    expect(isAllowedEnvName(RESTATE_ENV_ALLOWLIST, "DOCKER_HOST")).toBe(true);
    expect(isAllowedEnvName(BASE_ENV_ALLOWLIST, "DOCKER_HOST")).toBe(false);
    expect(RESTATE_ENV_ALLOWLIST.pinned).toEqual(BASE_ENV_ALLOWLIST.pinned);
  });

  it("does not change the base it extends", () => {
    const before = structuredClone(BASE_ENV_ALLOWLIST);
    extendEnvAllowlist(BASE_ENV_ALLOWLIST, { names: { EXTRA: "extra" } });
    expect(BASE_ENV_ALLOWLIST).toEqual(before);
  });
});

describe("allowlist entries", () => {
  it.each([
    ["BASE_ENV_ALLOWLIST", BASE_ENV_ALLOWLIST],
    ["RESTATE_ENV_ALLOWLIST", RESTATE_ENV_ALLOWLIST],
  ])("each entry in %s states its reason", (_label, allowlist) => {
    const reasons = [
      ...Object.values(allowlist.names),
      ...Object.values(allowlist.prefixes),
      ...Object.values(allowlist.pinned).map((pin) => pin.reason),
    ];
    for (const reason of reasons) expect(reason.trim()).not.toBe("");
  });
});
