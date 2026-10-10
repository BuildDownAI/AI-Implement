// Restate scenario for AII-1128: `readJournal()` (src/restate/journal-query.ts) against the
// harness's real admin API. The SQL column names and ORDER BY index are unknowns only the
// pinned server can confirm.
//
// Run with `npm run test:restate`; excluded from `npm test`.
import { randomUUID } from "node:crypto";
import * as restate from "@restatedev/restate-sdk";
import type { RestateEnvironment } from "./harness.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readJournal } from "../../restate/journal-query.js";
import { callWorkflow, eventually, settle, startVariants, stopAll } from "./harness.js";

const objectProbe = restate.object({
  name: "JournalObjectProbeTest",
  handlers: {
    touch: async (ctx: restate.ObjectContext, tag: string): Promise<string> => {
      await ctx.run(`touch-${tag}`, async () => tag);
      return tag;
    },
  },
});

const journalProbe = restate.workflow({
  name: "JournalProbeTest",
  handlers: {
    run: async (ctx: restate.WorkflowContext): Promise<string> => {
      await ctx.run("probe-step", async () => "step-done");
      return ctx.promise<string>("probe-promise").get();
    },
    resolve: async (ctx: restate.WorkflowSharedContext, value: string): Promise<void> => {
      ctx.promise<string>("probe-promise").resolve(value);
    },
  },
});

describe("readJournal against the real admin API", () => {
  let envs: Map<string, RestateEnvironment>;
  beforeAll(async () => {
    envs = await startVariants([journalProbe, objectProbe]);
  }, 60_000);
  afterAll(async () => {
    if (envs) await stopAll(envs);
  });

  it.each(["alwaysReplay", "disableRetries"])("reads invocation, entries, and promises (%s)", async (label) => {
    const env = envs.get(label);
    if (!env) throw new Error(`missing Restate variant ${label}`);
    const key = `probe-${randomUUID()}`;
    const base = env.baseUrl();
    const adminBaseUrl = env.adminAPIBaseUrl();

    const started = callWorkflow<string>(base, "JournalProbeTest", key, "run");
    await eventually(
      () => readJournal({ service: "JournalProbeTest", key }, { adminBaseUrl }),
      (r) => r !== null && r.entries.some((e) => e.entryType === "Notification: Run") && r.entries.some((e) => e.name === "probe-step"),
      { label: "probe-step journaled" },
    );
    await callWorkflow<void>(base, "JournalProbeTest", key, "resolve", "the-value");
    expect(await started).toBe("the-value");

    // A workflow key owns one invocation per handler call (`run`, then the shared `resolve`); the key
    // lookup answers `run`.
    const result = await eventually(
      () => readJournal({ service: "JournalProbeTest", key }, { adminBaseUrl }),
      (r) => r?.invocation.status === "completed",
      { label: "run invocation completed" },
    );
    expect(result!.invocation.target_handler_name).toBe("run");
    const indexes = result!.entries.map((e) => Number(e.index));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    const stepAt = result!.entries.findIndex((e) => e.name === "probe-step");
    const promiseAt = result!.entries.findIndex((e) => e.entryType === "Command: GetPromise");
    expect(stepAt).toBeGreaterThanOrEqual(0);
    expect(promiseAt).toBeGreaterThan(stepAt);
    const promise = result!.promises.find((p) => p.key === "probe-promise");
    expect(promise?.completed).toBe(true);
    expect(String(promise?.completion_success_value_utf8)).toContain("the-value");

    const byId = await readJournal({ id: String(result!.invocation.id) }, { adminBaseUrl });
    expect(byId?.invocation.id).toBe(result!.invocation.id);

    expect(await readJournal({ service: "JournalProbeTest", key: `unknown-${randomUUID()}` }, { adminBaseUrl })).toBeNull();
  });

  it.each(["alwaysReplay", "disableRetries"])("answers the newest call for a virtual-object key (%s)", async (label) => {
    const env = envs.get(label);
    if (!env) throw new Error(`missing Restate variant ${label}`);
    const key = `obj-${randomUUID()}`;
    const adminBaseUrl = env.adminAPIBaseUrl();
    const call = async (tag: string): Promise<void> => {
      const res = await fetch(`${env.baseUrl()}/JournalObjectProbeTest/${key}/touch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(tag),
      });
      expect(res.ok).toBe(true);
    };
    await call("first");
    await settle(50);
    await call("second");

    const result = await eventually(
      () => readJournal({ service: "JournalObjectProbeTest", key }, { adminBaseUrl }),
      (r) => r?.invocation.status === "completed" && r.entries.some((e) => e.name === "touch-second"),
      { label: "newest object call answered" },
    );
    expect(result!.entries.some((e) => e.name === "touch-first")).toBe(false);
  });
});
