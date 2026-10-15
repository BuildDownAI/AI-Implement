// Real Restate 1.7.10 coordination tests for AII-894's KgRepo single-flight lock.
// KgRepo sends to a fake "KgRefresh" service registered alongside it so this file can
// count and inspect the sends without depending on the real workflow module.
import { randomUUID } from "node:crypto";
import * as restate from "@restatedev/restate-sdk";
import type { RestateEnvironment } from "./harness.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_TRACKED_PRS } from "../../kg-refresh.js";
import { createKgRepo, type KgRepoEnqueueResult, type KgRepoTriggerResult } from "../../restate/kg-repo.js";
import { VARIANTS, callObject, callService, cancelInvocation, eventually, killInvocation, queryInvocations, setObjectState, settle, startVariants, stopAll } from "./harness.js";

const FAKE_WORKFLOW_NAME = "FakeKgRefresh";
const MARKER_AGE_WAIT_MS = 1_500;
const HOLD_MS = 24 * 60 * 60 * 1000;

interface RunSend {
  key: string;
  parameter: { triggerId: string; dryRun?: boolean; kgSourceRef?: string; acceptNewBaseline?: boolean; report?: { repo: string; prNumber: number; sha: string } };
}

// release, expire and recordDryRunOutcome are ingressPrivate (AII-976): only another handler
// may call them. This forwarder plays the workflow's part so scenarios can still drive them.
const privateCaller = restate.service({
  name: "KgRepoPrivateCaller",
  handlers: {
    call: async (ctx: restate.Context, input: { slug: string; handler: string; body: unknown }): Promise<unknown> =>
      ctx.genericCall({
        service: "KgRepo",
        method: input.handler,
        key: input.slug,
        parameter: input.body,
        inputSerde: restate.serde.json as restate.Serde<unknown>,
        outputSerde: restate.serde.json as restate.Serde<unknown>,
      }),
  },
});
async function callPrivate(baseUrl: string, slug: string, handler: "release" | "expire" | "recordDryRunOutcome" | "recordAdminDryRun", body: unknown): Promise<unknown> {
  return callService<unknown>(baseUrl, "KgRepoPrivateCaller", "call", { slug, handler, body });
}

