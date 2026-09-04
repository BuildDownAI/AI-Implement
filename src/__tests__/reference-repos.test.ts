import { describe, it, expect } from "vitest";
import { normalizeGitHubRepo, normalizeReferenceRepos } from "../reference-repos.js";

describe("normalizeGitHubRepo", () => {
  it("expands owner/repo shorthand", () => {
    expect(normalizeGitHubRepo("acme/docs", "referenceRepos")).toBe("https://github.com/acme/docs");
  });

  it("passes through an https://github.com URL unchanged", () => {
    expect(normalizeGitHubRepo("https://github.com/acme/docs", "referenceRepos")).toBe(
      "https://github.com/acme/docs",
    );
  });

  it("trims surrounding whitespace before matching", () => {
    expect(normalizeGitHubRepo("  acme/docs  ", "referenceRepos")).toBe("https://github.com/acme/docs");
  });

  it.each([
    ["an SSH remote", "git@github.com:acme/docs.git"],
    ["a non-GitHub host", "https://gitlab.com/acme/docs"],
    ["the www subdomain", "https://www.github.com/acme/docs"],
    ["a plain http URL", "http://github.com/acme/docs"],
    ["an unparseable URL", "https://"],
    ["a bare word", "docs"],
    ["three path segments", "acme/docs/extra"],
    ["a URL embedding a token", "https://x-access-token:ghs_SECRET@github.com/acme/docs"],
    ["a URL embedding a bare username", "https://someone@github.com/acme/docs"],
  ])("rejects %s", (_label, value) => {
    expect(() => normalizeGitHubRepo(value, "referenceRepos")).toThrow(/referenceRepos/);
  });

  it("names the caller's field in the error, so one function serves two settings", () => {
    expect(() => normalizeGitHubRepo("git@github.com:a/b.git", "skillsRepo")).toThrow(/skillsRepo/);
  });

  it("distinguishes an embedded credential from a bad host", () => {
    expect(() => normalizeGitHubRepo("https://user:tok@github.com/acme/docs", "referenceRepos"))
      .toThrow(/must not embed a username or token/);
  });

  // The message reaches an admin API response and the logs behind it.
  it("does not echo the credential back in the error", () => {
    let message = "";
    try {
      normalizeGitHubRepo("https://x-access-token:ghs_SUPERSECRET@github.com/acme/docs", "referenceRepos");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/must not embed/);
    expect(message).not.toContain("ghs_SUPERSECRET");
  });

  // Userinfo precedes the host, so an @ later in the URL is not a credential.
  it("accepts an @ in the path", () => {
    expect(normalizeGitHubRepo("https://github.com/acme/docs@v1", "referenceRepos")).toBe(
      "https://github.com/acme/docs@v1",
    );
  });
});

