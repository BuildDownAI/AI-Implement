import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { repoProcessEnv, modelProcessEnv } from "../pipeline/process-env.js";

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
