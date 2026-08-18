import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DedupModule from "../dedup.js";
import type * as DeployModule from "../deploy.js";
import type * as DeployNotifyModule from "../deploy-notify.js";
import type * as NotifyModule from "../notify.js";

// The formatters are covered by notify.test.ts; here we only care that the right
// payload reaches them, so the whole notify module is replaced by a spy.
vi.mock("../notify.js", () => ({ notifyDeploy: vi.fn() }));

// interpretMcpProbe is tested by deploy.test.ts; mock it so deploy-notify tests
// control the probe result without fetching or spawning flyctl.
vi.mock("../deploy.js", () => ({ interpretMcpProbe: vi.fn() }));

const IMAGE_A = "registry.fly.io/orch:deployment-AAA";
const IMAGE_B = "registry.fly.io/orch:deployment-BBB";
const LAST_IMAGE_REF_KEY = "deploy_last_image_ref";
const LAST_SHUTDOWN_AT_KEY = "deploy_last_shutdown_at";
const DEPLOY_OUTCOME_KEY = "deploy_last_outcome";

const config = { notifyType: "slack", notifyWebhookUrl: "https://hook.example.com" };

let dbPath: string;
let dedup: typeof DedupModule;
let deployModule: typeof DeployModule;
let deployNotify: typeof DeployNotifyModule;
let notify: typeof NotifyModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `deploy-notify-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  const runnerMode = await import("../runner-mode.js");
  runnerMode.initSettingsTable();
  deployModule = await import("../deploy.js");
  deployNotify = await import("../deploy-notify.js");
  notify = await import("../notify.js");
});

afterEach(() => {
  dedup.closeDb();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

/** Puts the process in "running as a Fly Machine on this image" state. */
function onFly(imageRef: string): void {
  vi.stubEnv("FLY_IMAGE_REF", imageRef);
  vi.stubEnv("FLY_APP_NAME", "ai-implement-testing-orchestrator");
  vi.stubEnv("FLY_REGION", "iad");
}

function readKey(key: string): string | null {
  const row = dedup.getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeKey(key: string, value: string): void {
  dedup.getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

// ---------- The decision, as a table. No database, no clock, no network. ----------

describe("decideBootNotification", () => {
  const base = { currentImageRef: IMAGE_B, prevImageRef: IMAGE_A, lastShutdownAt: 1_000, now: 4_000 };

  it("stays silent on the first boot of a fresh volume", () => {
    expect(deployNotify.decideBootNotification({ ...base, prevImageRef: null })).toBeNull();
  });

  it("reports a deploy when the image ref changed", () => {
    expect(deployNotify.decideBootNotification(base)).toEqual({ kind: "deployed", downtimeMs: 3_000 });
  });

  // A SIGKILLed process runs no handler, so there is no timestamp — but the stored ref
  // survives from the last successful boot, so the classification still holds.
  it("reports a deploy after a hard kill, without a downtime figure", () => {
    expect(deployNotify.decideBootNotification({ ...base, lastShutdownAt: null })).toEqual({
      kind: "deployed",
      downtimeMs: null,
    });
  });

  it("reports a restart when the ref is unchanged and a shutdown was announced", () => {
    expect(deployNotify.decideBootNotification({ ...base, currentImageRef: IMAGE_A })).toEqual({
      kind: "restarted",
      downtimeMs: 3_000,
    });
  });

  // Nothing told the channel this process stopped, so nothing needs to tell it we are back.
  it("stays silent when the ref is unchanged and nothing announced a stop", () => {
    expect(
      deployNotify.decideBootNotification({ ...base, currentImageRef: IMAGE_A, lastShutdownAt: null }),
    ).toBeNull();
  });

  it("clamps downtime to zero rather than reporting a negative duration", () => {
    expect(deployNotify.decideBootNotification({ ...base, now: 500 })).toEqual({
      kind: "deployed",
      downtimeMs: 0,
    });
  });
});

// ---------- The shell around it ----------

describe("recordShutdown", () => {
  it("records a timestamp when running on Fly", () => {
    onFly(IMAGE_A);
    deployNotify.recordShutdown();
    expect(Number(readKey(LAST_SHUTDOWN_AT_KEY))).toBeGreaterThan(0);
  });

  it("records nothing off Fly", () => {
    deployNotify.recordShutdown();
    expect(readKey(LAST_SHUTDOWN_AT_KEY)).toBeNull();
  });
});

describe("postShutdownNotice", () => {
  it("posts a shutdown notice with no downtime figure", async () => {
    onFly(IMAGE_A);
    await deployNotify.postShutdownNotice(config);

    expect(notify.notifyDeploy).toHaveBeenCalledOnce();
    const [type, url, payload] = vi.mocked(notify.notifyDeploy).mock.calls[0];
    expect(type).toBe("slack");
    expect(url).toBe(config.notifyWebhookUrl);
    expect(payload).toMatchObject({
      kind: "shutdown",
      appName: "ai-implement-testing-orchestrator",
      region: "iad",
      imageRef: IMAGE_A,
      downtimeMs: null,
    });
  });

  it("stays silent off Fly", async () => {
    await deployNotify.postShutdownNotice(config);
    expect(notify.notifyDeploy).not.toHaveBeenCalled();
  });

  it("stays silent when no webhook is configured", async () => {
    onFly(IMAGE_A);
    await deployNotify.postShutdownNotice({ ...config, notifyWebhookUrl: null });
    expect(notify.notifyDeploy).not.toHaveBeenCalled();
  });

  // A dead webhook must never wedge a shutdown that Fly is already counting down.
  it("swallows a webhook failure", async () => {
    onFly(IMAGE_A);
    vi.mocked(notify.notifyDeploy).mockRejectedValueOnce(new Error("Slack webhook failed: 500"));
    await expect(deployNotify.postShutdownNotice(config)).resolves.toBeUndefined();
  });
});

describe("postBootNotice", () => {
  it("stays silent and writes nothing off Fly", async () => {
    await deployNotify.postBootNotice(config);
    expect(notify.notifyDeploy).not.toHaveBeenCalled();
    expect(readKey(LAST_IMAGE_REF_KEY)).toBeNull();
  });

  it("records the ref silently on a first boot", async () => {
    onFly(IMAGE_A);
    await deployNotify.postBootNotice(config);

    expect(notify.notifyDeploy).not.toHaveBeenCalled();
    expect(readKey(LAST_IMAGE_REF_KEY)).toBe(IMAGE_A);
  });

  it("announces a deploy and advances the stored ref", async () => {
    writeKey(LAST_IMAGE_REF_KEY, IMAGE_A);
    onFly(IMAGE_B);
    await deployNotify.postBootNotice(config);

    expect(vi.mocked(notify.notifyDeploy).mock.calls[0][2]).toMatchObject({ kind: "deployed", imageRef: IMAGE_B });
    expect(readKey(LAST_IMAGE_REF_KEY)).toBe(IMAGE_B);
  });

  // Otherwise a later restart would measure its downtime from a deploy that already resolved.
  it("clears the shutdown record once it has been consumed", async () => {
    writeKey(LAST_IMAGE_REF_KEY, IMAGE_A);
    writeKey(LAST_SHUTDOWN_AT_KEY, String(Date.now() - 5_000));
    onFly(IMAGE_B);
    await deployNotify.postBootNotice(config);

    expect(readKey(LAST_SHUTDOWN_AT_KEY)).toBeNull();
  });

  // State is bookkeeping, not a side effect of notifying: if it only advanced when a webhook
  // was set, enabling notifications later would announce a deploy that happened weeks ago.
  it("advances state even when no webhook is configured", async () => {
    writeKey(LAST_IMAGE_REF_KEY, IMAGE_A);
    onFly(IMAGE_B);
    await deployNotify.postBootNotice({ ...config, notifyWebhookUrl: null });

    expect(notify.notifyDeploy).not.toHaveBeenCalled();
    expect(readKey(LAST_IMAGE_REF_KEY)).toBe(IMAGE_B);
  });

  it("swallows a webhook failure", async () => {
    writeKey(LAST_IMAGE_REF_KEY, IMAGE_A);
    onFly(IMAGE_B);
    vi.mocked(notify.notifyDeploy).mockRejectedValueOnce(new Error("Slack webhook failed: 500"));
    await expect(deployNotify.postBootNotice(config)).resolves.toBeUndefined();
  });

  // index.ts calls this fire-and-forget so a hanging webhook cannot stall startup, which is
  // only safe while every write sits above the first await. A webhook that never settles must
  // therefore still leave the state fully advanced once control returns.
  it("persists state synchronously, before the webhook is awaited", () => {
    writeKey(LAST_IMAGE_REF_KEY, IMAGE_A);
    writeKey(LAST_SHUTDOWN_AT_KEY, String(Date.now() - 5_000));
    onFly(IMAGE_B);
    vi.mocked(notify.notifyDeploy).mockReturnValueOnce(new Promise(() => { /* never settles */ }));

    void deployNotify.postBootNotice(config); // deliberately not awaited

    expect(readKey(LAST_IMAGE_REF_KEY)).toBe(IMAGE_B);
    expect(readKey(LAST_SHUTDOWN_AT_KEY)).toBeNull();
  });

  it("ignores a corrupt shutdown timestamp rather than reporting a nonsense duration", async () => {
    writeKey(LAST_IMAGE_REF_KEY, IMAGE_A);
    writeKey(LAST_SHUTDOWN_AT_KEY, "not-a-number");
    onFly(IMAGE_B);
    await deployNotify.postBootNotice(config);

    expect(vi.mocked(notify.notifyDeploy).mock.calls[0][2]).toMatchObject({ downtimeMs: null });
  });

  // ---------- Hold-aware outcome recording ----------

  it("does not probe or record an outcome when holdWasSet is false", async () => {
    writeKey(LAST_IMAGE_REF_KEY, IMAGE_A);
    onFly(IMAGE_B);
    const fetchMock = vi.fn();
    await deployNotify.postBootNotice(config, { holdWasSet: false, fetchImpl: fetchMock });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deployNotify.getDeployOutcome()).toBeNull();
  });

  it("records deployed-ok when the hold was set and /mcp returns 401", async () => {
    writeKey(LAST_IMAGE_REF_KEY, IMAGE_A);
    onFly(IMAGE_B);
    vi.stubEnv("AI_IMPLEMENT_SOURCE_COMMIT", "abc1234");
    vi.mocked(deployModule.interpretMcpProbe).mockReturnValue({ serving: true });
    const fetchMock = vi.fn().mockResolvedValue({ status: 401, text: vi.fn().mockResolvedValue("") });
    await deployNotify.postBootNotice(config, { holdWasSet: true, fetchImpl: fetchMock });
    const outcome = deployNotify.getDeployOutcome();
    expect(outcome).toMatchObject({ kind: "deployed-ok", commit: "abc1234" });
    expect(typeof outcome?.timestamp).toBe("number");
  });

  it("records deployed-not-serving when /mcp returns 503", async () => {
    writeKey(LAST_IMAGE_REF_KEY, IMAGE_A);
    onFly(IMAGE_B);
    vi.mocked(deployModule.interpretMcpProbe).mockReturnValue({
      serving: false,
      reason: "mcp-unavailable" as const,
      detail: "KG sidecar unavailable",
    });
    const fetchMock = vi.fn().mockResolvedValue({ status: 503, text: vi.fn().mockResolvedValue("KG sidecar unavailable") });
    await deployNotify.postBootNotice(config, { holdWasSet: true, fetchImpl: fetchMock });
    const outcome = deployNotify.getDeployOutcome();
    expect(outcome?.kind).toBe("deployed-not-serving");
    expect(outcome?.detail).toBe("KG sidecar unavailable");
  });

  it("records deployed-not-serving when the fetch probe throws", async () => {
    writeKey(LAST_IMAGE_REF_KEY, IMAGE_A);
    onFly(IMAGE_B);
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await deployNotify.postBootNotice(config, { holdWasSet: true, fetchImpl: fetchMock });
    const outcome = deployNotify.getDeployOutcome();
    expect(outcome?.kind).toBe("deployed-not-serving");
    expect(outcome?.detail).toContain("ECONNREFUSED");
  });

  it("records deployed-not-serving when FLY_APP_NAME is not set", async () => {
    writeKey(LAST_IMAGE_REF_KEY, IMAGE_A);
    // FLY_IMAGE_REF set (so postBootNotice runs) but FLY_APP_NAME absent (so probe URL unknown)
    vi.stubEnv("FLY_IMAGE_REF", IMAGE_B);
    const fetchMock = vi.fn();
    await deployNotify.postBootNotice(config, { holdWasSet: true, fetchImpl: fetchMock });
    expect(fetchMock).not.toHaveBeenCalled();
    const outcome = deployNotify.getDeployOutcome();
    expect(outcome?.kind).toBe("deployed-not-serving");
    expect(outcome?.detail).toContain("FLY_APP_NAME");
  });

  it("does not record an outcome when holdWasSet is true but the image is unchanged", async () => {
    writeKey(LAST_IMAGE_REF_KEY, IMAGE_A);
    onFly(IMAGE_A); // same image — no replacement
    const fetchMock = vi.fn();
    await deployNotify.postBootNotice(config, { holdWasSet: true, fetchImpl: fetchMock });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deployNotify.getDeployOutcome()).toBeNull();
  });

  it("does not record an outcome on a fresh volume even with the hold set", async () => {
    // prevImageRef is null — first boot; we cannot tell if this is a replacement.
    onFly(IMAGE_B);
    const fetchMock = vi.fn();
    await deployNotify.postBootNotice(config, { holdWasSet: true, fetchImpl: fetchMock });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deployNotify.getDeployOutcome()).toBeNull();
  });

  it("uses AI_IMPLEMENT_SOURCE_COMMIT as the outcome commit when set", async () => {
    writeKey(LAST_IMAGE_REF_KEY, IMAGE_A);
    onFly(IMAGE_B);
    vi.stubEnv("AI_IMPLEMENT_SOURCE_COMMIT", "deadbeef");
    vi.mocked(deployModule.interpretMcpProbe).mockReturnValue({ serving: true });
    const fetchMock = vi.fn().mockResolvedValue({ status: 401, text: vi.fn().mockResolvedValue("") });
    await deployNotify.postBootNotice(config, { holdWasSet: true, fetchImpl: fetchMock });
    expect(deployNotify.getDeployOutcome()?.commit).toBe("deadbeef");
  });

  it("sends exactly one webhook notification even when the outcome is recorded", async () => {
    writeKey(LAST_IMAGE_REF_KEY, IMAGE_A);
    onFly(IMAGE_B);
    vi.mocked(deployModule.interpretMcpProbe).mockReturnValue({ serving: true });
    const fetchMock = vi.fn().mockResolvedValue({ status: 401, text: vi.fn().mockResolvedValue("") });
    await deployNotify.postBootNotice(config, { holdWasSet: true, fetchImpl: fetchMock });
    expect(notify.notifyDeploy).toHaveBeenCalledOnce();
    expect(vi.mocked(notify.notifyDeploy).mock.calls[0][2]).toMatchObject({ kind: "deployed" });
  });
});

// ---------- The two halves in sequence, which is how they actually run ----------

describe("shutdown → boot cycle", () => {
  it("reports a deploy with measured downtime across a version change", async () => {
    onFly(IMAGE_A);
    await deployNotify.postBootNotice(config); // first boot: records IMAGE_A silently
    vi.mocked(notify.notifyDeploy).mockClear();

    deployNotify.recordShutdown();
    await deployNotify.postShutdownNotice(config);

    onFly(IMAGE_B); // the replacement machine
    await deployNotify.postBootNotice(config);

    const kinds = vi.mocked(notify.notifyDeploy).mock.calls.map((c) => c[2].kind);
    expect(kinds).toEqual(["shutdown", "deployed"]);
    expect(vi.mocked(notify.notifyDeploy).mock.calls[1][2].downtimeMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a restart when the same image comes back", async () => {
    onFly(IMAGE_A);
    await deployNotify.postBootNotice(config);
    vi.mocked(notify.notifyDeploy).mockClear();

    deployNotify.recordShutdown();
    await deployNotify.postShutdownNotice(config);
    await deployNotify.postBootNotice(config); // same IMAGE_A

    const kinds = vi.mocked(notify.notifyDeploy).mock.calls.map((c) => c[2].kind);
    expect(kinds).toEqual(["shutdown", "restarted"]);
  });
});

describe("postAvailableNotice", () => {
  it("names the commit and does not pretend an image exists", async () => {
    onFly(IMAGE_A);
    await deployNotify.postAvailableNotice(config, "def5678abcdef");

    expect(notify.notifyDeploy).toHaveBeenCalledOnce();
    const [type, url, payload] = vi.mocked(notify.notifyDeploy).mock.calls[0];
    expect(type).toBe("slack");
    expect(url).toBe(config.notifyWebhookUrl);
    expect(payload).toMatchObject({
      kind: "available",
      appName: "ai-implement-testing-orchestrator",
      region: "iad",
      imageRef: null,
      commit: "def5678abcdef",
    });
  });

  it("posts off Fly too, unlike the boot and shutdown notices", async () => {
    // Those gate on FLY_IMAGE_REF because they describe this machine's own lifecycle
    // and would fire on every local Ctrl-C. Availability is a fact about the repository
    // against the running commit, and is meaningful wherever self-deploy is configured.
    await deployNotify.postAvailableNotice(config, "def5678");
    expect(notify.notifyDeploy).toHaveBeenCalledOnce();
  });

  it("stays silent with no webhook configured", async () => {
    onFly(IMAGE_A);
    await deployNotify.postAvailableNotice({ ...config, notifyWebhookUrl: null }, "def5678");
    expect(notify.notifyDeploy).not.toHaveBeenCalled();
  });

  it("swallows a webhook failure rather than failing the poll", async () => {
    // It runs as a poll passenger; a dead webhook must not stall dispatch.
    onFly(IMAGE_A);
    vi.mocked(notify.notifyDeploy).mockRejectedValueOnce(new Error("Slack webhook failed: 500"));
    await expect(deployNotify.postAvailableNotice(config, "def5678")).resolves.toBeUndefined();
  });
});

describe("recordDeployOutcome / getDeployOutcome", () => {
  it("returns null when nothing has been recorded", () => {
    expect(deployNotify.getDeployOutcome()).toBeNull();
  });

  it("round-trips a deployed-ok outcome", () => {
    const outcome = { kind: "deployed-ok" as const, commit: "abc123", timestamp: 12345 };
    deployNotify.recordDeployOutcome(outcome);
    expect(deployNotify.getDeployOutcome()).toEqual(outcome);
  });

  it("round-trips a build-failed outcome with a detail", () => {
    const outcome = { kind: "build-failed" as const, commit: "def456", timestamp: 99999, detail: "flyctl exited 1" };
    deployNotify.recordDeployOutcome(outcome);
    expect(deployNotify.getDeployOutcome()).toEqual(outcome);
  });

  it("overwrites a previous outcome with the latest one", () => {
    deployNotify.recordDeployOutcome({ kind: "build-failed" as const, commit: "old", timestamp: 1 });
    deployNotify.recordDeployOutcome({ kind: "deployed-ok" as const, commit: "new", timestamp: 2 });
    expect(deployNotify.getDeployOutcome()?.kind).toBe("deployed-ok");
  });

  it("returns null when the stored value is corrupt JSON", () => {
    dedup.getDb()
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run("deploy_last_outcome", "not-json{");
    expect(deployNotify.getDeployOutcome()).toBeNull();
  });
});
