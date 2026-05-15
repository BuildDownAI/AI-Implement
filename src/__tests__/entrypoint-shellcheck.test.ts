import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

describe("session/entrypoint.sh", () => {
  it("passes shellcheck cleanly", () => {
    const r = spawnSync("shellcheck", ["session/entrypoint.sh"], { stdio: ["ignore", "pipe", "pipe"] });
    if (r.error?.code === "ENOENT") return; // skip when shellcheck not installed
    expect(r.status).toBe(0);
  });

  it("is under 100 lines (bootstrap, not monolith)", () => {
    const content = readFileSync("session/entrypoint.sh", "utf-8");
    expect(content.split("\n").length).toBeLessThan(100);
  });

  it("exec's node /app/dist/run-autonomous.js as the final step", () => {
    const content = readFileSync("session/entrypoint.sh", "utf-8");
    expect(content).toMatch(/exec\s+(.*\s+)?node\s+\/app\/dist\/run-autonomous\.js/);
  });

  it("detects GHA mode by GITHUB_ACTIONS=true", () => {
    const content = readFileSync("session/entrypoint.sh", "utf-8");
    expect(content).toMatch(/GITHUB_ACTIONS.*=.*"true"/);
  });

  it("exports GITHUB_DEFAULT_BRANCH for the TS runner", () => {
    const content = readFileSync("session/entrypoint.sh", "utf-8");
    expect(content).toMatch(/GITHUB_DEFAULT_BRANCH="\$\{GITHUB_DEFAULT_BRANCH:-main\}"/);
    expect(content).toMatch(/export GITHUB_DEFAULT_BRANCH/);
  });

  it("preserves the checked-out gap-fill PR branch for the TS clone step", () => {
    const content = readFileSync("session/entrypoint.sh", "utf-8");
    expect(content).toMatch(/gh pr checkout "\$PR_NUMBER"/);
    expect(content).toMatch(/GITHUB_DEFAULT_BRANCH="\$\(git branch --show-current\)"/);
  });

  it("does not pass duplicate preserve-environment flags to su", () => {
    const content = readFileSync("session/entrypoint.sh", "utf-8");
    expect(content).toContain("su -p coder");
    expect(content).not.toContain("su -m -p coder");
  });
});
