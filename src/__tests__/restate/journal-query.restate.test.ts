// Restate scenario for AII-1128: `readJournal()` (src/restate/journal-query.ts) against the
// harness's real admin API. The SQL column names and ORDER BY index are unknowns only the
// pinned server can confirm.
//
// Run with `npm run test:restate`; excluded from `npm test`.
import { randomUUID } from "node:crypto";
import * as restate from "@restatedev/restate-sdk";
import type { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readJournal } from "../../restate/journal-query.js";
import { callWorkflow, eventually, queryInvocations, startVariants, stopAll } from "./harness.js";

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
  let envs: Map<string, RestateTestEnvironment>;
  beforeAll(async () => {
    envs = await startVariants([journalProbe]);
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

    // A workflow key owns one invocation per handler call, and the key lookup answers the newest —
    // here the shared `resolve` call. The `run` invocation is reached by id.
    const latest = await eventually(
      () => readJournal({ service: "JournalProbeTest", key }, { adminBaseUrl }),
      (r) => r?.invocation.status === "completed",
      { label: "latest invocation completed" },
    );
    expect(latest!.invocation.target_handler_name).toBe("resolve");
    const promise = latest!.promises.find((p) => p.key === "probe-promise");
    expect(promise?.completed).toBe(true);
    expect(String(promise?.completion_success_value_utf8)).toContain("the-value");

    const runId = (await queryInvocations(adminBaseUrl, `target_service_name = 'JournalProbeTest' AND target_service_key = '${key}' AND target_handler_name = 'run'`))[0].id as string;
    const result = await eventually(
      () => readJournal({ id: runId }, { adminBaseUrl }),
      (r) => r?.invocation.status === "completed",
      { label: "run invocation completed" },
    );
    expect(result!.invocation.status).toBe("completed");
    const indexes = result!.entries.map((e) => Number(e.index));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    const stepAt = result!.entries.findIndex((e) => e.name === "probe-step");
    const promiseAt = result!.entries.findIndex((e) => e.entryType === "Command: GetPromise");
    expect(stepAt).toBeGreaterThanOrEqual(0);
    expect(promiseAt).toBeGreaterThan(stepAt);
    expect(result!.promises.find((p) => p.key === "probe-promise")?.completed).toBe(true);

    const byId = await readJournal({ id: String(latest!.invocation.id) }, { adminBaseUrl });
    expect(byId?.invocation.id).toBe(latest!.invocation.id);

    expect(await readJournal({ service: "JournalProbeTest", key: `unknown-${randomUUID()}` }, { adminBaseUrl })).toBeNull();
  });
});