describe("KgRepo durable single-flight lock", () => {
  const runSends: RunSend[] = [];

  const fakeKgRefresh = restate.object({
    name: FAKE_WORKFLOW_NAME,
    handlers: {
      run: async (ctx: restate.ObjectContext, input: RunSend["parameter"]): Promise<void> => {
        runSends.push({ key: ctx.key, parameter: input });
        // The run invocation holds the lock (AII-1297): it stays live until a test releases, kills or cancels it.
        await ctx.sleep(HOLD_MS);
      },
    },
  });

  const kgRepo = createKgRepo({ workflowName: FAKE_WORKFLOW_NAME });


  let envs: Map<string, RestateEnvironment>;
  beforeAll(async () => {
    envs = await startVariants([kgRepo, fakeKgRefresh, privateCaller]);
  }, 60_000);
  afterAll(async () => {
    if (envs) await stopAll(envs);
  });

  function envFor(label: string): RestateEnvironment {
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

      await eventually(() => runSends.length - before >= 1, (ok) => ok, { label: "durable effect" });
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

      await eventually(() => runSends.length - before >= 1, (ok) => ok, { label: "durable effect" });
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

      await callPrivate(env.baseUrl(), key, "release", { triggerId: "not-the-right-id" });
      const stillInFlight = await trigger(env.baseUrl(), key);
      expect(stillInFlight).toEqual({ status: "refresh-in-progress", triggerId });
      await eventually(() => runSends.length - before >= 1, (ok) => ok, { label: "durable effect" });
      expect(runSends.length - before).toBe(1);

      await callPrivate(env.baseUrl(), key, "release", { triggerId });
      const status = await callObject<{ triggerId: string; startedAt: number } | null>(env.baseUrl(), "KgRepo", key, "status", {});
      expect(status).toBeNull();

      const next = await trigger(env.baseUrl(), key);
      const nextTriggerId = (next as { triggerId: string }).triggerId;
      expect(nextTriggerId).not.toBe(triggerId);
      await eventually(() => runSends.length - before >= 2, (ok) => ok, { label: "durable effect" });
      expect(runSends.length - before).toBe(2);
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "R4: a marker carries the run invocation id and never goes stale; expire leaves it alone (%s)",
    async (label) => {
      const env = envFor(label);
      const key = newKey();

      const first = await trigger(env.baseUrl(), key);
      const triggerId = (first as { triggerId: string }).triggerId;
      const marker = (await repoStatus(env.baseUrl(), key))!;
      expect(marker.invocationId).toEqual(expect.any(String));
      expect(marker).not.toHaveProperty("leaseUntil");

      await settle(MARKER_AGE_WAIT_MS);
      expect(await trigger(env.baseUrl(), key)).toEqual({ status: "refresh-in-progress", triggerId });

      await callPrivate(env.baseUrl(), key, "expire", { triggerId: "not-the-right-id" });
      await callPrivate(env.baseUrl(), key, "expire", { triggerId });
      expect(await trigger(env.baseUrl(), key)).toEqual({ status: "refresh-in-progress", triggerId });
      expect((await repoStatus(env.baseUrl(), key))?.invocationId).toBe(marker.invocationId);
    },
    30_000,
  );

  // ---- AII-730: the PR-check dry-run queue ----

  const reportFor = (prNumber: number, sha = `sha-${prNumber}`) => ({ repo: "org/kg-source", prNumber, sha });

  async function enqueue(baseUrl: string, slug: string, prNumber: number, ref: string): Promise<KgRepoEnqueueResult> {
    return callObject<KgRepoEnqueueResult>(baseUrl, "KgRepo", slug, "enqueueDryRun", {
      key: `org/kg-source#${prNumber}`, ref, report: reportFor(prNumber, `sha-${ref}`),
    });
  }

  async function release(baseUrl: string, slug: string, triggerId: string): Promise<void> {
    await callPrivate(baseUrl, slug, "release", { triggerId });
  }

  async function repoStatus(baseUrl: string, slug: string) {
    return callObject<{ triggerId: string; startedAt: number; invocationId?: string; pending: string[] } | null>(baseUrl, "KgRepo", slug, "status", {});
  }

  it.each(VARIANTS.map(([label]) => label))(
    "Q1: enqueueDryRun on an idle object submits one dry-run workflow and returns its trigger id (%s)",
    async (label) => {
      const env = envFor(label);
      const slug = newKey();
      const before = runSends.length;

      const result = await enqueue(env.baseUrl(), slug, 1, "br1");
      expect(result).toEqual({ triggerId: expect.any(String) });
      const triggerId = (result as { triggerId: string }).triggerId;

      await eventually(() => runSends.length - before >= 1, (ok) => ok, { label: "durable effect" });
      expect(runSends.length - before).toBe(1);
      expect(runSends[runSends.length - 1]).toEqual({
        key: triggerId,
        parameter: { dryRun: true, kgSourceRef: "br1", report: reportFor(1, "sha-br1"), triggerId },
      });
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "D1: the same key and sha twice submits one workflow; a new sha is accepted; after forgetPr the PR is closed and refused (%s)",
    async (label) => {
      const env = envFor(label);
      const slug = newKey();
      const before = runSends.length;

      expect(await enqueue(env.baseUrl(), slug, 9, "x")).toEqual({ triggerId: expect.any(String) });
      await eventually(() => runSends.length - before >= 1, (ok) => ok, { label: "durable effect" });
      // a same-sha event while that run is in flight neither queues nor submits
      expect(await enqueue(env.baseUrl(), slug, 9, "x")).toEqual({ duplicate: true });
      expect((await repoStatus(env.baseUrl(), slug))?.pending).toEqual([]);
      expect(runSends.length - before).toBe(1);

      // a new sha for the same PR is accepted (queued behind the in-flight run)
      expect(await enqueue(env.baseUrl(), slug, 9, "y")).toEqual({ queued: true });

      await callObject(env.baseUrl(), "KgRepo", slug, "forgetPr", { repo: "org/kg-source", prNumber: 9 });
      expect((await repoStatus(env.baseUrl(), slug))?.pending).toEqual([]);
      expect(await enqueue(env.baseUrl(), slug, 9, "y")).toEqual({ closed: true });
      expect(runSends.length - before).toBe(1);
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "Q2/Q4: a busy object queues; the newer ref for the same key wins; release submits exactly one workflow (%s)",
    async (label) => {
      const env = envFor(label);
      const slug = newKey();
      const before = runSends.length;

      const first = await trigger(env.baseUrl(), slug);
      const triggerId = (first as { triggerId: string }).triggerId;
      await eventually(() => runSends.length - before >= 1, (ok) => ok, { label: "durable effect" });

      expect(await enqueue(env.baseUrl(), slug, 5, "old")).toEqual({ queued: true });
      expect(await enqueue(env.baseUrl(), slug, 5, "new")).toEqual({ queued: true });
      expect((await repoStatus(env.baseUrl(), slug))?.pending).toEqual(["org/kg-source#5"]);

      await release(env.baseUrl(), slug, triggerId);
      await eventually(() => runSends.length - before >= 2, (ok) => ok, { label: "durable effect" });
      expect(runSends.length - before).toBe(2);
      const head = runSends[runSends.length - 1].parameter;
      expect(head).toMatchObject({ dryRun: true, kgSourceRef: "new", report: reportFor(5, "sha-new") });
      // the drained head is now the in-flight refresh under a fresh id, with nothing pending
      expect(head.triggerId).not.toBe(triggerId);
      expect(await repoStatus(env.baseUrl(), slug)).toMatchObject({ triggerId: head.triggerId, pending: [] });
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "Q3: two queued keys drain one per release in enqueue order; a third release submits nothing (%s)",
    async (label) => {
      const env = envFor(label);
      const slug = newKey();
      const before = runSends.length;

      const first = await trigger(env.baseUrl(), slug);
      await eventually(() => runSends.length - before >= 1, (ok) => ok, { label: "durable effect" });
      await enqueue(env.baseUrl(), slug, 1, "a");
      await enqueue(env.baseUrl(), slug, 2, "b");

      // A release carrying the wrong id neither clears the marker nor drains.
      await release(env.baseUrl(), slug, "not-the-right-id");
      expect((await repoStatus(env.baseUrl(), slug))?.pending).toEqual(["org/kg-source#1", "org/kg-source#2"]);

      await release(env.baseUrl(), slug, (first as { triggerId: string }).triggerId);
      await eventually(() => runSends.length - before >= 2, (ok) => ok, { label: "durable effect" });
      const second = runSends[runSends.length - 1].parameter;
      expect(second.kgSourceRef).toBe("a");

      await release(env.baseUrl(), slug, second.triggerId);
      await eventually(() => runSends.length - before >= 3, (ok) => ok, { label: "durable effect" });
      const third = runSends[runSends.length - 1].parameter;
      expect(third.kgSourceRef).toBe("b");

      await release(env.baseUrl(), slug, third.triggerId);
      await settle(500);
      expect(runSends.length - before).toBe(3);
      expect(await repoStatus(env.baseUrl(), slug)).toBeNull();
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "Q5: past MAX_TRACKED_PRS the oldest pending key is evicted and status shows the cap (%s)",
    async (label) => {
      const env = envFor(label);
      const slug = newKey();
      await trigger(env.baseUrl(), slug);

      // #1 alone first so it is the oldest entry; the rest go concurrently so the whole
      // loop finishes well inside FRESH_WINDOW_MS (sequential calls outlast the marker).
      await enqueue(env.baseUrl(), slug, 1, "br1");
      await Promise.all(
        Array.from({ length: MAX_TRACKED_PRS }, (_, i) => enqueue(env.baseUrl(), slug, i + 2, `br${i + 2}`)),
      );

      const pending = (await repoStatus(env.baseUrl(), slug))!.pending;
      expect(pending).toHaveLength(MAX_TRACKED_PRS);
      expect(pending).not.toContain("org/kg-source#1");
      expect(pending).toContain(`org/kg-source#${MAX_TRACKED_PRS + 1}`);
    },
    120_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "AII-1010: an evicted PR's sha key is cleared, so the same head is queued again, not duplicate (%s)",
    async (label) => {
      const env = envFor(label);
      const slug = newKey();
      await trigger(env.baseUrl(), slug);
      await enqueue(env.baseUrl(), slug, 1, "br1");
      await Promise.all(
        Array.from({ length: MAX_TRACKED_PRS }, (_, i) => enqueue(env.baseUrl(), slug, i + 2, `br${i + 2}`)),
      );
      expect((await repoStatus(env.baseUrl(), slug))!.pending).not.toContain("org/kg-source#1");

      expect(await enqueue(env.baseUrl(), slug, 1, "br1")).not.toHaveProperty("duplicate");
      // A PR that was not evicted still answers duplicate for its head.
      expect(await enqueue(env.baseUrl(), slug, MAX_TRACKED_PRS + 1, `br${MAX_TRACKED_PRS + 1}`)).toEqual({ duplicate: true });
    },
    120_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "Q6: the same idempotency key and body is absorbed — one queue entry, one submit (%s)",
    async (label) => {
      const env = envFor(label);
      const slug = newKey();
      const before = runSends.length;
      const post = async (): Promise<unknown> => {
        const response = await fetch(`${env.baseUrl()}/KgRepo/${encodeURIComponent(slug)}/enqueueDryRun`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": `delivery-${slug}` },
          body: JSON.stringify({ key: "org/kg-source#9", ref: "br9", report: reportFor(9) }),
        });
        expect(response.ok).toBe(true);
        return response.json();
      };

      const first = await post();
      const second = await post();
      expect(second).toEqual(first);
      await eventually(() => runSends.length - before >= 1, (ok) => ok, { label: "durable effect" });
      await settle(300);
      expect(runSends.length - before).toBe(1);

      // The same key while busy: a redelivery adds no second entry either.
      const busyPost = async (): Promise<unknown> => {
        const response = await fetch(`${env.baseUrl()}/KgRepo/${encodeURIComponent(slug)}/enqueueDryRun`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": `delivery-busy-${slug}` },
          body: JSON.stringify({ key: "org/kg-source#10", ref: "br10", report: reportFor(10) }),
        });
        return response.json();
      };
      expect(await busyPost()).toEqual({ queued: true });
      expect(await busyPost()).toEqual({ queued: true });
      expect((await repoStatus(env.baseUrl(), slug))?.pending).toEqual(["org/kg-source#10"]);
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "enqueueDryRun rejects input missing its key, ref, or report, leaving no state (%s)",
    async (label) => {
      const env = envFor(label);
      const slug = newKey();
      const before = runSends.length;
      await expect(
        callObject(env.baseUrl(), "KgRepo", slug, "enqueueDryRun", { ref: "br", report: reportFor(1) }),
      ).rejects.toThrow();
      await expect(
        callObject(env.baseUrl(), "KgRepo", slug, "enqueueDryRun", { key: "org/kg-source#1", ref: "br" }),
      ).rejects.toThrow();
      expect(await repoStatus(env.baseUrl(), slug)).toBeNull();
      expect(runSends.length).toBe(before);
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "trigger forwards acceptNewBaseline and kgSourceRef to the run (%s)",
    async (label) => {
      const env = envFor(label);
      const before = runSends.length;
      const result = await callObject<{ triggerId: string }>(env.baseUrl(), "KgRepo", newKey(), "trigger", {
        acceptNewBaseline: true, kgSourceRef: "x",
      });
      await eventually(() => runSends.length - before >= 1, (ok) => ok, { label: "durable effect" });
      expect(runSends[runSends.length - 1]).toEqual({
        key: result.triggerId,
        parameter: { acceptNewBaseline: true, kgSourceRef: "x", triggerId: result.triggerId },
      });
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "trigger with an unknown option is a terminal error and leaves no marker (%s)",
    async (label) => {
      const env = envFor(label);
      const slug = newKey();
      const before = runSends.length;
      await expect(
        callObject(env.baseUrl(), "KgRepo", slug, "trigger", { ref: "x" }),
      ).rejects.toThrow();
      expect(await repoStatus(env.baseUrl(), slug)).toBeNull();
      expect(runSends.length).toBe(before);
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "expire on a legacy marker drains exactly one pending head, like release (%s)",
    async (label) => {
      const env = envFor(label);
      const slug = newKey();
      const before = runSends.length;
      const first = await trigger(env.baseUrl(), slug);
      const triggerId = (first as { triggerId: string }).triggerId;
      // The marker an older release wrote: no invocation id, so only expire can clear it. The write replaces
      // the object's whole state, so it comes before the queue is filled.
      await setObjectState(env.adminAPIBaseUrl(), "KgRepo", slug, "inFlight", { triggerId, startedAt: Date.now() });
      await enqueue(env.baseUrl(), slug, 1, "first");
      await enqueue(env.baseUrl(), slug, 2, "second");

      await callPrivate(env.baseUrl(), slug, "expire", { triggerId });
      await eventually(() => runSends.length - before >= 2, (ok) => ok, { label: "durable effect" });
      expect(runSends[runSends.length - 1].parameter).toMatchObject({ kgSourceRef: "first" });
      expect((await repoStatus(env.baseUrl(), slug))?.pending).toEqual(["org/kg-source#2"]);
    },
    30_000,
  );

  // ---- AII-977: the per-PR dry-run outcome ----

  const outcomeFor = (n: number) => ({
    ok: true, at: n, detail: `dry run passed ${n}`, stampBefore: null, stampAfter: null, dryRun: true,
  });
  const record = (baseUrl: string, slug: string, prNumber: number, sha = `sha-${prNumber}`) =>
    callPrivate(baseUrl, slug, "recordDryRunOutcome", { report: reportFor(prNumber, sha), outcome: outcomeFor(prNumber) });

  it.each(VARIANTS.map(([label]) => label))(
    "O0: recordAdminDryRun accepts an in-flight workflow's old-shape send and stores nothing (%s)",
    async (label) => {
      const env = envFor(label);
      const slug = newKey();
      await callPrivate(env.baseUrl(), slug, "recordAdminDryRun", { outcome: outcomeFor(1) });
      expect(await repoStatus(env.baseUrl(), slug)).toBeNull();
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "O1: recordDryRunOutcome accepts a journaled send and stores nothing (%s)",
    async (label) => {
      const env = envFor(label);
      const slug = newKey();
      await record(env.baseUrl(), slug, 3, "sha-a");
      expect(await repoStatus(env.baseUrl(), slug)).toBeNull();
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "AII-1107: enqueueDryRun for a PR already forgotten answers closed, holds nothing, and release submits nothing for it (%s)",
    async (label) => {
      const env = envFor(label);
      const forget = (n: number) => callObject(env.baseUrl(), "KgRepo", slug, "forgetPr", { repo: "org/kg-source", prNumber: n });
      const slug = newKey();
      const before = runSends.length;

      // Variant A: idle repo.
      await forget(7);
      expect(await enqueue(env.baseUrl(), slug, 7, "a")).toEqual({ closed: true });
      expect(await repoStatus(env.baseUrl(), slug)).toBeNull();
      expect(runSends.length - before).toBe(0);

      // Variant B: refresh in flight. Another PR is unaffected and is the only one held.
      const { triggerId } = (await trigger(env.baseUrl(), slug)) as { triggerId: string };
      await eventually(() => runSends.length - before >= 1, (ok) => ok, { label: "durable effect" });
      await forget(8);
      expect(await enqueue(env.baseUrl(), slug, 8, "b")).toEqual({ closed: true });
      expect(await enqueue(env.baseUrl(), slug, 9, "c")).toEqual({ queued: true });
      expect((await repoStatus(env.baseUrl(), slug))?.pending).toEqual(["org/kg-source#9"]);

      await release(env.baseUrl(), slug, triggerId);
      await eventually(() => runSends.length - before >= 2, (ok) => ok, { label: "durable effect" });
      const submitted = runSends.slice(before + 1).map((r) => (r.parameter as { report?: { prNumber: number } }).report?.prNumber);
      expect(submitted).toEqual([9]);
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "O2: forgetPr clears the PR's pending entry and leaves other PRs (%s)",
    async (label) => {
      const env = envFor(label);
      const slug = newKey();
      await trigger(env.baseUrl(), slug);
      await enqueue(env.baseUrl(), slug, 1, "one");
      await enqueue(env.baseUrl(), slug, 2, "two");

      await callObject(env.baseUrl(), "KgRepo", slug, "forgetPr", { repo: "org/kg-source", prNumber: 1 });

      expect((await repoStatus(env.baseUrl(), slug))?.pending).toEqual(["org/kg-source#2"]);
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "the outcome handlers reject unknown fields (%s)",
    async (label) => {
      const env = envFor(label);
      const slug = newKey();
      await expect(
        callPrivate(env.baseUrl(), slug, "recordDryRunOutcome", { report: reportFor(1), outcome: outcomeFor(1), extra: 1 }),
      ).rejects.toThrow();
      await expect(
        callObject(env.baseUrl(), "KgRepo", slug, "forgetPr", { repo: "org/kg-source", prNumber: 1, extra: 1 }),
      ).rejects.toThrow();
    },
  );
});

describe("KgRepo run-held lock", () => {
  const sends: Array<{ key: string; parameter: { triggerId: string; kgSourceRef?: string } }> = [];
  const holdingKgRefresh = restate.object({
    name: FAKE_WORKFLOW_NAME,
    handlers: {
      run: async (ctx: restate.ObjectContext, input: { triggerId: string; kgSourceRef?: string }): Promise<void> => {
        sends.push({ key: ctx.key, parameter: input });
        await ctx.sleep(HOLD_MS);
      },
    },
  });
  // A run that fails with a retryable error and pauses instead of being killed (onMaxAttempts: "pause").
  const pausingKgRefresh = restate.object({
    name: "PausingKgRefresh",
    handlers: {
      // The failure sits in a journaled step, so a cancel of the paused invocation lands on that step.
      run: async (ctx: restate.ObjectContext): Promise<void> => {
        await ctx.run("boom", () => {
          throw new Error("boom");
        });
      },
    },
    options: { retryPolicy: { maxAttempts: 1, onMaxAttempts: "pause", initialInterval: 10 } },
  });

  let production: Map<string, RestateEnvironment>;
  let pausing: Map<string, RestateEnvironment>;
  beforeAll(async () => {
    production = await startVariants([createKgRepo({ workflowName: FAKE_WORKFLOW_NAME }), holdingKgRefresh, privateCaller]);
    pausing = await startVariants([createKgRepo({ workflowName: "PausingKgRefresh" }), pausingKgRefresh, privateCaller]);
  }, 180_000);
  afterAll(async () => {
    if (production) await stopAll(production);
    if (pausing) await stopAll(pausing);
  });

  const pick = (envs: Map<string, RestateEnvironment>, label: string): RestateEnvironment => {
    const env = envs.get(label);
    if (!env) throw new Error(`missing Restate variant ${label}`);
    return env;
  };
  const slugOf = () => `buildDownAI/kg-source-${randomUUID()}`;
  const markerOf = (env: RestateEnvironment, slug: string) =>
    callObject<{ triggerId: string; invocationId?: string; pending: string[] } | null>(env.baseUrl(), "KgRepo", slug, "status", {});
  const trigger = (env: RestateEnvironment, slug: string) => callObject<KgRepoTriggerResult>(env.baseUrl(), "KgRepo", slug, "trigger", {});
  const runRow = async (env: RestateEnvironment, service: string, triggerId: string) => {
    const rows = await eventually(
      () => queryInvocations(env.adminAPIBaseUrl(), `target_service_name = '${service}' AND target_service_key = '${triggerId}' AND target_handler_name = 'run'`),
      (found) => found.length === 1,
      { label: "the run invocation", timeoutMs: 30_000 },
    );
    return rows[0];
  };
  const watchRows = (env: RestateEnvironment, slug: string) =>
    queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'KgRepo' AND target_service_key = '${slug}' AND target_handler_name = 'watch'`);
  const warnings = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => String(c[1]).includes("expired legacy in-flight marker"));

  it.each(VARIANTS.map(([label]) => label))(
    "a killed run frees KgRepo, and the next trigger answers a new trigger id (%s)",
    async (label) => {
      const env = pick(production, label);
      const slug = slugOf();
      const { triggerId } = (await trigger(env, slug)) as { triggerId: string };
      expect(await trigger(env, slug)).toEqual({ status: "refresh-in-progress", triggerId });

      await killInvocation(env.adminAPIBaseUrl(), String((await runRow(env, FAKE_WORKFLOW_NAME, triggerId)).id));

      await eventually(() => markerOf(env, slug), (marker) => marker === null, { label: "KgRepo marker cleared by watch", timeoutMs: 30_000, intervalMs: 50 });
      const next = await trigger(env, slug);
      expect(next).not.toHaveProperty("status");
      expect((next as { triggerId: string }).triggerId).not.toBe(triggerId);
    },
    60_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "a cancelled run frees KgRepo (%s)",
    async (label) => {
      const env = pick(production, label);
      const slug = slugOf();
      const { triggerId } = (await trigger(env, slug)) as { triggerId: string };
      await cancelInvocation(env.adminAPIBaseUrl(), String((await runRow(env, FAKE_WORKFLOW_NAME, triggerId)).id));
      await eventually(() => markerOf(env, slug), (marker) => marker === null, { label: "KgRepo marker cleared by watch", timeoutMs: 30_000, intervalMs: 50 });
    },
    60_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "a live run keeps the marker with an invocation id and no lease; a second trigger is refused; the run's release clears it once (%s)",
    async (label) => {
      const env = pick(production, label);
      const slug = slugOf();
      const { triggerId } = (await trigger(env, slug)) as { triggerId: string };
      const marker = (await markerOf(env, slug))!;
      expect(marker.invocationId).toBe(String((await runRow(env, FAKE_WORKFLOW_NAME, triggerId)).id));
      expect(marker).not.toHaveProperty("leaseUntil");
      // No delayed expire is scheduled any more: no wall clock bounds a live run.
      expect(await queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'KgRepo' AND target_service_key = '${slug}' AND target_handler_name = 'expire'`)).toHaveLength(0);

      await settle(MARKER_AGE_WAIT_MS);
      expect(await trigger(env, slug)).toEqual({ status: "refresh-in-progress", triggerId });

      await callPrivate(env.baseUrl(), slug, "release", { triggerId });
      expect(await markerOf(env, slug)).toBeNull();
      const next = (await trigger(env, slug)) as { triggerId: string };
      // A second release for the same trigger id does nothing to the newer marker.
      await callPrivate(env.baseUrl(), slug, "release", { triggerId });
      expect((await markerOf(env, slug))?.triggerId).toBe(next.triggerId);
    },
    60_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "a paused run keeps the marker, and a cancel of that invocation releases it (%s)",
    async (label) => {
      const env = pick(pausing, label);
      const slug = slugOf();
      const { triggerId } = (await trigger(env, slug)) as { triggerId: string };
      const row = await eventually(
        async () => (await queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'PausingKgRefresh' AND target_service_key = '${triggerId}'`))[0],
        (found) => found?.status === "paused",
        { label: "the run to pause", timeoutMs: 30_000, intervalMs: 50 },
      );
      await settle(MARKER_AGE_WAIT_MS);
      expect((await markerOf(env, slug))?.triggerId).toBe(triggerId);
      expect(await trigger(env, slug)).toEqual({ status: "refresh-in-progress", triggerId });

      await cancelInvocation(env.adminAPIBaseUrl(), String(row.id));
      await eventually(
        async () => ({ marker: await markerOf(env, slug), run: (await queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'PausingKgRefresh' AND target_service_key = '${triggerId}'`))[0]?.status }),
        (state) => state.marker === null,
        { label: "KgRepo marker cleared by watch", timeoutMs: 30_000, intervalMs: 50 },
      );
    },
    60_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "a cancel of the watch invocation does not release the lock of a live run (%s)",
    async (label) => {
      const env = pick(production, label);
      const slug = slugOf();
      const { triggerId } = (await trigger(env, slug)) as { triggerId: string };
      const watch = await eventually(() => watchRows(env, slug), (found) => found.length === 1, { label: "the watch invocation", timeoutMs: 30_000 });

      await cancelInvocation(env.adminAPIBaseUrl(), String(watch[0].id));
      await settle(MARKER_AGE_WAIT_MS);

      expect((await markerOf(env, slug))?.triggerId).toBe(triggerId);
      expect(await trigger(env, slug)).toEqual({ status: "refresh-in-progress", triggerId });
    },
    60_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "a queued dry run starts only after the holder's release (%s)",
    async (label) => {
      const env = pick(production, label);
      const slug = slugOf();
      const before = sends.length;
      const { triggerId } = (await trigger(env, slug)) as { triggerId: string };
      expect(await callObject(env.baseUrl(), "KgRepo", slug, "enqueueDryRun", {
        key: "org/kg-source#1", ref: "held", report: { repo: "org/kg-source", prNumber: 1, sha: "sha-held" },
      })).toEqual({ queued: true });
      await settle(MARKER_AGE_WAIT_MS);
      expect(sends.length - before).toBe(1);

      await killInvocation(env.adminAPIBaseUrl(), String((await runRow(env, FAKE_WORKFLOW_NAME, triggerId)).id));
      await eventually(() => sends.slice(before).filter((s) => s.parameter.kgSourceRef === "held").length, (n) => n === 1, { label: "queued dry run submitted after the release", timeoutMs: 30_000, intervalMs: 50 });
      const marker = (await markerOf(env, slug))!;
      expect(marker.triggerId).not.toBe(triggerId);
      expect(marker.invocationId).toEqual(expect.any(String));
      expect(sends.length - before).toBe(2);
    },
    60_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "expire clears a legacy marker with no invocation id, and leaves one that has an invocation id (%s)",
    async (label) => {
      const env = pick(production, label);
      const held = slugOf();
      const { triggerId: heldId } = (await trigger(env, held)) as { triggerId: string };
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await callPrivate(env.baseUrl(), held, "expire", { triggerId: heldId });
        expect(warnings(warnSpy)).toHaveLength(0);
        expect((await markerOf(env, held))?.triggerId).toBe(heldId);

        const legacy = slugOf();
        await setObjectState(env.adminAPIBaseUrl(), "KgRepo", legacy, "inFlight", { triggerId: "legacy-id", startedAt: Date.now() });
        await callPrivate(env.baseUrl(), legacy, "expire", { triggerId: "other-id" });
        expect((await markerOf(env, legacy))?.triggerId).toBe("legacy-id");
        await callPrivate(env.baseUrl(), legacy, "expire", { triggerId: "legacy-id" });
        expect(warnings(warnSpy)).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
      }
    },
    60_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "release and expire reject an unknown key or an empty trigger id (%s)",
    async (label) => {
      const env = pick(production, label);
      const slug = slugOf();
      await expect(callPrivate(env.baseUrl(), slug, "release", { triggerId: "t", extra: 1 })).rejects.toThrow();
      await expect(callPrivate(env.baseUrl(), slug, "expire", { triggerId: "" })).rejects.toThrow();
    },
    30_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "release, expire, watch and recordDryRunOutcome are ingress-private; trigger and status stay public (%s)",
    async (label) => {
      const env = pick(production, label);
      const slug = slugOf();
      for (const handler of ["release", "expire", "watch", "recordDryRunOutcome"]) {
        const response = await fetch(`${env.baseUrl()}/KgRepo/${encodeURIComponent(slug)}/${handler}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        expect(response.status, handler).toBe(400);
      }
      const triggered = (await trigger(env, slug)) as { triggerId: string };
      expect(typeof triggered.triggerId).toBe("string");
      // The workflow's own path still works: a forwarded release clears the marker.
      await callPrivate(env.baseUrl(), slug, "release", { triggerId: triggered.triggerId });
      expect(await markerOf(env, slug)).toBeNull();
    },
    30_000,
  );
});
