import { describe, it, expect } from "vitest";
import { planningDispatchBlockReason } from "../runner-callback.js";

const URL = "https://orchestrator.example.com";
const SECRET = "a-secret";

describe("planningDispatchBlockReason", () => {
  it("allows the dispatch when both the callback URL and the token secret are set", () => {
    expect(
      planningDispatchBlockReason({ runnerCallbackBaseUrl: URL, runnerTokenSecret: SECRET }),
    ).toBeNull();
  });

  it("blocks and names the variable when the callback base URL is missing", () => {
    const reason = planningDispatchBlockReason({
      runnerCallbackBaseUrl: null,
      runnerTokenSecret: SECRET,
    });
    expect(reason).toMatch(/RUNNER_CALLBACK_BASE_URL/);
    expect(reason).not.toMatch(/RUNNER_TOKEN_SECRET/);
  });

  it("blocks and names the variable when the token secret is missing", () => {
    const reason = planningDispatchBlockReason({
      runnerCallbackBaseUrl: URL,
      runnerTokenSecret: null,
    });
    expect(reason).toMatch(/RUNNER_TOKEN_SECRET/);
    expect(reason).not.toMatch(/RUNNER_CALLBACK_BASE_URL/);
  });

  it("names both variables when neither is set", () => {
    const reason = planningDispatchBlockReason({
      runnerCallbackBaseUrl: null,
      runnerTokenSecret: null,
    });
    expect(reason).toMatch(/RUNNER_CALLBACK_BASE_URL and RUNNER_TOKEN_SECRET/);
  });

  // An empty string is what the dispatch path actually produces when the env var
  // is present but blank, so it must block rather than read as configured.
  it("treats an empty string as missing", () => {
    expect(
      planningDispatchBlockReason({ runnerCallbackBaseUrl: "", runnerTokenSecret: SECRET }),
    ).toMatch(/RUNNER_CALLBACK_BASE_URL/);
    expect(
      planningDispatchBlockReason({ runnerCallbackBaseUrl: URL, runnerTokenSecret: "" }),
    ).toMatch(/RUNNER_TOKEN_SECRET/);
  });

  it("explains why the dispatch is refused, not just that it was", () => {
    const reason = planningDispatchBlockReason({
      runnerCallbackBaseUrl: null,
      runnerTokenSecret: null,
    });
    expect(reason).toMatch(/Plan-Complete/);
    expect(reason).toMatch(/every poll/);
  });
});
