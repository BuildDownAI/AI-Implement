// Real Restate 1.7.10 coordination tests for AII-894's KgRepo single-flight lock.
// KgRepo sends to a fake "KgRefresh" service registered alongside it so this file can
// count and inspect the sends without depending on the real workflow module.
import { randomUUID } from "node:crypto";
import * as restate from "@restatedev/restate-sdk";
import type { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_TRACKED_PRS } from "../../kg-refresh.js";
import { KG_REFRESH_TOTAL_DEADLINE_MS, KG_REPO_STALE_MARGIN_MS } from "../../restate/kg-refresh-workflow.js";
import { createKgRepo, type KgRepoEnqueueResult, type KgRepoTriggerResult } from "../../restate/kg-repo.js";
import { VARIANTS, callObject, startVariants, stopAll } from "./harness.js";

const FAKE_WORKFLOW_NAME = "FakeKgRefresh";
const MARKER_AGE_WAIT_MS = 1_500;

interface RunSend {
  key: string;
  parameter: { triggerId: string; dryRun?: boolean; kgSourceRef?: string; acceptNewBaseline?: boolean; report?: { repo: string; prNumber: number; sha: string } };
}

describe("KgRepo durable single-flight lock", () => {
  const runSends: RunSend[] = [];

  const fakeKgRefresh = restate.object({
    name: FAKE_WORKFLOW_NAME,
    handlers: {
      run: async (ctx: restate.ObjectContext, input: RunSend["parameter"]): Promise<void> => {
        runSends.push({ key: ctx.key, parameter: input });
      },
    },
  });

  const kgRepo = createKgRepo({ workflowName: FAKE_WORKFLOW_NAME });

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

  /** `trigger`'s send to the fake workflow is a one-way `ctx.genericSend` — the HTTP
   *  response for `trigger` itself does not wait for delivery, so a `runSends` count
   *  checked immediately afterward can observe the send before it lands. Poll instead
   *  of asserting synchronously. */
  async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
    const stop = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > stop) throw new Error("timed out waiting for a durable send to be delivered");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
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

      await until(() => runSends.length - before >= 1);
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

      await until(() => runSends.length - before >= 1);
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
      await until(() => runSends.length - before >= 1);
      expect(runSends.length - before).toBe(1);

      await callObject(env.baseUrl(), "KgRepo", key, "release", { triggerId });
      const status = await callObject<{ triggerId: string; startedAt: number } | null>(env.baseUrl(), "KgRepo", key, "status", {});
      expect(status).toBeNull();

      const next = await trigger(env.baseUrl(), key);
      const nextTriggerId = (next as { triggerId: string }).triggerId;
      expect(nextTriggerId).not.toBe(triggerId);
      await until(() => runSends.length - before >= 2);
      expect(runSends.length - before).toBe(2);
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "R4: a marker is never stale; expire clears it only for the matching trigger id (%s)",
    async (label) => {
      const env = envFor(label);
      const key = newKey();
      const before = runSends.length;

      const first = await trigger(env.baseUrl(), key);
      const triggerId = (first as { triggerId: string }).triggerId;

      await new Promise((resolve) => setTimeout(resolve, MARKER_AGE_WAIT_MS));
      expect(await trigger(env.baseUrl(), key)).toEqual({ status: "refresh-in-progress", triggerId });

      await callObject(env.baseUrl(), "KgRepo", key, "expire", { triggerId: "not-the-right-id" });
      expect(await trigger(env.baseUrl(), key)).toEqual({ status: "refresh-in-progress", triggerId });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await callObject(env.baseUrl(), "KgRepo", key, "expire", { triggerId });
        expect(warnSpy.mock.calls.filter((c) => String(c[1]).includes("expired in-flight marker"))).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
      }
      expect(await callObject(env.baseUrl(), "KgRepo", key, "status", {})).toBeNull();
      const next = await trigger(env.baseUrl(), key);
      expect((next as { triggerId: string }).triggerId).not.toBe(triggerId);
      await until(() => runSends.length - before >= 2);
      expect(runSends.length - before).toBe(2);
    },
    30_000,
  );

  // ---- AII-730: the PR-check dry-run queue ----

  const reportFor = (prNumber: number, sha = `sha-${prNumber}`) => ({ repo: "org/kg-source", prNumber, sha, acceptBaseline: false });

  async function enqueue(baseUrl: string, slug: string, prNumber: number, ref: string): Promise<KgRepoEnqueueResult> {
    return callObject<KgRepoEnqueueResult>(baseUrl, "KgRepo", slug, "enqueueDryRun", {
      key: `org/kg-source#${prNumber}`, ref, report: reportFor(prNumber, `sha-${ref}`),
    });
  }

  async function release(baseUrl: string, slug: string, triggerId: string): Promise<void> {
    await callObject(baseUrl, "KgRepo", slug, "release", { triggerId });
  }

  async function repoStatus(baseUrl: string, slug: string) {
    return callObject<{ triggerId: string; startedAt: number; pending: string[] } | null>(baseUrl, "KgRepo", slug, "status", {});
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

      await until(() => runSends.length - before >= 1);
      expect(runSends.length - before).toBe(1);
      expect(runSends[runSends.length - 1]).toEqual({
        key: triggerId,
        parameter: { dryRun: true, kgSourceRef: "br1", report: reportFor(1, "sha-br1"), triggerId },
      });
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
      await until(() => runSends.length - before >= 1);

      expect(await enqueue(env.baseUrl(), slug, 5, "old")).toEqual({ queued: true });
      expect(await enqueue(env.baseUrl(), slug, 5, "new")).toEqual({ queued: true });
      expect((await repoStatus(env.baseUrl(), slug))?.pending).toEqual(["org/kg-source#5"]);

      await release(env.baseUrl(), slug, triggerId);
      await until(() => runSends.length - before >= 2);
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
      await until(() => runSends.length - before >= 1);
      await enqueue(env.baseUrl(), slug, 1, "a");
      await enqueue(env.baseUrl(), slug, 2, "b");

      // A release carrying the wrong id neither clears the marker nor drains.
      await release(env.baseUrl(), slug, "not-the-right-id");
      expect((await repoStatus(env.baseUrl(), slug))?.pending).toEqual(["org/kg-source#1", "org/kg-source#2"]);

      await release(env.baseUrl(), slug, (first as { triggerId: string }).triggerId);
      await until(() => runSends.length - before >= 2);
      const second = runSends[runSends.length - 1].parameter;
      expect(second.kgSourceRef).toBe("a");

      await release(env.baseUrl(), slug, second.triggerId);
      await until(() => runSends.length - before >= 3);
      const third = runSends[runSends.length - 1].parameter;
      expect(third.kgSourceRef).toBe("b");

      await release(env.baseUrl(), slug, third.triggerId);
      await new Promise((resolve) => setTimeout(resolve, 500));
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
      await until(() => runSends.length - before >= 1);
      await new Promise((resolve) => setTimeout(resolve, 300));
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
      await until(() => runSends.length - before >= 1);
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
    "expire drains exactly one pending head, like release (%s)",
    async (label) => {
      const env = envFor(label);
      const slug = newKey();
      const before = runSends.length;
      const first = await trigger(env.baseUrl(), slug);
      const triggerId = (first as { triggerId: string }).triggerId;
      await enqueue(env.baseUrl(), slug, 1, "first");
      await enqueue(env.baseUrl(), slug, 2, "second");

      await callObject(env.baseUrl(), "KgRepo", slug, "expire", { triggerId });
      await until(() => runSends.length - before >= 2);
      expect(runSends[runSends.length - 1].parameter).toMatchObject({ kgSourceRef: "first" });
      expect((await repoStatus(env.baseUrl(), slug))?.pending).toEqual(["org/kg-source#2"]);
    },
    30_000,
  );
});

