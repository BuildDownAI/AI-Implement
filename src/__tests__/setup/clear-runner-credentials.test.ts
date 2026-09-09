import { beforeAll, describe, expect, it } from "vitest";

const CREDENTIAL_KEYS = [
  "RUN_TOKEN",
  "RUNNER_CALLBACK_URL",
  "RUN_PROGRESS_TOKEN",
  "RUN_PUBLICATION_TOKEN",
  "GIT_KG_PUSH_TOKEN_FILE",
] as const;

describe("clear-runner-credentials setup file", () => {
  beforeAll(() => {
    // Seed all five credential variables. The global beforeEach registered by
    // clear-runner-credentials.ts runs after this beforeAll and before the test
    // body, so the test can assert the deletion actually happened.
    for (const key of CREDENTIAL_KEYS) {
      process.env[key] = "sentinel";
    }
  });

  it("deletes all five runner credential variables before each test", () => {
    for (const key of CREDENTIAL_KEYS) {
      expect(process.env[key]).toBeUndefined();
    }
  });
});
