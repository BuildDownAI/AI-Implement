import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DeployAvailabilityModule from "../deploy-availability.js";
import type * as GithubAppAuthModule from "../github-app-auth.js";
import type * as GithubModule from "../github.js";

// Both dependencies exist only to reach GitHub; what matters here is what they
// return, so each is replaced by a spy exposing the functions we call.
vi.mock("../github-app-auth.js", () => ({ mintSourceTokenOrJwt: vi.fn() }));
vi.mock("../github.js", () => ({ getRefSha: vi.fn(), compareCommits: vi.fn() }));

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
  vi.mocked(githubAppAuth.mintSourceTokenOrJwt).mockResolvedValue({
    token: "installation-token",
    authMode: "installation",
  });
  vi.mocked(github.compareCommits).mockResolvedValue({ behindBy: 0 });
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

describe("resolveDeployTarget", () => {
  const stamped: DeployAvailabilityModule.SelfDeployTarget = {
    owner: "A",
    repo: "B",
    branch: "testing",
    runningCommit: RUNNING,
  };

  it("returns the override target when both watchedRepo and watchedRef are set", () => {
    const result = availability.resolveDeployTarget(stamped, { watchedRepo: "C/D", watchedRef: "v2" });
    expect(result).toEqual({ owner: "C", repo: "D", branch: "v2", runningCommit: RUNNING });
  });

  it("returns the stamped target when both override fields are null", () => {
    expect(availability.resolveDeployTarget(stamped, { watchedRepo: null, watchedRef: null })).toBe(stamped);
  });

  it("returns a target with null runningCommit when stamped is null but override is set", () => {
    const result = availability.resolveDeployTarget(null, { watchedRepo: "C/D", watchedRef: "v2" });
    expect(result).toEqual({ owner: "C", repo: "D", branch: "v2", runningCommit: null });
  });

  it("falls through to stamps when watchedRepo is malformed (no slash)", () => {
    expect(availability.resolveDeployTarget(stamped, { watchedRepo: "noslash", watchedRef: "main" })).toBe(stamped);
  });

  it("falls through to stamps when only watchedRepo is set", () => {
    expect(availability.resolveDeployTarget(stamped, { watchedRepo: "C/D", watchedRef: null })).toBe(stamped);
  });

  it("falls through to stamps when only watchedRef is set", () => {
    expect(availability.resolveDeployTarget(stamped, { watchedRepo: null, watchedRef: "main" })).toBe(stamped);
  });

  it("returns null when stamped is null and no override is set", () => {
    expect(availability.resolveDeployTarget(null, { watchedRepo: null, watchedRef: null })).toBeNull();
  });
});

