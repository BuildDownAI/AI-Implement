import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionImage, resolveDefaultRunnerImage, selectRunnerImageInput, resolveRunnerImageForDispatch, resolveKgRefreshSessionImage, resolveChannelCommit, stripImageTag, __clearRepoImageCacheForTests } from "../repo-image.js";

const DEFAULT_IMAGE = "ghcr.io/builddownai/ai-implement-runner:latest";

function mockFetch(
  status: number,
  body: string | null,
): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body ?? "",
    json: async () => (body ? JSON.parse(body) : null),
  });
}

// GitHub contents API returns JSON with base64-encoded `content` for file blobs.
function contentsApiResponse(fileBody: string): string {
  return JSON.stringify({
    type: "file",
    encoding: "base64",
    content: Buffer.from(fileBody, "utf8").toString("base64"),
  });
}

describe("resolveSessionImage", () => {
  beforeEach(() => {
    __clearRepoImageCacheForTests();
  });

  it("returns the override when image.yml has a valid image:", async () => {
    const fetchImpl = mockFetch(200, contentsApiResponse("image: ghcr.io/acme/my-runner:v3\n"));
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    expect(result).toEqual({ image: "ghcr.io/acme/my-runner:v3", source: "override" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns the default when the file is 404", async () => {
    const fetchImpl = mockFetch(404, "Not Found");
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    expect(result).toEqual({ image: DEFAULT_IMAGE, source: "default" });
  });

  it("returns the default when YAML is malformed (no image: key)", async () => {
    const fetchImpl = mockFetch(200, contentsApiResponse("something: else\n"));
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    expect(result).toEqual({ image: DEFAULT_IMAGE, source: "default" });
  });

  it("returns the default when image: value fails validation (whitespace)", async () => {
    const fetchImpl = mockFetch(200, contentsApiResponse("image: not a valid image\n"));
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    expect(result).toEqual({ image: DEFAULT_IMAGE, source: "default" });
  });

  it("returns the default when image: value lacks a tag (no colon)", async () => {
    const fetchImpl = mockFetch(200, contentsApiResponse("image: ghcr.io/acme/runner\n"));
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    expect(result).toEqual({ image: DEFAULT_IMAGE, source: "default" });
  });

  it("accepts digest references (@sha256:...)", async () => {
    const digestRef =
      "ghcr.io/acme/my-runner@sha256:deadbeefcafebabe0000000000000000000000000000000000000000000000ab";
    const fetchImpl = mockFetch(200, contentsApiResponse(`image: ${digestRef}\n`));
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    expect(result).toEqual({ image: digestRef, source: "override" });
  });

  it("ignores other keys in the YAML", async () => {
    const fetchImpl = mockFetch(
      200,
      contentsApiResponse("image: ghcr.io/acme/my-runner:v3\napt: [terraform]\nfuture_knob: 42\n"),
    );
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    expect(result).toEqual({ image: "ghcr.io/acme/my-runner:v3", source: "override" });
  });

  it("caches results for 60 seconds per owner/repo", async () => {
    const fetchImpl = mockFetch(200, contentsApiResponse("image: ghcr.io/acme/my-runner:v3\n"));
    await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not cache 404s forever — negative result is also cached for TTL but returns default", async () => {
    const fetchImpl = mockFetch(404, "Not Found");
    const a = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    const b = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    expect(a).toEqual({ image: DEFAULT_IMAGE, source: "default" });
    expect(b).toEqual({ image: DEFAULT_IMAGE, source: "default" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns the default and does not throw when the API returns 500", async () => {
    const fetchImpl = mockFetch(500, "Internal Server Error");
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
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
    const fetchImpl = mockFetch(200, contentsApiResponse("image: ghcr.io/acme/my-runner:v3\n"));
    const image = await resolveRunnerImageForDispatch({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      runnerImageExplicit: false,
      fetchImpl,
    });
    expect(image).toBe("ghcr.io/acme/my-runner:v3");
  });

  it("forwards the orchestrator default when it is explicitly set (e.g. testing pinned to :next)", async () => {
    const fetchImpl = mockFetch(404, null); // no per-repo override
    const image = await resolveRunnerImageForDispatch({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: "ghcr.io/builddownai/ai-implement-runner:next",
      runnerImageExplicit: true,
      fetchImpl,
    });
    expect(image).toBe("ghcr.io/builddownai/ai-implement-runner:next");
  });

  it("forwards nothing when neither an override nor an explicit default is set", async () => {
    const fetchImpl = mockFetch(404, null);
    const image = await resolveRunnerImageForDispatch({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      runnerImageExplicit: false,
      fetchImpl,
    });
    expect(image).toBeUndefined();
  });
});

// ── resolveKgRefreshSessionImage ──────────────────────────────────────────────

// Builds a fetch mock that routes by URL substring:
// "api.github.com" → image.yml lookup result
// "ghcr.io" + "/manifests/" with no Authorization → 401 challenge
// "ghcr.io" + "/manifests/" with Authorization → manifest check result
// "ghcr.io/token" → token fetch result
function mockKgFetch(opts: {
  imageYml: "override" | "404";
  tagExists: boolean;
}): typeof fetch {
  const challengeHeader =
    'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:builddownai/ai-implement-runner:pull"';
  return vi.fn(async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("api.github.com")) {
      if (opts.imageYml === "override") {
        const content = Buffer.from("image: ghcr.io/acme/custom-runner:v3\n", "utf8").toString("base64");
        return {
          ok: true, status: 200,
          json: async () => ({ type: "file", encoding: "base64", content }),
          text: async () => "",
          headers: { get: () => null },
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "", headers: { get: () => null } } as unknown as Response;
    }
    if (urlStr.includes("ghcr.io/token")) {
      return { ok: true, status: 200, json: async () => ({ token: "anon-token" }), text: async () => "", headers: { get: () => null } } as unknown as Response;
    }
    if (urlStr.includes("/manifests/")) {
      const headers = (init?.headers as Record<string, string>) ?? {};
      if (!headers["Authorization"]) {
        return {
          ok: false, status: 401,
          json: async () => ({}), text: async () => "",
          headers: { get: (k: string) => k === "www-authenticate" ? challengeHeader : null },
        } as unknown as Response;
      }
      const status = opts.tagExists ? 200 : 404;
      return { ok: opts.tagExists, status, json: async () => ({}), text: async () => "", headers: { get: () => null } } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "", headers: { get: () => null } } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("resolveKgRefreshSessionImage", () => {
  beforeEach(() => {
    __clearRepoImageCacheForTests();
  });

  it("returns source-commit-pinned image when stamp is set and tag exists", async () => {
    const fetchImpl = mockKgFetch({ imageYml: "404", tagExists: true });
    const result = await resolveKgRefreshSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      sourceCommit: "abc1234567890",
      fetchImpl,
    });
    expect(result.image).toBe("ghcr.io/builddownai/ai-implement-runner:abc1234567890");
    expect(result.source).toBe("default");
  });

  it("falls back to defaultImage when source-commit tag does not exist in registry", async () => {
    const fetchImpl = mockKgFetch({ imageYml: "404", tagExists: false });
    const result = await resolveKgRefreshSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      sourceCommit: "abc1234567890",
      fetchImpl,
    });
    expect(result.image).toBe(DEFAULT_IMAGE);
    expect(result.source).toBe("default");
  });

  it("falls back to defaultImage when no sourceCommit is provided", async () => {
    const fetchImpl = mockKgFetch({ imageYml: "404", tagExists: false });
    const result = await resolveKgRefreshSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    expect(result.image).toBe(DEFAULT_IMAGE);
    expect(result.source).toBe("default");
    // No registry manifest calls — tag check is skipped without a sourceCommit
    const manifestCalls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([u]: [string]) => String(u).includes("/manifests/"),
    );
    expect(manifestCalls).toHaveLength(0);
  });

  it("returns per-repo image.yml override over source-commit pin", async () => {
    const fetchImpl = mockKgFetch({ imageYml: "override", tagExists: true });
    const result = await resolveKgRefreshSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      sourceCommit: "abc1234567890",
      fetchImpl,
    });
    expect(result.image).toBe("ghcr.io/acme/custom-runner:v3");
    expect(result.source).toBe("override");
    // No registry manifest calls — override short-circuits the check
    const manifestCalls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([u]: [string]) => String(u).includes("/manifests/"),
    );
    expect(manifestCalls).toHaveLength(0);
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

// Builds a controlled fetch mock for the two-round-trip OCI label flow.
// Supports an optional 401 challenge before the manifest, and routes config blob
// fetches separately.
function buildChannelCommitFetch(opts: {
  manifestStatus?: number;
  manifestBody?: object | null;
  configStatus?: number;
  configBody?: object | null;
  useAuthChallenge?: boolean;
}): typeof fetch {
  const {
    manifestStatus = 200,
    manifestBody = {
      config: { digest: "sha256:configdigest" },
    },
    configStatus = 200,
    configBody = {
      config: {
        Labels: { "org.opencontainers.image.revision": "abc1234567890" },
      },
    },
    useAuthChallenge = false,
  } = opts;

  let manifestCallCount = 0;
  return vi.fn(async (url: string, init?: RequestInit) => {
    const urlStr = String(url);

    // Token endpoint
    if (urlStr.includes("ghcr.io/token")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: "test-token" }),
        headers: { get: () => null },
      } as unknown as Response;
    }

    // Manifest endpoint
    if (urlStr.includes("/manifests/")) {
      manifestCallCount++;
      const headers = (init?.headers as Record<string, string>) ?? {};
      if (useAuthChallenge && !headers["Authorization"]) {
        return {
          ok: false,
          status: 401,
          json: async () => ({}),
          headers: {
            get: (k: string) =>
              k === "www-authenticate"
                ? 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:builddownai/ai-implement-runner:pull"'
                : null,
          },
        } as unknown as Response;
      }
      if (manifestStatus !== 200) {
        return { ok: false, status: manifestStatus, json: async () => ({}), headers: { get: () => null } } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => manifestBody ?? {},
        headers: { get: () => null },
      } as unknown as Response;
    }

    // Config blob endpoint
    if (urlStr.includes("/blobs/")) {
      if (configStatus !== 200) {
        return { ok: false, status: configStatus, json: async () => ({}), headers: { get: () => null } } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => configBody ?? {},
        headers: { get: () => null },
      } as unknown as Response;
    }

    return { ok: false, status: 404, json: async () => ({}), headers: { get: () => null } } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("resolveChannelCommit", () => {
  const IMAGE_BASE = "ghcr.io/builddownai/ai-implement-runner";
  const CHANNEL_TAG = "next";

  it("returns SHA from org.opencontainers.image.revision label (happy path)", async () => {
    const fetchImpl = buildChannelCommitFetch({});
    const result = await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, fetchImpl);
    expect(result).toBe("abc1234567890");
  });

  it("falls back to AI_IMPLEMENT_SOURCE_COMMIT label when revision is absent", async () => {
    const fetchImpl = buildChannelCommitFetch({
      configBody: {
        config: { Labels: { AI_IMPLEMENT_SOURCE_COMMIT: "fallbacksha" } },
      },
    });
    const result = await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, fetchImpl);
    expect(result).toBe("fallbacksha");
  });

  it("returns null when both labels are absent", async () => {
    const fetchImpl = buildChannelCommitFetch({
      configBody: { config: { Labels: { unrelated: "value" } } },
    });
    const result = await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, fetchImpl);
    expect(result).toBeNull();
  });

  it("returns null when config has no Labels field", async () => {
    const fetchImpl = buildChannelCommitFetch({
      configBody: { config: {} },
    });
    const result = await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, fetchImpl);
    expect(result).toBeNull();
  });

  it("handles auth challenge: 401 → token fetch → retry manifest with Bearer", async () => {
    const fetchImpl = buildChannelCommitFetch({ useAuthChallenge: true });
    const result = await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, fetchImpl);
    expect(result).toBe("abc1234567890");
    // Should have called: manifest (401), token, manifest (200), config blob = 4 calls
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
  });

  it("returns null when 401 has no www-authenticate realm", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      headers: { get: () => null },
    })) as unknown as typeof fetch;
    const result = await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, fetchImpl);
    expect(result).toBeNull();
  });

  it("returns null on manifest 404", async () => {
    const fetchImpl = buildChannelCommitFetch({ manifestStatus: 404 });
    const result = await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, fetchImpl);
    expect(result).toBeNull();
  });

  it("returns null on network error (fetch throws)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, fetchImpl);
    expect(result).toBeNull();
  });

  it("returns null when manifest JSON has no config digest", async () => {
    const fetchImpl = buildChannelCommitFetch({
      manifestBody: { schemaVersion: 2 },
    });
    const result = await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, fetchImpl);
    expect(result).toBeNull();
  });

  it("returns null on config blob fetch failure", async () => {
    const fetchImpl = buildChannelCommitFetch({ configStatus: 500 });
    const result = await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, fetchImpl);
    expect(result).toBeNull();
  });

  it("returns null when config json() throws (malformed JSON)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/manifests/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ config: { digest: "sha256:xyz" } }),
          headers: { get: () => null },
        } as unknown as Response;
      }
      if (urlStr.includes("/blobs/")) {
        return {
          ok: true,
          status: 200,
          json: async () => { throw new SyntaxError("Unexpected token"); },
          headers: { get: () => null },
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}), headers: { get: () => null } } as unknown as Response;
    }) as unknown as typeof fetch;
    const result = await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, fetchImpl);
    expect(result).toBeNull();
  });

  it("returns null when imageBase has no slash (unparseable ref)", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await resolveChannelCommit("ubuntu", "next", fetchImpl);
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes AbortSignal to every fetch call", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? null);
      return buildChannelCommitFetch({})(url, init);
    }) as unknown as typeof fetch;
    await resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, fetchImpl);
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("returns null when registry hangs and the timeout fires", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }
      });
    }) as unknown as typeof fetch;

    const resultPromise = resolveChannelCommit(IMAGE_BASE, CHANNEL_TAG, fetchImpl, 5_000);
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await resultPromise;
    expect(result).toBeNull();
    vi.useRealTimers();
  });
});
