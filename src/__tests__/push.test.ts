import { describe, it, expect } from "vitest";
import { buildGitPushInvocation } from "../pipeline/steps/push.js";

const REMOTE = "https://x-access-token:secret@github.com/o/r.git";
const REF = "refs/heads/feature";

describe("buildGitPushInvocation", () => {
  it("builds a plain push without tracing", () => {
    const { args, env } = buildGitPushInvocation(REMOTE, REF, "abc123", false);
    expect(args).toEqual([
      "push",
      REMOTE,
      `HEAD:${REF}`,
      `--force-with-lease=${REF}:abc123`,
    ]);
    expect(args).not.toContain("--verbose");
    expect(env.GIT_TRACE2_PERF).toBeUndefined();
  });

  it("adds --verbose and GIT_TRACE2_PERF when tracing", () => {
    const { args, env } = buildGitPushInvocation(REMOTE, REF, "abc123", true);
    expect(args[0]).toBe("push");
    expect(args[1]).toBe("--verbose");
    expect(args).toEqual([
      "push",
      "--verbose",
      REMOTE,
      `HEAD:${REF}`,
      `--force-with-lease=${REF}:abc123`,
    ]);
    expect(env.GIT_TRACE2_PERF).toBe("1");
  });

  it("uses an empty lease target when the remote branch does not exist yet", () => {
    const { args } = buildGitPushInvocation(REMOTE, REF, null, false);
    expect(args).toContain(`--force-with-lease=${REF}:`);
  });
});
