import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("../runner-token.js", () => ({
  refreshRunnerGithubCredentials: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { refreshRunnerGithubCredentials } from "../runner-token.js";
import { refreshRunnerGithubCredentialsFromEnvironment } from "../refresh-runner-github-credentials.js";

describe("refreshRunnerGithubCredentialsFromEnvironment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GITHUB_OWNER", "BuildDownAI");
    vi.stubEnv("GITHUB_REPO", "AI-Implement");
    vi.stubEnv("GITHUB_TOKEN", "dispatch-token");
    vi.stubEnv("ORCHESTRATOR_URL", "https://orchestrator.example");
    vi.stubEnv("MACHINE_NONCE", "machine-nonce");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the latest token stored in origin as the fallback for the next refresh", async () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: Buffer.from("https://x-access-token:latest-token@github.com/BuildDownAI/AI-Implement.git\n"),
      stderr: Buffer.alloc(0),
    } as ReturnType<typeof spawnSync>);
    vi.mocked(refreshRunnerGithubCredentials).mockResolvedValue("fresh-token");

    await refreshRunnerGithubCredentialsFromEnvironment("/workspace");

    expect(refreshRunnerGithubCredentials).toHaveBeenCalledWith({
      currentToken: "latest-token",
      orchestratorUrl: "https://orchestrator.example",
      machineNonce: "machine-nonce",
      owner: "BuildDownAI",
      repo: "AI-Implement",
      workspaceDir: "/workspace",
      strict: true,
    });
  });
});
