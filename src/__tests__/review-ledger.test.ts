import { describe, expect, it } from "vitest";
import {
  extractClaudeSummaryFindings,
  formatReviewLedgerForPrompt,
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
