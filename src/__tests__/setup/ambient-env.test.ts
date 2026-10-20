// Both vitest configs collect this file, so the guard below checks the scrub each config loads.
import { basename, dirname, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, inject, it } from "vitest";
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

  it("points every temp-root variable, and so os.tmpdir(), at this file's own directory inside the run's", () => {
    const runRoot = inject("runTempRoot");
    expect(isAbsolute(runRoot), runRoot).toBe(true);
    expect(dirname(tmpdir())).toBe(runRoot);
    expect(basename(tmpdir())).toMatch(/^ambient-env\.test\.ts-/);
    for (const name of Object.keys(BASE_ENV_ALLOWLIST.tempRoot)) {
      expect(process.env[name], name).toBe(tmpdir());
    }
  });
});

describe("scrubAmbientEnv", () => {
  const allowlist: EnvAllowlist = {
    names: { KEPT: "kept by name" },
    prefixes: { KEPT_PREFIX_: "kept by prefix" },
    pinned: { PINNED: { value: "fixed", reason: "pinned" } },
    tempRoot: { TMPDIR: "set to the run temp root", TEMP: "set to the run temp root" },
  };
  const RUN_TEMP = "/run/temp";

  it("deletes every variable the allowlist does not cover, and keeps the ones it does", () => {
    const env: NodeJS.ProcessEnv = { KEPT: "a", KEPT_PREFIX_ONE: "b", RUN_TOKEN: "secret", FLY_IMAGE_REF: "x" };
    scrubAmbientEnv(allowlist, RUN_TEMP, env);
    expect(env).toEqual({ KEPT: "a", KEPT_PREFIX_ONE: "b", PINNED: "fixed", TMPDIR: RUN_TEMP, TEMP: RUN_TEMP });
  });

  it("keeps a covered variable whatever the case of its name, as Windows lists PATH as Path", () => {
    const env: NodeJS.ProcessEnv = { Kept: "a", kept_prefix_two: "b", Run_Token: "secret" };
    scrubAmbientEnv(allowlist, RUN_TEMP, env);
    expect(env).toMatchObject({ Kept: "a", kept_prefix_two: "b" });
    expect(env).not.toHaveProperty("Run_Token");
  });

  it("overwrites a pinned variable the machine set to something else", () => {
    const env: NodeJS.ProcessEnv = { PINNED: "machine value" };
    scrubAmbientEnv(allowlist, RUN_TEMP, env);
    expect(env.PINNED).toBe("fixed");
  });

  it("overwrites a temp-root variable the machine set, so the machine's temp directory is never used", () => {
    const env: NodeJS.ProcessEnv = { TMPDIR: "/machine/temp", TEMP: "C:\\Users\\dev\\AppData\\Local\\Temp" };
    scrubAmbientEnv(allowlist, RUN_TEMP, env);
    expect(env).toMatchObject({ TMPDIR: RUN_TEMP, TEMP: RUN_TEMP });
  });
});

describe("allowlist entries", () => {
  it("each entry in BASE_ENV_ALLOWLIST states its reason", () => {
    const reasons = [
      ...Object.values(BASE_ENV_ALLOWLIST.names),
      ...Object.values(BASE_ENV_ALLOWLIST.prefixes),
      ...Object.values(BASE_ENV_ALLOWLIST.pinned).map((pin) => pin.reason),
      ...Object.values(BASE_ENV_ALLOWLIST.tempRoot),
    ];
    for (const reason of reasons) expect(reason.trim()).not.toBe("");
  });
});
