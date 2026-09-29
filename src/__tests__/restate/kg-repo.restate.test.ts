// Real Restate 1.7.10 coordination tests for AII-894's KgRepo single-flight lock.
// KgRepo sends to a fake "KgRefresh" service registered alongside it so this file can
// count and inspect the sends without depending on the real workflow module.
import { randomUUID } from "node:crypto";
import * as restate from "@restatedev/restate-sdk";
import type { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKgRepo, type KgRepoTriggerResult } from "../../restate/kg-repo.js";
import { KG_REFRESH_TOTAL_DEADLINE_MS } from "../../restate/kg-refresh-workflow.js";
import { VARIANTS, callObject, startVariants, stopAll } from "./harness.js";

const FAKE_WORKFLOW_NAME = "FakeKgRefresh";
// KgRepo's staleness check is `age < KG_REFRESH_TOTAL_DEADLINE_MS + staleMarginMs`.
// A large negative margin collapses the real 4h+10min threshold down to FRESH_WINDOW_MS,
// so R2 (still fresh) and R4 (now stale) are both provable in real test time.
const FRESH_WINDOW_MS = 3_000;
const STALE_MARGIN_MS = FRESH_WINDOW_MS - KG_REFRESH_TOTAL_DEADLINE_MS;

interface RunSend {
  key: string;
  parameter: { triggerId: string };
}

describe("KgRepo durable single-flight lock", () => {
  const runSends: RunSend[] = [];

  const fakeKgRefresh = restate.object({
    name: FAKE_WORKFLOW_NAME,
    handlers: {
      run: async (ctx: restate.ObjectContext, input: { triggerId: string }): Promise<void> => {
        runSends.push({ key: ctx.key, parameter: input });
      },
    },
  });

  const kgRepo = createKgRepo({ workflowName: FAKE_WORKFLOW_NAME, staleMarginMs: STALE_MARGIN_MS });

  let envs: Map<string, RestateTestEnvironment>;
  beforeAll(async () => {
    envs = await startVariants([kgRepo, fakeKgRefresh]);
  }, 60_000);
  afterAll(async () => {
    if (envs) await stopAll(envs);
  });

  function envFor(label: string): RestateTestEnvironment {
    const env = envs.get(label);
    if (!env) throw new Error(`missing Restate variant ${label}`);
    return env;
  }

  function newKey(): string {
    return `buildDownAI/kg-source-${randomUUID()}`;
  }

  async function trigger(baseUrl: string, key: string): Promise<KgRepoTriggerResult> {
    return callObject<KgRepoTriggerResult>(baseUrl, "KgRepo", key, "trigger", {});
  }

  it.each(VARIANTS.map(([label]) => label))(
    "R1/R2: trigger mints once and sends once; a second trigger while in flight returns the same id with no second send (%s)",
    async (label) => {
      const env = envFor(label);
      const key = newKey();
      const before = runSends.length;

      const first = await trigger(env.baseUrl(), key);
      expect(first).not.toHaveProperty("status");
      const triggerId = (first as { triggerId: string }).triggerId;
      expect(typeof triggerId).toBe("string");
      expect(triggerId.length).toBeGreaterThan(0);

      const second = await trigger(env.baseUrl(), key);
      expect(second).toEqual({ status: "refresh-in-progress", triggerId });

      expect(runSends.length - before).toBe(1);
      expect(runSends[runSends.length - 1]).toEqual({ key: triggerId, parameter: { triggerId } });
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "R5: the in-flight refusal holds under replay too, still with exactly one send (%s)",
    async (label) => {
      const env = envFor(label);
      const key = newKey();
      const before = runSends.length;

      const first = await trigger(env.baseUrl(), key);
      const triggerId = (first as { triggerId: string }).triggerId;

      // Same assertion as R2, run again in the same (possibly alwaysReplay) environment —
      // this variant is what actually exercises replay, not a second call shape.
      const second = await trigger(env.baseUrl(), key);
      expect(second).toEqual({ status: "refresh-in-progress", triggerId });
      const third = await trigger(env.baseUrl(), key);
      expect(third).toEqual({ status: "refresh-in-progress", triggerId });

      expect(runSends.length - before).toBe(1);
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "R3: release with the wrong id is a no-op; the right id clears the marker for the next trigger (%s)",
    async (label) => {
      const env = envFor(label);
      const key = newKey();
      const before = runSends.length;

      const first = await trigger(env.baseUrl(), key);
      const triggerId = (first as { triggerId: string }).triggerId;

      await callObject(env.baseUrl(), "KgRepo", key, "release", { triggerId: "not-the-right-id" });
      const stillInFlight = await trigger(env.baseUrl(), key);
      expect(stillInFlight).toEqual({ status: "refresh-in-progress", triggerId });
      expect(runSends.length - before).toBe(1);

      await callObject(env.baseUrl(), "KgRepo", key, "release", { triggerId });
      const status = await callObject<{ triggerId: string; startedAt: number } | null>(env.baseUrl(), "KgRepo", key, "status", {});
      expect(status).toBeNull();

      const next = await trigger(env.baseUrl(), key);
      const nextTriggerId = (next as { triggerId: string }).triggerId;
      expect(nextTriggerId).not.toBe(triggerId);
      expect(runSends.length - before).toBe(2);
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "R4: a marker older than the total deadline plus the margin is treated as stale (%s)",
    async (label) => {
      const env = envFor(label);
      const key = newKey();
      const before = runSends.length;

      const first = await trigger(env.baseUrl(), key);
      const triggerId = (first as { triggerId: string }).triggerId;

      // Still fresh: well inside FRESH_WINDOW_MS.
      const stillFresh = await trigger(env.baseUrl(), key);
      expect(stillFresh).toEqual({ status: "refresh-in-progress", triggerId });

      await new Promise((resolve) => setTimeout(resolve, FRESH_WINDOW_MS + 750));

      const afterStale = await trigger(env.baseUrl(), key);
      const staleTriggerId = (afterStale as { triggerId: string }).triggerId;
      expect(staleTriggerId).not.toBe(triggerId);
      expect(runSends.length - before).toBe(2);
    },
    15_000,
  );
});
