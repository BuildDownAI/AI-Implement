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

  it("exec's the phase-selected TS runner as the final step", () => {
    const content = readFileSync("session/entrypoint.sh", "utf-8");
    expect(content).toContain('RUNNER_ENTRY="run-planning.js"');
    expect(content).toContain('RUNNER_ENTRY="run-autonomous.js"');
    expect(content).toContain('exec dbus-run-session -- su -p coder -c "HOME=/home/coder exec node /app/dist/$RUNNER_ENTRY"');
  });

  it("detects GHA mode by GITHUB_ACTIONS=true", () => {
    const content = readFileSync("session/entrypoint.sh", "utf-8");
    expect(content).toMatch(/GITHUB_ACTIONS.*=.*"true"/);
  });

  it("routes auth validation by provider and enables Claude Code Bedrock mode", () => {
    const content = readFileSync("session/entrypoint.sh", "utf-8");
    expect(content).toMatch(/PROVIDER="\$\{PROVIDER:-anthropic\}"/);
    expect(content).toMatch(/bedrock\) \[ "\$AI_IMPLEMENT_MODE" = "gha" \] \|\| fail "provider=bedrock is supported only in GHA mode"; require_env AWS_REGION; export CLAUDE_CODE_USE_BEDROCK=1/);
    // Bedrock must also disable experimental betas — Bedrock rejects the
    // cache_control.scope field, which breaks prompt caching. Assert explicitly
    // so removing or misspelling the export fails CI.
    expect(content).toContain("export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1");
    expect(content).toMatch(/anthropic\) require_one_of ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN/);
    expect(content.indexOf("CLAUDE_CODE_USE_BEDROCK=1")).toBeLessThan(content.indexOf("su -p coder"));
  });

  it("exports GITHUB_DEFAULT_BRANCH for the TS runner", () => {
    const content = readFileSync("session/entrypoint.sh", "utf-8");
    expect(content).toMatch(/GITHUB_DEFAULT_BRANCH="\$\{GITHUB_REF_NAME\}"/);
    expect(content).toMatch(/gh api "repos\/\$\{GITHUB_OWNER\}\/\$\{GITHUB_REPO\}"/);
    expect(content).toMatch(/export GITHUB_DEFAULT_BRANCH/);
    expect(content).not.toContain("GITHUB_DEFAULT_BRANCH:-main");
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
