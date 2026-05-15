import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

function runBash(script: string) {
  return spawnSync("bash", ["-lc", script], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("session/lib.sh", () => {
  it("passes shellcheck cleanly", () => {
    const result = spawnSync("shellcheck", ["session/lib.sh"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error?.code === "ENOENT") return;
    expect(result.status).toBe(0);
  });

  it("require_env accepts multiple set variables", () => {
    const result = runBash("source session/lib.sh; A=1 B=2; require_env A B");
    expect(result.status).toBe(0);
  });

  it("require_env fails when any requested variable is missing", () => {
    const result = runBash("source session/lib.sh; A=1; require_env A B");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FATAL: Required environment variable B is not set");
  });

  it("require_one_of succeeds when the first variable is set", () => {
    const result = runBash("source session/lib.sh; A=1; require_one_of A B C");
    expect(result.status).toBe(0);
  });

  it("require_one_of succeeds when the last variable is set", () => {
    const result = runBash("source session/lib.sh; C=1; require_one_of A B C");
    expect(result.status).toBe(0);
  });

  it("require_one_of fails through fail when none are set", () => {
    const result = runBash("source session/lib.sh; require_one_of A B C");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FATAL: At least one of A B C must be set");
  });
});
