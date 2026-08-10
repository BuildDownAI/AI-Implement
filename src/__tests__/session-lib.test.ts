import { describe, it, expect } from "vitest";

const isWindows = process.platform === "win32";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function runBash(script: string) {
  return spawnSync("bash", ["-lc", script], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe.skipIf(isWindows)("session/lib.sh", () => {
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

  it("adopt_workspace_ownership re-chowns /home/coder after renumbering coder", () => {
    const content = readFileSync("session/lib.sh", "utf-8");
    // After usermod re-numbers coder, /home/coder retains the old on-disk uid/gid.
    // Without this chown, coder loses write access to $HOME (EACCES on ~/.claude, etc.).
    expect(content).toContain("chown -R coder:coder /home/coder");
    // The chown must appear inside the renumber branch, after the usermod call.
    const usermodIdx = content.indexOf("usermod -o -u");
    const chownIdx = content.indexOf("chown -R coder:coder /home/coder");
    expect(chownIdx).toBeGreaterThan(usermodIdx);
  });

  it("adopt_workspace_ownership guards gid 0 symmetrically with uid 0", () => {
    const content = readFileSync("session/lib.sh", "utf-8");
    // Assigning coder to the root group (gid 0) is as hazardous as numbering it
    // to uid 0; the gid guard must prevent groupmod and the -g flag from doing so.
    expect(content).toMatch(/\[ "\$gid" != "0" \]/);
  });
});
