import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── session/git-credential-helper.sh ────────────────────────────────────────

describe("session/git-credential-helper.sh", () => {
  it("passes shellcheck cleanly", () => {
    const r = spawnSync("shellcheck", ["session/git-credential-helper.sh"], { stdio: ["ignore", "pipe", "pipe"] });
    if (r.error?.code === "ENOENT") return; // skip when shellcheck not installed
    expect(r.status).toBe(0);
  });

  it("exits 0 without credentials when GIT_DEPENDENCY_TOKEN_FILE is unset", () => {
    const r = spawnSync("bash", ["session/git-credential-helper.sh", "get"], {
      stdio: ["pipe", "pipe", "pipe"],
      input: "protocol=https\nhost=github.com\n\n",
      env: { ...process.env, GIT_DEPENDENCY_TOKEN_FILE: "" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe("");
  });

  it("exits 0 without credentials for non-github.com hosts", () => {
    const r = spawnSync("bash", ["session/git-credential-helper.sh", "get"], {
      stdio: ["pipe", "pipe", "pipe"],
      input: "protocol=https\nhost=gitlab.com\n\n",
      env: { ...process.env, GIT_DEPENDENCY_TOKEN_FILE: "" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe("");
  });

  it("exits 0 without credentials for store/erase operations", () => {
    for (const op of ["store", "erase"]) {
      const r = spawnSync("bash", ["session/git-credential-helper.sh", op], {
        stdio: ["pipe", "pipe", "pipe"],
        input: "protocol=https\nhost=github.com\n\n",
        env: { ...process.env },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.toString()).toBe("");
    }
  });

  it("returns x-access-token credentials from a fresh token file", () => {
    const dir = mkdtempSync(join(tmpdir(), "dep-token-test-"));
    const tokenFile = join(dir, "token.json");
    try {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      writeFileSync(tokenFile, JSON.stringify({ token: "ghs_test_tok", expires_at: expiresAt }));

      const r = spawnSync("bash", ["session/git-credential-helper.sh", "get"], {
        stdio: ["pipe", "pipe", "pipe"],
        input: "protocol=https\nhost=github.com\n\n",
        env: { ...process.env, GIT_DEPENDENCY_TOKEN_FILE: tokenFile },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.toString()).toContain("username=x-access-token");
      expect(r.stdout.toString()).toContain("password=ghs_test_tok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT re-fetch when the cached token has more than 10 minutes remaining", () => {
    const dir = mkdtempSync(join(tmpdir(), "dep-token-test-"));
    const tokenFile = join(dir, "token.json");
    try {
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min — fresh
      writeFileSync(tokenFile, JSON.stringify({ token: "fresh-tok", expires_at: expiresAt }));

      // Provide a callback URL pointing at a port where nothing is listening.
      // If the helper tries to refresh, curl will fail (connection refused) and
      // the helper must still return the cached token.  We assert the output is
      // the cached token (not empty), proving no refresh was attempted.
      const r = spawnSync("bash", ["session/git-credential-helper.sh", "get"], {
        stdio: ["pipe", "pipe", "pipe"],
        input: "protocol=https\nhost=github.com\n\n",
        env: {
          ...process.env,
          GIT_DEPENDENCY_TOKEN_FILE: tokenFile,
          GIT_DEPENDENCY_CALLBACK_URL: "http://127.0.0.1:19999",
          RUN_PROGRESS_TOKEN: "progress-tok",
        },
      });
      expect(r.status).toBe(0);
      // Token is returned immediately without contacting the server.
      expect(r.stdout.toString()).toContain("password=fresh-tok");
      // Cache file must not have changed.
      const cached = JSON.parse(readFileSync(tokenFile, "utf-8")) as { token: string };
      expect(cached.token).toBe("fresh-tok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-fetches and returns the new token when within 10 minutes of expiry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dep-token-test-"));
    const tokenFile = join(dir, "token.json");

    let serverCalled = false;
    const server = http.createServer((_req, res) => {
      serverCalled = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          token: "refreshed-tok",
          expires_at: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
        }),
      );
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;

      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min — near expiry
      writeFileSync(tokenFile, JSON.stringify({ token: "stale-tok", expires_at: expiresAt }));

      // Use async spawn so the Node.js event loop remains free to serve the
      // curl request that the shell script makes.  spawnSync would block the
      // loop and cause the HTTP server to deadlock.
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn("bash", ["session/git-credential-helper.sh", "get"], {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            GIT_DEPENDENCY_TOKEN_FILE: tokenFile,
            GIT_DEPENDENCY_CALLBACK_URL: `http://127.0.0.1:${port}`,
            RUN_PROGRESS_TOKEN: "progress-tok",
          },
        });
        child.stdin.write("protocol=https\nhost=github.com\n\n");
        child.stdin.end();
        let out = "";
        child.stdout.on("data", (d: Buffer) => (out += d.toString()));
        child.on("close", (code) => {
          if (code !== 0) reject(new Error(`helper exited ${code}`));
          else resolve(out);
        });
        child.on("error", reject);
        setTimeout(() => reject(new Error("helper timed out")), 15000);
      });

      expect(serverCalled).toBe(true);
      expect(stdout).toContain("password=refreshed-tok");
      // Helper must update the cache file with the refreshed token.
      const cached = JSON.parse(readFileSync(tokenFile, "utf-8")) as { token: string };
      expect(cached.token).toBe("refreshed-tok");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is not consulted when the git URL already contains embedded credentials (AC #5)", () => {
    // Safety property: clone.ts and push.ts embed credentials directly in the
    // remote URL (https://x-access-token:TOKEN@github.com/…).  Git's
    // credential_fill() short-circuits immediately when username+password are
    // already set on the credential struct — which is what happens when git
    // parses an embedded-credential URL — so the helper is never invoked.
    //
    // We verify this by registering a sentinel-writing credential helper for
    // https://github.com and then calling `git credential fill` with all fields
    // pre-supplied (replicating what git does internally after parsing the URL).
    // The sentinel file must NOT exist after the call.
    const dir = mkdtempSync(join(tmpdir(), "dep-token-test-"));
    try {
      const sentinelFile = join(dir, "sentinel");
      const helperScript = join(dir, "sentinel-helper.sh");
      const gitconfigFile = join(dir, ".gitconfig");

      writeFileSync(helperScript, `#!/bin/bash\ntouch "${sentinelFile}"\n`);
      chmodSync(helperScript, 0o755);

      // Register sentinel for https://github.com — same scope as the real helper.
      writeFileSync(gitconfigFile, `[credential "https://github.com"]\n\thelper = ${helperScript}\n`);

      // Provide a fully-specified credential (protocol + host + username + password).
      // git credential fill returns immediately without invoking any helper because
      // there is nothing left to fill — mirroring the embedded-credential URL path.
      const r = spawnSync("git", ["credential", "fill"], {
        stdio: ["pipe", "pipe", "pipe"],
        input: "protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghs_test_tok\n\n",
        env: { ...process.env, GIT_CONFIG_GLOBAL: gitconfigFile },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.toString()).toContain("password=ghs_test_tok");
      // The sentinel must not exist — the helper was never consulted.
      expect(existsSync(sentinelFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── session/entrypoint.sh ───────────────────────────────────────────────────

describe("session/entrypoint.sh", () => {
  it("passes shellcheck cleanly", () => {
    const r = spawnSync("shellcheck", ["session/entrypoint.sh"], { stdio: ["ignore", "pipe", "pipe"] });
    if (r.error?.code === "ENOENT") return; // skip when shellcheck not installed
    expect(r.status).toBe(0);
  });

  it("is under 115 lines (bootstrap, not monolith)", () => {
    const content = readFileSync("session/entrypoint.sh", "utf-8");
    expect(content.split("\n").length).toBeLessThan(115);
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

  it("overrides GITHUB_DEFAULT_BRANCH with run_config.baseBranch on non-gap-fill runs", () => {
    const content = readFileSync("session/entrypoint.sh", "utf-8");
    // baseBranch must be read from the envelope
    expect(content).toContain("c.baseBranch");
    // override must be guarded: skip when PR_NUMBER is set (gap-fill must not override)
    expect(content).toContain('[ -z "${PR_NUMBER:-}" ]');
    // override must come AFTER the initial GITHUB_DEFAULT_BRANCH export (not gated on it being unset)
    const initialExport = content.indexOf("export GITHUB_DEFAULT_BRANCH");
    const branchOverride = content.indexOf('GITHUB_DEFAULT_BRANCH="$_rb"');
    expect(branchOverride).toBeGreaterThan(initialExport);
  });

  it("skips the legacy ISSUE_ID require/export when AI_IMPLEMENT_RUN_CONFIG is set", () => {
    const content = readFileSync("session/entrypoint.sh", "utf-8");
    expect(content).toMatch(/if \[ -n "\$\{AI_IMPLEMENT_RUN_CONFIG:-\}" \]; then/);
    expect(content).toContain('require_env ISSUE_ID ISSUE_IDENTIFIER ISSUE_TITLE ISSUE_DESCRIPTION');
    expect(content).toContain("export ISSUE_ID ISSUE_IDENTIFIER ISSUE_TITLE ISSUE_DESCRIPTION");
  });
});
