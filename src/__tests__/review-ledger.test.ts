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
            user: { login: "reviewer-a" },
            body: "not blocking",
            html_url: "https://example.com/commented",
          },
          {
            state: "CHANGES_REQUESTED",
            user: { login: "reviewer-b" },
            body: "Please fix the failing validation.",
            html_url: "https://example.com/review-1",
          },
          {
            state: "CHANGES_REQUESTED",
            user: { login: "reviewer-c" },
            body: "   ",
            html_url: "https://example.com/empty",
          },
          {
            state: "CHANGES_REQUESTED",
            user: { login: "reviewer-d" },
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
    expect(calls[0]).toContain("--paginate");
    expect(calls[0]).toContain("repos/:owner/:repo/pulls/42/reviews?per_page=100");
    expect(calls[1]?.slice(0, 2)).toEqual(["api", "graphql"]);
  });

  it("ignores stale changes-requested reviews when the same reviewer later approves", () => {
    const ghSpawn: GhSpawn = (args) => {
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
            state: "CHANGES_REQUESTED",
            user: { login: "reviewer-a" },
            body: "This old issue was fixed before approval.",
            html_url: "https://example.com/stale-review",
          },
          {
            state: "APPROVED",
            user: { login: "reviewer-a" },
            body: "Approved now.",
            html_url: "https://example.com/approval",
          },
        ]),
      };
    };

    expect(collectExternalReviewFindingsFromGh(ghSpawn, "42")).toEqual([]);
  });

  it("collects latest comments from unresolved review threads as blocking findings", () => {
    const calls: string[][] = [];
    const ghSpawn: GhSpawn = (args) => {
      calls.push(args);

      if (isPullReviewsRequest(args)) {
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
                      isOutdated: false,
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
                      isOutdated: false,
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

  it("ignores unresolved review threads that GitHub marks as outdated", () => {
    const ghSpawn: GhSpawn = (args) => {
      if (isPullReviewsRequest(args)) {
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
                      isResolved: false,
                      isOutdated: true,
                      path: "src/app.ts",
                      line: 27,
                      comments: {
                        nodes: [
                          {
                            body: "This comment belongs to an outdated diff.",
                            url: "https://example.com/outdated-thread",
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

    expect(collectExternalReviewFindingsFromGh(ghSpawn, "42")).toEqual([]);
  });

  it("collects unresolved review threads from later GraphQL pages", () => {
    const calls: string[][] = [];
    const ghSpawn: GhSpawn = (args) => {
      calls.push(args);

      if (isPullReviewsRequest(args)) {
        return { exitCode: 0, stdout: "[]" };
      }

      if (args.includes("after=cursor-1")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        isResolved: false,
                        isOutdated: false,
                        path: "src/later.ts",
                        line: 88,
                        comments: {
                          nodes: [
                            {
                              body: "Later page unresolved finding.",
                              url: "https://example.com/later-thread",
                            },
                          ],
                        },
                      },
                    ],
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null,
                    },
                  },
                },
              },
            },
          }),
        };
      }

      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [],
                  pageInfo: {
                    hasNextPage: true,
                    endCursor: "cursor-1",
                  },
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
        path: "src/later.ts",
        line: 88,
        body: "Later page unresolved finding.",
        url: "https://example.com/later-thread",
      },
    ]);
    expect(calls.filter((call) => call[0] === "api" && call[1] === "graphql")).toHaveLength(2);
    expect(calls[2]).toContain("after=cursor-1");
  });

  it("does not throw when GraphQL returns malformed JSON", () => {
    const ghSpawn: GhSpawn = (args) => {
      if (isPullReviewsRequest(args)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              state: "CHANGES_REQUESTED",
              user: { login: "reviewer-a" },
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

function isPullReviewsRequest(args: string[]): boolean {
  return args.includes("repos/:owner/:repo/pulls/42/reviews?per_page=100");
}