describe("KgRepo object-owned lease expiry", () => {
  const SHORT_TOTAL_MS = 400;
  const SHORT_MARGIN_MS = 400;
  const fakeKgRefresh = restate.object({
    name: FAKE_WORKFLOW_NAME,
    handlers: { run: async (): Promise<void> => {} },
  });

  let production: Map<string, RestateTestEnvironment>;
  let short: Map<string, RestateTestEnvironment>;
  beforeAll(async () => {
    production = await startVariants([createKgRepo({ workflowName: FAKE_WORKFLOW_NAME }), fakeKgRefresh]);
    short = await startVariants([
      createKgRepo({ workflowName: FAKE_WORKFLOW_NAME, totalDeadlineMs: SHORT_TOTAL_MS, staleMarginMs: SHORT_MARGIN_MS }),
      fakeKgRefresh,
    ]);
  }, 120_000);
  afterAll(async () => {
    if (production) await stopAll(production);
    if (short) await stopAll(short);
  });

  const pick = (envs: Map<string, RestateTestEnvironment>, label: string): RestateTestEnvironment => {
    const env = envs.get(label);
    if (!env) throw new Error(`missing Restate variant ${label}`);
    return env;
  };
  const slugOf = () => `buildDownAI/kg-source-${randomUUID()}`;
  const markerOf = (env: RestateTestEnvironment, slug: string) =>
    callObject<{ triggerId: string } | null>(env.baseUrl(), "KgRepo", slug, "status", {});
  async function untilAsync(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
    const stop = Date.now() + timeoutMs;
    while (!(await predicate())) {
      if (Date.now() > stop) throw new Error("timed out");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it.each(VARIANTS.map(([label]) => label))(
    "trigger records one delayed expire self-send (%s)",
    async (label) => {
      const env = pick(production, label);
      const slug = slugOf();
      await callObject(env.baseUrl(), "KgRepo", slug, "trigger", {});
      const response = await fetch(`${env.adminAPIBaseUrl()}/query`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          query: `SELECT * FROM sys_invocation WHERE target_service_name = 'KgRepo' AND target_service_key = '${slug}' AND target_handler_name = 'expire'`,
        }),
      });
      const rows = ((await response.json()) as { rows: Array<Record<string, unknown>> }).rows;
      expect(rows).toHaveLength(1);
      const delay = Date.parse(String(rows[0].scheduled_start_at)) - Date.parse(String(rows[0].created_at));
      expect(Math.abs(delay - (KG_REFRESH_TOTAL_DEADLINE_MS + KG_REPO_STALE_MARGIN_MS))).toBeLessThan(5_000);
    },
    30_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "with a short margin, expire clears the marker when no release arrives (%s)",
    async (label) => {
      const env = pick(short, label);
      const slug = slugOf();
      await callObject(env.baseUrl(), "KgRepo", slug, "trigger", {});
      await untilAsync(async () => (await markerOf(env, slug)) === null);
    },
    30_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "expire after release is a no-op: it leaves a newer marker alone (%s)",
    async (label) => {
      const env = pick(short, label);
      const slug = slugOf();
      const startedAt = Date.now();
      const { triggerId } = await callObject<{ triggerId: string }>(env.baseUrl(), "KgRepo", slug, "trigger", {});
      await callObject(env.baseUrl(), "KgRepo", slug, "release", { triggerId });
      // Stagger the second lease so the first expire fires while the second marker is still live.
      await new Promise((resolve) => setTimeout(resolve, 400));
      const next = await callObject<{ triggerId: string }>(env.baseUrl(), "KgRepo", slug, "trigger", {});
      expect(next.triggerId).not.toBe(triggerId);
      // Wait past the first lease's expire (startedAt + 800 ms) but before the second's (>= startedAt + 1200 ms).
      const wait = startedAt + SHORT_TOTAL_MS + SHORT_MARGIN_MS + 200 - Date.now();
      await new Promise((resolve) => setTimeout(resolve, Math.max(wait, 0)));
      expect(Date.now()).toBeLessThan(startedAt + SHORT_TOTAL_MS + SHORT_MARGIN_MS + 400);
      expect((await markerOf(env, slug))?.triggerId).toBe(next.triggerId);
    },
    30_000,
  );

  it.each(VARIANTS.map(([label]) => label))(
    "release and expire reject an unknown key or an empty trigger id (%s)",
    async (label) => {
      const env = pick(production, label);
      const slug = slugOf();
      await expect(callObject(env.baseUrl(), "KgRepo", slug, "release", { triggerId: "t", extra: 1 })).rejects.toThrow();
      await expect(callObject(env.baseUrl(), "KgRepo", slug, "expire", { triggerId: "" })).rejects.toThrow();
    },
    30_000,
  );
});
