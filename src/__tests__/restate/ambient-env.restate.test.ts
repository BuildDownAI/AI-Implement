// The Restate tier's counterpart to setup/ambient-env.test.ts, which only vitest.config.ts collects.
// This one runs under vitest.restate.config.ts, so it checks the scrub that config actually loads.
import { describe, expect, it } from "vitest";
import { RESTATE_ENV_ALLOWLIST, isAllowedEnvName } from "../setup/ambient-env.js";

describe("the environment a Restate-tier test sees", () => {
  it("holds no variable outside the Restate allowlist", () => {
    const outside = Object.keys(process.env).filter((name) => !isAllowedEnvName(RESTATE_ENV_ALLOWLIST, name));
    expect(
      outside,
      "Reached a Restate-tier test past the scrub. If the tier really needs one, add it to RESTATE_ENV_ALLOWLIST in " +
        "src/__tests__/setup/ambient-env.ts with its reason; otherwise set it inside that test.",
    ).toEqual([]);
  });

  it("holds every pinned value, whatever the machine set", () => {
    for (const [name, { value }] of Object.entries(RESTATE_ENV_ALLOWLIST.pinned)) {
      expect(process.env[name], name).toBe(value);
    }
  });
});
