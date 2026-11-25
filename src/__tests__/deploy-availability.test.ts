import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DeployAvailabilityModule from "../deploy-availability.js";
import type * as GithubAppAuthModule from "../github-app-auth.js";
import type * as GithubModule from "../github.js";
import { GitHubApiError } from "../github-errors.js";
import { fakeFetch, hangUntilAborted, stubAbortTimeout } from "./helpers/fake-fetch.js";

// Both dependencies exist only to reach GitHub; what matters here is what they
// return, so each is replaced by a spy exposing the functions we call.
vi.mock("../github-app-auth.js", () => ({ mintSourceTokenOrJwt: vi.fn() }));
vi.mock("../github.js", async (importOriginal) => ({
  getRefSha: vi.fn(),
  compareCommits: vi.fn(),
  defaultFetchSignal: vi.fn(() => AbortSignal.timeout(60_000)),
  // Pure, so the status read keeps its real headers.
  srcHeaders: (await importOriginal<typeof GithubModule>()).srcHeaders,
}));

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

  it("bounds the whole read, token and manifest, by one 10-second budget", async () => {
    const timeout = stubAbortTimeout(10_000);
    const ghcr = fakeFetch({ [TOKEN]: { json: { token: "anonymous-token" } }, [MANIFEST]: hangUntilAborted });

    await expect(availability.anonymousImageReadable(IMAGE, ghcr.fetch)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeout).toHaveBeenCalledOnce();
    expect(ghcr.calls[1].signal).toBe(ghcr.calls[0].signal);
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

  it("reads the status of the copy it would deploy: the public GHCR copy's, or a control-plane machine's Fly copy's", async () => {
    const ghcr = reads(true, true);
    await availability.publishedImageReadiness(GHCR, ghcr);
    expect(ghcr.published).toHaveBeenCalledExactlyOnceWith("orchestrator-image/public");

    const fly = reads(true, true);
    await availability.publishedImageReadiness("registry.fly.io/owned-images:testing-2222222", fly);
    expect(fly.published).toHaveBeenCalledExactlyOnceWith("orchestrator-image/published");
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

describe("availableHeadDeployable", () => {
  const target: DeployAvailabilityModule.SelfDeployTarget = { owner: "BuildDownAI", repo: "AI-Implement", branch: "testing", runningCommit: RUNNING };
  // The record refreshAvailability writes when the watched branch has moved past the running commit.
  const moved: DeployAvailabilityModule.DeploymentAvailability = { available: true, runningCommit: RUNNING, headCommit: HEAD, checkedAt: 1_700_000_000_000, isDowngrade: false };
  const IMAGE = "ghcr.io/builddownai/ai-implement-orchestrator:testing-2222222";
  const reads = (published: boolean, readable = true) => ({
    published: vi.fn(async (_commit: string) => published),
    readable: vi.fn(async (_image: string) => readable),
  });
  type Input = Parameters<typeof DeployAvailabilityModule.availableHeadDeployable>[0];
  const check = (over: Partial<Input> = {}) =>
    availability.availableHeadDeployable({ availability: moved, target, kgSourceRepo: null, imageApp: undefined, reads: reads(true), ...over });

  it("waits on the published path until the head's publication status is success", async () => {
    const r = reads(false);

    expect(await check({ reads: r })).toBe(false);
    expect(r.published).toHaveBeenCalledExactlyOnceWith(HEAD, "orchestrator-image/public");
    expect(r.readable).not.toHaveBeenCalled();
  });

  it("then waits until the public image can be pulled anonymously", async () => {
    const r = reads(true, false);

    expect(await check({ reads: r })).toBe(false);
    expect(r.readable).toHaveBeenCalledExactlyOnceWith(IMAGE);
    expect(availability.getPublishedImageReadiness(target, HEAD, undefined)).toBe("not-pullable");
  });

  it("is deployable once both hold", async () => {
    expect(await check()).toBe(true);
    expect(availability.getPublishedImageReadiness(target, HEAD, undefined)).toBe("ready");
  });

  it("judges a control-plane machine's Fly image by its status alone", async () => {
    const r = reads(true, false);

    expect(await check({ imageApp: "owned-images", reads: r })).toBe(true);
    expect(r.readable).not.toHaveBeenCalled();
  });

  it("gates nothing on the built path, which needs no publication", async () => {
    const r = reads(false);

    expect(await check({ kgSourceRepo: "BuildDownAI/knowledge-graph", reads: r })).toBe(true);
    expect(r.published).not.toHaveBeenCalled();
    expect(availability.getPublishedImageReadiness(target, HEAD, undefined)).toBeNull();
  });

  it.each([
    ["the head is the running commit", { ...moved, available: false, headCommit: RUNNING }],
    ["availability is unknown", { ...moved, available: null, runningCommit: null, isDowngrade: null }],
    ["nothing was refreshed yet", null],
  ] as const)("reads nothing when %s, since there is no new deployment to gate", async (_label, record) => {
    const r = reads(false);

    expect(await check({ availability: record, reads: r })).toBe(true);
    expect(r.published).not.toHaveBeenCalled();
  });

  it("reads a waiting image again on each call, and remembers a ready one for its commit", async () => {
    expect(await check({ reads: reads(false) })).toBe(false);
    const second = reads(true);
    expect(await check({ reads: second })).toBe(true);
    expect(second.published).toHaveBeenCalledOnce();
    const third = reads(false);
    expect(await check({ reads: third })).toBe(true);
    expect(third.published).not.toHaveBeenCalled();
  });

  it("reads again once the head moves past the commit it remembers", async () => {
    expect(await check()).toBe(true);
    const next = "3333333333333333333333333333333333333333";
    const r = reads(false);

    expect(await check({ availability: { ...moved, headCommit: next }, reads: r })).toBe(false);
    expect(r.published).toHaveBeenCalledExactlyOnceWith(next, "orchestrator-image/public");
    expect(availability.getPublishedImageReadiness(target, HEAD, undefined)).toBeNull();
    expect(availability.getPublishedImageReadiness(target, next, undefined)).toBe("not-published");
  });

  it("reads another repository's own status at the same commit, rather than reusing the first one's ready image", async () => {
    expect(await check()).toBe(true);
    // A watched source moved to another repository of the same owner names the same GHCR image, but its own status.
    const mirror = { ...target, repo: "AI-Implement-mirror" };
    const r = reads(false);

    expect(await check({ target: mirror, reads: r })).toBe(false);
    expect(r.published).toHaveBeenCalledExactlyOnceWith(HEAD, "orchestrator-image/public");
  });

  it("answers the status route only for the repository, commit and image the poll read", async () => {
    expect(await check()).toBe(true);

    expect(availability.getPublishedImageReadiness(target, HEAD, undefined)).toBe("ready");
    expect(availability.getPublishedImageReadiness({ ...target, branch: "main" }, HEAD, undefined)).toBeNull();
    expect(availability.getPublishedImageReadiness({ ...target, repo: "AI-Implement-mirror" }, HEAD, undefined)).toBeNull();
    expect(availability.getPublishedImageReadiness(target, HEAD, "owned-images")).toBeNull();
  });

  // The real status read, as the poll calls it.
  const statusRead = (commit: string, context: string) => availability.githubImagePublished("app-1", "private-key", target, commit, context);
  const STATUSES = `GET /repos/BuildDownAI/AI-Implement/commits/${HEAD}/statuses`;

  it("records a status read GitHub refuses as unreadable instead of failing the poll, and reads it again next time", async () => {
    // An installation without Commit statuses: the mint refuses before any read, as intersectPermissions does.
    vi.mocked(githubAppAuth.mintSourceTokenOrJwt).mockRejectedValueOnce(new GitHubApiError({
      status: 403,
      path: "/app/installations/1/access_tokens",
      message: 'GitHub App installation for owner "BuildDownAI" grants none of the requested permissions: statuses: read',
    }));
    const readable = vi.fn(async (_image: string) => true);

    expect(await check({ reads: { published: statusRead, readable } })).toBe(false);
    expect(availability.getPublishedImageReadiness(target, HEAD, undefined)).toBe("status-unreadable");
    expect(readable).not.toHaveBeenCalled();

    fakeFetch({ [STATUSES]: { json: [{ context: "orchestrator-image/public", state: "success" }] } }).install();
    expect(await check({ reads: { published: statusRead, readable } })).toBe(true);
  });

  it("still fails the poll on any other status read failure, so nothing is recorded for the commit", async () => {
    fakeFetch({ [STATUSES]: { status: 502 } }).install();

    await expect(check({ reads: { published: statusRead, readable: vi.fn(async () => true) } })).rejects.toThrow("HTTP 502");
    expect(availability.getPublishedImageReadiness(target, HEAD, undefined)).toBeNull();
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