describe("refreshAvailability", () => {
  it("reports an available deployment when the branch has moved", async () => {
    vi.mocked(github.getRefSha).mockResolvedValue(HEAD);

    const state = await availability.refreshAvailability(input());

    expect(state).toMatchObject({ available: true, runningCommit: RUNNING, headCommit: HEAD });
  });

  it("requests a token scoped to the one repository it reads", async () => {
    // This runs on every poll cycle — the option shape must stay narrow (one repo, one permission).
    vi.mocked(github.getRefSha).mockResolvedValue(HEAD);

    await availability.refreshAvailability(input());

    expect(githubAppAuth.mintSourceTokenOrJwt).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "BuildDownAI",
      { permissions: { contents: "read" }, repositories: ["AI-Implement"] },
    );
  });

  it("reports up to date when the running commit is the branch head", async () => {
    vi.mocked(github.getRefSha).mockResolvedValue(RUNNING);

    expect((await availability.refreshAvailability(input())).available).toBe(false);
  });

  it("reports unknown rather than up to date when the branch is missing", async () => {
    // getRefSha resolves null on a 404 — a deleted or renamed branch.
    vi.mocked(github.getRefSha).mockResolvedValue(null);

    const state = await availability.refreshAvailability(input());

    expect(state.available).toBeNull();
    expect(state.headCommit).toBeNull();
  });

  it("reports unknown when the image carries no source commit", async () => {
    vi.mocked(github.getRefSha).mockResolvedValue(HEAD);

    const state = await availability.refreshAvailability(input({ runningCommit: null }));

    expect(state.available).toBeNull();
  });

  it("looks up the head of the configured owner, repo and branch", async () => {
    vi.mocked(github.getRefSha).mockResolvedValue(HEAD);

    await availability.refreshAvailability(input());

    expect(github.getRefSha).toHaveBeenCalledWith(
      "installation-token",
      "BuildDownAI",
      "AI-Implement",
      "testing",
    );
  });

  it("sets isDowngrade true when the selected ref is behind the running commit", async () => {
    vi.mocked(github.getRefSha).mockResolvedValue(HEAD);
    vi.mocked(github.compareCommits).mockResolvedValue({ behindBy: 3 });

    const state = await availability.refreshAvailability(input());

    expect(state.isDowngrade).toBe(true);
    expect(github.compareCommits).toHaveBeenCalledWith(
      "installation-token",
      "BuildDownAI",
      "AI-Implement",
      RUNNING,
      HEAD,
    );
  });

  it("sets isDowngrade false when the selected ref is not behind", async () => {
    vi.mocked(github.getRefSha).mockResolvedValue(HEAD);
    vi.mocked(github.compareCommits).mockResolvedValue({ behindBy: 0 });

    const state = await availability.refreshAvailability(input());

    expect(state.isDowngrade).toBe(false);
  });

  it("sets isDowngrade null when runningCommit is null (compare not called)", async () => {
    vi.mocked(github.getRefSha).mockResolvedValue(HEAD);

    const state = await availability.refreshAvailability(input({ runningCommit: null }));

    expect(state.isDowngrade).toBeNull();
    expect(github.compareCommits).not.toHaveBeenCalled();
  });

  it("sets isDowngrade null when headCommit is null (compare not called)", async () => {
    vi.mocked(github.getRefSha).mockResolvedValue(null);

    const state = await availability.refreshAvailability(input());

    expect(state.isDowngrade).toBeNull();
    expect(github.compareCommits).not.toHaveBeenCalled();
  });

  it("sets isDowngrade null when compareCommits returns null", async () => {
    vi.mocked(github.getRefSha).mockResolvedValue(HEAD);
    vi.mocked(github.compareCommits).mockResolvedValue(null);

    const state = await availability.refreshAvailability(input());

    expect(state.isDowngrade).toBeNull();
  });
});

describe("refreshAvailability — JWT fallback", () => {
  it("uses the JWT token when the App is not installed on the source owner", async () => {
    vi.mocked(githubAppAuth.mintSourceTokenOrJwt).mockResolvedValue({
      token: "jwt-token",
      authMode: "jwt",
    });
    vi.mocked(github.getRefSha).mockResolvedValue(HEAD);

    const state = await availability.refreshAvailability(input());

    expect(github.getRefSha).toHaveBeenCalledWith("jwt-token", "BuildDownAI", "AI-Implement", "testing");
    expect(state.available).toBe(true);
    expect(state.headCommit).toBe(HEAD);
  });

  it("reports unknown availability when a private repo is inaccessible under JWT", async () => {
    // GitHub hides private repos from App JWTs behind a 404; getRefSha maps that to null.
    vi.mocked(githubAppAuth.mintSourceTokenOrJwt).mockResolvedValue({
      token: "jwt-token",
      authMode: "jwt",
    });
    vi.mocked(github.getRefSha).mockResolvedValue(null);

    const state = await availability.refreshAvailability(input());

    expect(state.available).toBeNull();
    expect(state.headCommit).toBeNull();
  });

  it("propagates non-404 mint errors without falling back", async () => {
    vi.mocked(githubAppAuth.mintSourceTokenOrJwt).mockRejectedValue(new Error("GitHub 500"));

    await expect(availability.refreshAvailability(input())).rejects.toThrow("GitHub 500");
    expect(availability.getAvailability()).toBeNull();
  });
});

describe("getAvailability", () => {
  it("is null before the first refresh of the process", () => {
    expect(availability.getAvailability()).toBeNull();
  });

  it("returns the most recent result once refreshed", async () => {
    vi.mocked(github.getRefSha).mockResolvedValue(HEAD);

    const state = await availability.refreshAvailability(input());

    expect(availability.getAvailability()).toEqual(state);
  });

  it("stays null when the lookup throws, and the error reaches the caller", async () => {
    vi.mocked(github.getRefSha).mockRejectedValue(new Error("HTTP 502"));

    await expect(availability.refreshAvailability(input())).rejects.toThrow("HTTP 502");
    expect(availability.getAvailability()).toBeNull();
  });
});
