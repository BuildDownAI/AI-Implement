import { claudeReviewRepairClient } from "../restate/claude-review-repair.js";
import { describe, expect, it } from "vitest";
import { claudeReviewStartClient } from "../restate/claude-review-start.js";
import { fakeFetch, stubAbortTimeout } from "./helpers/fake-fetch.js";

describe("ClaudeReviewStart ingress client", () => {
  it.each([undefined, { idempotencyKey: "webhook-delivery-1" }])(
    "bounds send and preserves optional idempotency options: %j",
    async opts => {
      const timeout = stubAbortTimeout(5000);
      const fake = fakeFetch({
        "POST /ClaudeReviewStart/trusted%2Frepo%231/start/send": {
          json: { invocationId: "inv_1", status: "Accepted" },
        },
      }).install();
      const input = { ref: "testing", allowDraft: false };

      await claudeReviewStartClient().send("trusted/repo#1", input, opts);

      expect(fake.calls).toHaveLength(1);
      const [request] = fake.calls;
      expect(JSON.parse(request.body)).toEqual(input);
      expect(request.headers.get("idempotency-key")).toBe(opts?.idempotencyKey ?? null);
      expect(request.signal).toBeInstanceOf(AbortSignal);
      expect(timeout).toHaveBeenCalledExactlyOnceWith(5000);
      expect(request.signal).toBe(timeout.mock.results[0].value);
    },
  );
});

it("bounds the repair send without an idempotency key", async () => {
  const timeout = stubAbortTimeout(5000);
  const fake = fakeFetch({ "POST /ClaudeReviewRepair/orchestrator/tick/send": {
    json: { invocationId: "inv_1", status: "Accepted" },
  } }).install();
  const input = { repositories: [{ repository: "trusted/repo", ref: "testing", pulls: [{ number: 1, headSha: "head" }] }] };
  await claudeReviewRepairClient().send(input);
  expect(fake.calls).toHaveLength(1);
  const [request] = fake.calls;
  expect(JSON.parse(request.body)).toEqual(input);
  expect(request.headers.get("idempotency-key")).toBeNull();
  expect(request.signal).toBeInstanceOf(AbortSignal);
  expect(timeout).toHaveBeenCalledExactlyOnceWith(5000);
  expect(request.signal).toBe(timeout.mock.results[0].value);
});
