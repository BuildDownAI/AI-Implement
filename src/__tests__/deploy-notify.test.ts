import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DedupModule from "../dedup.js";
import type * as DeployNotifyModule from "../deploy-notify.js";
import type * as NotifyModule from "../notify.js";

// The formatters are covered by notify.test.ts; here we only care that the right
// payload reaches them, so the whole notify module is replaced by a spy.
vi.mock("../notify.js", () => ({ notifyDeploy: vi.fn() }));

const IMAGE_A = "registry.fly.io/orch:deployment-AAA";
const IMAGE_B = "registry.fly.io/orch:deployment-BBB";
const LAST_IMAGE_REF_KEY = "deploy_last_image_ref";
const LAST_SHUTDOWN_AT_KEY = "deploy_last_shutdown_at";
const DEPLOY_OUTCOME_KEY = "deploy_last_outcome";
const SIDECAR = "http://127.0.0.1:8765";

const config = { notifyType: "slack", notifyWebhookUrl: "https://hook.example.com", kgSidecarUrl: SIDECAR };

let dbPath: string;
let dedup: typeof DedupModule;
let deployNotify: typeof DeployNotifyModule;
let notify: typeof NotifyModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `deploy-notify-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  const runnerMode = await import("../runner-mode.js");
  runnerMode.initSettingsTable();
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

describe("decideDeployOutcome", () => {
  const base = {
    holdWasSet: true,
    prevImageRef: IMAGE_A,
    currentImageRef: IMAGE_B,
    kgSidecarUrl: SIDECAR,
    commit: "abc1234",
    now: 1_700_000_000_000,
  };

  it("is null when no hold was set — nothing was deploying", () => {
    expect(deployNotify.decideDeployOutcome({ ...base, holdWasSet: false })).toBeNull();
  });

  it("is null on a fresh volume, where a replacement cannot be distinguished from a first boot", () => {
    expect(deployNotify.decideDeployOutcome({ ...base, prevImageRef: null })).toBeNull();
  });

  it("is null when the image is unchanged — a crash and restart, not a release", () => {
    expect(deployNotify.decideDeployOutcome({ ...base, currentImageRef: IMAGE_A })).toBeNull();
  });

  it("is deployed-ok when the sidecar URL is present", () => {
    expect(deployNotify.decideDeployOutcome(base)).toEqual({
      kind: "deployed-ok",
      commit: "abc1234",
      timestamp: 1_700_000_000_000,
    });
  });

  // The entrypoint exports KG_SIDECAR_URL only after the sidecar answers, so an absent
  // value means the image shipped without one — the failure this whole outcome exists for.
  it("is deployed-not-serving when the sidecar URL is absent, and says why", () => {
    const outcome = deployNotify.decideDeployOutcome({ ...base, kgSidecarUrl: null });
    expect(outcome).toMatchObject({ kind: "deployed-not-serving", commit: "abc1234" });
    expect(outcome?.detail).toContain("sidecar");
  });

  it("carries a null commit through rather than inventing one", () => {
    expect(deployNotify.decideDeployOutcome({ ...base, commit: null })?.commit).toBeNull();
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
  // The branch table is decideDeployOutcome's; these cover the wiring around it —
  // where each input comes from, and that the record lands independently of the webhook.

  it("records deployed-ok, taking the commit from the build stamp", async () => {
    writeKey(LAST_IMAGE_REF_KEY, IMAGE_A);
    onFly(IMAGE_B);
    vi.stubEnv("AI_IMPLEMENT_SOURCE_COMMIT", "abc1234");

    await deployNotify.postBootNotice(config, { holdWasSet: true });

    const outcome = deployNotify.getDeployOutcome();
    expect(outcome).toMatchObject({ kind: "deployed-ok", commit: "abc1234" });
    expect(typeof outcome?.timestamp).toBe("number");
  });

  it("records deployed-not-serving when the config carries no sidecar URL", async () => {
    writeKey(LAST_IMAGE_REF_KEY, IMAGE_A);
    onFly(IMAGE_B);

    await deployNotify.postBootNotice({ ...config, kgSidecarUrl: null }, { holdWasSet: true });

    expect(deployNotify.getDeployOutcome()?.kind).toBe("deployed-not-serving");
  });

  it("records nothing when no hold was set", async () => {
    writeKey(LAST_IMAGE_REF_KEY, IMAGE_A);
    onFly(IMAGE_B);

    await deployNotify.postBootNotice(config, { holdWasSet: false });

    expect(deployNotify.getDeployOutcome()).toBeNull();
  });

  it("records a null commit when the image carries no build stamp", async () => {
    writeKey(LAST_IMAGE_REF_KEY, IMAGE_A);
    onFly(IMAGE_B);
    delete process.env.AI_IMPLEMENT_SOURCE_COMMIT;

    await deployNotify.postBootNotice(config, { holdWasSet: true });

    expect(deployNotify.getDeployOutcome()?.commit).toBeNull();
  });

  // The point of the record: a deployment with no webhook still learns how its deploy went.
  it("records the outcome with no webhook configured, and posts nothing", async () => {
    writeKey(LAST_IMAGE_REF_KEY, IMAGE_A);
    onFly(IMAGE_B);

    await deployNotify.postBootNotice({ ...config, notifyWebhookUrl: null }, { holdWasSet: true });

    expect(deployNotify.getDeployOutcome()?.kind).toBe("deployed-ok");
    expect(notify.notifyDeploy).not.toHaveBeenCalled();
  });

  it("sends exactly one webhook notification alongside the record", async () => {
    writeKey(LAST_IMAGE_REF_KEY, IMAGE_A);
    onFly(IMAGE_B);

    await deployNotify.postBootNotice(config, { holdWasSet: true });

    expect(deployNotify.getDeployOutcome()?.kind).toBe("deployed-ok");
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
      .run(DEPLOY_OUTCOME_KEY, "not-json{");
    expect(deployNotify.getDeployOutcome()).toBeNull();
  });
});
