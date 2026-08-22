import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetPublicationCredentialForTests,
  clearPublicationCredential,
  getPublicationCredential,
} from "../publication-credential.js";

describe("publication credential custody", () => {
  afterEach(() => {
    clearPublicationCredential();
    __resetPublicationCredentialForTests();
    vi.unstubAllEnvs();
  });

  it("captures the credential once and immediately removes it from the environment", () => {
    vi.stubEnv("RUN_PUBLICATION_TOKEN", "  one-use-token  ");

    expect(getPublicationCredential()).toBe("one-use-token");
    expect(process.env.RUN_PUBLICATION_TOKEN).toBeUndefined();

    process.env.RUN_PUBLICATION_TOKEN = "replacement-token";
    expect(getPublicationCredential()).toBe("one-use-token");
  });

  it("clears both private memory and any later environment value", () => {
    vi.stubEnv("RUN_PUBLICATION_TOKEN", "one-use-token");
    expect(getPublicationCredential()).toBe("one-use-token");

    process.env.RUN_PUBLICATION_TOKEN = "later-token";
    clearPublicationCredential();

    expect(process.env.RUN_PUBLICATION_TOKEN).toBeUndefined();
    expect(getPublicationCredential()).toBeUndefined();
  });
});
