import { describe, expect, it, vi, beforeEach } from "vitest";
import { getDeployPosture, channelTagForRef, deriveMergeCost } from "../deploy-posture.js";

vi.mock("../deploy-policy.js", () => ({
  getDeployPolicy: vi.fn(),
}));

vi.mock("../deploy-availability.js", () => ({
  readStampedTarget: vi.fn(),
  resolveDeployTarget: vi.fn(),
  getAvailability: vi.fn(),
}));

vi.mock("../deploy-hold.js", () => ({
  isDeployHeld: vi.fn(),
}));

vi.mock("../in-flight-work.js", () => ({
  getInFlightWork: vi.fn(),
}));

vi.mock("../deploy-notify.js", () => ({
  getDeployOutcome: vi.fn(),
}));

vi.mock("../repo-image.js", () => ({
  resolveDefaultRunnerImage: vi.fn(),
  stripImageTag: vi.fn(),
  resolveChannelCommit: vi.fn(),
}));

let deployPolicyMock: typeof import("../deploy-policy.js");
let deployAvailabilityMock: typeof import("../deploy-availability.js");
let deployHoldMock: typeof import("../deploy-hold.js");
let inFlightWorkMock: typeof import("../in-flight-work.js");
let deployNotifyMock: typeof import("../deploy-notify.js");
let repoImageMock: typeof import("../repo-image.js");

const TARGET = {
  owner: "BuildDownAI",
  repo: "AI-Implement",
  branch: "testing",
  runningCommit: "aaa",
};

