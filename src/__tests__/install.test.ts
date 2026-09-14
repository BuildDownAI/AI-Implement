import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { installStep, parseReviewCheckNamesConfig, parseReviewersConfig } from "../pipeline/steps/install.js";
import { REVIEWER_VERDICT_SCHEMA } from "../pipeline/reviewers/schema.js";

const tempDirs: string[] = [];

function makeWorkspace(prefix = "ai-implement-install-reviewers-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeContext(data: Record<string, unknown> = {}, cloneOutputs: Record<string, unknown> = {}) {
  return { data, getOutputs: (stepId: string) => stepId === "clone" ? cloneOutputs : {} } as never;
}

function reviewerPrompt(reviewer: { buildPrompt(input: { issueIdentifier: string; issueTitle: string; issueDescription: string; prNumber: string; diff: string; previousFindings: string }): string }): string {
  return reviewer.buildPrompt({
    issueIdentifier: "AII-1",
    issueTitle: "Title",
    issueDescription: "Description",
    prNumber: "42",
    diff: "diff",
    previousFindings: "previous",
  });
}

function contentsApiResponse(fileBody: string): Record<string, unknown> {
  return {
    type: "file",
    encoding: "base64",
    content: Buffer.from(fileBody, "utf8").toString("base64"),
  };
}

function mockContentsFetch(status: number, body?: unknown): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async () => new Response(
    body === undefined ? "" : JSON.stringify(body),
    { status },
  ));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("parseReviewCheckNamesConfig", () => {
  it("returns undefined for non-array values", () => {
    expect(parseReviewCheckNamesConfig(undefined)).toBeUndefined();
    expect(parseReviewCheckNamesConfig(null)).toBeUndefined();
    expect(parseReviewCheckNamesConfig("review")).toBeUndefined();
    expect(parseReviewCheckNamesConfig(42)).toBeUndefined();
    expect(parseReviewCheckNamesConfig({ reviewCheckNames: ["review"] })).toBeUndefined();
  });

  it("returns undefined for an empty array", () => {
    expect(parseReviewCheckNamesConfig([])).toBeUndefined();
  });

  it("returns undefined when all entries are blank strings", () => {
    expect(parseReviewCheckNamesConfig(["", "  ", "\t"])).toBeUndefined();
  });

  it("filters out non-string entries", () => {
    expect(parseReviewCheckNamesConfig([42, null, "review", true])).toEqual(["review"]);
  });

  it("trims whitespace from names", () => {
    expect(parseReviewCheckNamesConfig(["  review  ", " my-check "])).toEqual(["review", "my-check"]);
  });

  it("returns the names array for valid string entries", () => {
    expect(parseReviewCheckNamesConfig(["review", "code-review-plugin"])).toEqual(["review", "code-review-plugin"]);
  });

  it("returns undefined when only non-string entries after filtering", () => {
    expect(parseReviewCheckNamesConfig([null, 42, false])).toBeUndefined();
  });
});

describe("parseReviewersConfig", () => {
  it("returns undefined for absent or malformed reviewers config", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseReviewersConfig(undefined)).toBeUndefined();
    expect(parseReviewersConfig("review")).toBeUndefined();
    expect(parseReviewersConfig({ reviewers: [] })).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenNthCalledWith(1, expect.stringContaining("reviewers"));
    expect(warnSpy).toHaveBeenNthCalledWith(2, expect.stringContaining("reviewers"));
  });

  it("builds data-only reviewer definitions with the shared verdict schema", () => {
    const reviewers = parseReviewersConfig([
      { id: " accessibility-review ", model: " claude-sonnet-5 ", prompt: " Review accessibility. ", gates: true },
      { id: "architecture-review", prompt: "Review boundaries." },
    ]);

    expect(reviewers).toHaveLength(2);
    expect(reviewers?.[0]).toEqual({
      id: "accessibility-review",
      model: "claude-sonnet-5",
      buildPrompt: expect.any(Function),
      outputSchema: REVIEWER_VERDICT_SCHEMA,
    });
    expect(reviewerPrompt(reviewers![0]!)).toBe(" Review accessibility. ");
    expect(reviewers?.[1]).toEqual({
      id: "architecture-review",
      buildPrompt: expect.any(Function),
      outputSchema: REVIEWER_VERDICT_SCHEMA,
    });
    expect(Object.keys(reviewers?.[0] ?? {})).not.toContain("gates");
  });

  it("drops malformed reviewer declarations with one warning per dropped entry", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reviewers = parseReviewersConfig([
      { id: "valid-review", prompt: "Review it." },
      { prompt: "missing id" },
      { id: "missing-prompt" },
      42,
      { id: "valid-review", prompt: "duplicate" },
    ]);

    expect(reviewers?.map((reviewer) => reviewer.id)).toEqual(["valid-review"]);
    expect(warnSpy).toHaveBeenCalledTimes(4);
    for (const call of warnSpy.mock.calls) expect(call[0]).toContain("reviewers[");
  });
});

