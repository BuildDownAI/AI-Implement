import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubApiError } from "../github-errors.js";

// Mock the github-app-auth boundary so the probe's branching logic is tested in isolation — no real
// GitHub calls, no JWT signing. Each test drives getInstallation / installationIncludesRepo / getAppSlug.
vi.mock("../github-app-auth.js", () => ({
  getInstallation: vi.fn(),
  installationIncludesRepo: vi.fn(),
  getAppSlug: vi.fn(),
}));

import { probeInstallState } from "../github-install-state.js";
import { getInstallation, installationIncludesRepo, getAppSlug } from "../github-app-auth.js";

const PARAMS = { appId: "123", privateKey: "key", owner: "acme", repo: "backend" };
const INSTALL_URL = "https://github.com/apps/ai-implement/installations/new";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("probeInstallState", () => {
  it("app-not-installed: maps a 404 from getInstallation to the install-flow URL", async () => {
    vi.mocked(getInstallation).mockRejectedValueOnce(
      new GitHubApiError({ status: 404, path: "/users/acme/installation", bodyText: "", message: "not installed" }),
    );
    vi.mocked(getAppSlug).mockResolvedValueOnce("ai-implement");

    const result = await probeInstallState(PARAMS);

    expect(result).toEqual({ state: "app-not-installed", installUrl: INSTALL_URL });
    expect(installationIncludesRepo).not.toHaveBeenCalled();
  });

  it("rethrows a non-404 error instead of mislabeling it as not-installed", async () => {
    vi.mocked(getInstallation).mockRejectedValueOnce(
      new GitHubApiError({ status: 401, path: "/orgs/acme/installation", bodyText: "", message: "bad jwt" }),
    );

    await expect(probeInstallState(PARAMS)).rejects.toThrow("bad jwt");
  });

  it("ready: an 'all' install short-circuits without listing repos", async () => {
    vi.mocked(getInstallation).mockResolvedValueOnce({
      token: "ghs_x",
      installationId: 7,
      repositorySelection: "all",
    });

    const result = await probeInstallState(PARAMS);

    expect(result).toEqual({ state: "ready" });
    expect(installationIncludesRepo).not.toHaveBeenCalled(); // "all" never needs the repo-listing call
  });

  it("ready: a 'selected' install that includes the repo", async () => {
    vi.mocked(getInstallation).mockResolvedValueOnce({
      token: "ghs_x",
      installationId: 8,
      repositorySelection: "selected",
    });
    vi.mocked(installationIncludesRepo).mockResolvedValueOnce(true);

    const result = await probeInstallState(PARAMS);

    expect(result).toEqual({ state: "ready" });
    expect(installationIncludesRepo).toHaveBeenCalledWith("ghs_x", "backend");
  });

  it("repo-not-selected: a selected install missing the repo -> the same install-flow URL", async () => {
    vi.mocked(getInstallation).mockResolvedValueOnce({
      token: "ghs_x",
      installationId: 9,
      repositorySelection: "selected",
    });
    vi.mocked(installationIncludesRepo).mockResolvedValueOnce(false);
    vi.mocked(getAppSlug).mockResolvedValueOnce("ai-implement");

    const result = await probeInstallState(PARAMS);

    expect(result).toEqual({ state: "repo-not-selected", installUrl: INSTALL_URL });
  });
});
