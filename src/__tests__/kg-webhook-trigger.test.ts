import { describe, it, expect, vi } from "vitest";
import { makeKgWebhookTrigger } from "../kg-webhook-trigger.js";

describe("makeKgWebhookTrigger", () => {
  it("forwards dryRun and ref to the admin trigger and drops report", async () => {
    const trigger = vi.fn().mockResolvedValue({ status: 202, body: {} });
    const t = makeKgWebhookTrigger(() => ({ trigger }));
    const res = await t({ dryRun: true, ref: "feat", report: { prNumber: 1 } });
    expect(trigger).toHaveBeenCalledWith({ dryRun: true, ref: "feat" });
    expect(res.status).toBe(202);
  });

  it("answers 501 when the KG source repo is not configured", async () => {
    const t = makeKgWebhookTrigger(() => undefined);
    expect((await t({ dryRun: true })).status).toBe(501);
  });
});