describe("installStep reviewers output", () => {
  it("exposes reviewers from .ai-implement/config.yml without running install when no package.json exists", async () => {
    const workspaceDir = makeWorkspace();
    mkdirSync(join(workspaceDir, ".ai-implement"), { recursive: true });
    writeFileSync(join(workspaceDir, ".ai-implement", "config.yml"), [
      "reviewers:",
      "  - id: domain-review",
      "    model: claude-sonnet-5",
      "    gates: true",
      "    prompt: |",
      "      Review the diff for domain mistakes.",
      "",
    ].join("\n"));

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir },
      {} as never,
    );

    expect(outputs.installMethod).toBe("skipped: no package.json");
    expect(outputs.trustedConfigReviewers).toEqual([]);
    expect(outputs.reviewers?.map((reviewer) => ({
      id: reviewer.id,
      model: reviewer.model,
      prompt: reviewer.buildPrompt({
        issueIdentifier: "AII-1",
        issueTitle: "Title",
        issueDescription: "Description",
        prNumber: "42",
        diff: "diff",
        previousFindings: "",
      }),
      outputSchema: reviewer.outputSchema,
      gates: (reviewer as unknown as { gates?: unknown }).gates,
    }))).toEqual([{
      id: "domain-review",
      model: "claude-sonnet-5",
      prompt: "Review the diff for domain mistakes.\n",
      outputSchema: REVIEWER_VERDICT_SCHEMA,
      gates: undefined,
    }]);
  });

  it("fetches selected gating config reviewers from the trusted default-branch config without a ref", async () => {
    const workspaceDir = makeWorkspace();
    mkdirSync(join(workspaceDir, ".ai-implement"), { recursive: true });
    writeFileSync(join(workspaceDir, ".ai-implement", "config.yml"), [
      "reviewers:",
      "  - id: domain-review",
      "    model: claude-opus-5",
      "    prompt: malicious PR prompt",
      "",
    ].join("\n"));
    const fetchImpl = mockContentsFetch(200, contentsApiResponse([
      "reviewers:",
      "  - id: domain-review",
      "    model: claude-sonnet-5",
      "    prompt: trusted default prompt",
      "  - id: unselected-review",
      "    prompt: should not be fetched into outputs",
      "",
    ].join("\n")));

    const outputs = await installStep.run(
      makeContext({
        githubOwner: "acme",
        githubRepo: "app",
        githubToken: "ghs_secret",
        reviewers: [{ id: "domain-review", gates: true }],
        trustedReviewerDefinitions: new Map(),
      }),
      { workspaceDir, fetchImpl },
      {} as never,
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    const firstCall = fetchImpl.mock.calls[0]!;
    expect(firstCall[0]).toBe("https://api.github.com/repos/acme/app/contents/.ai-implement/config.yml");
    expect(String(firstCall[0])).not.toContain("ref=");
    expect(firstCall[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer ghs_secret" }),
    }));
    expect(reviewerPrompt(outputs.reviewers![0]!)).toBe("malicious PR prompt");
    expect(outputs.trustedConfigReviewers.map((reviewer) => ({ id: reviewer.id, model: reviewer.model }))).toEqual([
      { id: "domain-review", model: "claude-sonnet-5" },
    ]);
    expect(reviewerPrompt(outputs.trustedConfigReviewers[0]!)).toBe("trusted default prompt");
  });

  it("uses the current clone output credential without adding it to install inputs", async () => {
    const workspaceDir = makeWorkspace();
    const fetchImpl = mockContentsFetch(200, contentsApiResponse([
      "reviewers:",
      "  - id: domain-review",
      "    prompt: trusted default prompt",
      "",
    ].join("\n")));

    await installStep.run(
      makeContext({
        githubOwner: "stale-owner",
        githubRepo: "stale-repo",
        githubToken: "",
        reviewers: [{ id: "domain-review", gates: true }],
        trustedReviewerDefinitions: new Map(),
      }, { repoOwner: "acme", repoRepo: "app", githubToken: "fresh-token" }),
      { workspaceDir, fetchImpl },
      {} as never,
    );

    const firstCall = fetchImpl.mock.calls[0]!;
    expect(firstCall[0]).toBe("https://api.github.com/repos/acme/app/contents/.ai-implement/config.yml");
    expect(firstCall[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer fresh-token" }),
    }));
  });

  it("fetches trusted config even when the PR branch deletes the local config entry", async () => {
    const workspaceDir = makeWorkspace();
    const fetchImpl = mockContentsFetch(200, contentsApiResponse([
      "reviewers:",
      "  - id: domain-review",
      "    prompt: trusted default prompt",
      "",
    ].join("\n")));

    const outputs = await installStep.run(
      makeContext({
        githubOwner: "acme",
        githubRepo: "app",
        githubToken: "ghs_secret",
        reviewers: [{ id: "domain-review", gates: true }],
        trustedReviewerDefinitions: new Map(),
      }),
      { workspaceDir, fetchImpl },
      {} as never,
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(outputs.reviewers).toBeUndefined();
    expect(outputs.trustedConfigReviewers.map((reviewer) => reviewer.id)).toEqual(["domain-review"]);
  });

  it("does not fetch trusted config for an actual built-in even without a precomputed trusted map", async () => {
    const workspaceDir = makeWorkspace();
    const fetchImpl = vi.fn();

    const outputs = await installStep.run(
      makeContext({
        githubOwner: "acme",
        githubRepo: "app",
        githubToken: "ghs_secret",
        reviewers: [{ id: "gap-analysis", gates: true }],
      }),
      { workspaceDir, fetchImpl },
      {} as never,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outputs.trustedConfigReviewers).toEqual([]);
  });

  it("does not fetch trusted config for selected built-in, image-baked, external, or advisory-only reviewers", async () => {
    const workspaceDir = makeWorkspace();
    const fetchImpl = vi.fn();

    const outputs = await installStep.run(
      makeContext({
        githubOwner: "acme",
        githubRepo: "app",
        githubToken: "ghs_secret",
        reviewers: [
          { id: "gap-analysis", gates: true },
          { id: "image-review", gates: true },
          { id: "claude-review-summary", gates: true },
          { id: "legacy-post-push-review", gates: true },
          { id: "domain-review", gates: false },
        ],
        trustedReviewerDefinitions: new Map([
          ["gap-analysis", { id: "gap-analysis", buildPrompt: () => "gap", outputSchema: REVIEWER_VERDICT_SCHEMA }],
          ["image-review", { id: "image-review", buildPrompt: () => "image", outputSchema: REVIEWER_VERDICT_SCHEMA }],
        ]),
      }),
      { workspaceDir, fetchImpl },
      {} as never,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outputs.trustedConfigReviewers).toEqual([]);
  });

  it.each([
    ["missing GitHub context", {}, undefined],
    ["transport error", { githubOwner: "acme", githubRepo: "app", githubToken: "ghs_secret" }, vi.fn().mockRejectedValue(new Error("offline"))],
    ["missing default config", { githubOwner: "acme", githubRepo: "app", githubToken: "ghs_secret" }, mockContentsFetch(404)],
    ["HTTP error", { githubOwner: "acme", githubRepo: "app", githubToken: "ghs_secret" }, mockContentsFetch(500)],
    ["null JSON body", { githubOwner: "acme", githubRepo: "app", githubToken: "ghs_secret" }, mockContentsFetch(200, null)],
    ["array JSON body", { githubOwner: "acme", githubRepo: "app", githubToken: "ghs_secret" }, mockContentsFetch(200, [])],
    ["malformed contents response", { githubOwner: "acme", githubRepo: "app", githubToken: "ghs_secret" }, mockContentsFetch(200, { type: "dir", encoding: "base64", content: "" })],
    ["malformed YAML", { githubOwner: "acme", githubRepo: "app", githubToken: "ghs_secret" }, mockContentsFetch(200, contentsApiResponse("reviewers: ["))],
    ["missing selected reviewer", { githubOwner: "acme", githubRepo: "app", githubToken: "ghs_secret" }, mockContentsFetch(200, contentsApiResponse("reviewers:\n  - id: other-review\n    prompt: other\n"))],
  ])("returns no trusted config reviewers on %s so downstream selection fails closed", async (_name, contextData, fetchImpl) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const workspaceDir = makeWorkspace();

    const outputs = await installStep.run(
      makeContext({
        ...contextData,
        reviewers: [{ id: "domain-review", gates: true }],
        trustedReviewerDefinitions: new Map(),
      }),
      { workspaceDir, ...(fetchImpl ? { fetchImpl } : {}) },
      {} as never,
    );

    expect(outputs.trustedConfigReviewers).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});
