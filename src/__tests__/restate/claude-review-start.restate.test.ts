import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as clients from "@restatedev/restate-sdk-clients";
import { createClaudeReviewStart, type ClaudeReviewStartDefinition } from "../../restate/claude-review-start.js";
import { VARIANTS, callObject, startVariants, stopAll, gate, queryInvocations, journalEntries, journalText, type RestateEnvironment } from "./harness.js";

const SECRET = "PRIVATE-CLAUDE-START-SECRET";
describe("ClaudeReviewStart durable ownership", () => {
  let environments: Map<string, RestateEnvironment>;
  const read = vi.fn();
  const dispatch = vi.fn();
  const token = vi.fn();
  const eligible = { state: "open" as const, headSha: "head", draft: false, sameRepository: true };
  beforeEach(() => {
    read.mockReset().mockResolvedValue(eligible);
    dispatch.mockReset().mockResolvedValue({ success: true, status: 204 });
    token.mockReset().mockResolvedValue(SECRET);
  });
  beforeAll(async () => {
    environments = await startVariants([createClaudeReviewStart({ appId: "app", privateKey: SECRET,
      getInstallationToken: token, getPullRequest: read, postWorkflowDispatch: dispatch })]);
  }, 60_000);
  afterAll(async () => { await stopAll(environments); });
  for (const [variant] of VARIANTS) describe(variant, () => {
    const env = () => environments.get(variant)!;
    const key = () => `owner/${randomUUID()}#42`;
    const start = (key: string, allowDraft = false) => callObject<string>(env().baseUrl(), "ClaudeReviewStart", key, "start", { ref: "testing", allowDraft });
    it("serializes concurrent same-head calls and starts again for a new head", async () => {
      const pr = key();
      const held = gate("first dispatch");
      dispatch.mockImplementationOnce(async () => { await held.wait(); return { success: true, status: 204 }; });
      const first = start(pr);
      try {
        await held.reached();
        const second = start(pr);
        held.release();
        expect(await Promise.all([first, second])).toEqual(["started", "same"]);
        expect(dispatch).toHaveBeenCalledTimes(1);
        read.mockResolvedValue({ ...eligible, headSha: "next" });
        expect(await start(pr)).toBe("started");
        expect(dispatch).toHaveBeenCalledTimes(2);
        expect(dispatch.mock.calls[1][0]).toMatchObject({ workflowFile: "claude-review.yml", ref: "testing", inputs: { pr_number: "42", head_sha: "next" } });
      } finally { held.release(); }
    });
    it("deduplicates one-way sends by delivery id", async () => {
      const pr = key();
      const client = clients.connect({ url: env().baseUrl() }).objectSendClient<ClaudeReviewStartDefinition>({ name: "ClaudeReviewStart" }, pr);
      const opts = clients.rpc.sendOpts<{ ref: string; allowDraft: boolean }>({ idempotencyKey: randomUUID() });
      const first = await client.start({ ref: "testing", allowDraft: false }, opts);
      const second = await client.start({ ref: "testing", allowDraft: false }, opts);
      expect(first.invocationId).toBe(second.invocationId);
      // An exclusive call queued behind the sends observes their completion.
      expect(await start(pr)).toBe("same");
      expect(read).toHaveBeenCalledTimes(2);
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
    it.each([
      { state: "closed" }, { sameRepository: false }, { draft: true },
    ])("skips ineligible PRs without recording the head: %j", async change => {
      const pr = key();
      read.mockResolvedValue({ ...eligible, ...change });
      expect(await start(pr)).toBe("skipped");
      expect(dispatch).not.toHaveBeenCalled();
      read.mockResolvedValue(eligible);
      expect(await start(pr)).toBe("started");
    });
    it("allows a bot draft synchronization", async () => {
      read.mockResolvedValue({ ...eligible, draft: true });
      expect(await start(key(), true)).toBe("started");
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
    it.each([404, 422])("records final HTTP %s failures", async status => {
      const pr = key();
      dispatch.mockResolvedValue({ success: false, status, error: SECRET });
      expect(await start(pr)).toBe("failed");
      expect(await start(pr)).toBe("same");
      expect(dispatch).toHaveBeenCalledTimes(1);
      read.mockResolvedValue({ ...eligible, headSha: "next" });
      expect(await start(pr)).toBe("failed");
      expect(dispatch).toHaveBeenCalledTimes(2);
    });
    it.each([401, 403, 429, 500, "network", "token", "dispatch-token", "read-error", "unreadable"])("retries %s on the next call and sanitizes journal/state", async failure => {
      const pr = key();
      if (failure === "network") dispatch.mockRejectedValue(new Error(SECRET));
      else if (failure === "token") token.mockRejectedValue(new Error(SECRET));
      else if (failure === "dispatch-token") token.mockResolvedValueOnce(SECRET).mockRejectedValueOnce(new Error(SECRET));
      else if (failure === "read-error") read.mockRejectedValueOnce(new Error(SECRET));
      else if (failure === "unreadable") read.mockResolvedValue(null);
      else dispatch.mockResolvedValue({ success: false, status: failure, error: SECRET });
      expect(await start(pr)).toBe("failed");
      token.mockResolvedValue(SECRET); read.mockResolvedValue(eligible);
      dispatch.mockResolvedValue({ success: true, status: 204 });
      expect(await start(pr)).toBe("started");
      const rows = await queryInvocations(env().adminAPIBaseUrl(), `target_service_name = 'ClaudeReviewStart' AND target_service_key = '${pr}'`);
      for (const row of rows) {
        expect(journalText(await journalEntries(env().adminAPIBaseUrl(), String(row.id)))).not.toContain(SECRET);
      }
      const response = await fetch(`${env().adminAPIBaseUrl()}/query`, { // restate-test-allow: inspect full state for leaked secrets
        method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query: `SELECT * FROM state WHERE service_name = 'ClaudeReviewStart' AND service_key = '${pr}'` }),
      });
      expect(response.ok).toBe(true);
      expect(await response.text()).not.toContain(SECRET);
    });
  });
});
