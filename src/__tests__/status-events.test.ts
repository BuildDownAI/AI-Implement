import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatStatusComment, formatDuration, postStatusComment } from "../status-events.js";
import type { StatusEvent } from "../status-events.js";

vi.mock("../linear.js", () => ({
  postIssueComment: vi.fn(),
}));

describe("formatDuration", () => {
  it("formats sub-minute durations as seconds", () => {
    expect(formatDuration(30_000)).toBe("30s");
    expect(formatDuration(1_000)).toBe("1s");
    expect(formatDuration(59_000)).toBe("59s");
  });

  it("formats exact minutes with no seconds component", () => {
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(120_000)).toBe("2m");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });

  it("rounds to nearest second", () => {
    expect(formatDuration(1_499)).toBe("1s");
    expect(formatDuration(1_500)).toBe("2s");
  });
});

describe("formatStatusComment", () => {
  it("formats machine_created", () => {
    const event: StatusEvent = { type: "machine_created", machineName: "session-eng-42" };
    const comment = formatStatusComment(event);
    expect(comment).toContain("🚀");
    expect(comment).toContain("`session-eng-42`");
    expect(comment).toContain("Cloning repo");
  });

  it("formats setup_complete", () => {
    const comment = formatStatusComment({ type: "setup_complete" });
    expect(comment).toContain("✅");
    expect(comment).toContain("Environment ready");
    expect(comment).toContain("implementing");
  });

  it("formats implementation_complete with PR details", () => {
    const event: StatusEvent = {
      type: "implementation_complete",
      prNumber: 42,
      prUrl: "https://github.com/org/repo/pull/42",
    };
    const comment = formatStatusComment(event);
    expect(comment).toContain("📝");
    expect(comment).toContain("PR #42");
    expect(comment).toContain("https://github.com/org/repo/pull/42");
  });

  it("formats verify_running", () => {
    const comment = formatStatusComment({ type: "verify_running" });
    expect(comment).toContain("🧪");
    expect(comment).toContain("verification");
  });

  it("formats verify_passed", () => {
    const comment = formatStatusComment({ type: "verify_passed" });
    expect(comment).toContain("✅");
    expect(comment).toContain("Verification passed");
  });

  it("formats verify_failed with summary", () => {
    const event: StatusEvent = { type: "verify_failed", summary: "tests failed: 3 errors" };
    const comment = formatStatusComment(event);
    expect(comment).toContain("❌");
    expect(comment).toContain("Verification failed");
    expect(comment).toContain("tests failed: 3 errors");
  });

  it("formats machine_destroyed with duration", () => {
    const event: StatusEvent = { type: "machine_destroyed", durationMs: 90_000 };
    const comment = formatStatusComment(event);
    expect(comment).toContain("🧹");
    expect(comment).toContain("cleaned up");
    expect(comment).toContain("1m 30s");
  });

  it("formats error with reason", () => {
    const event: StatusEvent = { type: "error", reason: "setup script failed" };
    const comment = formatStatusComment(event);
    expect(comment).toContain("⚠️");
    expect(comment).toContain("setup script failed");
    expect(comment).toContain("cleaned up");
  });

  it("formats timeout with reason", () => {
    const event: StatusEvent = { type: "timeout", reason: "machine timed out after 45m" };
    const comment = formatStatusComment(event);
    expect(comment).toContain("⚠️");
    expect(comment).toContain("timed out");
    expect(comment).toContain("machine timed out after 45m");
  });

  it("includes a UTC timestamp in every comment", () => {
    const comment = formatStatusComment({ type: "setup_complete" });
    expect(comment).toMatch(/_\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC_/);
  });

  it("appends machine logs link when provided", () => {
    const url = "https://fly.io/apps/my-app/machines/abc123";
    const comment = formatStatusComment({ type: "setup_complete" }, url);
    expect(comment).toContain(`[Machine logs](${url})`);
  });

  it("omits machine logs link when not provided", () => {
    const comment = formatStatusComment({ type: "setup_complete" });
    expect(comment).not.toContain("Machine logs");
  });
});

describe("postStatusComment", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("calls postIssueComment with formatted body", async () => {
    const { postIssueComment } = await import("../linear.js");
    vi.mocked(postIssueComment).mockResolvedValueOnce(undefined);

    await postStatusComment("api-key", "issue-123", { type: "setup_complete" });

    expect(postIssueComment).toHaveBeenCalledOnce();
    const [apiKey, issueId, body] = vi.mocked(postIssueComment).mock.calls[0];
    expect(apiKey).toBe("api-key");
    expect(issueId).toBe("issue-123");
    expect(body).toContain("Environment ready");
  });

  it("includes machine logs URL in the posted comment", async () => {
    const { postIssueComment } = await import("../linear.js");
    vi.mocked(postIssueComment).mockResolvedValueOnce(undefined);

    const logsUrl = "https://fly.io/apps/my-app/machines/m123";
    await postStatusComment("api-key", "issue-123", { type: "machine_created", machineName: "session-eng-1" }, logsUrl);

    const body = vi.mocked(postIssueComment).mock.calls[0][2];
    expect(body).toContain(logsUrl);
  });

  it("propagates errors from postIssueComment", async () => {
    const { postIssueComment } = await import("../linear.js");
    vi.mocked(postIssueComment).mockRejectedValueOnce(new Error("Linear API error"));

    await expect(
      postStatusComment("api-key", "issue-123", { type: "setup_complete" }),
    ).rejects.toThrow("Linear API error");
  });
});
