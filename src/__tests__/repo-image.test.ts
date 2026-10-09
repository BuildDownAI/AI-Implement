import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionImage, resolveDefaultRunnerImage, selectRunnerImageInput, resolveRunnerImageForDispatch, resolveChannelCommit, stripImageTag, __clearRepoImageCacheForTests } from "../repo-image.js";
import { fakeFetch, hangUntilAborted, type FakeFetch, type Reply, type Routes } from "./helpers/fake-fetch.js";

const DEFAULT_IMAGE = "ghcr.io/builddownai/ai-implement-runner:latest";

/** GitHub's contents API answering for acme/widgets' `.ai-implement/image.yml`. */
function imageYml(reply: Reply): FakeFetch {
  return fakeFetch({ "GET /repos/acme/widgets/contents/.ai-implement/image.yml": reply });
}

// GitHub contents API returns JSON with base64-encoded `content` for file blobs.
function contentsApiResponse(fileBody: string): Reply {
  return { json: { type: "file", encoding: "base64", content: Buffer.from(fileBody, "utf8").toString("base64") } };
}

describe("resolveSessionImage", () => {
  beforeEach(() => {
    __clearRepoImageCacheForTests();
  });

  it("returns the override when image.yml has a valid image:", async () => {
    const github = imageYml(contentsApiResponse("image: ghcr.io/acme/my-runner:v3\n"));
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl: github.fetch,
    });
    expect(result).toEqual({ image: "ghcr.io/acme/my-runner:v3", source: "override" });
    expect(github.calls).toHaveLength(1);
  });

  it("returns the default when the file is 404", async () => {
    const github = imageYml({ status: 404, text: "Not Found" });
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl: github.fetch,
    });
    expect(result).toEqual({ image: DEFAULT_IMAGE, source: "default" });
  });

  it("returns the default when YAML is malformed (no image: key)", async () => {
    const github = imageYml(contentsApiResponse("something: else\n"));
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl: github.fetch,
    });
    expect(result).toEqual({ image: DEFAULT_IMAGE, source: "default" });
  });

  it("returns the default when image: value fails validation (whitespace)", async () => {
    const github = imageYml(contentsApiResponse("image: not a valid image\n"));
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl: github.fetch,
    });
    expect(result).toEqual({ image: DEFAULT_IMAGE, source: "default" });
  });

  it("returns the default when image: value lacks a tag (no colon)", async () => {
    const github = imageYml(contentsApiResponse("image: ghcr.io/acme/runner\n"));
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl: github.fetch,
    });
    expect(result).toEqual({ image: DEFAULT_IMAGE, source: "default" });
  });

  it("accepts digest references (@sha256:...)", async () => {
    const digestRef =
      "ghcr.io/acme/my-runner@sha256:deadbeefcafebabe0000000000000000000000000000000000000000000000ab";
    const github = imageYml(contentsApiResponse(`image: ${digestRef}\n`));
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl: github.fetch,
    });
    expect(result).toEqual({ image: digestRef, source: "override" });
  });

  it("ignores other keys in the YAML", async () => {
    const github = imageYml(contentsApiResponse("image: ghcr.io/acme/my-runner:v3\napt: [terraform]\nfuture_knob: 42\n"));
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl: github.fetch,
    });
    expect(result).toEqual({ image: "ghcr.io/acme/my-runner:v3", source: "override" });
  });

  it("caches results for 60 seconds per owner/repo", async () => {
    const github = imageYml(contentsApiResponse("image: ghcr.io/acme/my-runner:v3\n"));
    await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl: github.fetch,
    });
    await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl: github.fetch,
    });
    expect(github.calls).toHaveLength(1);
  });

  it("does not cache 404s forever — negative result is also cached for TTL but returns default", async () => {
    const github = imageYml({ status: 404, text: "Not Found" });
    const a = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl: github.fetch,
    });
    const b = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl: github.fetch,
    });
    expect(a).toEqual({ image: DEFAULT_IMAGE, source: "default" });
    expect(b).toEqual({ image: DEFAULT_IMAGE, source: "default" });
    expect(github.calls).toHaveLength(1);
  });

  it("returns the default and does not throw when the API returns 500", async () => {
    const github = imageYml({ status: 500, text: "Internal Server Error" });
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl: github.fetch,
    });
    expect(result).toEqual({ image: DEFAULT_IMAGE, source: "default" });
  });
});

