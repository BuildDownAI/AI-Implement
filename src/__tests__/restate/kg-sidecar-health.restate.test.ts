// Real Restate coverage for the KgSidecarHealth object (AII-1527), on both variants.
//
// Run with `npm run test:restate`; excluded from `npm test`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
let envs: Map<string, RestateEnvironment>;

beforeAll(async () => {
  envs = await startVariants([createKgSidecarHealth({ probe: () => nextProbe() })]);
}, 60_000);

afterAll(async () => {
  await stopAll(envs);
});

describe.each(VARIANTS.map(([label]) => label))("KgSidecarHealth (%s)", (label) => {
  const env = () => envs.get(label)!;
  const check = () => callObject<SidecarHealth | null>(env().baseUrl(), "KgSidecarHealth", "sidecar", "check", undefined);

  it("returns the probe result and journals it", async () => {
    const result = health(null, 1000);
    nextProbe = async () => result;
    expect(await check()).toEqual(result);
    const rows = await eventually(
      () => queryInvocations(env().adminAPIBaseUrl(), "target_service_name = 'KgSidecarHealth' AND target_handler_name = 'check'"),
      (r) => r.length > 0,
      { label: "check invocation" },
    );
    const entries = await journalEntries(env().adminAPIBaseUrl(), String(rows[rows.length - 1].id));
    expect(journaledRunResult(entries, "probe")).toEqual(result);
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
