import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DeployAvailabilityModule from "../deploy-availability.js";
import type * as GithubAppAuthModule from "../github-app-auth.js";
import type * as GithubModule from "../github.js";

// Both dependencies exist only to reach GitHub; what matters here is what they
// return, so each is replaced by a spy exposing the single function we call.
vi.mock("../github-app-auth.js", () => ({ getScopedInstallationToken: vi.fn() }));
vi.mock("../github.js", () => ({ getBranchSha: vi.fn() }));

const RUNNING = "1111111111111111111111111111111111111111";
const HEAD = "2222222222222222222222222222222222222222";

let availability: typeof DeployAvailabilityModule;
let githubAppAuth: typeof GithubAppAuthModule;
let github: typeof GithubModule;

function input(
  overrides: Partial<DeployAvailabilityModule.AvailabilityInput> = {},
): DeployAvailabilityModule.AvailabilityInput {
  return {
    appId: "app-1",
    privateKey: "private-key",
    owner: "BuildDownAI",
    repo: "AI-Implement",
    branch: "testing",
    runningCommit: RUNNING,
    ...overrides,
  };
}

beforeEach(async () => {
  // The module caches the last result in module scope, so every test needs its
  // own copy rather than one shared across the file.
  vi.resetModules();
  githubAppAuth = await import("../github-app-auth.js");
  github = await import("../github.js");
  vi.mocked(githubAppAuth.getScopedInstallationToken).mockResolvedValue({
    token: "installation-token",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  availability = await import("../deploy-availability.js");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("decideAvailability", () => {
  it("is true when the running commit differs from the branch head", () => {
    expect(availability.decideAvailability(RUNNING, HEAD)).toBe(true);
  });

  it("is false when the running commit is the branch head", () => {
    expect(availability.decideAvailability(RUNNING, RUNNING)).toBe(false);
  });

  it("is null, not false, when the running commit is unknown", () => {
    expect(availability.decideAvailability(null, HEAD)).toBeNull();
  });

  it("is null, not false, when the branch head is unknown", () => {
    expect(availability.decideAvailability(RUNNING, null)).toBeNull();
  });
});

describe("readStampedTarget", () => {
  const stamps = {
    AI_IMPLEMENT_SOURCE_COMMIT: RUNNING,
    AI_IMPLEMENT_SOURCE_REPO: "BuildDownAI/AI-Implement",
    AI_IMPLEMENT_SOURCE_BRANCH: "testing",
  };

  it("splits the stamped repo into owner and name", () => {
    expect(availability.readStampedTarget(stamps)).toEqual({
      owner: "BuildDownAI",
      repo: "AI-Implement",
      branch: "testing",
      runningCommit: RUNNING,
    });
  });

  it("is null when the image carries no stamps", () => {
    expect(availability.readStampedTarget({})).toBeNull();
  });

  it("treats the 'unknown' build default as absent", () => {
    expect(
      availability.readStampedTarget({
        AI_IMPLEMENT_SOURCE_COMMIT: "unknown",
        AI_IMPLEMENT_SOURCE_REPO: "unknown",
        AI_IMPLEMENT_SOURCE_BRANCH: "unknown",
      }),
    ).toBeNull();
  });

  it("is null when the stamped repo is not owner/repo", () => {
    expect(
      availability.readStampedTarget({ ...stamps, AI_IMPLEMENT_SOURCE_REPO: "AI-Implement" }),
    ).toBeNull();
  });

  it("keeps the target when only the commit stamp is missing, so availability reads unknown", () => {
    const target = availability.readStampedTarget({
      ...stamps,
      AI_IMPLEMENT_SOURCE_COMMIT: undefined,
    });

    expect(target).toMatchObject({ owner: "BuildDownAI", repo: "AI-Implement", runningCommit: null });
    expect(availability.decideAvailability(target!.runningCommit, HEAD)).toBeNull();
  });
});

describe("refreshAvailability", () => {
  it("reports an available deployment when the branch has moved", async () => {
    vi.mocked(github.getBranchSha).mockResolvedValue(HEAD);

    const state = await availability.refreshAvailability(input());

    expect(state).toMatchObject({ available: true, runningCommit: RUNNING, headCommit: HEAD });
  });

  it("mints a token scoped to the one repository it reads", async () => {
    // This runs on every poll cycle, so the broad installation-wide mint it used to make
    // was the orchestrator's most frequently issued credential and its widest. The option
    // shape also has to match the deploy path's mint exactly — the cache is keyed on
    // (owner, permissions, repositories), so an identical shape means one token serves both.
    vi.mocked(github.getBranchSha).mockResolvedValue(HEAD);

    await availability.refreshAvailability(input());

    expect(githubAppAuth.getScopedInstallationToken).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "BuildDownAI",
      { permissions: { contents: "read" }, repositories: ["AI-Implement"] },
    );
  });

  it("reports up to date when the running commit is the branch head", async () => {
    vi.mocked(github.getBranchSha).mockResolvedValue(RUNNING);

    expect((await availability.refreshAvailability(input())).available).toBe(false);
  });

  it("reports unknown rather than up to date when the branch is missing", async () => {
    // getBranchSha resolves null on a 404 — a deleted or renamed branch.
    vi.mocked(github.getBranchSha).mockResolvedValue(null);

    const state = await availability.refreshAvailability(input());

    expect(state.available).toBeNull();
    expect(state.headCommit).toBeNull();
  });

  it("reports unknown when the image carries no source commit", async () => {
    vi.mocked(github.getBranchSha).mockResolvedValue(HEAD);

    const state = await availability.refreshAvailability(input({ runningCommit: null }));

    expect(state.available).toBeNull();
  });

  it("looks up the head of the configured owner, repo and branch", async () => {
    vi.mocked(github.getBranchSha).mockResolvedValue(HEAD);

    await availability.refreshAvailability(input());

    expect(github.getBranchSha).toHaveBeenCalledWith(
      "installation-token",
      "BuildDownAI",
      "AI-Implement",
      "testing",
    );
  });
});

describe("getAvailability", () => {
  it("is null before the first refresh of the process", () => {
    expect(availability.getAvailability()).toBeNull();
  });

  it("returns the most recent result once refreshed", async () => {
    vi.mocked(github.getBranchSha).mockResolvedValue(HEAD);

    const state = await availability.refreshAvailability(input());

    expect(availability.getAvailability()).toEqual(state);
  });

  it("stays null when the lookup throws, and the error reaches the caller", async () => {
    vi.mocked(github.getBranchSha).mockRejectedValue(new Error("HTTP 502"));

    await expect(availability.refreshAvailability(input())).rejects.toThrow("HTTP 502");
    expect(availability.getAvailability()).toBeNull();
  });
});