describe("resolveDefaultRunnerImage", () => {
  it("prefers AI_IMPLEMENT_RUNNER_IMAGE over SESSION_IMAGE and reports SESSION_IMAGE as shadowed", () => {
    const r = resolveDefaultRunnerImage({
      AI_IMPLEMENT_RUNNER_IMAGE: "ghcr.io/acme/ai-implement-runner:v3",
      SESSION_IMAGE: "ghcr.io/old/legacy:latest",
    });
    expect(r.image).toBe("ghcr.io/acme/ai-implement-runner:v3");
    expect(r.sessionImageStatus).toBe("shadowed");
    expect(r.explicit).toBe(true);
  });

  it("falls back to SESSION_IMAGE and reports it active when AI_IMPLEMENT_RUNNER_IMAGE is unset", () => {
    const r = resolveDefaultRunnerImage({ SESSION_IMAGE: "ghcr.io/acme/runner:1" });
    expect(r.image).toBe("ghcr.io/acme/runner:1");
    expect(r.sessionImageStatus).toBe("active");
    expect(r.explicit).toBe(true);
  });

  it("uses AI_IMPLEMENT_RUNNER_IMAGE with no SESSION_IMAGE warning", () => {
    const r = resolveDefaultRunnerImage({ AI_IMPLEMENT_RUNNER_IMAGE: "ghcr.io/acme/runner:2" });
    expect(r.image).toBe("ghcr.io/acme/runner:2");
    expect(r.sessionImageStatus).toBe("unused");
    expect(r.explicit).toBe(true);
  });

  it("falls back to the upstream image when neither is set", () => {
    const r = resolveDefaultRunnerImage({});
    expect(r.image).toBe("ghcr.io/builddownai/ai-implement-runner:latest");
    expect(r.sessionImageStatus).toBe("unused");
    expect(r.explicit).toBe(false);
  });
});

describe("selectRunnerImageInput", () => {
  it("forwards a per-repo override regardless of whether the orchestrator default is explicit", () => {
    const resolved = { image: "ghcr.io/acme/my-runner:v3", source: "override" as const };
    expect(selectRunnerImageInput({ resolved, runnerImageExplicit: false })).toBe(
      "ghcr.io/acme/my-runner:v3",
    );
    expect(selectRunnerImageInput({ resolved, runnerImageExplicit: true })).toBe(
      "ghcr.io/acme/my-runner:v3",
    );
  });

  it("forwards the orchestrator default when a runner image is explicitly set", () => {
    const resolved = { image: "ghcr.io/builddownai/ai-implement-runner:next", source: "default" as const };
    expect(selectRunnerImageInput({ resolved, runnerImageExplicit: true })).toBe(
      "ghcr.io/builddownai/ai-implement-runner:next",
    );
  });

  it("forwards nothing when the image is the implicit default (no explicit env, no override)", () => {
    // Leaving runner_image unset lets the target workflow keep its own resolution
    // (its .ai-implement/image.yml, the AI_IMPLEMENT_RUNNER_IMAGE repo variable, then the
    // built-in default), so repos that pin via that variable are not silently overridden.
    const resolved = { image: DEFAULT_IMAGE, source: "default" as const };
    expect(selectRunnerImageInput({ resolved, runnerImageExplicit: false })).toBeUndefined();
  });
});

describe("resolveRunnerImageForDispatch", () => {
  beforeEach(() => {
    __clearRepoImageCacheForTests();
  });

  it("forwards a per-repo override even when the orchestrator default is implicit", async () => {
    const github = imageYml(contentsApiResponse("image: ghcr.io/acme/my-runner:v3\n"));
    const image = await resolveRunnerImageForDispatch({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      runnerImageExplicit: false,
      fetchImpl: github.fetch,
    });
    expect(image).toBe("ghcr.io/acme/my-runner:v3");
  });

  it("forwards the orchestrator default when it is explicitly set (e.g. testing pinned to :next)", async () => {
    const github = imageYml({ status: 404 }); // no per-repo override
    const image = await resolveRunnerImageForDispatch({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: "ghcr.io/builddownai/ai-implement-runner:next",
      runnerImageExplicit: true,
      fetchImpl: github.fetch,
    });
    expect(image).toBe("ghcr.io/builddownai/ai-implement-runner:next");
  });

  it("forwards nothing when neither an override nor an explicit default is set", async () => {
    const github = imageYml({ status: 404 });
    const image = await resolveRunnerImageForDispatch({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      runnerImageExplicit: false,
      fetchImpl: github.fetch,
    });
    expect(image).toBeUndefined();
  });
});

// ── stripImageTag ─────────────────────────────────────────────────────────────

describe("stripImageTag", () => {
  it("strips a :tag suffix", () => {
    expect(stripImageTag("ghcr.io/builddownai/ai-implement-runner:latest")).toBe(
      "ghcr.io/builddownai/ai-implement-runner",
    );
  });

  it("strips a @digest suffix", () => {
    expect(
      stripImageTag("ghcr.io/acme/runner@sha256:deadbeef"),
    ).toBe("ghcr.io/acme/runner");
  });

  it("returns null for an image without a tag or digest", () => {
    expect(stripImageTag("ghcr.io/acme/runner")).toBeNull();
  });

  it("returns null for a bare image name without a slash", () => {
    expect(stripImageTag("ubuntu:22.04")).toBeNull();
  });
});

// ── resolveChannelCommit ──────────────────────────────────────────────────────

const MANIFEST = "GET /v2/builddownai/ai-implement-runner/manifests/next";
const CONFIG_BLOB = "GET /v2/builddownai/ai-implement-runner/blobs/sha256:configdigest";
const AUTH_CHALLENGE =
  'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:builddownai/ai-implement-runner:pull"';

