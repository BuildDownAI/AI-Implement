import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoMapping } from "../config.js";

const startMock = vi.hoisted(() => ({ start: vi.fn() }));

vi.mock("../local-docker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../local-docker.js")>();
  return { ...actual, startLocalRunnerContainer: startMock.start };
});

const { dispatchLocalGapfill } = await import("../local-gapfill.js");

const mapping = {
  owner: "acme",
  repo: "billing",
  workflowFile: "claude-implement.yml",
  defaultBranch: "main",
  provider: "anthropic",
  sessionMode: "autonomous",
  extraEnv: {},
} as unknown as RepoMapping;

function decision(withBootstrap = true) {
  return {
    kind: "launch" as const,
    dispatchId: "d-1",
    projectKey: "TEAM",
    backend: "local-docker" as const,
    snapshot: { v: 1, marker: "snapshot" } as never,
    grant: {} as never,
    takeBootstrap: vi.fn(() => (withBootstrap ? ({ bootstrap: true } as never) : undefined)),
  };
}

function input(extra: Record<string, unknown> = {}) {
  return {
    mapping,
    issue: { id: "i-1", identifier: "AII-1", title: "t" },
    prNumber: 7,
    githubToken: "gh",
    image: "runner:local",
    orchestratorUrl: "http://host.docker.internal:8080",
    runnerCallbackUrl: "http://cb",
    runToken: "run-token",
    retryPolicy: null,
    ...extra,
  };
}

beforeEach(() => {
  startMock.start.mockReset();
  startMock.start.mockResolvedValue({ containerId: "c", containerName: "c" });
});

describe("dispatchLocalGapfill managed input (AII-1392)", () => {
  it("legacy run still requires an Anthropic credential and carries AI_IMPLEMENT_RUN_CONFIG", async () => {
    await expect(dispatchLocalGapfill(input())).rejects.toThrow(/ANTHROPIC_API_KEY/);
    await dispatchLocalGapfill(input({ anthropicApiKey: "k" }));
    const arg = startMock.start.mock.calls[0]![0];
    expect(arg.extraEnv.AI_IMPLEMENT_RUN_CONFIG).toBeTruthy();
    expect(arg.protectedModelAuth).toBeUndefined();
  });

  it("managed run skips the key check, sets agentConfig and passes the protected grant", async () => {
    const d = decision();
    const result = await dispatchLocalGapfill(input({ managed: { decision: d, modelAuthUrl: "http://host.docker.internal:8080" } }));
    const arg = startMock.start.mock.calls[0]![0];
    expect(arg.anthropicApiKey).toBeUndefined();
    expect(arg.claudeOAuthToken).toBeUndefined();
    expect(arg.extraEnv ?? {}).not.toHaveProperty("AI_IMPLEMENT_RUN_CONFIG");
    expect(arg.protectedModelAuth.bootstrap).toEqual({ bootstrap: true });
    expect(arg.protectedModelAuth.projectKey).toBe("TEAM");
    expect(arg.protectedModelAuth.modelAuthUrl).toBe("http://host.docker.internal:8080");
    expect(arg.protectedModelAuth.runConfig.agentConfig).toEqual(d.snapshot);
    expect(arg.protectedModelAuth.runConfig.runnerPhase).toBe("gap-analysis");
    expect(result.runConfig.agentConfig).toEqual(d.snapshot);
  });

  it("a missing bootstrap throws before onBeforeLaunch and before any container starts", async () => {
    const onBeforeLaunch = vi.fn();
    await expect(
      dispatchLocalGapfill(input({ onBeforeLaunch, managed: { decision: decision(false), modelAuthUrl: "http://x" } })),
    ).rejects.toThrow(/bootstrap unavailable/);
    expect(onBeforeLaunch).not.toHaveBeenCalled();
    expect(startMock.start).not.toHaveBeenCalled();
  });

  it("an invalid model-auth URL fails validation before the container start", async () => {
    await expect(
      dispatchLocalGapfill(input({ managed: { decision: decision(), modelAuthUrl: "" } })),
    ).rejects.toThrow(/protected local model auth rejected/);
    expect(startMock.start).not.toHaveBeenCalled();
  });
});
