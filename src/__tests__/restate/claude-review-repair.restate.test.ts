import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClaudeReviewStart } from "../../restate/claude-review-start.js";
import { createClaudeReviewRepair } from "../../restate/claude-review-repair.js";
import { VARIANTS, callObject, startVariants, stopAll, gate, queryInvocations, killInvocation, eventually, type RestateEnvironment } from "./harness.js";

describe("ClaudeReviewRepair durable snapshots", () => {
  let environments: Map<string, RestateEnvironment>;
  const read = vi.fn();
  const dispatch = vi.fn();
  const eligible = { state: "open" as const, headSha: "head", draft: false, sameRepository: true };
  beforeEach(() => {
    read.mockReset().mockResolvedValue(eligible);
    dispatch.mockReset().mockResolvedValue({ success: true, status: 204 });
  });
  beforeAll(async () => {
    environments = await startVariants([createClaudeReviewRepair(), createClaudeReviewStart({
      appId: "app", privateKey: "secret", getInstallationToken: async () => "token",
      getPullRequest: read, postWorkflowDispatch: dispatch,
    })]);
  }, 60_000);
  afterAll(async () => { await stopAll(environments); });
  for (const [variant] of VARIANTS) describe(variant, () => {
    const env = () => environments.get(variant)!;
    const snapshot = () => {
      const key = randomUUID();
      const repository = `owner/${key}`;
      return { key, repository, tick: (pulls = [{ number: 42, headSha: "head" }]) =>
        callObject<void>(env().baseUrl(), "ClaudeReviewRepair", key, "tick", {
          repositories: [{ repository, ref: "testing", pulls }],
        }) };
    };
    it("dispatches the message ref, suppresses unchanged reads, dispatches new heads, and prunes absent PRs", async () => {
      const { tick } = snapshot();
      await tick();
      expect(read).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ref: "testing", inputs: { pr_number: "42", head_sha: "head" } }));
      await tick();
      expect(read).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledTimes(1);
      read.mockResolvedValue({ ...eligible, headSha: "next" });
      const next = [{ number: 42, headSha: "next" }];
      await tick(next);
      expect(read).toHaveBeenCalledTimes(2);
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(dispatch.mock.calls[1][0].inputs.head_sha).toBe("next");
      await tick([]);
      await tick(next);
      expect(read).toHaveBeenCalledTimes(3);
      expect(dispatch).toHaveBeenCalledTimes(2);
    });
    it("retries a failed start for the same head", async () => {
      const { tick } = snapshot();
      dispatch.mockResolvedValueOnce({ success: false, status: 500 });
      await tick();
      await tick();
      expect(read).toHaveBeenCalledTimes(2);
      expect(dispatch).toHaveBeenCalledTimes(2);
      await tick();
      expect(read).toHaveBeenCalledTimes(2);
    });
    it("continues after a child invocation ends with a terminal error", async () => {
      const { tick, repository } = snapshot();
      const held = gate("first PR read");
      read.mockImplementationOnce(async () => { await held.wait(); return eligible; });
      const running = tick([{ number: 42, headSha: "head" }, { number: 43, headSha: "head" }]);
      try {
        await held.reached();
        const rows = await eventually(() => queryInvocations(env().adminAPIBaseUrl(),
          `target_service_name = 'ClaudeReviewStart' AND target_service_key = '${repository}#42'`),
        rows => rows.length === 1, { label: "gated child invocation" });
        await killInvocation(env().adminAPIBaseUrl(), String(rows[0].id));
        await running;
        expect(read).toHaveBeenCalledTimes(2);
        expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ inputs: { pr_number: "43", head_sha: "head" } }));
      } finally { held.release(); await running; }
    });
  });
});
