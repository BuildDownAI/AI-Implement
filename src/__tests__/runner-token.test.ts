import { describe, expect, it, vi } from "vitest";
import { refreshRunnerGithubToken } from "../runner-token.js";

describe("refreshRunnerGithubToken", () => {
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

  it("rejects nonce and owner validation failures instead of masking them", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response);

    await expect(refreshRunnerGithubToken({
      currentToken: "boot-token",
      orchestratorUrl: "https://orchestrator.example",
      machineNonce: "invalid-nonce",
      owner: "BuildDownAI",
      fetchImpl,
    })).rejects.toThrow(/rejected with HTTP 403/);
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
