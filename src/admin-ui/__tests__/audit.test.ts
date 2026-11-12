import { describe, expect, it } from "vitest";
import { auditHtml } from "../pages/audit.js";

describe("audit log page", () => {
  it("promises no time window, since GET /api/dedup lists every dedup row", () => {
    // listDispatched (src/dedup.ts) reads the whole dispatched table, newest first, with no time filter.
    const subtitle = /class="page-subtitle">([^<]*)</.exec(auditHtml)?.[1] ?? "";
    expect(subtitle).not.toBe("");
    expect(subtitle).not.toMatch(/\b\d+\s*(h|hours?|d|days?)\b/i);
  });
});