/** The registry's two-round-trip OCI label flow: the manifest names the config blob, whose labels carry the commit. */
function registry(overrides: Routes = {}): FakeFetch {
  return fakeFetch({
    [MANIFEST]: { json: { config: { digest: "sha256:configdigest" } } },
    [CONFIG_BLOB]: { json: { config: { Labels: { "org.opencontainers.image.revision": "abc1234567890" } } } },
    ...overrides,
  });
}

/** A registry that answers the manifest with a 401 challenge until a bearer token from its token endpoint is sent. */
function challengingRegistry(): FakeFetch {
  return registry({
    [MANIFEST]: ({ headers }) =>
      headers.has("authorization")
        ? { json: { config: { digest: "sha256:configdigest" } } }
        : { status: 401, json: {}, headers: { "www-authenticate": AUTH_CHALLENGE } },
    "GET /token": { json: { token: "test-token" } },
  });
}

describe("resolveChannelCommit", () => {
  const IMAGE_BASE = "ghcr.io/builddownai/ai-implement-runner";
  const CHANNEL_TAG = "next";

  it("returns SHA from org.opencontainers.image.revision label (happy path)", async () => {
    const ghcr = registry();
    const result = await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, ghcr.fetch);
    expect(result).toBe("abc1234567890");
  });

  it("falls back to AI_IMPLEMENT_SOURCE_COMMIT label when revision is absent", async () => {
    const ghcr = registry({ [CONFIG_BLOB]: { json: { config: { Labels: { AI_IMPLEMENT_SOURCE_COMMIT: "fallbacksha" } } } } });
    const result = await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, ghcr.fetch);
    expect(result).toBe("fallbacksha");
  });

  it("returns null when both labels are absent", async () => {
    const ghcr = registry({ [CONFIG_BLOB]: { json: { config: { Labels: { unrelated: "value" } } } } });
    const result = await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, ghcr.fetch);
    expect(result).toBeNull();
  });

  it("returns null when config has no Labels field", async () => {
    const ghcr = registry({ [CONFIG_BLOB]: { json: { config: {} } } });
    const result = await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, ghcr.fetch);
    expect(result).toBeNull();
  });

  it("handles auth challenge: 401 → token fetch → retry manifest with Bearer", async () => {
    const ghcr = challengingRegistry();
    const result = await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, ghcr.fetch);
    expect(result).toBe("abc1234567890");
    // Should have called: manifest (401), token, manifest (200), config blob = 4 calls
    expect(ghcr.calls.map((c) => `${c.method} ${c.path}`)).toEqual([MANIFEST, "GET /token", MANIFEST, CONFIG_BLOB]);
    expect(ghcr.calls[2].headers.get("authorization")).toBe("Bearer test-token");
  });

  it("returns null when 401 has no www-authenticate realm", async () => {
    const ghcr = fakeFetch({ [MANIFEST]: { status: 401, json: {} } });
    const result = await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, ghcr.fetch);
    expect(result).toBeNull();
  });

  it("returns null on manifest 404", async () => {
    const ghcr = registry({ [MANIFEST]: { status: 404, json: {} } });
    const result = await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, ghcr.fetch);
    expect(result).toBeNull();
  });

  it("returns null on network error (fetch throws)", async () => {
    const ghcr = fakeFetch({
      [MANIFEST]: () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const result = await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, ghcr.fetch);
    expect(result).toBeNull();
  });

  it("returns null when manifest JSON has no config digest", async () => {
    const ghcr = registry({ [MANIFEST]: { json: { schemaVersion: 2 } } });
    const result = await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, ghcr.fetch);
    expect(result).toBeNull();
  });

  it("returns null on config blob fetch failure", async () => {
    const ghcr = registry({ [CONFIG_BLOB]: { status: 500, json: {} } });
    const result = await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, ghcr.fetch);
    expect(result).toBeNull();
  });

  it("returns null when config json() throws (malformed JSON)", async () => {
    const ghcr = registry({ [CONFIG_BLOB]: { text: "{ not json" } });
    const result = await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, ghcr.fetch);
    expect(result).toBeNull();
  });

  it("returns null when imageBase has no slash (unparseable ref)", async () => {
    const ghcr = fakeFetch({});
    const result = await resolveChannelCommit("ubuntu", "next", ghcr.fetch);
    expect(result).toBeNull();
    expect(ghcr.calls).toHaveLength(0);
  });

  it("passes AbortSignal to every fetch call", async () => {
    const ghcr = challengingRegistry();
    await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, ghcr.fetch);
    expect(ghcr.calls).toHaveLength(4);
    for (const call of ghcr.calls) {
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("returns null when registry hangs and the timeout fires", async () => {
    vi.useFakeTimers();
    const ghcr = fakeFetch({ [MANIFEST]: hangUntilAborted });

    const resultPromise = resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, ghcr.fetch, 5_000);
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await resultPromise;
    expect(result).toBeNull();
    vi.useRealTimers();
  });
});
