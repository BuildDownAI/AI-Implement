import { describe, expect, it } from "vitest";
import { resolveLocalDockerTerminalStatus } from "../local-docker-monitor.js";

describe("resolveLocalDockerTerminalStatus", () => {
  it("fails when the container exits non-zero", () => {
    expect(resolveLocalDockerTerminalStatus(1, "https://github.com/org/repo/pull/1", false)).toBe("failed");
  });

  it("fails when the container exits zero but no PR is found", () => {
    expect(resolveLocalDockerTerminalStatus(0, null, false)).toBe("failed");
  });

  it("completes when a zero-exit container produced a PR", () => {
    expect(resolveLocalDockerTerminalStatus(0, "https://github.com/org/repo/pull/1", false)).toBe("completed");
  });

  it("marks review_failed when post-push review needs attention", () => {
    expect(resolveLocalDockerTerminalStatus(0, "https://github.com/org/repo/pull/1", true)).toBe("review_failed");
  });
});
