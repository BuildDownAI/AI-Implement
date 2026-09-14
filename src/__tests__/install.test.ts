import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { installStep, parseReviewCheckNamesConfig, parseReviewersConfig } from "../pipeline/steps/install.js";
import { REVIEWER_VERDICT_SCHEMA } from "../pipeline/reviewers/schema.js";

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
    try {
      expect(parseReviewersConfig(undefined)).toBeUndefined();
      expect(parseReviewersConfig("review")).toBeUndefined();
      expect(parseReviewersConfig({ reviewers: [] })).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenNthCalledWith(1, expect.stringContaining("reviewers"));
      expect(warnSpy).toHaveBeenNthCalledWith(2, expect.stringContaining("reviewers"));
    } finally {
      warnSpy.mockRestore();
    }
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
    expect(reviewers?.[0]?.buildPrompt({
      issueIdentifier: "AII-1",
      issueTitle: "Title",
      issueDescription: "Description",
      prNumber: "42",
      diff: "diff",
      previousFindings: "previous",
    })).toBe(" Review accessibility. ");
    expect(reviewers?.[1]).toEqual({
      id: "architecture-review",
      buildPrompt: expect.any(Function),
      outputSchema: REVIEWER_VERDICT_SCHEMA,
    });
    expect(Object.keys(reviewers?.[0] ?? {})).not.toContain("gates");
  });

  it("drops malformed reviewer declarations with one warning per dropped entry", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
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
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("installStep reviewers output", () => {
  it("exposes reviewers from .ai-implement/config.yml without running install when no package.json exists", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "ai-implement-install-reviewers-"));
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
      {} as never,
      { workspaceDir },
      {} as never,
    );

    expect(outputs.installMethod).toBe("skipped: no package.json");
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
});
