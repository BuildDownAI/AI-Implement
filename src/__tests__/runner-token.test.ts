import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { assertRunnerPublicationAuthority, refreshRunnerGithubCredentials, refreshRunnerGithubToken } from "../runner-token.js";
import { __resetPublicationCredentialForTests } from "../publication-credential.js";
import { fakeFetch, type Reply } from "./helpers/fake-fetch.js";

const VEND = "POST /api/token";
const PUBLICATION_TOKEN = "POST /api/runner/publication-token";

const connectionRefused: Reply = () => {
  throw new Error("connection refused");
};

describe("refreshRunnerGithubToken", () => {
  it("rechecks pilot authority for the exact GitHub execution before publication", async () => {
    const config = {
      v: 1,
      issue: { id: "issue-1", identifier: "AII-799", title: "Test", description: "Test" },
      reviewFix: { version: 1, attemptId: "attempt-1", installationId: 7,
        repository: "acme/app", prNumber: 42, deadlineAt: Date.now() + 60_000 },
    };
    vi.stubEnv("AI_IMPLEMENT_RUN_CONFIG", Buffer.from(JSON.stringify(config)).toString("base64"));
    vi.stubEnv("RUN_TOKEN", "result-token");
    vi.stubEnv("GITHUB_RUN_ID", "123");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "2");
    const orchestrator = fakeFetch({ "POST /api/runner/publication-authority": [{ status: 200 }, { status: 403 }] });
    await assertRunnerPublicationAuthority({ callbackUrl: "https://orchestrator.example", owner: "acme", repo: "app", fetchImpl: orchestrator.fetch });
    expect(orchestrator.calls[0].url.href).toBe("https://orchestrator.example/api/runner/publication-authority");
    expect(Object.fromEntries(orchestrator.calls[0].headers)).toEqual({
      authorization: "Bearer result-token", "x-run-repository": "acme/app",
      "x-github-run-id": "123", "x-github-run-attempt": "2",
    });
    await expect(assertRunnerPublicationAuthority({ callbackUrl: "https://orchestrator.example", owner: "acme", repo: "app", fetchImpl: orchestrator.fetch }))
      .rejects.toThrow(/authority rejected with HTTP 403/);
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    __resetPublicationCredentialForTests();
    vi.unstubAllEnvs();
  });

  it("vends a token with the machine nonce and repository owner", async () => {
    const orchestrator = fakeFetch({ [VEND]: { json: { token: "fresh-token", expires_at: "2026-08-07T01:00:00Z" } } });

    const token = await refreshRunnerGithubToken({
      currentToken: "boot-token",
      orchestratorUrl: "https://orchestrator.example/",
      machineNonce: "machine-nonce",
      owner: "BuildDownAI",
      fetchImpl: orchestrator.fetch,
    });

    expect(token).toBe("fresh-token");
    expect(orchestrator.calls).toHaveLength(1);
    expect(orchestrator.calls[0].url.href).toBe("https://orchestrator.example/api/token");
    expect(Object.fromEntries(orchestrator.calls[0].headers)).toEqual({ "content-type": "application/json" });
    expect(orchestrator.calls[0].body).toBe(JSON.stringify({ nonce: "machine-nonce", owner: "BuildDownAI" }));
  });

  it("logs the credential source without the token (AII-922)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const orchestrator = fakeFetch({
      [VEND]: { json: { token: "secret-fresh-token" } },
      [PUBLICATION_TOKEN]: { json: { token: "secret-fresh-token" } },
    });
    await refreshRunnerGithubToken({
      currentToken: "boot-token", orchestratorUrl: "https://orchestrator.example",
      machineNonce: "machine-nonce", owner: "BuildDownAI", fetchImpl: orchestrator.fetch,
    });
    await refreshRunnerGithubToken({
      currentToken: "boot-token", callbackUrl: "https://orchestrator.example",
      publicationToken: "one-use", owner: "BuildDownAI", repo: "AI-Implement", fetchImpl: orchestrator.fetch,
    });
    const lines = log.mock.calls.map((c) => c.join(" "));
    log.mockRestore();
    expect(lines.some((l) => l.includes("(source: machine-nonce)"))).toBe(true);
    expect(lines.some((l) => l.includes("(source: publication-token)"))).toBe(true);
    expect(lines.join("\n")).not.toMatch(/secret-fresh-token|one-use/);
  });

  it("keeps the boot token when vending is unavailable", async () => {
    const orchestrator = fakeFetch({ [VEND]: connectionRefused });

    await expect(refreshRunnerGithubToken({
      currentToken: "boot-token",
      orchestratorUrl: "https://orchestrator.example",
      machineNonce: "machine-nonce",
      owner: "BuildDownAI",
      fetchImpl: orchestrator.fetch,
    })).resolves.toBe("boot-token");
  });

  it("reapplies the previous token to the environment and origin when vending is unavailable", async () => {
    const orchestrator = fakeFetch({ [VEND]: connectionRefused });
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
      fetchImpl: orchestrator.fetch,
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
    const orchestrator = fakeFetch({ [VEND]: { status: 403 } });

    await expect(refreshRunnerGithubToken({
      currentToken: "boot-token",
      orchestratorUrl: "https://orchestrator.example",
      machineNonce: "invalid-nonce",
      owner: "BuildDownAI",
      fetchImpl: orchestrator.fetch,
    })).resolves.toBe("boot-token");
  });

  it("rejects vending failures in strict mode", async () => {
    const orchestrator = fakeFetch({ [VEND]: { status: 403 } });

    await expect(refreshRunnerGithubToken({
      currentToken: "boot-token",
      orchestratorUrl: "https://orchestrator.example",
      machineNonce: "invalid-nonce",
      owner: "BuildDownAI",
      fetchImpl: orchestrator.fetch,
      strict: true,
    })).rejects.toThrow(/rejected with HTTP 403/);
  });

  it("still rejects unexpected client errors in automated mode", async () => {
    const orchestrator = fakeFetch({ [VEND]: { status: 400 } });

    await expect(refreshRunnerGithubToken({
      currentToken: "boot-token",
      orchestratorUrl: "https://orchestrator.example",
      machineNonce: "machine-nonce",
      owner: "BuildDownAI",
      fetchImpl: orchestrator.fetch,
    })).rejects.toThrow(/rejected with HTTP 400/);
  });

  it("does not call the orchestrator without both URL and nonce", async () => {
    const orchestrator = fakeFetch({});

    await expect(refreshRunnerGithubToken({
      currentToken: "workflow-token",
      owner: "BuildDownAI",
      fetchImpl: orchestrator.fetch,
    })).resolves.toBe("workflow-token");
    expect(orchestrator.calls).toHaveLength(0);
  });

  it("vends through the dedicated publication endpoint when no machine nonce exists", async () => {
    const orchestrator = fakeFetch({ [PUBLICATION_TOKEN]: { json: { token: "fresh-publication-token", expires_at: "2030-01-01T00:00:00Z" } } });

    const token = await refreshRunnerGithubToken({
      currentToken: "workflow-token",
      callbackUrl: "https://orchestrator.example/",
      publicationToken: "one-use-runner-token",
      owner: "BuildDownAI",
      fetchImpl: orchestrator.fetch,
    });

    expect(token).toBe("fresh-publication-token");
    expect(orchestrator.calls).toHaveLength(1);
    expect(orchestrator.calls[0].url.href).toBe("https://orchestrator.example/api/runner/publication-token");
    expect(Object.fromEntries(orchestrator.calls[0].headers)).toEqual({ authorization: "Bearer one-use-runner-token" });
  });

  it("fails closed when the publication credential is rejected", async () => {
    const orchestrator = fakeFetch({ [PUBLICATION_TOKEN]: { status: 403 } });

    await expect(refreshRunnerGithubCredentials({
      currentToken: "workflow-token",
      callbackUrl: "https://orchestrator.example",
      publicationToken: "rejected-publication-token",
      owner: "BuildDownAI",
      repo: "AI-Implement",
      workspaceDir: "/workspace",
      fetchImpl: orchestrator.fetch,
    })).rejects.toThrow(/rejected with HTTP 403/);

    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("fails closed when the publication credential exchange cannot reach the orchestrator", async () => {
    const orchestrator = fakeFetch({ [PUBLICATION_TOKEN]: connectionRefused });
    vi.stubEnv("GITHUB_TOKEN", "workflow-token");
    vi.stubEnv("GH_TOKEN", "workflow-token");

    await expect(refreshRunnerGithubCredentials({
      currentToken: "workflow-token",
      callbackUrl: "https://orchestrator.example",
      publicationToken: "one-use-publication-token",
      owner: "BuildDownAI",
      repo: "AI-Implement",
      workspaceDir: "/workspace",
      fetchImpl: orchestrator.fetch,
    })).rejects.toThrow(/Token refresh unavailable \(connection refused\)/);

    expect(process.env.GITHUB_TOKEN).toBe("workflow-token");
    expect(process.env.GH_TOKEN).toBe("workflow-token");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("fails closed when the publication credential exchange returns invalid JSON", async () => {
    const orchestrator = fakeFetch({ [PUBLICATION_TOKEN]: { text: "{ not json" } });
    vi.stubEnv("GITHUB_TOKEN", "workflow-token");
    vi.stubEnv("GH_TOKEN", "workflow-token");

    await expect(refreshRunnerGithubCredentials({
      currentToken: "workflow-token",
      callbackUrl: "https://orchestrator.example",
      publicationToken: "one-use-publication-token",
      owner: "BuildDownAI",
      repo: "AI-Implement",
      workspaceDir: "/workspace",
      fetchImpl: orchestrator.fetch,
    })).rejects.toThrow(/Token refresh returned invalid JSON \(.+\)/);

    expect(process.env.GITHUB_TOKEN).toBe("workflow-token");
    expect(process.env.GH_TOKEN).toBe("workflow-token");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("fails closed when the publication credential exchange returns no token", async () => {
    const orchestrator = fakeFetch({ [PUBLICATION_TOKEN]: { json: {} } });
    vi.stubEnv("GITHUB_TOKEN", "workflow-token");
    vi.stubEnv("GH_TOKEN", "workflow-token");

    await expect(refreshRunnerGithubCredentials({
      currentToken: "workflow-token",
      callbackUrl: "https://orchestrator.example",
      publicationToken: "one-use-publication-token",
      owner: "BuildDownAI",
      repo: "AI-Implement",
      workspaceDir: "/workspace",
      fetchImpl: orchestrator.fetch,
    })).rejects.toThrow(/Token refresh returned no token/);

    expect(process.env.GITHUB_TOKEN).toBe("workflow-token");
    expect(process.env.GH_TOKEN).toBe("workflow-token");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("fails closed when the publication credential exchange returns an empty token", async () => {
    const orchestrator = fakeFetch({ [PUBLICATION_TOKEN]: { json: { token: "" } } });
    vi.stubEnv("GITHUB_TOKEN", "workflow-token");
    vi.stubEnv("GH_TOKEN", "workflow-token");

    await expect(refreshRunnerGithubCredentials({
      currentToken: "workflow-token",
      callbackUrl: "https://orchestrator.example",
      publicationToken: "one-use-publication-token",
      owner: "BuildDownAI",
      repo: "AI-Implement",
      workspaceDir: "/workspace",
      fetchImpl: orchestrator.fetch,
    })).rejects.toThrow(/Token refresh returned no token/);

    expect(process.env.GITHUB_TOKEN).toBe("workflow-token");
    expect(process.env.GH_TOKEN).toBe("workflow-token");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("prefers the machine nonce path when both credential mechanisms are present", async () => {
    // No publication-token route: a request there would fail the test.
    const orchestrator = fakeFetch({ [VEND]: { json: { token: "fresh-machine-token" } } });

    await refreshRunnerGithubToken({
      currentToken: "boot-token",
      orchestratorUrl: "https://orchestrator.example",
      machineNonce: "machine-nonce",
      callbackUrl: "https://callback.example",
      publicationToken: "publication-token",
      owner: "BuildDownAI",
      fetchImpl: orchestrator.fetch,
    });

    expect(orchestrator.calls).toHaveLength(1);
    expect(orchestrator.calls[0].url.href).toBe("https://orchestrator.example/api/token");
  });

  it("removes RUN_PUBLICATION_TOKEN after a successful credential exchange", async () => {
    const orchestrator = fakeFetch({ [PUBLICATION_TOKEN]: { json: { token: "fresh-token" } } });
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
      fetchImpl: orchestrator.fetch,
    });

    expect(process.env.RUN_PUBLICATION_TOKEN).toBeUndefined();
    expect(process.env.GITHUB_TOKEN).toBe("fresh-token");
    expect(process.env.GH_TOKEN).toBe("fresh-token");
  });
});

describe("refreshRunnerGithubToken — fail-closed retry (publication exchange)", () => {
  const publicationInputs = {
    currentToken: "boot-token",
    callbackUrl: "https://orchestrator.example",
    publicationToken: "one-use",
    owner: "acme",
  };

  it("retries a transport failure and succeeds on a later attempt", async () => {
    const orchestrator = fakeFetch({
      [PUBLICATION_TOKEN]: [
        () => {
          throw new Error("connect ETIMEDOUT");
        },
        { json: { token: "fresh" } },
      ],
    });

    const token = await refreshRunnerGithubToken({ ...publicationInputs, fetchImpl: orchestrator.fetch });

    expect(token).toBe("fresh");
    expect(orchestrator.calls).toHaveLength(2);
  });

  it("retries a 502 (the request may never have reached the orchestrator)", async () => {
    const orchestrator = fakeFetch({ [PUBLICATION_TOKEN]: [{ status: 502 }, { json: { token: "fresh" } }] });

    const token = await refreshRunnerGithubToken({ ...publicationInputs, fetchImpl: orchestrator.fetch });

    expect(token).toBe("fresh");
    expect(orchestrator.calls).toHaveLength(2);
  });

  it("throws after exhausting the bounded retries", async () => {
    const orchestrator = fakeFetch({ [PUBLICATION_TOKEN]: connectionRefused });

    await expect(refreshRunnerGithubToken({ ...publicationInputs, fetchImpl: orchestrator.fetch }))
      .rejects.toThrow(/Token refresh unavailable/);
    expect(orchestrator.calls).toHaveLength(3); // initial + [250, 1000]ms backoff attempts
  });

  it("never retries a 403 — the single-use credential is consumed before the mint", async () => {
    const orchestrator = fakeFetch({ [PUBLICATION_TOKEN]: { status: 403 } });

    await expect(refreshRunnerGithubToken({ ...publicationInputs, fetchImpl: orchestrator.fetch }))
      .rejects.toThrow(/HTTP 403/);
    expect(orchestrator.calls).toHaveLength(1);
  });

  it("keeps the machine-nonce path single-attempt (best-effort fallback exists)", async () => {
    const orchestrator = fakeFetch({ [VEND]: connectionRefused });

    const token = await refreshRunnerGithubToken({
      currentToken: "boot-token",
      orchestratorUrl: "https://orchestrator.example",
      machineNonce: "nonce",
      owner: "acme",
      fetchImpl: orchestrator.fetch,
    });

    expect(token).toBe("boot-token");
    expect(orchestrator.calls).toHaveLength(1);
  });
});
