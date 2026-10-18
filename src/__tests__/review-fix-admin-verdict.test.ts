import { describe, it, expect } from "vitest";
import { parseStoredVerdict } from "../review-fix-admin-facade.js";

describe("parseStoredVerdict", () => {
  it("projects the structured verdict", () => {
    expect(parseStoredVerdict(JSON.stringify({ approved: true, reason: "approved", summary: "x" }))).toEqual({ approved: true, reason: "approved" });
    expect(parseStoredVerdict(JSON.stringify({ approved: false, reason: "rejected" }))).toEqual({ approved: false, reason: "rejected" });
    expect(parseStoredVerdict(JSON.stringify({ approved: null, reason: "fix_failed" }))).toEqual({ approved: null, reason: "fix_failed" });
  });
  it("falls back to the raw text for legacy and malformed values", () => {
    expect(parseStoredVerdict("passed")).toEqual({ approved: null, reason: "passed" });
    expect(parseStoredVerdict("{not json")).toEqual({ approved: null, reason: "{not json" });
    const odd = JSON.stringify({ approved: "yes", reason: 3 });
    expect(parseStoredVerdict(odd)).toEqual({ approved: null, reason: odd });
  });
});
