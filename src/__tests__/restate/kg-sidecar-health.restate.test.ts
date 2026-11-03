// Real Restate coverage for the KgSidecarHealth object (AII-1527), on both variants.
//
// Run with `npm run test:restate`; excluded from `npm test`.
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { testDb } from "../helpers/test-db.js";
import type { SidecarHealth } from "../../kg-provider.js";
import { createKgSidecarHealth } from "../../restate/kg-sidecar-health.js";
import type { RestateEnvironment } from "./harness.js";
import { VARIANTS, callObject, eventually, gate, journalEntries, journaledRunResult, queryInvocations, settle, startVariants, stopAll } from "./harness.js";

const health = (lastError: string | null, checkedAt: number): SidecarHealth => ({
  reachable: lastError === null,
  toolsListed: lastError === null,
  lastError,
  checkedAt,
});

let nextProbe: () => Promise<SidecarHealth | null> = async () => null;
let nextNotify: () => Promise<void> = async () => {};
let nextClear: () => void = () => {};
let envs: Map<string, RestateEnvironment>;

beforeAll(async () => {
  envs = await startVariants([createKgSidecarHealth({ probe: () => nextProbe(), notifyRecovery: () => nextNotify(), clearRecovery: () => nextClear() })]);
}, 60_000);

afterAll(async () => {
  await stopAll(envs);
});

describe.each(VARIANTS.map(([label]) => label))("KgSidecarHealth (%s)", (label) => {
  const env = () => envs.get(label)!;
  const check = () => callObject<SidecarHealth | null>(env().baseUrl(), "KgSidecarHealth", "sidecar", "check", undefined);

  it("journals recovery once after a warning and stays silent without one", async () => {
    const { modules: { deploy, dedup, kg } } = await testDb({ modules: {
      deploy: () => import("../../deploy-notify.js"),
      dedup: () => import("../../dedup.js"),
      kg: () => import("../../kg-provider.js"),
    } });
    const messages: string[] = [];
    let failRecovery = false;
    let failedAttempts = 0;
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (url === "https://notice.example.test") {
        const payload = JSON.parse(String(init?.body));
        if (failRecovery) {
          failedAttempts++;
          return new Response("unavailable", { status: 503 });
        }
        messages.push(payload.text ?? payload.blocks[0].text.text);
        return new Response("ok");
      }
      return realFetch(url, init);
    });
    onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); nextNotify = async () => {}; nextClear = () => {}; });
    nextNotify = () => deploy.postKgRecoveryNotice();
    nextClear = () => deploy.clearKgRecoveryNotice();
    nextProbe = async () => health(null, 9000);
    await check();
    expect(messages).toEqual([]);
    vi.stubEnv("FLY_IMAGE_REF", "new-image");
    dedup.getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("deploy_last_image_ref", "old-image");
    Object.assign(kg.sidecarHealth, health("timed out", 8000));
    await deploy.postBootNotice({ notifyType: "slack", notifyWebhookUrl: "https://notice.example.test", kgSidecarUrl: null }, {
      probe: async () => health("timed out", 8000), deadlineMs: 0,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("⚠️ KG sidecar not serving — timed out");
    expect(deploy.hasKgRecoveryNotice()).toBe(true);
    messages.length = 0;
    // The idempotency key re-attaches to the same invocation, including on alwaysReplay.
    const send = () => fetch(`${env().baseUrl()}/KgSidecarHealth/sidecar/check`, {
      method: "POST", headers: { "idempotency-key": `recovery-${label}` },
    });
    expect((await send()).ok).toBe(true);
    expect((await send()).ok).toBe(true);
    await check();
    expect(messages).toEqual(["✅ KG sidecar serving again"]);
    const rows = await queryInvocations(env().adminAPIBaseUrl(), "target_service_name = 'KgSidecarHealth' AND target_handler_name = 'check'");
    const entries = await Promise.all(rows.map(row => journalEntries(env().adminAPIBaseUrl(), String(row.id))));
    expect(JSON.stringify(entries)).toContain("notify-recovery");
    // A webhook outage must release this exclusive handler and abandon the notice.
    dedup.getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("deploy_last_image_ref", "old-image");
    await deploy.postBootNotice({ notifyType: "slack", notifyWebhookUrl: "https://notice.example.test", kgSidecarUrl: null }, {
      probe: async () => health("timed out", 8000), deadlineMs: 0,
    });
    expect(deploy.hasKgRecoveryNotice()).toBe(true);
    failRecovery = true;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await check()).toEqual(health(null, 9000));
    expect(failedAttempts).toBe(3);
    expect(deploy.hasKgRecoveryNotice()).toBe(false);
    const recoveryWarnings = () => warning.mock.calls.filter(([message]) =>
      String(message).startsWith("[deploy-notify] KG recovery notice failed:"));
    expect(recoveryWarnings()).toEqual([
      ["[deploy-notify] KG recovery notice failed: Webhook notification failed: 503 — unavailable"],
    ]);
    expect(await check()).toEqual(health(null, 9000));
    expect(failedAttempts).toBe(3);
    expect(recoveryWarnings()).toHaveLength(1);
  });

  it("returns the probe result and journals it", async () => {
    const result = health(null, 1000);
    nextProbe = async () => result;
    expect(await check()).toEqual(result);
    const rows = await eventually(
      () => queryInvocations(env().adminAPIBaseUrl(), "target_service_name = 'KgSidecarHealth' AND target_handler_name = 'check'"),
      (r) => r.length > 0,
      { label: "check invocation" },
    );
    const entries = await Promise.all(rows.map(row => journalEntries(env().adminAPIBaseUrl(), String(row.id))));
    expect(entries.map(entry => journaledRunResult(entry, "probe"))).toContainEqual(result);
  });

  it("probes again on each check after a repeated failure", async () => {
    let calls = 0;
    nextProbe = async () => health("KG sidecar request timed out after 10000ms", 2000 + ++calls);
    const first = await check();
    const second = await check();
    expect(calls).toBe(2);
    expect(first?.checkedAt).toBe(2001);
    expect(second?.checkedAt).toBe(2002);
  });

  it("never runs two probes at once", async () => {
    const hold = gate("probe");
    let running = 0;
    let max = 0;
    let calls = 0;
    nextProbe = async () => {
      calls++;
      running++;
      max = Math.max(max, running);
      await hold.wait();
      running--;
      return health("timed out", 3000 + calls);
    };
    const send = () => fetch(`${env().baseUrl()}/KgSidecarHealth/sidecar/check/send`, { method: "POST" });
    expect((await send()).ok).toBe(true);
    await hold.reached();
    expect((await send()).ok).toBe(true);
    await settle(300);
    hold.release();
    await eventually(
      async () => calls,
      (n) => n === 2,
      { label: "both probes ran" },
    );
    expect(max).toBe(1);
  });

  it("answers null when the probe has nothing to do", async () => {
    nextProbe = async () => null;
    expect(await check()).toBeNull();
  });
});
