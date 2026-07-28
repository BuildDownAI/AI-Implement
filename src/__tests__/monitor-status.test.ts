import { describe, expect, it } from "vitest";
import { resolveTerminalStatus } from "../monitor-status.js";

const PR = "https://github.com/org/repo/pull/1";

describe("resolveTerminalStatus", () => {
  describe("implementation phase (a PR is the success signal)", () => {
    it("completes on a clean exit with a PR", () => {
      expect(resolveTerminalStatus(0, PR, false, "implementation")).toBe("completed");
    });

    it("fails on a clean exit with no PR", () => {
      expect(resolveTerminalStatus(0, null, false, "implementation")).toBe("failed");
    });

    it("marks review_failed when the pushed PR needs attention", () => {
      expect(resolveTerminalStatus(0, PR, true, "implementation")).toBe("review_failed");
    });

    it("fails on a non-zero exit even when a PR exists (the exit code is authoritative)", () => {
      expect(resolveTerminalStatus(1, PR, false, "implementation")).toBe("failed");
    });

    it("marks review_failed when the matched PR is an unapproved draft, even with no post-push review flag", () => {
      expect(resolveTerminalStatus(0, PR, false, "implementation", true)).toBe("review_failed");
    });

    it("stays review_failed when both the draft flag and the post-push review flag are set", () => {
      expect(resolveTerminalStatus(0, PR, true, "implementation", true)).toBe("review_failed");
    });

    it("defaults isDraftPr to false when omitted (unchanged behavior)", () => {
      expect(resolveTerminalStatus(0, PR, false, "implementation")).toBe("completed");
    });
  });

  describe("planning phase (read-only — no PR is ever produced)", () => {
    it("completes on a clean exit with no PR (the AII-144 fix — was misclassified failed)", () => {
      expect(resolveTerminalStatus(0, null, false, "planning")).toBe("completed");
    });

    it("fails when a planning run exits non-zero", () => {
      expect(resolveTerminalStatus(1, null, false, "planning")).toBe("failed");
    });
  });

  describe("unreadable exit code (fly: destroyed machine, or a clean exit 0 Fly reports with no exit_code)", () => {
    it("treats a null exit as clean — a planning run completes", () => {
      expect(resolveTerminalStatus(null, null, false, "planning")).toBe("completed");
    });

    it("treats a null exit as clean — an implementation run with a PR completes", () => {
      expect(resolveTerminalStatus(null, PR, false, "implementation")).toBe("completed");
    });

    it("falls back to the PR heuristic on a null exit — implementation with no PR fails", () => {
      expect(resolveTerminalStatus(null, null, false, "implementation")).toBe("failed");
    });
  });
});