describe("normalizeReferenceRepos", () => {
  const entry = { repo: "acme/docs", path: "docs-source" };

  it("returns null for absent and for empty, so the column stores one unset value", () => {
    expect(normalizeReferenceRepos(null)).toBeNull();
    expect(normalizeReferenceRepos(undefined)).toBeNull();
    expect(normalizeReferenceRepos([])).toBeNull();
  });

  it("normalizes the repo and keeps the path", () => {
    expect(normalizeReferenceRepos([entry])).toEqual([
      { repo: "https://github.com/acme/docs", path: "docs-source" },
    ]);
  });

  it("omits ref entirely when absent rather than storing undefined", () => {
    const [only] = normalizeReferenceRepos([entry])!;
    expect(only).not.toHaveProperty("ref");
  });

  it("keeps and trims a ref when present", () => {
    expect(normalizeReferenceRepos([{ ...entry, ref: "  v1.1.0  " }])).toEqual([
      { repo: "https://github.com/acme/docs", path: "docs-source", ref: "v1.1.0" },
    ]);
  });

  it("accepts the same repository twice at two paths on two refs", () => {
    const entries = normalizeReferenceRepos([
      { repo: "acme/docs", path: "stable-source", ref: "v1.1.0" },
      { repo: "acme/docs", path: "latest-source", ref: "testing" },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries![0].repo).toBe(entries![1].repo);
  });

  it("preserves declaration order", () => {
    const entries = normalizeReferenceRepos([
      { repo: "acme/a", path: "a" },
      { repo: "acme/b", path: "b" },
      { repo: "acme/c", path: "c" },
    ]);
    expect(entries!.map((e) => e.path)).toEqual(["a", "b", "c"]);
  });

  it.each([
    ["a non-array", { repo: "acme/docs", path: "x" }],
    ["a non-object entry", ["acme/docs"]],
    ["a null entry", [null]],
    ["an array entry", [[]]],
    ["a missing repo", [{ path: "x" }]],
    ["a blank repo", [{ repo: "   ", path: "x" }]],
    ["a missing path", [{ repo: "acme/docs" }]],
    ["a non-string path", [{ repo: "acme/docs", path: 7 }]],
    ["a blank ref", [{ repo: "acme/docs", path: "x", ref: "  " }]],
    ["a non-string ref", [{ repo: "acme/docs", path: "x", ref: 7 }]],
  ])("rejects %s", (_label, value) => {
    expect(() => normalizeReferenceRepos(value)).toThrow();
  });

  it("rejects more than ten entries", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ repo: "acme/docs", path: `p${i}` }));
    expect(() => normalizeReferenceRepos(many)).toThrow(/too many entries \(11\)/);
  });

  it("accepts exactly ten", () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ repo: "acme/docs", path: `p${i}` }));
    expect(normalizeReferenceRepos(ten)).toHaveLength(10);
  });

  it("rejects two entries sharing a path, comparing the normalized form", () => {
    expect(() =>
      normalizeReferenceRepos([
        { repo: "acme/a", path: "shared" },
        { repo: "acme/b", path: "./shared/" },
      ]),
    ).toThrow(/share the path/);
  });
});

describe("normalizeReferenceRepos path rules", () => {
  const withPath = (p: unknown) => () => normalizeReferenceRepos([{ repo: "acme/docs", path: p }]);

  it.each([
    ["an absolute posix path", "/etc/passwd"],
    ["a Windows drive path", "C:\\Windows"],
    ["a parent traversal", "../outside"],
    ["a traversal in the middle", "docs/../../outside"],
    ["a path that normalizes to the workspace root", "docs/.."],
    ["a bare dot", "."],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["the git directory", ".git"],
    ["a path inside the git directory", ".git/hooks"],
    ["a backslash separator", "vendor\\upstream"],
    ["a backslash traversal attempt", "vendor\\..\\..\\etc"],
  ])("rejects %s", (_label, value) => {
    expect(withPath(value)).toThrow();
  });

  // Backslash cannot traverse on the runner, so this is a typo guard rather than a
  // security control — the message should say so.
  it("tells the operator to use forward slashes", () => {
    expect(withPath("vendor\\upstream")).toThrow(/must use forward slashes/);
  });

  it("rejects a path over 256 characters", () => {
    expect(withPath("a".repeat(257))).toThrow(/path too long \(257 chars\)/);
  });

  it("allows a dot-prefixed directory that is not .git", () => {
    const entries = normalizeReferenceRepos([{ repo: "acme/docs", path: ".github-source" }]);
    expect(entries![0].path).toBe(".github-source");
  });

  it("allows a nested path and strips a trailing slash", () => {
    const entries = normalizeReferenceRepos([{ repo: "acme/docs", path: "vendor/upstream/" }]);
    expect(entries![0].path).toBe("vendor/upstream");
  });

  it("collapses a redundant segment rather than rejecting it", () => {
    const entries = normalizeReferenceRepos([{ repo: "acme/docs", path: "vendor/./upstream" }]);
    expect(entries![0].path).toBe("vendor/upstream");
  });
});
