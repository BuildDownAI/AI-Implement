import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DeployAvailabilityModule from "../deploy-availability.js";
import type * as GithubAppAuthModule from "../github-app-auth.js";
import type * as GithubModule from "../github.js";
import { fakeFetch } from "./helpers/fake-fetch.js";

// Both dependencies exist only to reach GitHub; what matters here is what they
// return, so each is replaced by a spy exposing the functions we call.
vi.mock("../github-app-auth.js", () => ({ mintSourceTokenOrJwt: vi.fn() }));
vi.mock("../github.js", () => ({ getRefSha: vi.fn(), compareCommits: vi.fn(), defaultFetchSignal: vi.fn(() => AbortSignal.timeout(60_000)) }));

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

describe("anonymousImageReadable", () => {
  const IMAGE = "ghcr.io/builddownai/ai-implement-orchestrator:testing-2222222";
  const TOKEN = "GET /token";
  const MANIFEST = "HEAD /v2/builddownai/ai-implement-orchestrator/manifests/testing-2222222";
  // GHCR's answer to an anonymous token request for a private or missing package, as it sends it.
  const DENIED = { status: 403, json: { errors: [{ code: "DENIED", message: "requested access to the resource is denied" }] } };

  it("reads the manifest with an anonymous pull token, as another Fly organization pulls the image", async () => {
    const ghcr = fakeFetch({ [TOKEN]: { json: { token: "anonymous-token" } }, [MANIFEST]: { status: 200 } });

    expect(await availability.anonymousImageReadable(IMAGE, ghcr.fetch)).toBe(true);

    const [token, manifest] = ghcr.calls;
    expect(token.url.searchParams.get("scope")).toBe("repository:builddownai/ai-implement-orchestrator:pull");
    expect(token.headers.has("authorization")).toBe(false);
    expect(manifest.headers.get("authorization")).toBe("Bearer anonymous-token");
    // A push can store an image index or a single manifest, in OCI or Docker media types.
    for (const type of ["application/vnd.oci.image.index.v1+json", "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json", "application/vnd.docker.distribution.manifest.v2+json"]) {
      expect(manifest.headers.get("accept")).toContain(type);
    }
    for (const call of ghcr.calls) expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  it("is false for a tag the public package does not have", async () => {
    const ghcr = fakeFetch({ [TOKEN]: { json: { token: "anonymous-token" } }, [MANIFEST]: { status: 404 } });

    expect(await availability.anonymousImageReadable(IMAGE, ghcr.fetch)).toBe(false);
  });

  it("is false, reading no manifest, when GHCR refuses a token for a private or missing package", async () => {
    const ghcr = fakeFetch({ [TOKEN]: DENIED });

    expect(await availability.anonymousImageReadable(IMAGE, ghcr.fetch)).toBe(false);
    expect(ghcr.calls).toHaveLength(1);
  });

  it.each([[TOKEN, 502], [MANIFEST, 503]] as const)("throws with the status when %s answers %i, so a retry can clear it", async (route, status) => {
    const ghcr = fakeFetch({ [TOKEN]: route === TOKEN ? { status } : { json: { token: "anonymous-token" } }, [MANIFEST]: { status } });

    await expect(availability.anonymousImageReadable(IMAGE, ghcr.fetch)).rejects.toMatchObject({ status });
  });

  it("throws for an image outside GHCR, which no anonymous read can settle", async () => {
    await expect(availability.anonymousImageReadable("registry.fly.io/owned-images:testing-2222222", fakeFetch({}).fetch)).rejects.toThrow("not a GHCR image");
  });
});

describe("publishedImageReadiness", () => {
  const GHCR = "ghcr.io/builddownai/ai-implement-orchestrator:testing-2222222";
  const reads = (published: boolean, readable: boolean) => ({ published: vi.fn(async () => published), readable: vi.fn(async () => readable) });

  it("is not-published, reading no image, when the publication status is not success", async () => {
    const r = reads(false, true);

    expect(await availability.publishedImageReadiness(GHCR, r)).toBe("not-published");
    expect(r.readable).not.toHaveBeenCalled();
  });

  it("is not-pullable when the status is success but the public image cannot be read anonymously", async () => {
    const r = reads(true, false);

    expect(await availability.publishedImageReadiness(GHCR, r)).toBe("not-pullable");
    expect(r.readable).toHaveBeenCalledExactlyOnceWith(GHCR);
  });

  it("is ready when the status is success and the public image reads", async () => {
    expect(await availability.publishedImageReadiness(GHCR, reads(true, true))).toBe("ready");
  });

  it("reads no image on Fly's registry, where a control-plane image app keeps it and no anonymous read applies", async () => {
    const r = reads(true, false);

    expect(await availability.publishedImageReadiness("registry.fly.io/owned-images:testing-2222222", r)).toBe("ready");
    expect(r.readable).not.toHaveBeenCalled();
  });
});

describe("publishedImage", () => {
  it("names the public image in the lowercased owner's GHCR namespace", () => {
    expect(availability.publishedImage("BuildDownAI", "testing", HEAD)).toBe("ghcr.io/builddownai/ai-implement-orchestrator:testing-2222222");
  });

  it("names a control-plane machine's image in its Fly image app", () => {
    expect(availability.publishedImage("BuildDownAI", "main", HEAD, "owned-images")).toBe("registry.fly.io/owned-images:main-2222222");
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

  it("looks up the head of the configured owner, repo and branch via getRefSha (installation path)", async () => {
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

// Mocked tests cannot detect the credential defect class (JWT-vs-null / header presence).
// Live verification: the deploy-refs smoke on the feature branch confirms unauthenticated
// reads succeed for public repos and 401s do not appear.
describe("refreshAvailability — public mode (no App installation)", () => {
  const COMMITS = "GET /repos/BuildDownAI/AI-Implement/commits";

  it("reads the branch head unauthenticated when the App is not installed on the source owner", async () => {
    vi.mocked(githubAppAuth.mintSourceTokenOrJwt).mockResolvedValue({
      token: null,
      authMode: "public",
    });
    const api = fakeFetch({ [COMMITS]: { json: [{ sha: HEAD }] } });
    api.install();

    const state = await availability.refreshAvailability(input());

    // No Authorization header is sent in public mode — this is the load-bearing fix.
    expect(api.calls[0].headers.has("authorization")).toBe(false);
    // getRefSha is bypassed in public mode; the direct fetch above handles the lookup.
    expect(github.getRefSha).not.toHaveBeenCalled();
    expect(state.available).toBe(true);
    expect(state.headCommit).toBe(HEAD);
  });

  it("reports unknown availability when a private repo returns 404 in public mode", async () => {
    // GitHub hides private repos behind 404 on unauthenticated reads.
    vi.mocked(githubAppAuth.mintSourceTokenOrJwt).mockResolvedValue({
      token: null,
      authMode: "public",
    });
    fakeFetch({ [COMMITS]: { status: 404 } }).install();

    const state = await availability.refreshAvailability(input());

    expect(state.available).toBeNull();
    expect(state.headCommit).toBeNull();
  });

  it("propagates non-404 mint errors without falling back", async () => {
    vi.mocked(githubAppAuth.mintSourceTokenOrJwt).mockRejectedValue(new Error("GitHub 500"));

    await expect(availability.refreshAvailability(input())).rejects.toThrow("GitHub 500");
    expect(availability.getAvailability()).toBeNull();
  });

  it("sends no If-None-Match on the first poll (no prior ETag)", async () => {
    vi.mocked(githubAppAuth.mintSourceTokenOrJwt).mockResolvedValue({
      token: null,
      authMode: "public",
    });
    const api = fakeFetch({ [COMMITS]: { json: [{ sha: HEAD }] } });
    api.install();

    await availability.refreshAvailability(input());

    expect(api.calls[0].headers.has("if-none-match")).toBe(false);
  });

  it("stores the ETag from the first poll and sends If-None-Match on the second; 304 reuses the cached SHA", async () => {
    vi.mocked(githubAppAuth.mintSourceTokenOrJwt).mockResolvedValue({
      token: null,
      authMode: "public",
    });
    const api = fakeFetch({ [COMMITS]: [{ json: [{ sha: HEAD }], headers: { ETag: '"v1"' } }, { status: 304 }] });
    api.install();

    // First poll — fetches branch head and stores ETag.
    const state1 = await availability.refreshAvailability(input());
    expect(state1.headCommit).toBe(HEAD);

    // Second poll — sends If-None-Match; 304 response reuses the cached SHA.
    const state2 = await availability.refreshAvailability(input());
    expect(api.calls[1].headers.get("if-none-match")).toBe('"v1"');
    expect(state2.headCommit).toBe(HEAD);
    expect(state2.available).toBe(true);
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
