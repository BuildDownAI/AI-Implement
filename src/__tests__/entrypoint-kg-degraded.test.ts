import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

// KG degraded-detection tests (marker + npz combinations) have moved to
// src/__tests__/kg-sidecar.test.ts, which exercises checkDegraded() directly
// in TypeScript now that the logic lives in src/kg-sidecar.ts.

// Verify docker-entrypoint.sh itself passes shellcheck when available.
describe("docker-entrypoint.sh shellcheck", () => {
  it("passes shellcheck cleanly", () => {
    const r = spawnSync("shellcheck", ["docker-entrypoint.sh"], { stdio: "ignore" });
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return; // skip when shellcheck not installed
    expect(r.status).toBe(0);
  });
});
