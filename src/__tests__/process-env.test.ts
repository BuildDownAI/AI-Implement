import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoProcessEnv, modelProcessEnv, gitProcessEnv, gitDependencyProcessEnv } from "../pipeline/process-env.js";

const SAVED: Record<string, string | undefined> = {};

function saveAndSet(key: string, value: string | undefined): void {
  SAVED[key] = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function restoreAll(): void {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const key of Object.keys(SAVED)) delete SAVED[key];
}

beforeEach(() => {
  saveAndSet("ANTHROPIC_API_KEY", undefined);
  saveAndSet("CLAUDE_CODE_OAUTH_TOKEN", undefined);
  saveAndSet("RUN_PROGRESS_TOKEN", undefined);
  saveAndSet("RUN_PUBLICATION_TOKEN", undefined);
  saveAndSet("RUN_TOKEN", undefined);
  saveAndSet("GITHUB_TOKEN", undefined);
  saveAndSet("NPM_TOKEN", undefined);
});

afterEach(() => {
  restoreAll();
});

describe("repoProcessEnv", () => {
  it("strips ANTHROPIC_API_KEY", () => {
    process.env.ANTHROPIC_API_KEY = "sentinel-api-key";
    const env = repoProcessEnv();
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("strips CLAUDE_CODE_OAUTH_TOKEN", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sentinel-oauth-token";
    const env = repoProcessEnv();
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("preserves PATH and non-credential variables", () => {
    const env = repoProcessEnv();
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("does not mutate process.env", () => {
    process.env.ANTHROPIC_API_KEY = "sentinel-api-key";
    repoProcessEnv();
    expect(process.env.ANTHROPIC_API_KEY).toBe("sentinel-api-key");
  });
});

describe("repoProcessEnv install credentials", () => {
  it("keeps NPM_TOKEN for the install step and hooks", () => {
    process.env.NPM_TOKEN = "sentinel-npm-token";
    const env = repoProcessEnv();
    expect(env.NPM_TOKEN).toBe("sentinel-npm-token");
  });
});

describe("modelProcessEnv", () => {
  it("OAuth-wins: when both are set, only OAuth token is present", () => {
    process.env.ANTHROPIC_API_KEY = "sentinel-api-key";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sentinel-oauth-token";
    const env = modelProcessEnv(false);
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sentinel-oauth-token");
  });

  it("API key alone: when OAuth is absent, API key is present", () => {
    process.env.ANTHROPIC_API_KEY = "sentinel-api-key";
    const env = modelProcessEnv(false);
    expect(env.ANTHROPIC_API_KEY).toBe("sentinel-api-key");
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("OAuth alone: when API key is absent, OAuth token is present", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sentinel-oauth-token";
    const env = modelProcessEnv(false);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sentinel-oauth-token");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("neither credential set: neither key is present", () => {
    const env = modelProcessEnv(false);
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("strips RUN_PROGRESS_TOKEN", () => {
    process.env.RUN_PROGRESS_TOKEN = "sentinel-progress-token";
    const env = modelProcessEnv(false);
    expect(env).not.toHaveProperty("RUN_PROGRESS_TOKEN");
  });

  it("strips RUN_PUBLICATION_TOKEN", () => {
    process.env.RUN_PUBLICATION_TOKEN = "sentinel-publication-token";
    const env = modelProcessEnv(false);
    expect(env).not.toHaveProperty("RUN_PUBLICATION_TOKEN");
  });

  it("strips RUN_TOKEN", () => {
    process.env.RUN_TOKEN = "sentinel-run-token";
    const env = modelProcessEnv(false);
    expect(env).not.toHaveProperty("RUN_TOKEN");
  });

  it("strips NPM_TOKEN even when it is not a forwarded secret", () => {
    process.env.NPM_TOKEN = "sentinel-npm-token";
    const env = modelProcessEnv(true);
    expect(env).not.toHaveProperty("NPM_TOKEN");
  });

  it("modelProcessEnv(false) strips GITHUB_TOKEN", () => {
    process.env.GITHUB_TOKEN = "sentinel-github-token";
    const env = modelProcessEnv(false);
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("modelProcessEnv(true) keeps GITHUB_TOKEN", () => {
    process.env.GITHUB_TOKEN = "sentinel-github-token";
    const env = modelProcessEnv(true);
    expect(env.GITHUB_TOKEN).toBe("sentinel-github-token");
  });

  it("does not mutate process.env", () => {
    process.env.ANTHROPIC_API_KEY = "sentinel-api-key";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sentinel-oauth-token";
    modelProcessEnv(false);
    expect(process.env.ANTHROPIC_API_KEY).toBe("sentinel-api-key");
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sentinel-oauth-token");
  });
});

describe("gitProcessEnv", () => {
  const SENTINEL_KEYS = [
    "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN",
    "RUN_PROGRESS_TOKEN", "RUN_PUBLICATION_TOKEN", "RUN_TOKEN",
    "NPM_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
    "GH_ENTERPRISE_TOKEN", "GIT_PASSWORD", "MY_FORWARDED_SECRET",
    "AI_IMPLEMENT_RUN_CONFIG", "AI_IMPLEMENT_FORWARDED_SECRETS",
  ];
  const KEEP_KEYS = [
    "PATH", "HOME", "SSL_CERT_FILE", "GIT_SSL_CAINFO", "GIT_SSL_NO_VERIFY",
    "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "no_proxy", "XDG_CONFIG_HOME",
    "GIT_CONFIG_GLOBAL",
  ];

  beforeEach(() => {
    for (const key of [...SENTINEL_KEYS, ...KEEP_KEYS]) saveAndSet(key, `sentinel-${key}`);
    process.env.AI_IMPLEMENT_FORWARDED_SECRETS = "MY_FORWARDED_SECRET";
  });
  afterEach(restoreAll);

  it("strips every runner, model, install, GitHub and forwarded credential", () => {
    const env = gitProcessEnv();
    for (const key of SENTINEL_KEYS) expect(env[key], key).toBeUndefined();
  });

  it("keeps PATH, HOME, TLS, proxy and git config discovery variables", () => {
    const env = gitProcessEnv();
    for (const key of KEEP_KEYS) expect(env[key], key).toBe(`sentinel-${key}`);
  });

  it("applies operation-scoped extras after stripping", () => {
    const env = gitProcessEnv({ GIT_PASSWORD: "scoped", GIT_CONFIG_COUNT: "1" });
    expect(env.GIT_PASSWORD).toBe("scoped");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GH_TOKEN).toBeUndefined();
  });

  it("does not mutate process.env", () => {
    gitProcessEnv();
    expect(process.env.GH_TOKEN).toBe("sentinel-GH_TOKEN");
    expect(process.env.AI_IMPLEMENT_RUN_CONFIG).toBe("sentinel-AI_IMPLEMENT_RUN_CONFIG");
    expect(process.env.MY_FORWARDED_SECRET).toBe("sentinel-MY_FORWARDED_SECRET");
  });
});

describe("gitProcessEnv dependency credentials", () => {
  const DEP = {
    GIT_DEPENDENCY_TOKEN_FILE: "/sentinel/cache.json",
    GIT_DEPENDENCY_CALLBACK_URL: "https://sentinel.invalid",
    COMPOSER_AUTH: '{"sentinel":"composer"}',
  };

  beforeEach(() => {
    for (const [k, v] of Object.entries(DEP)) saveAndSet(k, v);
    saveAndSet("RUN_PROGRESS_TOKEN", "sentinel-progress");
    saveAndSet("RUN_TOKEN", "sentinel-run");
    saveAndSet("NPM_TOKEN", "sentinel-npm");
    saveAndSet("GITHUB_TOKEN", "sentinel-github");
    saveAndSet("AI_IMPLEMENT_RUN_CONFIG", "sentinel-run-config");
  });

  it("strips the three derived dependency variables and leaves process.env intact", () => {
    const env = gitProcessEnv();
    for (const k of Object.keys(DEP)) expect(env[k], k).toBeUndefined();
    for (const [k, v] of Object.entries(DEP)) expect(process.env[k]).toBe(v);
  });

  it("gitDependencyProcessEnv restores only the helper handle, callback URL and progress bearer", () => {
    const env = gitDependencyProcessEnv();
    expect(env.GIT_DEPENDENCY_TOKEN_FILE).toBe(DEP.GIT_DEPENDENCY_TOKEN_FILE);
    expect(env.GIT_DEPENDENCY_CALLBACK_URL).toBe(DEP.GIT_DEPENDENCY_CALLBACK_URL);
    expect(env.RUN_PROGRESS_TOKEN).toBe("sentinel-progress");
    for (const k of ["COMPOSER_AUTH", "RUN_TOKEN", "NPM_TOKEN", "GITHUB_TOKEN", "AI_IMPLEMENT_RUN_CONFIG"]) {
      expect(env[k], k).toBeUndefined();
    }
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("gitDependencyProcessEnv applies extras and omits unset variables", () => {
    saveAndSet("GIT_DEPENDENCY_CALLBACK_URL", undefined);
    const env = gitDependencyProcessEnv({ GIT_TERMINAL_PROMPT: "0" });
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env).not.toHaveProperty("GIT_DEPENDENCY_CALLBACK_URL");
  });

  describe("git-credential-helper.sh cache", () => {
    let dir: string;
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    function runHelper(env: NodeJS.ProcessEnv) {
      return spawnSync("bash", [join(process.cwd(), "session", "git-credential-helper.sh"), "get"], {
        input: "protocol=https\nhost=github.com\n\n",
        env,
        encoding: "utf8",
      });
    }

    it("a missing progress bearer alone does not fence the cached token; gitProcessEnv does", () => {
      dir = mkdtempSync(join(tmpdir(), "helper-cache-"));
      const cache = join(dir, "cache.json");
      writeFileSync(cache, JSON.stringify({ token: "SENTINEL-CACHED", expires_at: "2999-01-01T00:00:00Z" }));
      process.env.GIT_DEPENDENCY_TOKEN_FILE = cache;
      delete process.env.RUN_PROGRESS_TOKEN;

      const bearerOnly = { ...process.env };
      expect(runHelper(bearerOnly).stdout).toContain("password=SENTINEL-CACHED");

      expect(runHelper(gitProcessEnv()).stdout).not.toContain("SENTINEL-CACHED");
    });
  });
});
