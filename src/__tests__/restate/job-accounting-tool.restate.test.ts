// The control-plane (service) caller pages through list_job_accounting on the real orchestratorTools
// service, on the binary runtime (AII-1564). Run with `npm run test:restate`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { orchestratorTools } from "../../restate/tools.js";
import * as dedup from "../../dedup.js";
import { appendLog, initLogTable } from "../../log.js";
import { JobAccountingPageSchema } from "../../job-accounting.js";
import type { RestateEnvironment } from "./harness.js";
import { callService, startRetryEnabled } from "./harness.js";

interface ToolCallResult {
  isError?: boolean;
  content: Array<{ text: string }>;
}

const SERVICE_CALLER = { kind: "service", email: null, role: "user" };

describe("list_job_accounting on the orchestratorTools service", () => {
  let env: RestateEnvironment;

  beforeAll(async () => {
    dedup.getDb();
    initLogTable();
    const done = Date.now() - 60 * 60 * 1000;
    for (let i = 0; i < 25; i++) {
      const id = appendLog({ issueId: `i${i}`, dispatchId: `d-${String(i).padStart(2, "0")}` });
      // pairs share a completed_at
      dedup.getDb().prepare("UPDATE dispatch_log SET status = 'completed', conclusion = 'success', completed_at = ? WHERE id = ?")
        .run(done + Math.floor(i / 2) * 1000, id);
    }
    env = await startRetryEnabled([orchestratorTools]);
  }, 120_000);

  afterAll(async () => {
    await env?.stop();
  });

  const call = (args: unknown) =>
    callService<ToolCallResult>(env.baseUrl(), "orchestratorTools", "list_job_accounting", { caller: SERVICE_CALLER, args });

  it("pages every job once, in order", async () => {
    const seen: string[] = [];
    let cursor: unknown;
    for (let i = 0; i < 10; i++) {
      const res = await call({ pageSize: 10, ...(cursor ? { cursor } : {}) });
      expect(res.isError).toBeUndefined();
      const page = JobAccountingPageSchema.parse(JSON.parse(res.content[0].text));
      seen.push(...page.records.map((r) => r.dispatchId));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen).toEqual([...seen].sort());
  });

  it("rejects page sizes 0 and 201", async () => {
    for (const pageSize of [0, 201]) {
      const res = await fetch(`${env.baseUrl()}/orchestratorTools/list_job_accounting`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caller: SERVICE_CALLER, args: { pageSize } }),
      });
      expect(res.ok).toBe(false);
    }
  });
});
