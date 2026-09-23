import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DISPOSITIONS_FILE,
  buildDispositionInstructions,
  readFindingDispositions,
  replyToDispositionThreads,
  sanitizeFindingDispositions,
  stableReviewFindingKey,
  type FindingDisposition,
} from "../pipeline/finding-dispositions.js";
import type { GhSpawn } from "../pipeline/review-ledger.js";

function hexKey(n: number): string {
  return n.toString(16).padStart(64, "0");
}

const HEX_KEY_WITH_LETTERS = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567";

describe("stableReviewFindingKey", () => {
  it("returns a byte-identical key for a known finding after the move", () => {
    expect(
      stableReviewFindingKey({ source: "github-review", severity: "blocking", body: "Fix the validation." }),
    ).toBe("ec9106e87e088d48b108fee8fd1359ee9b71f51818b77106c502fce245a3687a");
  });
});

describe("sanitizeFindingDispositions", () => {
  it("returns an empty result when the input is not an array", () => {
    expect(sanitizeFindingDispositions(null)).toEqual({ valid: [], dropped: 0 });
    expect(sanitizeFindingDispositions(undefined)).toEqual({ valid: [], dropped: 0 });
    expect(sanitizeFindingDispositions("not an array")).toEqual({ valid: [], dropped: 0 });
    expect(sanitizeFindingDispositions({ findingKey: hexKey(1) })).toEqual({ valid: [], dropped: 0 });
  });

  it("drops entries that are not objects", () => {
    const result = sanitizeFindingDispositions(["nope", 42, null, true]);
    expect(result).toEqual({ valid: [], dropped: 4 });
  });

  it("drops entries whose findingKey is not 64 lowercase hex characters", () => {
    const result = sanitizeFindingDispositions([
      { findingKey: "not-hex", disposition: "fixed", reason: "" },
      { findingKey: HEX_KEY_WITH_LETTERS.toUpperCase(), disposition: "fixed", reason: "" },
      { findingKey: hexKey(1).slice(0, 63), disposition: "fixed", reason: "" },
      { disposition: "fixed", reason: "" },
    ]);
    expect(result).toEqual({ valid: [], dropped: 4 });
  });

  it("drops entries whose disposition is not one of the three values", () => {
    const result = sanitizeFindingDispositions([
      { findingKey: hexKey(1), disposition: "skipped", reason: "" },
      { findingKey: hexKey(2), reason: "" },
    ]);
    expect(result).toEqual({ valid: [], dropped: 2 });
  });

  it("keeps an entry with a non-string reason, coercing it to an empty string", () => {
    const result = sanitizeFindingDispositions([
      { findingKey: hexKey(1), disposition: "invalid", reason: 42 },
      { findingKey: hexKey(2), disposition: "invalid" },
    ]);
    expect(result).toEqual({
      valid: [
        { findingKey: hexKey(1), disposition: "invalid", reason: "" },
        { findingKey: hexKey(2), disposition: "invalid", reason: "" },
      ],
      dropped: 0,
    });
  });

  it("truncates a reason longer than 500 characters to exactly 500", () => {
    const longReason = "x".repeat(600);
    const result = sanitizeFindingDispositions([
      { findingKey: hexKey(1), disposition: "follow-up", reason: longReason },
    ]);
    expect(result.dropped).toBe(0);
    expect(result.valid[0].reason).toHaveLength(500);
    expect(result.valid[0].reason).toBe("x".repeat(500));
  });

  it("keeps the last entry when a findingKey is duplicated", () => {
    const result = sanitizeFindingDispositions([
      { findingKey: hexKey(1), disposition: "fixed", reason: "first" },
      { findingKey: hexKey(1), disposition: "follow-up", reason: "second" },
    ]);
    expect(result).toEqual({
      valid: [{ findingKey: hexKey(1), disposition: "follow-up", reason: "second" }],
      dropped: 0,
    });
  });

  it("keeps only the first 200 valid entries when more than 200 are given", () => {
    const entries = Array.from({ length: 210 }, (_, i) => ({
      findingKey: hexKey(i),
      disposition: "fixed" as const,
      reason: "",
    }));
    const result = sanitizeFindingDispositions(entries);
    expect(result.valid).toHaveLength(200);
    expect(result.dropped).toBe(10);
    expect(result.valid[0].findingKey).toBe(hexKey(0));
    expect(result.valid[199].findingKey).toBe(hexKey(199));
  });

  it("applies deduplication before the 200-entry cap so an intended entry survives both rules", () => {
    const entries = [
      ...Array.from({ length: 200 }, (_, i) => ({
        findingKey: hexKey(i),
        disposition: "fixed" as const,
        reason: "",
      })),
      { findingKey: hexKey(0), disposition: "invalid" as const, reason: "updated" },
    ];
    const result = sanitizeFindingDispositions(entries);
    expect(result.valid).toHaveLength(200);
    expect(result.dropped).toBe(0);
    expect(result.valid[0]).toEqual({ findingKey: hexKey(0), disposition: "invalid", reason: "updated" });
  });
});

