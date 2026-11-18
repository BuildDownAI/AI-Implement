import { describe, expect, it } from "vitest";
import { isAddressInUse } from "./restate/binary-environment.js";

describe("isAddressInUse", () => {
  it("retries a lost port race", () => {
    expect(
      isAddressInUse("[admin-api-server] failed binding to address '127.0.0.1:33959': Address in use (os error 98)"),
    ).toBe(true);
  });

  it("does not retry other startup failures", () => {
    expect(isAddressInUse("invalid configuration: unknown key")).toBe(false);
    expect(isAddressInUse("")).toBe(false);
  });
});
