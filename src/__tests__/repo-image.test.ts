import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionImage, selectRunnerImageInput, __clearRepoImageCacheForTests } from "../repo-image.js";

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

describe("selectRunnerImageInput", () => {
  it("forwards a per-repo override regardless of whether SESSION_IMAGE is set", () => {
    const resolved = { image: "ghcr.io/acme/my-runner:v3", source: "override" as const };
    expect(selectRunnerImageInput({ resolved, sessionImageExplicit: false })).toBe(
      "ghcr.io/acme/my-runner:v3",
    );
    expect(selectRunnerImageInput({ resolved, sessionImageExplicit: true })).toBe(
      "ghcr.io/acme/my-runner:v3",
    );
  });

  it("forwards the orchestrator default when SESSION_IMAGE is explicitly set", () => {
    const resolved = { image: "ghcr.io/builddownai/ai-implement-runner:next", source: "default" as const };
    expect(selectRunnerImageInput({ resolved, sessionImageExplicit: true })).toBe(
      "ghcr.io/builddownai/ai-implement-runner:next",
    );
  });

  it("forwards nothing when the image is the implicit default (SESSION_IMAGE unset, no override)", () => {
    // Leaving runner_image unset lets the target workflow keep its own resolution
    // (AI_IMPLEMENT_RUNNER_IMAGE repo variable, then the built-in default), so
    // repos that pin via that variable are not silently overridden.
    const resolved = { image: DEFAULT_IMAGE, source: "default" as const };
    expect(selectRunnerImageInput({ resolved, sessionImageExplicit: false })).toBeUndefined();
  });
});
