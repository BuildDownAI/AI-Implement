import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { refreshRunnerGithubCredentials, refreshRunnerGithubToken } from "../runner-token.js";
import { __resetPublicationCredentialForTests } from "../publication-credential.js";

describe("refreshRunnerGithubToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    __resetPublicationCredentialForTests();
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

  it("vends through the dedicated publication endpoint when no machine nonce exists", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "fresh-publication-token", expires_at: "2030-01-01T00:00:00Z" }),
    } as Response);

    const token = await refreshRunnerGithubToken({
      currentToken: "workflow-token",
      callbackUrl: "https://orchestrator.example/",
      publicationToken: "one-use-runner-token",
      owner: "BuildDownAI",
      fetchImpl,
    });

    expect(token).toBe("fresh-publication-token");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://orchestrator.example/api/runner/publication-token",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer one-use-runner-token" },
      }),
    );
  });

  it("fails closed when the publication credential is rejected", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response);

    await expect(refreshRunnerGithubCredentials({
      currentToken: "workflow-token",
      callbackUrl: "https://orchestrator.example",
      publicationToken: "rejected-publication-token",
      owner: "BuildDownAI",
      repo: "AI-Implement",
      workspaceDir: "/workspace",
      fetchImpl,
    })).rejects.toThrow(/rejected with HTTP 403/);

    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("fails closed when the publication credential exchange cannot reach the orchestrator", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connection refused"));
    vi.stubEnv("GITHUB_TOKEN", "workflow-token");
    vi.stubEnv("GH_TOKEN", "workflow-token");

    await expect(refreshRunnerGithubCredentials({
      currentToken: "workflow-token",
      callbackUrl: "https://orchestrator.example",
      publicationToken: "one-use-publication-token",
      owner: "BuildDownAI",
      repo: "AI-Implement",
      workspaceDir: "/workspace",
      fetchImpl,
    })).rejects.toThrow(/Token refresh unavailable \(connection refused\)/);

    expect(process.env.GITHUB_TOKEN).toBe("workflow-token");
    expect(process.env.GH_TOKEN).toBe("workflow-token");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("fails closed when the publication credential exchange returns invalid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected token");
      },
    } as unknown as Response);
    vi.stubEnv("GITHUB_TOKEN", "workflow-token");
    vi.stubEnv("GH_TOKEN", "workflow-token");

    await expect(refreshRunnerGithubCredentials({
      currentToken: "workflow-token",
      callbackUrl: "https://orchestrator.example",
      publicationToken: "one-use-publication-token",
      owner: "BuildDownAI",
      repo: "AI-Implement",
      workspaceDir: "/workspace",
      fetchImpl,
    })).rejects.toThrow(/Token refresh returned invalid JSON \(Unexpected token\)/);

    expect(process.env.GITHUB_TOKEN).toBe("workflow-token");
    expect(process.env.GH_TOKEN).toBe("workflow-token");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("fails closed when the publication credential exchange returns no token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response);
    vi.stubEnv("GITHUB_TOKEN", "workflow-token");
    vi.stubEnv("GH_TOKEN", "workflow-token");

    await expect(refreshRunnerGithubCredentials({
      currentToken: "workflow-token",
      callbackUrl: "https://orchestrator.example",
      publicationToken: "one-use-publication-token",
      owner: "BuildDownAI",
      repo: "AI-Implement",
      workspaceDir: "/workspace",
      fetchImpl,
    })).rejects.toThrow(/Token refresh returned no token/);

    expect(process.env.GITHUB_TOKEN).toBe("workflow-token");
    expect(process.env.GH_TOKEN).toBe("workflow-token");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("fails closed when the publication credential exchange returns an empty token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "" }),
    } as Response);
    vi.stubEnv("GITHUB_TOKEN", "workflow-token");
    vi.stubEnv("GH_TOKEN", "workflow-token");

    await expect(refreshRunnerGithubCredentials({
      currentToken: "workflow-token",
      callbackUrl: "https://orchestrator.example",
      publicationToken: "one-use-publication-token",
      owner: "BuildDownAI",
      repo: "AI-Implement",
      workspaceDir: "/workspace",
      fetchImpl,
    })).rejects.toThrow(/Token refresh returned no token/);

    expect(process.env.GITHUB_TOKEN).toBe("workflow-token");
    expect(process.env.GH_TOKEN).toBe("workflow-token");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("prefers the machine nonce path when both credential mechanisms are present", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "fresh-machine-token" }),
    } as Response);

    await refreshRunnerGithubToken({
      currentToken: "boot-token",
      orchestratorUrl: "https://orchestrator.example",
      machineNonce: "machine-nonce",
      callbackUrl: "https://callback.example",
      publicationToken: "publication-token",
      owner: "BuildDownAI",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://orchestrator.example/api/token");
  });

  it("removes RUN_PUBLICATION_TOKEN after a successful credential exchange", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "fresh-token" }),
    } as Response);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    } as ReturnType<typeof spawnSync>);
    vi.stubEnv("RUN_PUBLICATION_TOKEN", "one-use-token");
    vi.stubEnv("GITHUB_TOKEN", "workflow-token");
    vi.stubEnv("GH_TOKEN", "workflow-token");

    await refreshRunnerGithubCredentials({
      currentToken: "workflow-token",
      callbackUrl: "https://orchestrator.example",
      publicationToken: process.env.RUN_PUBLICATION_TOKEN,
      owner: "BuildDownAI",
      repo: "AI-Implement",
      workspaceDir: "/workspace",
      fetchImpl,
    });

    expect(process.env.RUN_PUBLICATION_TOKEN).toBeUndefined();
    expect(process.env.GITHUB_TOKEN).toBe("fresh-token");
    expect(process.env.GH_TOKEN).toBe("fresh-token");
  });
});