beforeEach(async () => {
  deployPolicyMock = await import("../deploy-policy.js");
  deployAvailabilityMock = await import("../deploy-availability.js");
  deployHoldMock = await import("../deploy-hold.js");
  inFlightWorkMock = await import("../in-flight-work.js");
  deployNotifyMock = await import("../deploy-notify.js");
  repoImageMock = await import("../repo-image.js");

  // Sensible defaults
  (deployPolicyMock.getDeployPolicy as ReturnType<typeof vi.fn>).mockReturnValue({
    autoDeploy: true,
    notifyAvailable: true,
    watchedRepo: "BuildDownAI/AI-Implement",
    watchedRef: "testing",
  });
  (deployAvailabilityMock.readStampedTarget as ReturnType<typeof vi.fn>).mockReturnValue(TARGET);
  (deployAvailabilityMock.resolveDeployTarget as ReturnType<typeof vi.fn>).mockReturnValue(TARGET);
  (deployAvailabilityMock.getAvailability as ReturnType<typeof vi.fn>).mockReturnValue({
    available: true,
    runningCommit: "aaa",
    headCommit: "bbb",
    checkedAt: Date.now(),
    isDowngrade: false,
  });
  (deployHoldMock.isDeployHeld as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (inFlightWorkMock.getInFlightWork as ReturnType<typeof vi.fn>).mockReturnValue([]);
  (deployNotifyMock.getDeployOutcome as ReturnType<typeof vi.fn>).mockReturnValue({
    kind: "deployed-ok",
    commit: "aaa",
    at: Date.now(),
  });
  (repoImageMock.resolveDefaultRunnerImage as ReturnType<typeof vi.fn>).mockReturnValue({
    image: "ghcr.io/builddownai/ai-implement-runner:latest",
    explicit: false,
    sessionImageStatus: "unused",
  });
  (repoImageMock.stripImageTag as ReturnType<typeof vi.fn>).mockReturnValue(
    "ghcr.io/builddownai/ai-implement-runner",
  );
  (repoImageMock.resolveChannelCommit as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

// ── channelTagForRef ──────────────────────────────────────────────────────────

describe("channelTagForRef", () => {
  it('maps "testing" → "next"', () => {
    expect(channelTagForRef("testing")).toBe("next");
  });

  it('maps "main" → "latest"', () => {
    expect(channelTagForRef("main")).toBe("latest");
  });

  it("returns null for unknown branches", () => {
    expect(channelTagForRef("feature/x")).toBeNull();
    expect(channelTagForRef("develop")).toBeNull();
    expect(channelTagForRef(null)).toBeNull();
  });
});

// ── deriveMergeCost ───────────────────────────────────────────────────────────

describe("deriveMergeCost", () => {
  it('returns "deploy+image" when autoDeploy is true, regardless of branch', () => {
    expect(deriveMergeCost(true, "testing")).toBe("deploy+image");
    expect(deriveMergeCost(true, "main")).toBe("deploy+image");
    expect(deriveMergeCost(true, "feature/x")).toBe("deploy+image");
    expect(deriveMergeCost(true, null)).toBe("deploy+image");
  });

  it('returns "image" when autoDeploy is false and watchedRef is "testing"', () => {
    expect(deriveMergeCost(false, "testing")).toBe("image");
  });

  it('returns "image" when autoDeploy is false and watchedRef is "main"', () => {
    expect(deriveMergeCost(false, "main")).toBe("image");
  });

  it('returns "none" when autoDeploy is false and watchedRef is an unknown branch', () => {
    expect(deriveMergeCost(false, "feature/x")).toBe("none");
  });

  it('returns "none" when autoDeploy is false and watchedRef is null', () => {
    expect(deriveMergeCost(false, null)).toBe("none");
  });
});

// ── getDeployPosture ──────────────────────────────────────────────────────────

describe("getDeployPosture", () => {
  it("returns all required top-level keys", async () => {
    const posture = await getDeployPosture();
    expect(posture).toHaveProperty("autoDeploy");
    expect(posture).toHaveProperty("watchedRepo");
    expect(posture).toHaveProperty("watchedRef");
    expect(posture).toHaveProperty("runningCommit");
    expect(posture).toHaveProperty("headCommit");
    expect(posture).toHaveProperty("upToDate");
    expect(posture).toHaveProperty("deploy");
    expect(posture).toHaveProperty("runnerChannel");
    expect(posture).toHaveProperty("mergeCost");
  });

  it("autoDeploy on, head !== running → upToDate false, mergeCost deploy+image", async () => {
    const posture = await getDeployPosture();
    expect(posture.autoDeploy).toBe(true);
    expect(posture.upToDate).toBe(false);
    expect(posture.mergeCost).toBe("deploy+image");
    expect(posture.watchedRepo).toBe("BuildDownAI/AI-Implement");
    expect(posture.watchedRef).toBe("testing");
  });

  it("autoDeploy on, head === running → upToDate true", async () => {
    (deployAvailabilityMock.getAvailability as ReturnType<typeof vi.fn>).mockReturnValue({
      available: false,
      runningCommit: "abc",
      headCommit: "abc",
      checkedAt: Date.now(),
      isDowngrade: false,
    });
    const posture = await getDeployPosture();
    expect(posture.upToDate).toBe(true);
    expect(posture.mergeCost).toBe("deploy+image");
  });

  it("autoDeploy off, watchedRef testing → mergeCost image", async () => {
    (deployPolicyMock.getDeployPolicy as ReturnType<typeof vi.fn>).mockReturnValue({
      autoDeploy: false,
      notifyAvailable: true,
      watchedRepo: "BuildDownAI/AI-Implement",
      watchedRef: "testing",
    });
    const posture = await getDeployPosture();
    expect(posture.autoDeploy).toBe(false);
    expect(posture.mergeCost).toBe("image");
  });

  it("autoDeploy off, watchedRef main → mergeCost image", async () => {
    (deployPolicyMock.getDeployPolicy as ReturnType<typeof vi.fn>).mockReturnValue({
      autoDeploy: false,
      notifyAvailable: true,
      watchedRepo: "BuildDownAI/AI-Implement",
      watchedRef: "main",
    });
    (deployAvailabilityMock.resolveDeployTarget as ReturnType<typeof vi.fn>).mockReturnValue({
      ...TARGET,
      branch: "main",
    });
    const posture = await getDeployPosture();
    expect(posture.mergeCost).toBe("image");
  });

  it("autoDeploy off, watchedRef feature/x → mergeCost none, channelTag null", async () => {
    (deployPolicyMock.getDeployPolicy as ReturnType<typeof vi.fn>).mockReturnValue({
      autoDeploy: false,
      notifyAvailable: true,
      watchedRepo: "BuildDownAI/AI-Implement",
      watchedRef: "feature/x",
    });
    (deployAvailabilityMock.resolveDeployTarget as ReturnType<typeof vi.fn>).mockReturnValue({
      ...TARGET,
      branch: "feature/x",
    });
    const posture = await getDeployPosture();
    expect(posture.mergeCost).toBe("none");
    expect(posture.runnerChannel.channelTag).toBeNull();
    expect(posture.runnerChannel.channelCommit).toBeNull();
    expect(posture.runnerChannel.matchesHead).toBeNull();
  });

  it("deploy held → deploy.held true", async () => {
    (deployHoldMock.isDeployHeld as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const posture = await getDeployPosture();
    expect(posture.deploy.held).toBe(true);
    expect(posture.deploy.inFlight).toBe(false);
  });

  it("deploy held + runner jobs in flight → deploy.held true, deploy.inFlight true", async () => {
    (deployHoldMock.isDeployHeld as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (inFlightWorkMock.getInFlightWork as ReturnType<typeof vi.fn>).mockReturnValue([
      { kind: "runner-job", count: 2 },
    ]);
    const posture = await getDeployPosture();
    expect(posture.deploy.held).toBe(true);
    expect(posture.deploy.inFlight).toBe(true);
  });

  it("lastOutcome null when no deploy has completed", async () => {
    (deployNotifyMock.getDeployOutcome as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const posture = await getDeployPosture();
    expect(posture.deploy.lastOutcome).toBeNull();
  });

  it("lastOutcome surfaces deploy outcome kind", async () => {
    (deployNotifyMock.getDeployOutcome as ReturnType<typeof vi.fn>).mockReturnValue({
      kind: "deployed-ok",
      commit: "aaa",
      at: Date.now(),
    });
    const posture = await getDeployPosture();
    expect(posture.deploy.lastOutcome).toBe("deployed-ok");
  });

  it("registry failure → channelCommit null, matchesHead null, no error", async () => {
    (repoImageMock.resolveChannelCommit as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("registry error"),
    );
    const posture = await getDeployPosture();
    expect(posture.runnerChannel.channelCommit).toBeNull();
    expect(posture.runnerChannel.matchesHead).toBeNull();
  });

  it("channelCommit matches headCommit → matchesHead true", async () => {
    (deployAvailabilityMock.getAvailability as ReturnType<typeof vi.fn>).mockReturnValue({
      available: false,
      runningCommit: "abc",
      headCommit: "def",
      checkedAt: Date.now(),
      isDowngrade: false,
    });
    (repoImageMock.resolveChannelCommit as ReturnType<typeof vi.fn>).mockResolvedValue("def");
    const posture = await getDeployPosture();
    expect(posture.runnerChannel.channelCommit).toBe("def");
    expect(posture.runnerChannel.matchesHead).toBe(true);
  });

  it("channelCommit mismatches headCommit → matchesHead false", async () => {
    (deployAvailabilityMock.getAvailability as ReturnType<typeof vi.fn>).mockReturnValue({
      available: true,
      runningCommit: "abc",
      headCommit: "def",
      checkedAt: Date.now(),
      isDowngrade: false,
    });
    (repoImageMock.resolveChannelCommit as ReturnType<typeof vi.fn>).mockResolvedValue("zzz");
    const posture = await getDeployPosture();
    expect(posture.runnerChannel.channelCommit).toBe("zzz");
    expect(posture.runnerChannel.matchesHead).toBe(false);
  });

  it("no stamps (resolveDeployTarget → null) → watchedRepo null, watchedRef null, upToDate null", async () => {
    (deployAvailabilityMock.resolveDeployTarget as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (deployAvailabilityMock.getAvailability as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const posture = await getDeployPosture();
    expect(posture.watchedRepo).toBeNull();
    expect(posture.watchedRef).toBeNull();
    expect(posture.runningCommit).toBeNull();
    expect(posture.headCommit).toBeNull();
    expect(posture.upToDate).toBeNull();
  });

  it("runnerChannel.channelTag is next for testing branch", async () => {
    const posture = await getDeployPosture();
    expect(posture.runnerChannel.channelTag).toBe("next");
    expect(posture.runnerChannel.image).toBe("ghcr.io/builddownai/ai-implement-runner");
  });

  it("resolveChannelCommit is called with imageBase and channelTag", async () => {
    await getDeployPosture();
    expect(repoImageMock.resolveChannelCommit).toHaveBeenCalledWith(
      "ghcr.io/builddownai/ai-implement-runner",
      "next",
      undefined,
    );
  });

  it("passes fetchImpl to resolveChannelCommit", async () => {
    const fakeFetch = vi.fn();
    await getDeployPosture({ fetchImpl: fakeFetch as unknown as typeof fetch });
    expect(repoImageMock.resolveChannelCommit).toHaveBeenCalledWith(
      "ghcr.io/builddownai/ai-implement-runner",
      "next",
      fakeFetch,
    );
  });
});