describe("buildDispositionInstructions", () => {
  it("names the dispositions file, all three dispositions, and the changed-lines rule", () => {
    const text = buildDispositionInstructions();
    expect(text).toContain(DISPOSITIONS_FILE);
    expect(text).toContain("fixed");
    expect(text).toContain("follow-up");
    expect(text).toContain("invalid");
    expect(text).toMatch(/never.*follow-up/i);
  });
});

describe("readFindingDispositions", () => {
  it("returns an empty result without throwing when the file is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finding-dispositions-"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(() => readFindingDispositions(dir)).not.toThrow();
      expect(readFindingDispositions(dir)).toEqual({ valid: [], dropped: 0 });
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty result without throwing when the file has invalid JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finding-dispositions-"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      fs.mkdirSync(path.join(dir, "ai-output"), { recursive: true });
      fs.writeFileSync(path.join(dir, DISPOSITIONS_FILE), "{not valid json");
      expect(() => readFindingDispositions(dir)).not.toThrow();
      expect(readFindingDispositions(dir)).toEqual({ valid: [], dropped: 0 });
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads and sanitizes a valid dispositions file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finding-dispositions-"));
    try {
      fs.mkdirSync(path.join(dir, "ai-output"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, DISPOSITIONS_FILE),
        JSON.stringify([{ findingKey: hexKey(1), disposition: "fixed", reason: "done" }]),
      );
      expect(readFindingDispositions(dir)).toEqual({
        valid: [{ findingKey: hexKey(1), disposition: "fixed", reason: "done" }],
        dropped: 0,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("replyToDispositionThreads", () => {
  const followUpBody = "Missing null check.";
  const invalidBody = "Nit: rename variable.";
  const fixedBody = "Add docstring.";
  const errorBody = "Consider caching this.";

  const followUpKey = stableReviewFindingKey({
    source: "github-review-thread",
    severity: "medium",
    body: followUpBody,
    path: "src/app.ts",
    line: 10,
  });
  const invalidKey = stableReviewFindingKey({
    source: "github-review-thread",
    severity: "medium",
    body: invalidBody,
    path: "src/app.ts",
    line: 20,
  });
  const fixedKey = stableReviewFindingKey({
    source: "github-review-thread",
    severity: "medium",
    body: fixedBody,
    path: "src/other.ts",
    line: 5,
  });
  const errorKey = stableReviewFindingKey({
    source: "github-review-thread",
    severity: "medium",
    body: errorBody,
    path: "src/other.ts",
    line: 30,
  });

  function threadsResponse() {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  { id: "RT_1", isResolved: false, path: "src/app.ts", line: 10, comments: { nodes: [{ body: followUpBody }] } },
                  { id: "RT_2", isResolved: false, path: "src/app.ts", line: 20, comments: { nodes: [{ body: invalidBody }] } },
                  { id: "RT_3", isResolved: false, path: "src/other.ts", line: 5, comments: { nodes: [{ body: fixedBody }] } },
                  { id: "RT_4", isResolved: false, path: "src/other.ts", line: 30, comments: { nodes: [{ body: errorBody }] } },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }),
    };
  }

  function buildDispositions(): FindingDisposition[] {
    return [
      { findingKey: followUpKey, disposition: "follow-up", reason: "Out of scope for this issue." },
      { findingKey: invalidKey, disposition: "invalid", reason: "The variable name matches convention." },
      { findingKey: fixedKey, disposition: "fixed", reason: "Docstring added." },
      { findingKey: errorKey, disposition: "follow-up", reason: "Caching is unrelated to this issue." },
    ];
  }

  it("resolves a follow-up thread, replies without resolving on invalid, ignores fixed, and marks every reply", () => {
    const calls: string[][] = [];
    const ghSpawn: GhSpawn = (args) => {
      calls.push(args);
      if (args.includes("threadId=RT_4")) throw new Error("network error");
      if (args.some((a) => a.includes("addPullRequestReviewThreadReply"))) {
        return { exitCode: 0, stdout: JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { id: "IC_1" } } } }) };
      }
      if (args.some((a) => a.includes("resolveReviewThread"))) {
        return { exitCode: 0, stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: "RT_1" } } } }) };
      }
      return threadsResponse();
    };

    const replied = replyToDispositionThreads(ghSpawn, "42", buildDispositions());

    expect(replied).toBe(2);

    const followUpReplyCall = calls.find(
      (call) => call.includes("threadId=RT_1") && call.some((a) => a.includes("addPullRequestReviewThreadReply")),
    );
    expect(followUpReplyCall).toBeTruthy();
    const followUpBodyArg = followUpReplyCall!.find((a) => a.startsWith("body="));
    expect(followUpBodyArg).toContain("<!-- ai-implement finding-disposition -->");
    expect(followUpBodyArg).toContain("Deferred as a follow-up: Out of scope for this issue.");

    const followUpResolveCall = calls.find(
      (call) => call.includes("threadId=RT_1") && call.some((a) => a.includes("resolveReviewThread")),
    );
    expect(followUpResolveCall).toBeTruthy();

    const invalidReplyCall = calls.find(
      (call) => call.includes("threadId=RT_2") && call.some((a) => a.includes("addPullRequestReviewThreadReply")),
    );
    expect(invalidReplyCall).toBeTruthy();
    const invalidBodyArg = invalidReplyCall!.find((a) => a.startsWith("body="));
    expect(invalidBodyArg).toContain("<!-- ai-implement finding-disposition -->");
    expect(invalidBodyArg).toContain("Not changed: The variable name matches convention.");

    const invalidResolveCall = calls.find(
      (call) => call.includes("threadId=RT_2") && call.some((a) => a.includes("resolveReviewThread")),
    );
    expect(invalidResolveCall).toBeUndefined();

    const fixedCall = calls.find((call) => call.includes("threadId=RT_3"));
    expect(fixedCall).toBeUndefined();
  });

  it("does not throw when a gh call errors, and continues to the remaining threads", () => {
    const ghSpawn: GhSpawn = (args) => {
      if (args.includes("threadId=RT_4")) throw new Error("network error");
      if (args.some((a) => a.includes("addPullRequestReviewThreadReply"))) {
        return { exitCode: 0, stdout: JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { id: "IC_1" } } } }) };
      }
      if (args.some((a) => a.includes("resolveReviewThread"))) {
        return { exitCode: 0, stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: "RT_1" } } } }) };
      }
      return threadsResponse();
    };

    let replied = 0;
    expect(() => {
      replied = replyToDispositionThreads(ghSpawn, "42", buildDispositions());
    }).not.toThrow();
    // RT_4's reply throws and is not counted, but RT_1 and RT_2 still succeed.
    expect(replied).toBe(2);
  });
});
