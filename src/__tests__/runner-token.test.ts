import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { refreshRunnerGithubCredentials, refreshRunnerGithubToken } from "../runner-token.js";

describe("refreshRunnerGithubToken", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("vends a token with the machine nonce and repository owner", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "fresh-token", expires_at: "2026-08-07T01:00:00Z" }),
    } as Response);

    const token = await refreshRunnerGithubToken({
      currentToken: "boot-token",
      orchestratorUrl: "https://orchestrator.example/",
      machineNonce: "machine-nonce",
      owner: "BuildDownAI",
      fetchImpl,
    });

    expect(token).toBe("fresh-token");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://orchestrator.example/api/token",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nonce: "machine-nonce", owner: "BuildDownAI" }),
      }),
    );
  });

  it("keeps the boot token when vending is unavailable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connection refused"));

    await expect(refreshRunnerGithubToken({
      currentToken: "boot-token",
      orchestratorUrl: "https://orchestrator.example",
      machineNonce: "machine-nonce",
      owner: "BuildDownAI",
      fetchImpl,
    })).resolves.toBe("boot-token");
  });

  it("reapplies the previous token to the environment and origin when vending is unavailable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connection refused"));
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    } as ReturnType<typeof spawnSync>);
    vi.stubEnv("GITHUB_TOKEN", "stale-env-token");
    vi.stubEnv("GH_TOKEN", "stale-env-token");

    await expect(refreshRunnerGithubCredentials({
      currentToken: "previous-token",
      orchestratorUrl: "https://orchestrator.example",
      machineNonce: "machine-nonce",
      owner: "BuildDownAI",
      repo: "AI-Implement",
      workspaceDir: "/workspace",
      fetchImpl,
    })).resolves.toBe("previous-token");

    expect(process.env.GITHUB_TOKEN).toBe("previous-token");
    expect(process.env.GH_TOKEN).toBe("previous-token");
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      [
        "remote",
        "set-url",
        "origin",
        "https://x-access-token:previous-token@github.com/BuildDownAI/AI-Implement.git",
      ],
      expect.objectContaining({ cwd: "/workspace" }),
    );
  });

  it("keeps the boot token when vending rejects an automated refresh", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response);

    await expect(refreshRunnerGithubToken({
      currentToken: "boot-token",
      orchestratorUrl: "https://orchestrator.example",
      machineNonce: "invalid-nonce",
      owner: "BuildDownAI",
      fetchImpl,
    })).resolves.toBe("boot-token");
  });

  it("rejects vending failures in strict mode", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response);

    await expect(refreshRunnerGithubToken({
      currentToken: "boot-token",
      orchestratorUrl: "https://orchestrator.example",
      machineNonce: "invalid-nonce",
      owner: "BuildDownAI",
      fetchImpl,
      strict: true,
    })).rejects.toThrow(/rejected with HTTP 403/);
  });

  it("still rejects unexpected client errors in automated mode", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 400 } as Response);

    await expect(refreshRunnerGithubToken({
      currentToken: "boot-token",
      orchestratorUrl: "https://orchestrator.example",
      machineNonce: "machine-nonce",
      owner: "BuildDownAI",
      fetchImpl,
    })).rejects.toThrow(/rejected with HTTP 400/);
  });

  it("does not call the orchestrator without both URL and nonce", async () => {
    const fetchImpl = vi.fn();

    await expect(refreshRunnerGithubToken({
      currentToken: "workflow-token",
      owner: "BuildDownAI",
      fetchImpl,
    })).resolves.toBe("workflow-token");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
