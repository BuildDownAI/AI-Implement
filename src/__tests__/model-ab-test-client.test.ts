import { describe, expect, it } from "vitest";
import { assignModelAbTestRow } from "../restate/model-ab-test.js";
import { fakeFetch, hangUntilAborted, stubAbortTimeout } from "./helpers/fake-fetch.js";

const baseUrl = "http://restate.test";

describe("assignModelAbTestRow failures", () => {
  it("rejects when ingress returns a non-success response", async () => {
    const ingress = fakeFetch({
      "POST /ModelAbTest/project/assign": { status: 503, text: "Ingress unavailable" },
    });

    await expect(assignModelAbTestRow("project", "issue", { baseUrl, fetchImpl: ingress.fetch }))
      .rejects.toMatchObject({ status: 503, message: expect.stringContaining("Ingress unavailable") });
    expect(ingress.calls).toHaveLength(1);
  });

  it("propagates a network rejection to the caller", async () => {
    const error = new TypeError("connect ECONNREFUSED");
    const ingress = fakeFetch({
      "POST /ModelAbTest/project/assign": () => { throw error; },
    });

    await expect(assignModelAbTestRow("project", "issue", { baseUrl, fetchImpl: ingress.fetch }))
      .rejects.toBe(error);
    expect(ingress.calls).toHaveLength(1);
  });

  it("rejects a pending request when its 10-second timeout aborts", async () => {
    const timeout = stubAbortTimeout(10_000);
    const ingress = fakeFetch({ "POST /ModelAbTest/project/assign": hangUntilAborted });

    await expect(assignModelAbTestRow("project", "issue", { baseUrl, fetchImpl: ingress.fetch }))
      .rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
    expect(ingress.calls).toHaveLength(1);
    expect(ingress.calls[0].signal?.aborted).toBe(true);
  });
});
