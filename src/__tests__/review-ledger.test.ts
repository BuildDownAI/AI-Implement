import { describe, expect, it } from "vitest";
import {
  collectExternalReviewFindingsFromGh,
  extractClaudeSummaryFindings,
  formatReviewLedgerForPrompt,
  type GhSpawn,
  type ReviewLedgerFinding,
} from "../pipeline/review-ledger.js";

describe("extractClaudeSummaryFindings", () => {
  it("extracts normalized bullets from a blocking section only", () => {
    const body = `
## Summary
- ignore this summary bullet

## Blocking
- **Fix** \`src/app.ts\` before merge.
- [Update docs](https://example.com/docs)   to explain the new flow.

## Medium
- ignore this medium bullet
`;

    expect(extractClaudeSummaryFindings(body, "https://example.com/review")).toEqual([
      {
        source: "claude-review-summary",
        severity: "blocking",
        body: "Fix src/app.ts before merge.",
        url: "https://example.com/review",
      },
      {
        source: "claude-review-summary",
        severity: "blocking",
        body: "Update docs to explain the new flow.",
        url: "https://example.com/review",
      },
    ]);
  });

  it("extracts ordered bullets from blocking issues sections", () => {
    const body = `
## Blocking issues
1. Missing UUID validation
2) Fix confidence validation
`;

    expect(extractClaudeSummaryFindings(body)).toEqual([
      {
        source: "claude-review-summary",
        severity: "blocking",
        body: "Missing UUID validation",
      },
      {
        source: "claude-review-summary",
        severity: "blocking",
        body: "Fix confidence validation",
      },
    ]);
  });

  it("folds indented continuation lines into the previous blocking bullet", () => {
    const body = `
## Blocking
- Fix auth
  because missing validation returns 500
- Fix status
  because it reports success too early
`;

    expect(extractClaudeSummaryFindings(body)).toEqual([
      {
        source: "claude-review-summary",
        severity: "blocking",
        body: "Fix auth because missing validation returns 500",
      },
      {
        source: "claude-review-summary",
        severity: "blocking",
        body: "Fix status because it reports success too early",
      },
    ]);
  });
});

describe("formatReviewLedgerForPrompt", () => {
  it("returns an explicit empty-state message with no findings", () => {
    expect(formatReviewLedgerForPrompt([])).toBe("No unresolved external review findings.");
  });

  it("formats review-ledger findings for a fix prompt", () => {
    const findings: ReviewLedgerFinding[] = [
      {
        source: "claude-review-summary",
        severity: "blocking",
        path: "src/app.ts",
        line: 12,
        body: "Fix the broken validation.",
        url: "https://example.com/review",
      },
      {
        source: "github-review-thread",
        severity: "medium",
        body: "Consider preserving the existing return shape.",
      },
    ];

    expect(formatReviewLedgerForPrompt(findings)).toBe(
      [
        "[external-1] claude-review-summary blocking src/app.ts:12",
        "Fix the broken validation.",
        "URL: https://example.com/review",
        "",
        "[external-2] github-review-thread medium",
        "Consider preserving the existing return shape.",
      ].join("\n"),
    );
  });
});

describe("collectExternalReviewFindingsFromGh", () => {
  it("collects non-empty changes-requested review bodies as blocking github-review findings", () => {
    const calls: string[][] = [];
    const ghSpawn: GhSpawn = (args) => {
      calls.push(args);

      if (args[0] === "api" && args[1] === "graphql") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
          }),
        };
      }

      return {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            state: "COMMENTED",
            body: "not blocking",
            html_url: "https://example.com/commented",
          },
          {
            state: "CHANGES_REQUESTED",
            body: "Please fix the failing validation.",
            html_url: "https://example.com/review-1",
          },
          {
            state: "CHANGES_REQUESTED",
            body: "   ",
            html_url: "https://example.com/empty",
          },
          {
            state: "CHANGES_REQUESTED",
            body: "Also restore the timeout handling.",
            html_url: "https://example.com/review-2",
          },
        ]),
      };
    };

    expect(collectExternalReviewFindingsFromGh(ghSpawn, "42")).toEqual([
      {
        source: "github-review",
        severity: "blocking",
        body: "Please fix the failing validation.",
        url: "https://example.com/review-1",
      },
      {
        source: "github-review",
        severity: "blocking",
        body: "Also restore the timeout handling.",
        url: "https://example.com/review-2",
      },
    ]);
    expect(calls[0]).toEqual(["api", "repos/:owner/:repo/pulls/42/reviews"]);
    expect(calls[1]?.slice(0, 2)).toEqual(["api", "graphql"]);
  });

  it("collects latest comments from unresolved review threads as blocking findings", () => {
    const calls: string[][] = [];
    const ghSpawn: GhSpawn = (args) => {
      calls.push(args);

      if (args[0] === "api" && args[1] === "repos/:owner/:repo/pulls/42/reviews") {
        return { exitCode: 0, stdout: "[]" };
      }

      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      isResolved: true,
                      path: "src/ignored.ts",
                      line: 1,
                      comments: {
                        nodes: [
                          {
                            body: "resolved comment",
                            url: "https://example.com/resolved",
                          },
                        ],
                      },
                    },
                    {
                      isResolved: false,
                      path: "src/app.ts",
                      line: 27,
                      comments: {
                        nodes: [
                          {
                            body: "Original note",
                            url: "https://example.com/thread-old",
                          },
                          {
                            body: "Latest unresolved note",
                            url: "https://example.com/thread-latest",
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
      };
    };

    expect(collectExternalReviewFindingsFromGh(ghSpawn, "42")).toEqual([
      {
        source: "github-review-thread",
        severity: "blocking",
        path: "src/app.ts",
        line: 27,
        body: "Latest unresolved note",
        url: "https://example.com/thread-latest",
      },
    ]);
    expect(calls[1]?.slice(0, 2)).toEqual(["api", "graphql"]);
  });

  it("does not throw when GraphQL returns malformed JSON", () => {
    const ghSpawn: GhSpawn = (args) => {
      if (args[0] === "api" && args[1] === "repos/:owner/:repo/pulls/42/reviews") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              state: "CHANGES_REQUESTED",
              body: "Keep already collected review findings.",
              html_url: "https://example.com/review",
            },
          ]),
        };
      }

      return { exitCode: 0, stdout: "{not-json" };
    };

    expect(() => collectExternalReviewFindingsFromGh(ghSpawn, "42")).not.toThrow();
    expect(collectExternalReviewFindingsFromGh(ghSpawn, "42")).toEqual([
      {
        source: "github-review",
        severity: "blocking",
        body: "Keep already collected review findings.",
        url: "https://example.com/review",
      },
    ]);
  });
});
