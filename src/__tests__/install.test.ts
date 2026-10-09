import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import type { DefaultPipelineContext } from "../pipeline/context.js";
import { installStep, parseReviewCheckNamesConfig, parseReviewersConfig } from "../pipeline/steps/install.js";
import { REVIEWER_VERDICT_SCHEMA } from "../pipeline/reviewers/schema.js";
import type { PipelineContextData } from "../pipeline/types.js";
import { makeContext } from "./helpers/builders.js";
import { fakeFetch, type FakeFetch, type Reply } from "./helpers/fake-fetch.js";
import { testDir } from "./helpers/test-dir.js";

/** A pipeline context with `data`, and the clone step's outputs when given. */
function installContext(data: Partial<PipelineContextData> = {}, cloneOutputs?: Record<string, unknown>): DefaultPipelineContext {
  const context = makeContext(data);
  if (cloneOutputs) context.setOutputs("clone", cloneOutputs);
  return context;
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

function contentsApiResponse(fileBody: string): Reply {
  return {
    json: {
      type: "file",
      encoding: "base64",
      content: Buffer.from(fileBody, "utf8").toString("base64"),
    },
  };
}

/** GitHub's contents API answering for acme/app's `.ai-implement/config.yml` on the default branch. */
function trustedConfig(reply: Reply): FakeFetch {
  return fakeFetch({ "GET /repos/acme/app/contents/.ai-implement/config.yml": reply });
}

afterEach(() => {
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
      { id: " accessibility-review ", model: " claude-sonnet-5-5 ", prompt: " Review accessibility. ", gates: true },
      { id: "architecture-review", prompt: "Review boundaries." },
    ]);

    expect(reviewers).toHaveLength(2);
    expect(reviewers?.[0]).toEqual({
      id: "accessibility-review",
      model: "claude-sonnet-5-5",
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
    const workspaceDir = testDir("ai-implement-install-reviewers");
    mkdirSync(join(workspaceDir, ".ai-implement"), { recursive: true });
    writeFileSync(join(workspaceDir, ".ai-implement", "config.yml"), [
      "reviewers:",
      "  - id: domain-review",
      "    model: claude-sonnet-5-5",
      "    gates: true",
      "    prompt: |",
      "      Review the diff for domain mistakes.",
      "",
    ].join("\n"));

    const outputs = await installStep.run(
      installContext(),
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
      model: "claude-sonnet-5-5",
      prompt: "Review the diff for domain mistakes.\n",
      outputSchema: REVIEWER_VERDICT_SCHEMA,
      gates: undefined,
    }]);
  });

  it("fetches selected gating config reviewers from the trusted default-branch config without a ref", async () => {
    const workspaceDir = testDir("ai-implement-install-reviewers");
    mkdirSync(join(workspaceDir, ".ai-implement"), { recursive: true });
    writeFileSync(join(workspaceDir, ".ai-implement", "config.yml"), [
      "reviewers:",
      "  - id: domain-review",
      "    model: claude-opus-5",
      "    prompt: malicious PR prompt",
      "",
    ].join("\n"));
    const github = trustedConfig(contentsApiResponse([
      "reviewers:",
      "  - id: domain-review",
      "    model: claude-sonnet-5-5",
      "    prompt: trusted default prompt",
      "  - id: unselected-review",
      "    prompt: should not be fetched into outputs",
      "",
    ].join("\n")));

    const outputs = await installStep.run(
      installContext({
        githubOwner: "acme",
        githubRepo: "app",
        githubToken: "ghs_secret",
        reviewers: [{ id: "domain-review", gates: true }],
        trustedReviewerDefinitions: new Map(),
      }),
      { workspaceDir, fetchImpl: github.fetch },
      {} as never,
    );

    expect(github.calls).toHaveLength(1);
    expect(github.calls[0].url.href).toBe("https://api.github.com/repos/acme/app/contents/.ai-implement/config.yml");
    expect(github.calls[0].url.search).toBe("");
    expect(github.calls[0].headers.get("authorization")).toBe("Bearer ghs_secret");
    expect(reviewerPrompt(outputs.reviewers![0]!)).toBe("malicious PR prompt");
    expect(outputs.trustedConfigReviewers.map((reviewer) => ({ id: reviewer.id, model: reviewer.model }))).toEqual([
      { id: "domain-review", model: "claude-sonnet-5-5" },
    ]);
    expect(reviewerPrompt(outputs.trustedConfigReviewers[0]!)).toBe("trusted default prompt");
  });

  it("uses the current clone output credential without adding it to install inputs", async () => {
    const workspaceDir = testDir("ai-implement-install-reviewers");
    const github = trustedConfig(contentsApiResponse([
      "reviewers:",
      "  - id: domain-review",
      "    prompt: trusted default prompt",
      "",
    ].join("\n")));

    await installStep.run(
      installContext({
        githubOwner: "stale-owner",
        githubRepo: "stale-repo",
        githubToken: "",
        reviewers: [{ id: "domain-review", gates: true }],
        trustedReviewerDefinitions: new Map(),
      }, { repoOwner: "acme", repoRepo: "app", githubToken: "fresh-token" }),
      { workspaceDir, fetchImpl: github.fetch },
      {} as never,
    );

    expect(github.calls[0].url.href).toBe("https://api.github.com/repos/acme/app/contents/.ai-implement/config.yml");
    expect(github.calls[0].headers.get("authorization")).toBe("Bearer fresh-token");
  });

  it("fetches trusted config even when the PR branch deletes the local config entry", async () => {
    const workspaceDir = testDir("ai-implement-install-reviewers");
    const github = trustedConfig(contentsApiResponse([
      "reviewers:",
      "  - id: domain-review",
      "    prompt: trusted default prompt",
      "",
    ].join("\n")));

    const outputs = await installStep.run(
      installContext({
        githubOwner: "acme",
        githubRepo: "app",
        githubToken: "ghs_secret",
        reviewers: [{ id: "domain-review", gates: true }],
        trustedReviewerDefinitions: new Map(),
      }),
      { workspaceDir, fetchImpl: github.fetch },
      {} as never,
    );

    expect(github.calls).toHaveLength(1);
    expect(outputs.reviewers).toBeUndefined();
    expect(outputs.trustedConfigReviewers.map((reviewer) => reviewer.id)).toEqual(["domain-review"]);
  });

  it("does not fetch trusted config for an actual built-in even without a precomputed trusted map", async () => {
    const workspaceDir = testDir("ai-implement-install-reviewers");
    const github = fakeFetch({});

    const outputs = await installStep.run(
      installContext({
        githubOwner: "acme",
        githubRepo: "app",
        githubToken: "ghs_secret",
        reviewers: [{ id: "gap-analysis", gates: true }],
      }),
      { workspaceDir, fetchImpl: github.fetch },
      {} as never,
    );

    expect(github.calls).toHaveLength(0);
    expect(outputs.trustedConfigReviewers).toEqual([]);
  });

  it("does not fetch trusted config for selected built-in, image-baked, external, or advisory-only reviewers", async () => {
    const workspaceDir = testDir("ai-implement-install-reviewers");
    const github = fakeFetch({});

    const outputs = await installStep.run(
      installContext({
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
      { workspaceDir, fetchImpl: github.fetch },
      {} as never,
    );

    expect(github.calls).toHaveLength(0);
    expect(outputs.trustedConfigReviewers).toEqual([]);
  });

  // Each row carries the contents API's reply, not a fake: a fakeFetch belongs to a running test,
  // and it.each builds its rows while the file is collected.
  const githubContext = { githubOwner: "acme", githubRepo: "app", githubToken: "ghs_secret" };
  const offline: Reply = () => {
    throw new Error("offline");
  };
  it.each<[string, Partial<PipelineContextData>, Reply | undefined]>([
    ["missing GitHub context", {}, undefined],
    ["transport error", githubContext, offline],
    ["missing default config", githubContext, { status: 404 }],
    ["HTTP error", githubContext, { status: 500 }],
    ["null JSON body", githubContext, { json: null }],
    ["array JSON body", githubContext, { json: [] }],
    ["malformed contents response", githubContext, { json: { type: "dir", encoding: "base64", content: "" } }],
    ["malformed YAML", githubContext, contentsApiResponse("reviewers: [")],
    ["missing selected reviewer", githubContext, contentsApiResponse("reviewers:\n  - id: other-review\n    prompt: other\n")],
  ])("returns no trusted config reviewers on %s so downstream selection fails closed", async (_name, contextData, reply) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const workspaceDir = testDir("ai-implement-install-reviewers");

    const outputs = await installStep.run(
      installContext({
        ...contextData,
        reviewers: [{ id: "domain-review", gates: true }],
        trustedReviewerDefinitions: new Map(),
      }),
      { workspaceDir, ...(reply ? { fetchImpl: trustedConfig(reply).fetch } : {}) },
      {} as never,
    );

    expect(outputs.trustedConfigReviewers).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});
